import { Tokens } from '@valenced/discord/common/tokens'
import { Design } from '@valenced/discord/design'
import { getModules, lookupModule } from '@valenced/modules/finders'
import {
	createFilterGenerator,
	FilterScopes,
	withProps,
} from '@valenced/modules/finders/filters'
import { after } from '@valenced/patcher'
import {
	Component,
	cloneElement,
	createElement,
	isValidElement,
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import {
	Animated,
	BackHandler,
	PanResponder,
	Platform,
	Pressable,
	StyleSheet,
	useWindowDimensions,
	View,
} from 'react-native'
import { gestureHandler, scrub } from './gesture'
import { iconId } from './icons'
import { PlayerBody, usePlayerVisible } from './player'
import { dockModeOf, setDockMode, useSettings } from './shared'
import { restorePlayer, useSpotify } from './spotify'
import type { Filter, FilterGenerator } from '@valenced/modules/finders/filters'
import type { ComponentType, ReactElement, ReactNode } from 'react'
import type { LayoutChangeEvent } from 'react-native'
import type { DockMode } from './shared'

// Built once; the bundler rewrites a bare `Animated.View` member access.
const AnimatedView = Animated.createAnimatedComponent(View)

type AnyElement = ReactElement<any>
type AnyFn = (...args: any[]) => any
interface BarLayout {
	x: number
	y: number
	width: number
	height: number
}

const MAX_TREE_DEPTH = 16
/** Fallbacks used only when Discord's own layout hooks cannot be found. */
const FALLBACK_BAR_HEIGHT = 56
const FALLBACK_MARGIN = 16
const TOP_RADIUS = 24
const BAR_RADIUS = 28
/** Space above the player content, holds the drag handle. */
const CONTENT_TOP = 16
const EXPANDED_PADDING_BOTTOM = 8
/** Content height guesses used until the real content has been measured. */
const GUESS = { compact: 48, expanded: 150 }
const SPRING = {
	mass: 0.5,
	damping: 80,
	stiffness: 320,
	useNativeDriver: false,
} as const

const nameOf = (value: unknown) => {
	const fn = value as { displayName?: string; name?: string } | undefined
	return fn?.displayName || fn?.name || ''
}

/** Matches a component exported plain, memoized, forwardRef-ed or as `default`. */
const withComponentName = createFilterGenerator(
	([name]: [string], _, exports) => {
		const e = exports as Record<string, unknown> | undefined
		const d = e?.default as Record<string, unknown> | undefined
		return [e, d, e?.type, d?.type, e?.render, d?.render].some(
			candidate => nameOf(candidate) === name,
		)
	},
	([name]: [string]) => `dariuss.spotify.component(${name})`,
	FilterScopes.Initialized,
) as unknown as FilterGenerator<
	(
		name: string,
	) => Filter<{ Result: object; Scopes: [typeof FilterScopes.Initialized] }>
>

/** Renders the original element when anything inside the injected UI throws. */
class Guard extends Component<
	{ original: ReactNode; children: ReactNode },
	{ failed: boolean }
> {
	state = { failed: false }
	static getDerivedStateFromError() {
		return { failed: true }
	}
	render() {
		return this.state.failed ? this.props.original : this.props.children
	}
}

const barWrappers = new WeakMap<object, ComponentType<any>>()

/** Replaces the `YouBar` element by a wrapper that reports the bar's real layout. */
function measureBar(
	node: ReactNode,
	onBarLayout: (layout: BarLayout) => void,
	depth = 0,
): ReactNode {
	if (depth > MAX_TREE_DEPTH || !node) return node
	if (Array.isArray(node))
		return node.map(child => measureBar(child, onBarLayout, depth + 1))
	if (!isValidElement<{ children?: ReactNode }>(node)) return node

	const type = node.type as { type?: AnyFn; compare?: AnyFn } | AnyFn
	const render = (typeof type === 'function' ? type : type?.type) as
		| AnyFn
		| undefined
	if (typeof render === 'function' && nameOf(render) === 'YouBar') {
		let wrapper = barWrappers.get(type)
		if (!wrapper) {
			// biome-ignore lint/correctness/noComponentHookFactories: created once per YouBar type and cached in a WeakMap, so the identity is stable
			const Bar = ({ onBarLayout: report, ...props }: any) => {
				const bar = render(props)
				if (!isValidElement<{ onLayout?: AnyFn }>(bar)) return bar
				return cloneElement(bar, {
					onLayout: (event: any) => {
						try {
							report(event.nativeEvent.layout)
						} catch {}
						bar.props.onLayout?.(event)
					},
				})
			}
			wrapper =
				typeof type === 'function'
					? Bar
					: (memo(Bar, type.compare) as unknown as ComponentType<any>)
			barWrappers.set(type, wrapper)
		}
		return createElement(wrapper, { ...node.props, key: node.key, onBarLayout })
	}

	return node.props.children
		? cloneElement(
				node as AnyElement,
				{},
				measureBar(node.props.children, onBarLayout, depth + 1),
			)
		: node
}

interface DockHooks {
	margin: () => number
	bottom: () => number
	background: () => unknown
	barHeight: number
}
let dockHooks: DockHooks | null = null

function findExport(prop: string) {
	try {
		return (lookupModule(withProps(prop))[0] ?? null) as Record<
			string,
			unknown
		> | null
	} catch {
		return null
	}
}

/** Discord's own YouBar / Quest dock layout and color hooks, with token fallbacks. */
function useDockLook() {
	if (!dockHooks) {
		const margins = findExport('useYouBarHorizontalMargin')
		const constants = findExport('YOU_BAR_HEIGHT')
		const dock = findExport('useQuestDockAppThemedBackgroundColor')
		const hook = (value: unknown, fallback: () => unknown) =>
			(typeof value === 'function' ? value : fallback) as () => any
		dockHooks = {
			margin: hook(margins?.useYouBarHorizontalMargin, () => FALLBACK_MARGIN),
			bottom: hook(margins?.useYouBarBottomMargin, () => FALLBACK_MARGIN),
			background: hook(dock?.useQuestDockAppThemedBackgroundColor, () => null),
			barHeight:
				typeof constants?.YOU_BAR_HEIGHT === 'number'
					? constants.YOU_BAR_HEIGHT
					: FALLBACK_BAR_HEIGHT,
		}
	}
	const margin = dockHooks.margin()
	const bottom = dockHooks.bottom()
	const dockColor = dockHooks.background()
	const { theme } = (Design as any).useThemeContext()

	const colors = useMemo(() => {
		const { colors: palette, internal } = Tokens.default as any
		const resolve = (names: string[]) => {
			for (const name of names) {
				try {
					if (!palette[name]) continue
					const value = internal.resolveSemanticColor(theme, palette[name])
					if (typeof value === 'string' && value !== 'transparent') return value
				} catch {}
			}
			return undefined
		}
		return {
			background: resolve([
				'BACKGROUND_SURFACE_HIGH',
				'MOBILE_FLOATINGBAR_BACKGROUND',
			]),
			border: resolve(['BORDER_MUTED', 'BORDER_SUBTLE']),
			handle: resolve(['INTERACTIVE_MUTED', 'TEXT_MUTED']),
		}
	}, [theme])

	const finite = (value: unknown, fallback: number) =>
		typeof value === 'number' && Number.isFinite(value) ? value : fallback
	return {
		margin: finite(margin, FALLBACK_MARGIN),
		bottom: finite(bottom, FALLBACK_MARGIN),
		barHeight: dockHooks.barHeight,
		background:
			typeof dockColor === 'string' && dockColor !== 'transparent'
				? dockColor
				: colors.background,
		border: colors.border,
		handle: colors.handle,
	}
}

const sameLayout = (a: BarLayout, b: BarLayout) =>
	Math.abs(a.x - b.x) < 0.5 &&
	Math.abs(a.y - b.y) < 0.5 &&
	Math.abs(a.width - b.width) < 0.5 &&
	Math.abs(a.height - b.height) < 0.5

type Axis = 'x' | 'y'

const MODES: DockMode[] = ['closed', 'collapsed', 'expanded']
const CLOSED_HEIGHT = 22

/**
 * The player card: an absolutely positioned dock that grows upward from the YouBar. It has three
 * sizes: closed (only the handle), collapsed (title and buttons) and expanded (covers the bar).
 */
function DockCard({ bar }: { bar: ReactNode }) {
	const { width: screen } = useWindowDimensions()
	const settings = useSettings()
	const visible = usePlayerVisible()
	const look = useDockLook()
	const [layout, setLayout] = useState<BarLayout | null>(null)
	const [containerHeight, setContainerHeight] = useState(0)
	const [content, setContent] = useState(GUESS)
	const [mounted, setMounted] = useState(visible)
	// With nothing playing the dock has two sizes only: the handle, and one pull up to the search row.
	const { playback } = useSpotify()
	const idle = settings.alwaysShow && !playback
	const [idleMode, setIdleMode] = useState<DockMode>('closed')
	const mode = idle ? idleMode : dockModeOf(settings)
	const setMode = idle ? setIdleMode : setDockMode

	const onBarLayout = useCallback(
		(next: BarLayout) =>
			setLayout(previous =>
				previous && sameLayout(previous, next)
					? previous
					: { x: next.x, y: next.y, width: next.width, height: next.height },
			),
		[],
	)
	const measuredBar = useMemo(
		() => measureBar(bar, onBarLayout),
		[bar, onBarLayout],
	)

	const frame =
		layout && layout.width > 0 && containerHeight > 0
			? {
					left: layout.x,
					width: layout.width,
					bottom: Math.max(0, containerHeight - layout.y - layout.height),
					barHeight: layout.height,
				}
			: {
					left: look.margin,
					width: Math.max(0, screen - look.margin * 2),
					bottom: look.bottom,
					barHeight: look.barHeight,
				}

	const closedHeight = frame.barHeight + CLOSED_HEIGHT
	const collapsedHeight = frame.barHeight + CONTENT_TOP + content.compact
	const expandedHeight = Math.max(
		collapsedHeight + 1,
		CONTENT_TOP + content.expanded + EXPANDED_PADDING_BOTTOM,
	)
	const target = !visible
		? frame.barHeight
		: mode === 'closed'
			? closedHeight
			: mode === 'collapsed'
				? collapsedHeight
				: expandedHeight

	const height = useRef(new Animated.Value(frame.barHeight)).current
	const offsetX = useRef(new Animated.Value(0)).current
	const current = useRef(frame.barHeight)
	const dragging = useRef(false)
	const live = useRef({
		idle,
		setMode,
		collapsedHeight,
		mode,
		screen,
		target,
		closedHeight,
		expandedHeight,
		always: settings.alwaysShow,
	})
	live.current = {
		idle,
		setMode,
		collapsedHeight,
		mode,
		screen,
		target,
		closedHeight,
		expandedHeight,
		always: settings.alwaysShow,
	}

	useEffect(() => {
		const id = height.addListener(({ value }) => {
			current.current = value
		})
		return () => height.removeListener(id)
	}, [height])
	useEffect(() => {
		if (!visible) return
		setMounted(true)
		// A card that was swiped away comes back from its resting place.
		offsetX.setValue(0)
	}, [visible, offsetX])
	useEffect(() => {
		if (!mounted || dragging.current) return
		const animation = Animated.spring(height, { ...SPRING, toValue: target })
		animation.start(({ finished }) => {
			if (finished && !visible) setMounted(false)
		})
		return () => animation.stop()
	}, [target, mounted, visible, height])
	useEffect(() => {
		if (mode !== 'expanded' || !visible) return
		const subscription = BackHandler.addEventListener(
			'hardwareBackPress',
			() => {
				setDockMode('collapsed')
				return true
			},
		)
		return () => subscription.remove()
	}, [mode, visible])

	const drag = useMemo(() => {
		let axis: Axis = 'y'
		let startHeight = 0
		// A touch that began on the progress bar belongs to the bar.
		let ignored = false
		const settle = () =>
			Animated.spring(height, {
				...SPRING,
				toValue: live.current.target,
			}).start()
		const springBack = () =>
			Animated.spring(offsetX, { ...SPRING, toValue: 0 }).start()
		return {
			start(dx: number, dy: number) {
				ignored = scrub.active
				if (ignored) return
				dragging.current = true
				axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
				height.stopAnimation()
				startHeight = current.current
			},
			move(dx: number, dy: number) {
				if (ignored) return
				if (axis === 'x') return offsetX.setValue(dx)
				const low = live.current.closedHeight
				const high = live.current.idle
					? live.current.collapsedHeight
					: live.current.expandedHeight
				const next = startHeight - dy
				height.setValue(
					next < low
						? low - (low - next) * 0.25
						: next > high
							? high + (next - high) * 0.25
							: next,
				)
			},
			end(_dx: number, dy: number, _vx: number, vy: number) {
				if (ignored) return
				dragging.current = false
				const { mode: now } = live.current
				if (axis === 'x') {
					springBack()
					return
				}
				const up = dy < -15 || (Math.abs(vy) > 0.2 && vy < 0)
				const down = dy > 15 || (Math.abs(vy) > 0.2 && vy > 0)
				const { setMode: apply, idle: nothing } = live.current
				const modes = nothing ? MODES.slice(0, 2) : MODES
				const index = modes.indexOf(now)
				if (up) apply(modes[Math.min(modes.length - 1, index + 1)])
				else if (down) apply(modes[Math.max(0, index - 1)])
				settle()
			},
			cancel() {
				if (ignored) return
				dragging.current = false
				if (axis === 'x') springBack()
				else settle()
			},
		}
	}, [height, offsetX])

	const pan = useMemo(
		() =>
			PanResponder.create({
				// Vertical drags are claimed before the buttons inside the card can take them.
				onMoveShouldSetPanResponderCapture: (_, g) =>
					Math.abs(g.dy) > 8 && Math.abs(g.dy) > Math.abs(g.dx) * 1.5,
				onMoveShouldSetPanResponder: (_, g) =>
					(Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx) * 1.5) ||
					(Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy)),
				onPanResponderGrant: (_, g) => drag.start(g.dx, g.dy),
				onPanResponderMove: (_, g) => drag.move(g.dx, g.dy),
				onPanResponderRelease: (_, g) => drag.end(g.dx, g.dy, g.vx, g.vy),
				onPanResponderTerminate: () => drag.cancel(),
			}),
		[drag],
	)

	// iOS: Discord's root gesture handler takes over touches, so the drag must be a native gesture there.
	const handler = useMemo(gestureHandler, [])
	const gesture = useMemo(
		() =>
			handler && Platform.OS === 'ios'
				? handler.Gesture.Pan()
						.runOnJS(true)
						.activeOffsetY([-8, 8])
						.activeOffsetX([-14, 14])
						.onStart(e => drag.start(e.translationX, e.translationY))
						.onUpdate(e => drag.move(e.translationX, e.translationY))
						.onEnd(e =>
							drag.end(
								e.translationX,
								e.translationY,
								e.velocityX / 1000,
								e.velocityY / 1000,
							),
						)
						.onFinalize((_e, success) => {
							if (!success) drag.cancel()
						})
				: null,
		[handler, drag],
	)

	const ease = (input: number[], output: number[]) =>
		height.interpolate({
			inputRange: input,
			outputRange: output,
			extrapolate: 'clamp',
		})
	const barOpacity = ease(
		[
			collapsedHeight,
			collapsedHeight + (expandedHeight - collapsedHeight) * 0.6,
		],
		[1, 0],
	)
	const collapsedOpacity = ease(
		[closedHeight, collapsedHeight, collapsedHeight + 40],
		[0, 1, 0],
	)
	const expandedOpacity = ease(
		[collapsedHeight + 20, Math.max(expandedHeight, collapsedHeight + 21)],
		[0, 1],
	)
	const cardOpacity = ease([frame.barHeight, frame.barHeight + 8], [0, 1])
	const covering = mode === 'expanded' && visible
	const measure = (key: 'compact' | 'expanded') =>
		function onLayout(event: LayoutChangeEvent) {
			const value = Math.round(event.nativeEvent.layout.height)
			setContent(previous =>
				value > 0 && Math.abs(previous[key] - value) > 0.5
					? { ...previous, [key]: value }
					: previous,
			)
		}

	const card = (
		<AnimatedView
			{...(gesture ? { collapsable: false } : pan.panHandlers)}
			style={{
				position: 'absolute',
				left: frame.left,
				width: frame.width,
				bottom: frame.bottom,
				height,
				opacity: cardOpacity,
				overflow: 'hidden',
				transform: [{ translateX: offsetX }],
				borderTopLeftRadius: TOP_RADIUS,
				borderTopRightRadius: TOP_RADIUS,
				borderBottomLeftRadius: BAR_RADIUS,
				borderBottomRightRadius: TOP_RADIUS,
				borderWidth: 1,
				borderColor: look.border,
				backgroundColor: look.background,
			}}
		>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={
					mode === 'expanded' ? 'Collapse player' : 'Expand player'
				}
				hitSlop={8}
				onPress={() =>
					setMode(
						idle
							? mode === 'closed'
								? 'collapsed'
								: 'closed'
							: mode === 'collapsed'
								? 'expanded'
								: 'collapsed',
					)
				}
				style={dockStyles.handleRow}
			>
				<View style={[dockStyles.handle, { backgroundColor: look.handle }]} />
			</Pressable>
			<AnimatedView
				pointerEvents={mode === 'collapsed' ? 'auto' : 'none'}
				style={[dockStyles.content, { opacity: collapsedOpacity }]}
				onLayout={measure('compact')}
			>
				<PlayerBody mode="compact" />
			</AnimatedView>
			<AnimatedView
				pointerEvents={mode === 'expanded' ? 'auto' : 'none'}
				style={[dockStyles.content, { opacity: expandedOpacity }]}
				onLayout={measure('expanded')}
			>
				<PlayerBody mode="expanded" />
			</AnimatedView>
		</AnimatedView>
	)

	return (
		<>
			{mounted &&
				// custom: Discord's Quest dock card is not exposed as a component, so the dock is
				// built from Views styled with Discord's own dock color hook and Tokens
				(gesture && handler ? (
					<handler.GestureDetector gesture={gesture}>
						{card}
					</handler.GestureDetector>
				) : (
					card
				))}
			<AnimatedView
				pointerEvents={covering ? 'none' : 'box-none'}
				style={[StyleSheet.absoluteFill, { opacity: mounted ? barOpacity : 1 }]}
				onLayout={event => {
					const value = event.nativeEvent.layout.height
					setContainerHeight(previous =>
						Math.abs(previous - value) < 0.5 ? previous : value,
					)
				}}
			>
				{measuredBar}
			</AnimatedView>
		</>
	)
}

const dockStyles = StyleSheet.create({
	handleRow: {
		position: 'absolute',
		top: 0,
		left: 0,
		right: 0,
		height: CONTENT_TOP + 4,
		alignItems: 'center',
		zIndex: 2,
	},
	handle: { marginTop: 6, width: 36, height: 4, borderRadius: 2, opacity: 0.6 },
	content: { position: 'absolute', top: CONTENT_TOP - 8, left: 0, right: 0 },
})

/** Finds the YouBar button container whose only child is an icon button, to copy its look. */
function findIconContainer(node: ReactNode, depth = 0): AnyElement | null {
	if (!node || depth > 8) return null
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = findIconContainer(child, depth + 1)
			if (found) return found
		}
		return null
	}
	if (!isValidElement<{ children?: ReactNode }>(node)) return null
	const child = node.props.children
	if (
		isValidElement<{ icon?: unknown }>(child) &&
		typeof child.props.icon === 'number'
	)
		return node as AnyElement
	return findIconContainer(child, depth + 1)
}

/** Shown next to the YouBar buttons after the player was swiped away. */
function RestoreButton({ container }: { container: ReactNode }) {
	const { dismissed, playback } = useSpotify()
	const target = findIconContainer(container)
	const icon = iconId('MusicIcon', 'PlayIcon')
	if (!dismissed || !playback || !target || !icon) return null

	const original = target.props.children as AnyElement
	return createElement(
		target.type,
		{ key: 'spotify-restore', style: target.props.style },
		<Design.IconButton
			icon={icon}
			accessibilityLabel="Restore Spotify Controls"
			variant={original.props.variant ?? 'tertiary'}
			size={original.props.size ?? 'sm'}
			onPress={restorePlayer}
		/>,
	)
}

/** Wraps the whole YouBar tree: the dock card sits behind the measured bar. */
function Dock({ original }: { original: ReactNode }) {
	return (
		<View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
			<DockCard bar={original} />
		</View>
	)
}

/**
 * Patches `YouBarThemed` (dock the player) and `YouBarNotificationsButton` (restore button).
 * Every patch and subscription is registered through `cleanup`.
 */
export function patchYouBar(
	cleanup: (...undo: (() => void)[]) => void,
	onError: (error: unknown) => void,
) {
	let active = true
	const patched = new WeakSet<object>()

	const patchComponent = (
		namespace: unknown,
		wrap: (rendered: ReactNode) => ReactNode,
	) => {
		const ns = namespace as Record<string, unknown> | undefined
		const inner = (ns?.default ?? ns) as Record<string, unknown> | undefined
		const hasType = typeof inner?.type === 'function'
		const hasRender = typeof inner?.render === 'function'
		const target = (hasType || hasRender ? inner : ns) as
			| Record<string, AnyFn>
			| undefined
		const key = hasType ? 'type' : hasRender ? 'render' : 'default'
		if (!target || typeof target[key] !== 'function' || patched.has(target))
			return
		patched.add(target)
		try {
			cleanup(
				after(target, key, rendered =>
					active ? wrap(rendered as ReactNode) : rendered,
				),
			)
		} catch (error) {
			onError(error)
		}
	}

	cleanup(
		() => {
			active = false
		},
		getModules(
			withComponentName('YouBarThemed'),
			namespace =>
				patchComponent(namespace, rendered => (
					<Guard original={rendered}>
						<Dock original={rendered} />
					</Guard>
				)),
			{ returnNamespace: true },
		),
		getModules(
			withComponentName('YouBarNotificationsButton'),
			namespace =>
				patchComponent(namespace, rendered => (
					<Guard original={rendered}>
						<RestoreButton container={rendered} />
						{rendered}
					</Guard>
				)),
			{ returnNamespace: true },
		),
	)
}

import { Tokens } from '@valenced/discord/common/tokens'
import { Design } from '@valenced/discord/design'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
	AccessibilityInfo,
	Animated,
	AppState,
	Easing,
	Image,
	Linking,
	PanResponder,
	Platform,
	Pressable,
	View,
} from 'react-native'
import { gestureHandler, scrub } from './gesture'
import { Icons, iconId } from './icons'
import { openSearch } from './search'
import { lazyStyles, setDockMode, useSettings } from './shared'
import { control, formatTime, positionOf, useSpotify } from './spotify'
import type { ButtonId, PlayerMode, Settings } from './shared'
import type { Playback } from './spotify'

// Built once; the bundler rewrites a bare `Animated.View` member access.
const AnimatedView = Animated.createAnimatedComponent(View)

const IDLE_HIDE_MS = 5 * 60 * 1000
/** Horizontal wave period in px, shared by the wave function and the loop animation. */
const WAVE_PERIOD = 192
const WAVE_HEIGHT = 18
const COLUMN_STEP = 3
/** Duration of one wave loop when the tempo of the song is unknown. */
const STEADY_LOOP_MS = 8000

const SAMPLE: Playback = {
	id: 'preview',
	uri: 'spotify:track:preview',
	title: 'Song title',
	artist: 'Artist',
	artwork: null,
	duration: 180_000,
	position: 45_000,
	updatedAt: 0,
	playing: false,
	shuffle: false,
	repeat: 'off',
	deviceId: null,
}

/** Whether the player should currently be shown above the YouBar. */
export function usePlayerVisible() {
	const { playback, dismissed } = useSpotify()
	const { alwaysShow } = useSettings()
	const [idle, setIdle] = useState(false)
	const id = playback?.id
	const playing = playback?.playing

	useEffect(() => {
		setIdle(false)
		if (id && !playing) {
			const timer = setTimeout(() => setIdle(true), IDLE_HIDE_MS)
			return () => clearTimeout(timer)
		}
	}, [id, playing])

	if (alwaysShow) return true
	return !dismissed && !!playback?.deviceId && (!!playing || !idle)
}

function useReduceMotion() {
	const [reduce, setReduce] = useState(false)
	useEffect(() => {
		let alive = true
		AccessibilityInfo.isReduceMotionEnabled()
			.then(value => alive && setReduce(value))
			.catch(() => {})
		const sub = AccessibilityInfo.addEventListener(
			'reduceMotionChanged',
			setReduce,
		)
		return () => {
			alive = false
			sub.remove()
		}
	}, [])
	return reduce
}

function useAppActive() {
	const [active, setActive] = useState(AppState.currentState === 'active')
	useEffect(() => {
		const sub = AppState.addEventListener('change', s =>
			setActive(s === 'active'),
		)
		return () => sub.remove()
	}, [])
	return active
}

function wave(x: number) {
	const t = ((x % WAVE_PERIOD) + WAVE_PERIOD) % WAVE_PERIOD
	const hill = (center: number, width: number, height: number) => {
		const d = Math.abs(t - center)
		return d < width ? (height * (1 + Math.cos((d / width) * Math.PI))) / 2 : 0
	}
	return 9 - hill(32, 22, 6) - hill(112, 36, 3) - hill(170, 12, 1)
}

interface SeekProps {
	/** 0..1 */
	progress: number
	duration: number
	disabled: boolean
	onPreview(fraction: number | null): void
	onSeek(fraction: number): void
}

/**
 * Animated wave progress bar.
 * custom: Discord has no native wave/progress-scrub component (the Quest progress indicator is a
 * plain bar), so this is built from Views styled with Tokens; the straight mode uses Design.Slider.
 */
function WaveBar({
	progress,
	playing,
	disabled,
	onPreview,
	onSeek,
}: SeekProps & {
	playing: boolean
}) {
	const styles = useWaveStyles()
	const [width, setWidth] = useState(1)
	const [drag, setDrag] = useState<number | null>(null)
	const reduceMotion = useReduceMotion()
	const shift = useRef(new Animated.Value(0)).current
	const live = useRef({ width, disabled, onPreview, onSeek })
	live.current = { width, disabled, onPreview, onSeek }
	const startX = useRef(0)

	const pan = useMemo(() => {
		const fraction = (x: number) =>
			Math.max(0, Math.min(1, x / live.current.width))
		return PanResponder.create({
			onStartShouldSetPanResponder: () => !live.current.disabled,
			onMoveShouldSetPanResponder: (_, g) =>
				!live.current.disabled && Math.abs(g.dx) > Math.abs(g.dy),
			onPanResponderGrant: e => {
				startX.current = e.nativeEvent.locationX
				const value = fraction(startX.current)
				setDrag(value)
				live.current.onPreview(value)
			},
			onPanResponderMove: (_, g) => {
				const value = fraction(startX.current + g.dx)
				setDrag(value)
				live.current.onPreview(value)
			},
			onPanResponderRelease: (_, g) => {
				const value = fraction(startX.current + g.dx)
				setDrag(null)
				live.current.onPreview(null)
				live.current.onSeek(value)
			},
			onPanResponderTerminate: () => {
				setDrag(null)
				live.current.onPreview(null)
			},
			// The parent card listens for swipes; never hand the scrub gesture over to it.
			onPanResponderTerminationRequest: () => false,
		})
	}, [])

	// iOS: Discord's root gesture handler takes over touches, so scrubbing needs a native gesture there.
	const handler = useMemo(gestureHandler, [])
	const gesture = useMemo(() => {
		if (!handler || Platform.OS !== 'ios') return null
		const fraction = (x: number) =>
			Math.max(0, Math.min(1, x / live.current.width))
		const show = (x: number) => {
			if (live.current.disabled) return
			const value = fraction(x)
			setDrag(value)
			live.current.onPreview(value)
		}
		return handler.Gesture.Pan()
			.runOnJS(true)
			.minDistance(0)
			.failOffsetY([-16, 16])
			.onBegin(event => {
				if (live.current.disabled) return
				scrub.active = true
				show(event.x)
			})
			.onUpdate(event => show(event.x))
			.onEnd(event => {
				if (live.current.disabled) return
				const value = fraction(event.x)
				setDrag(null)
				live.current.onPreview(null)
				live.current.onSeek(value)
			})
			.onFinalize((_event, success) => {
				scrub.active = false
				if (!success) {
					setDrag(null)
					live.current.onPreview(null)
				}
			})
	}, [handler])

	const tileWidth = width + WAVE_PERIOD + COLUMN_STEP + 1
	const columns = useMemo(
		() =>
			Array.from({ length: Math.ceil(tileWidth / COLUMN_STEP) }, (_, i) => {
				const y = wave(i * COLUMN_STEP)
				return { left: i * COLUMN_STEP, top: y - 0.5, height: 10.5 - y }
			}),
		[tileWidth],
	)

	useEffect(() => {
		if (!playing || reduceMotion) return
		shift.setValue(0)
		const loop = Animated.loop(
			Animated.timing(shift, {
				toValue: -WAVE_PERIOD,
				duration: STEADY_LOOP_MS,
				easing: Easing.linear,
				useNativeDriver: true,
				isInteraction: false,
			}),
		)
		loop.start()
		return () => loop.stop()
	}, [playing, reduceMotion, shift])

	const value = drag ?? progress
	const bar = (
		<View
			{...(gesture ? { collapsable: false } : pan.panHandlers)}
			accessibilityRole="adjustable"
			accessibilityLabel="Song progress"
			accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}
			accessibilityActions={[
				{ name: 'increment', label: 'Forward ten percent' },
				{ name: 'decrement', label: 'Back ten percent' },
			]}
			onAccessibilityAction={e =>
				onSeek(
					Math.max(
						0,
						Math.min(
							1,
							progress +
								(e.nativeEvent.actionName === 'increment' ? 0.1 : -0.1),
						),
					),
				)
			}
			onLayout={e => setWidth(Math.max(1, e.nativeEvent.layout.width))}
			style={styles.hit}
		>
			<View pointerEvents="none" style={styles.lane}>
				<View style={styles.track} />
				<View
					style={[
						styles.clip,
						{ width: Math.max(0, Math.min(width, width * value)) },
					]}
				>
					<AnimatedView
						style={[
							styles.tile,
							{ width: tileWidth, transform: [{ translateX: shift }] },
						]}
					>
						{columns.map(column => (
							<View key={column.left} style={[styles.column, column]} />
						))}
					</AnimatedView>
				</View>
			</View>
			<View
				pointerEvents="none"
				style={[
					styles.knob,
					{ left: Math.max(0, Math.min(width - 12, value * width - 6)) },
				]}
			/>
		</View>
	)
	return gesture && handler ? (
		<handler.GestureDetector gesture={gesture}>{bar}</handler.GestureDetector>
	) : (
		bar
	)
}

function StraightBar({ progress, disabled, onPreview, onSeek }: SeekProps) {
	return (
		<Design.Slider
			step={0.001}
			minimumValue={0}
			maximumValue={1}
			value={progress}
			onSlidingStart={() => !disabled && onPreview(progress)}
			onValueChange={value => !disabled && onPreview(value)}
			onSlidingComplete={value => {
				onPreview(null)
				if (!disabled) onSeek(value)
			}}
		/>
	)
}

function ControlButton({
	id,
	playback,
	busy,
}: {
	id: ButtonId
	playback: Playback
	busy: boolean
}) {
	const styles = useControlStyles()
	const mode = playback.repeat
	const spec = {
		Shuffle: {
			names: Icons.Shuffle,
			label: playback.shuffle ? 'Shuffle on' : 'Shuffle off',
			active: playback.shuffle,
			press: () => control('shuffle'),
		},
		Previous: {
			names: Icons.Previous,
			label: 'Previous',
			active: false,
			press: () => control('previous'),
		},
		Play: {
			names: playback.playing ? Icons.Pause : Icons.Play,
			label: playback.playing ? 'Pause' : 'Play',
			active: true,
			press: () => control(playback.playing ? 'pause' : 'play'),
		},
		Next: {
			names: Icons.Next,
			label: 'Next',
			active: false,
			press: () => control('next'),
		},
		Repeat: {
			names: Icons.Repeat,
			label:
				mode === 'track'
					? 'Repeat one'
					: mode === 'context'
						? 'Repeat all'
						: 'Repeat off',
			active: mode !== 'off',
			press: () => control('repeat'),
		},
		Search: {
			names: Icons.Search,
			label: 'Search songs',
			active: false,
			press: openSearch,
		},
	}[id]

	const icon = iconId(...spec.names)
	if (!icon)
		return (
			<Design.Button
				text={spec.label}
				size="sm"
				variant="secondary"
				disabled={busy && id !== 'Search'}
				onPress={spec.press}
			/>
		)

	return (
		<View style={styles.slot}>
			<Design.IconButton
				icon={icon}
				size="md"
				variant={spec.active ? 'primary' : 'tertiary'}
				accessibilityLabel={spec.label}
				accessibilityState={{ selected: spec.active }}
				disabled={busy && id !== 'Search'}
				onPress={spec.press}
			/>
			{id === 'Repeat' && mode === 'track' && (
				<View pointerEvents="none" style={styles.badge}>
					<Design.Text variant="text-xxs/semibold" color="text-default">
						1
					</Design.Text>
				</View>
			)}
		</View>
	)
}

/**
 * Player content (no surface): the dock supplies the card, handle and gestures.
 * Also used standalone, inside a Card, for the settings preview.
 */
/** Opens the search sheet; the only control shown while nothing is playing. */
function SearchButton() {
	const icon = iconId(...Icons.Search)
	return icon ? (
		<Design.IconButton
			icon={icon}
			size="sm"
			variant="secondary"
			accessibilityLabel="Search songs"
			onPress={openSearch}
		/>
	) : (
		<Design.Button
			text="Search"
			size="sm"
			variant="secondary"
			onPress={openSearch}
		/>
	)
}

export function PlayerBody({
	mode,
	preview = false,
}: {
	mode: PlayerMode
	preview?: boolean
}) {
	const spotify = useSpotify()
	const settings = useSettings()
	const styles = usePlayerStyles()
	const appActive = useAppActive()
	const compact = mode === 'compact'
	const playback = spotify.playback ?? (preview ? SAMPLE : null)
	const [dragFraction, setDragFraction] = useState<number | null>(null)
	const [, tick] = useState(0)
	// Preview in settings: never animate or tick.
	const playingNow = !!playback?.playing && appActive && !preview
	useEffect(() => {
		if (!playingNow) return
		const timer = setInterval(() => tick(n => n + 1), 1000)
		return () => clearInterval(timer)
	}, [playingNow])
	// A new song resets any half-finished scrub.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on the song id
	useEffect(() => setDragFraction(null), [playback?.id])

	if (!playback && !preview && settings.alwaysShow)
		return (
			<View style={styles.body}>
				<View style={styles.row}>
					<View style={styles.titles}>
						<Design.Text
							variant="text-md/semibold"
							color="text-muted"
							numberOfLines={1}
						>
							Nothing playing
						</Design.Text>
					</View>
					<View style={styles.controls}>
						<SearchButton />
					</View>
				</View>
			</View>
		)

	if (!playback)
		return preview ? (
			<Design.Stack spacing={0}>
				<Design.Text variant="text-sm/medium" color="text-muted">
					{spotify.status}
				</Design.Text>
			</Design.Stack>
		) : null

	const position =
		dragFraction === null
			? positionOf(playback)
			: dragFraction * playback.duration
	const progress = playback.duration ? position / playback.duration : 0
	const openTrack = () =>
		Linking.openURL(
			`https://open.spotify.com/track/${encodeURIComponent(playback.id)}`,
		).catch(() => {})
	const buttons = (
		['Shuffle', 'Previous', 'Play', 'Next', 'Repeat', 'Search'] as const
	).filter(id => settings[`${mode}${id}` as keyof Settings])
	const controls = buttons.map(id => (
		<ControlButton key={id} id={id} playback={playback} busy={spotify.busy} />
	))
	const seekProps: SeekProps = {
		progress,
		duration: playback.duration,
		disabled: spotify.busy || preview,
		onPreview: setDragFraction,
		onSeek: fraction => control('seek', fraction * playback.duration),
	}

	return (
		<View
			pointerEvents={preview ? 'none' : 'auto'}
			accessibilityElementsHidden={preview}
			importantForAccessibility={preview ? 'no-hide-descendants' : 'auto'}
			style={styles.body}
		>
			<Design.Stack spacing={compact ? 0 : 10}>
				<View style={styles.row}>
					<Pressable
						accessibilityRole={compact ? 'button' : 'link'}
						accessibilityLabel={
							compact
								? 'Expand Spotify Controls'
								: `Open ${playback.title} in Spotify`
						}
						onPress={compact ? () => setDockMode('expanded') : openTrack}
						onLongPress={openTrack}
						style={styles.info}
					>
						{playback.artwork ? (
							<Image
								source={{ uri: playback.artwork }}
								style={compact ? styles.artCompact : styles.art}
							/>
						) : null}
						<View style={styles.titles}>
							<Design.Text
								variant="text-md/semibold"
								color="text-strong"
								numberOfLines={1}
							>
								{playback.title}
							</Design.Text>
							{!compact && (
								<Design.Text
									variant="text-sm/medium"
									color="text-muted"
									numberOfLines={1}
								>
									{playback.artist}
								</Design.Text>
							)}
						</View>
					</Pressable>
					{compact && controls.length > 0 && (
						<View style={styles.controls}>{controls}</View>
					)}
				</View>
				{!compact && (
					<>
						<View>
							{settings.animatedWave ? (
								<WaveBar {...seekProps} playing={playingNow} />
							) : (
								<StraightBar {...seekProps} />
							)}
							<Design.Stack
								direction="horizontal"
								justify="space-between"
								style={styles.times}
							>
								<Design.Text variant="text-xs/medium" color="text-muted">
									{formatTime(position)}
								</Design.Text>
								<Design.Text variant="text-xs/medium" color="text-muted">
									{formatTime(playback.duration)}
								</Design.Text>
							</Design.Stack>
						</View>
						{controls.length > 0 && (
							<Design.Stack
								direction="horizontal"
								align="center"
								justify="space-between"
							>
								{controls}
							</Design.Stack>
						)}
					</>
				)}
			</Design.Stack>
		</View>
	)
}

/** Settings preview: the same content on a plain card. */
export function Player({ previewMode }: { previewMode: PlayerMode }) {
	return (
		<Design.Card
			variant="primary"
			border="none"
			shadow="none"
			style={{ borderRadius: 16, overflow: 'hidden' }}
		>
			<PlayerBody mode={previewMode} preview />
		</Design.Card>
	)
}

const usePlayerStyles = lazyStyles(() =>
	Design.createStyles({
		body: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 8 },
		// custom: the title must take the space the controls leave, which Stack does not do
		row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
		controls: { flexDirection: 'row', alignItems: 'center' },
		info: {
			flex: 1,
			minWidth: 0,
			flexDirection: 'row',
			alignItems: 'center',
			gap: 12,
		},
		titles: { flex: 1, minWidth: 0 },
		art: { width: 48, height: 48, borderRadius: 8 },
		artCompact: { width: 32, height: 32, borderRadius: 16 },
		times: { marginTop: -4 },
	}),
)

const useControlStyles = lazyStyles(() =>
	Design.createStyles({
		slot: {
			width: 44,
			height: 44,
			alignItems: 'center',
			justifyContent: 'center',
		},
		badge: {
			position: 'absolute',
			top: 15,
			left: 18,
			width: 8,
			height: 12,
			alignItems: 'center',
			justifyContent: 'center',
		},
	}),
)

const useWaveStyles = lazyStyles(() =>
	Design.createStyles({
		hit: { height: 32, justifyContent: 'center', overflow: 'hidden' },
		lane: { height: WAVE_HEIGHT, overflow: 'hidden' },
		track: {
			position: 'absolute',
			top: 8,
			left: 0,
			right: 0,
			height: 2,
			borderRadius: 1,
			backgroundColor: Tokens.default.colors.INTERACTIVE_MUTED,
		},
		clip: {
			position: 'absolute',
			top: 0,
			left: 0,
			height: WAVE_HEIGHT,
			overflow: 'hidden',
		},
		tile: { height: WAVE_HEIGHT },
		column: {
			position: 'absolute',
			width: COLUMN_STEP + 1,
			borderRadius: 1,
			backgroundColor: Tokens.default.colors.TEXT_LINK,
		},
		knob: {
			position: 'absolute',
			top: 10,
			width: 12,
			height: 12,
			borderRadius: 6,
			backgroundColor: Tokens.default.colors.TEXT_LINK,
		},
	}),
)

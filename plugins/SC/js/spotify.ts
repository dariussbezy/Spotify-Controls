import { getStore, onFluxEventDispatched } from '@valenced/discord/flux'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { useSyncExternalStore } from 'react'
import { AppState } from 'react-native'

export type Repeat = 'off' | 'track' | 'context'
export type ControlAction =
	| 'play'
	| 'pause'
	| 'next'
	| 'previous'
	| 'seek'
	| 'shuffle'
	| 'repeat'
export type SearchAction = 'now' | 'next' | 'queue'
export type SearchOutcome = 'played' | 'queued'

export interface Playback {
	id: string
	uri: string
	title: string
	artist: string
	artwork: string | null
	duration: number
	position: number
	updatedAt: number
	playing: boolean
	shuffle: boolean
	repeat: Repeat
	deviceId: string | null
}

export interface SearchTrack {
	id: string
	uri: string
	title: string
	artist: string
	artwork: string | null
}

export interface SpotifyState {
	playback: Playback | null
	status: string
	busy: boolean
	connected: boolean
	/** The player was swiped away for this music session. */
	dismissed: boolean
}

interface Credentials {
	accountId: string
	accessToken: string
}

// Loose shapes of Discord's own Spotify modules, which are not part of the public typings.
interface SpotifySocketStore {
	getActiveSocketAndDevice?(): {
		socket?: { accountId?: string; accessToken?: string }
	} | null
}
interface ConnectedAccountsStore {
	getAccounts?(): unknown
}
interface SpotifyApiModule {
	SpotifyAPI?: unknown
	getDevices?: unknown
	getAccessToken?(accountId: string): Promise<unknown>
}

type Raw = any

const API = 'https://api.spotify.com/v1'
const PLAYER = `${API}/me/player`
const IDLE_HIDE_MS = 5 * 60 * 1000
const POLL_MS = 15_000
const REQUEST_TIMEOUT_MS = 12_000
// Spotify caps the `uris` array of the play endpoint at 100 entries.
const NEXT_REPEAT: Record<Repeat, Repeat> = {
	off: 'context',
	context: 'track',
	track: 'off',
}

const listeners = new Set<() => void>()
let state: SpotifyState = {
	playback: null,
	status: 'Connecting to Discord’s Spotify session…',
	busy: false,
	connected: false,
	dismissed: false,
}

let running = false
/** Bumped on every start/stop/logout so late async results are dropped. */
let epoch = 0
/** Bumped on every state change that makes an in-flight poll stale. */
let generation = 0
let pollInFlight: Promise<void> | null = null
let connectInFlight: Promise<void> | null = null
let pausedSince = 0
let optimistic: {
	id: string
	until: number
	shuffle?: boolean
	repeat?: Repeat
} | null = null
let fallbackCredentials: Credentials | null = null
let socketStore: SpotifySocketStore | null = null
let accountsStore: ConnectedAccountsStore | null = null
let apiModule: SpotifyApiModule | null = null
const timers = new Set<ReturnType<typeof setTimeout>>()
const controllers = new Set<AbortController>()

function setState(patch: Partial<SpotifyState>) {
	if ('playback' in patch) {
		const next = patch.playback
		if (!next) {
			patch.dismissed = false
			pausedSince = 0
			optimistic = null
		} else if (next.playing) {
			// A new listening session after a long pause shows the player again.
			if (pausedSince && Date.now() - pausedSince >= IDLE_HIDE_MS)
				patch.dismissed = false
			pausedSince = 0
		} else if (!pausedSince) pausedSince = Date.now()
	}
	state = { ...state, ...patch }
	for (const listener of listeners) listener()
}

export const getState = () => state

export function subscribe(listener: () => void) {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

export function useSpotify() {
	return useSyncExternalStore(subscribe, getState)
}

export function dismissPlayer() {
	if (state.playback) setState({ dismissed: true })
}

export function restorePlayer() {
	setState({ dismissed: false })
}

/** Playback position now, extrapolated from the last known position. */
export function positionOf(p: Playback, now = Date.now()) {
	const elapsed = p.playing ? Math.max(0, now - p.updatedAt) : 0
	return clamp(p.position + elapsed, p.duration)
}

export function formatTime(ms: number) {
	const total = Math.max(0, Math.floor(ms / 1000))
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function clamp(value: number, max: number) {
	return Math.max(0, Math.min(max, Number.isFinite(value) ? value : 0))
}

/** Normalizes both the Web API payload and Discord's `SPOTIFY_PLAYER_STATE` event. */
function toPlayback(raw: Raw, now = Date.now()): Playback | null {
	const item = raw?.item ?? raw?.track
	if (!item?.id) return null
	const repeat: unknown =
		raw.repeat_state ??
		raw.actual_repeat ??
		(typeof raw.repeat === 'string' ? raw.repeat : 'off')
	const duration = Math.max(0, Number(item.duration_ms ?? item.duration) || 0)
	return {
		id: String(item.id),
		uri: String(item.uri ?? `spotify:track:${item.id}`),
		title: String(item.name || 'Unknown track'),
		artist:
			(item.artists ?? [])
				.map((a: Raw) => a.name)
				.filter(Boolean)
				.join(', ') || 'Unknown artist',
		artwork: item.album?.images?.[0]?.url ?? item.album?.image?.url ?? null,
		duration,
		position: clamp(Number(raw.progress_ms ?? raw.position) || 0, duration),
		updatedAt: now,
		playing: !!(raw.is_playing ?? raw.isPlaying),
		shuffle: !!(raw.shuffle_state ?? raw.shuffle),
		repeat: repeat === 'track' || repeat === 'context' ? repeat : 'off',
		deviceId: raw.device?.id ?? null,
	}
}

/** Spotify applies shuffle/repeat late; keep the optimistic value for a few seconds. */
function withOptimistic(p: Playback | null): Playback | null {
	if (
		!p ||
		!optimistic ||
		p.id !== optimistic.id ||
		Date.now() >= optimistic.until
	) {
		optimistic = null
		return p
	}
	return {
		...p,
		...(optimistic.shuffle === undefined
			? {}
			: { shuffle: optimistic.shuffle }),
		...(optimistic.repeat ? { repeat: optimistic.repeat } : {}),
	}
}

function credentials(): Credentials | null {
	try {
		const socket = socketStore?.getActiveSocketAndDevice?.()?.socket
		if (socket?.accessToken && socket.accountId)
			return { accountId: socket.accountId, accessToken: socket.accessToken }
	} catch {}
	return fallbackCredentials
}

function describeRequest(url: string, method: string) {
	if (url.includes('/search?')) return 'searching the Spotify catalog'
	if (url.includes('/player/play?')) return 'starting playback'
	if (url.includes('/player/queue')) return 'reading or changing the queue'
	return method === 'GET'
		? 'reading playback and the active device'
		: 'changing playback'
}

async function errorReason(response: Response) {
	try {
		const text = await response.text()
		if (text.length > 8192) return ''
		const error = JSON.parse(text)?.error
		const reason = `${error?.reason ?? ''} ${error?.message ?? ''}`
		if (/insufficient.*scope|missing.*scope/i.test(reason))
			return 'missing Spotify permission/scope'
		if (/premium.*required|premium_required/i.test(reason))
			return 'Spotify reports Premium is required'
		if (/restriction|restricted|not.allowed/i.test(reason))
			return 'Spotify playback restriction'
		if (/market|territory|unavailable/i.test(reason))
			return 'track unavailable for this account or region'
	} catch {}
	return ''
}

function errorMessage(status: number, what: string, reason: string) {
	if (status === 401)
		return 'Spotify session expired. Tap Reconnect in settings.'
	if (status === 403)
		return `Spotify denied ${what} (403${reason ? `: ${reason}` : '; reason not specified'}).`
	if (status === 404) return 'Start a song on a Spotify device, then refresh.'
	if (status === 429)
		return 'Spotify is limiting requests. Wait a moment before trying again.'
	return `Spotify failed while ${what} (${status}).`
}

async function request(
	url: string,
	method: 'GET' | 'POST' | 'PUT' = 'GET',
	body?: object,
	signal?: AbortSignal,
): Promise<Raw> {
	if (!running) throw new Error('Spotify Controls is stopped')
	const creds = credentials()
	if (!creds)
		throw new Error(
			'Connect Spotify under Discord’s Connections, then tap Reconnect.',
		)

	const controller = new AbortController()
	controllers.add(controller)
	const abort = () => controller.abort()
	signal?.addEventListener('abort', abort)
	if (signal?.aborted) controller.abort()
	const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS)

	try {
		const response = await fetch(url, {
			method,
			headers: {
				Authorization: `Bearer ${creds.accessToken}`,
				Accept: 'application/json',
				...(body ? { 'Content-Type': 'application/json' } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
			signal: controller.signal,
		})
		if (!response.ok)
			throw new Error(
				errorMessage(
					response.status,
					describeRequest(url, method),
					await errorReason(response),
				),
			)
		if (method !== 'GET' || response.status === 204 || response.status === 202)
			return null
		const text = (await response.text()).trim()
		if (!text) return null
		try {
			return JSON.parse(text)
		} catch {
			throw new Error(
				'Spotify returned an unreadable playback response. Try Refresh in settings.',
			)
		}
	} finally {
		clearTimeout(timeout)
		controllers.delete(controller)
		signal?.removeEventListener('abort', abort)
	}
}

function clearTimers() {
	for (const timer of timers) clearTimeout(timer)
	timers.clear()
}

/** Re-reads playback shortly after a control, because Spotify reports changes late. */
function scheduleBurstRefresh() {
	clearTimers()
	for (const delay of [800, 4400]) {
		const timer = setTimeout(() => {
			timers.delete(timer)
			if (running && !state.busy) refresh()
		}, delay)
		timers.add(timer)
	}
}

export function refresh(): Promise<void> {
	if (!running || AppState.currentState !== 'active') return Promise.resolve()
	if (pollInFlight) return pollInFlight
	const startEpoch = epoch
	const startGeneration = ++generation
	const current = () =>
		running && startEpoch === epoch && startGeneration === generation

	pollInFlight = (async () => {
		try {
			const raw = await request(PLAYER)
			if (!current()) return
			const playback = withOptimistic(
				raw?.device?.is_active === false ? null : toPlayback(raw),
			)
			setState({
				playback,
				connected: true,
				status: playback
					? 'Connected to Spotify'
					: 'Start a song in Spotify to show the player.',
			})
		} catch (error) {
			if (current())
				setState({
					status:
						error instanceof Error
							? error.message
							: 'Could not connect to Spotify.',
				})
		} finally {
			if (startEpoch === epoch && startGeneration === generation)
				pollInFlight = null
		}
	})()
	return pollInFlight
}

/** Asks Discord's Spotify module for a fresh access token, then reads playback. */
export function reconnect(force = true): Promise<void> {
	if (!running || connectInFlight) return connectInFlight ?? Promise.resolve()
	const startEpoch = epoch
	connectInFlight = (async () => {
		await Promise.resolve()
		try {
			const accounts = accountsStore?.getAccounts?.() ?? []
			const list = (
				Array.isArray(accounts) ? accounts : Object.values(accounts as object)
			) as Raw[]
			const accountId =
				list.find(account => account.type === 'spotify')?.id ??
				credentials()?.accountId
			if (accountId && apiModule?.getAccessToken && (force || !credentials())) {
				setState({
					status: 'Connecting to the Spotify account linked to Discord…',
				})
				await apiModule.getAccessToken(accountId)
				if (running && startEpoch === epoch) await refresh()
			} else if (credentials()) await refresh()
			else
				setState({
					status:
						!apiModule || !accountsStore
							? 'Waiting for Discord’s Spotify modules…'
							: 'Connect Spotify in Discord → Connections first.',
				})
		} catch {
			if (running && startEpoch === epoch)
				setState({
					status: 'Could not refresh the Discord Spotify connection.',
				})
		} finally {
			if (startEpoch === epoch) connectInFlight = null
		}
	})()
	return connectInFlight
}

export async function control(action: ControlAction, seekMs?: number) {
	const { playback } = state
	if (!running || state.busy || !playback) return
	if (!playback.deviceId) {
		setState({ status: 'Start playback on a Spotify device first.' })
		return
	}

	const startEpoch = epoch
	generation++
	pollInFlight = null
	clearTimers()
	setState({ busy: true })
	try {
		const query = [`device_id=${encodeURIComponent(playback.deviceId)}`]
		if (action === 'seek')
			query.push(
				`position_ms=${Math.round(clamp(seekMs ?? 0, playback.duration))}`,
			)
		else if (action === 'shuffle') query.push(`state=${!playback.shuffle}`)
		else if (action === 'repeat')
			query.push(`state=${NEXT_REPEAT[playback.repeat]}`)
		await request(
			`${PLAYER}/${action}?${query.join('&')}`,
			action === 'next' || action === 'previous' ? 'POST' : 'PUT',
		)
		if (!running || startEpoch !== epoch) return

		generation++
		pollInFlight = null
		const live = state.playback
		if (live?.id === playback.id) {
			if (action === 'pause' || action === 'play')
				setState({
					playback: {
						...live,
						playing: action === 'play',
						position: positionOf(playback),
						updatedAt: Date.now(),
					},
				})
			if (action === 'seek')
				setState({
					playback: {
						...live,
						position: clamp(seekMs ?? 0, playback.duration),
						updatedAt: Date.now(),
					},
				})
			if (action === 'shuffle' || action === 'repeat') {
				optimistic = {
					...(optimistic?.id === playback.id ? optimistic : {}),
					id: playback.id,
					until: Date.now() + 4000,
					...(action === 'shuffle'
						? { shuffle: !playback.shuffle }
						: { repeat: NEXT_REPEAT[playback.repeat] }),
				}
				setState({ playback: withOptimistic(live) })
			}
		}
		await refresh()
		if (running && startEpoch === epoch) scheduleBurstRefresh()
	} catch (error) {
		if (running && startEpoch === epoch)
			setState({
				status:
					error instanceof Error ? error.message : 'Spotify control failed.',
			})
	} finally {
		if (running && startEpoch === epoch) setState({ busy: false })
	}
}

export async function searchTracks(
	query: string,
	signal?: AbortSignal,
): Promise<SearchTrack[]> {
	if (!query.trim()) return []
	const startEpoch = epoch
	const raw = await request(
		`${API}/search?type=track&limit=10&q=${encodeURIComponent(query.trim().slice(0, 200))}`,
		'GET',
		undefined,
		signal,
	)
	if (!running || startEpoch !== epoch || signal?.aborted) return []
	const results: SearchTrack[] = []
	for (const item of raw?.tracks?.items ?? []) {
		if (!item?.id || item.is_playable === false || item.is_local) continue
		results.push({
			id: String(item.id),
			uri: String(item.uri ?? `spotify:track:${item.id}`),
			title: String(item.name || 'Unknown track'),
			artist:
				(item.artists ?? [])
					.map((a: Raw) => a.name)
					.filter(Boolean)
					.join(', ') || 'Unknown artist',
			artwork: item.album?.images?.[0]?.url ?? null,
		})
	}
	return results
}

const isTrackUri = (uri: unknown): uri is string =>
	typeof uri === 'string' && /^spotify:track:[A-Za-z0-9]{22}$/.test(uri)

/**
 * Plays or queues a search result without touching the rest of the queue.
 *
 * Spotify Web API facts this relies on:
 * - `PUT /me/player/play` with `uris` REPLACES the playback context: the album or playlist is
 *   dropped and Spotify stops after the song, so it is only used when nothing is playing.
 * - `POST /me/player/queue` appends to the user queue, which plays before the rest of the
 *   album or playlist, and leaves everything else as it is.
 * - `POST /me/player/next` skips to the next item.
 * - Discord's Spotify token cannot read the queue (HTTP 403), so the queue is never read.
 *
 * Behaviour:
 * - `queue` and `next`: add the song to the queue. It plays after what is already queued.
 * - `now`: add the song to the queue, then skip to it. Songs that were already in the user
 *   queue play before it, and the album or playlist continues afterwards.
 * - Nothing playing: the song is started on the first available device.
 */
export async function playSearchResult(
	track: SearchTrack,
	action: SearchAction,
): Promise<SearchOutcome> {
	if (!running || state.busy || !/^[A-Za-z0-9]{22}$/.test(track.id))
		throw new Error('Spotify is busy. Try again in a moment.')
	if (!isTrackUri(track.uri)) throw new Error('This item cannot be played.')

	const startEpoch = epoch
	generation++
	pollInFlight = null
	clearTimers()
	setState({ busy: true })
	const stale = () => !running || startEpoch !== epoch

	try {
		const player = await request(PLAYER)
		if (stale()) throw new Error('Spotify Controls was stopped.')
		const active = player?.device?.is_active !== false && !!player?.device?.id
		let deviceId: string | null = active ? player.device.id : null
		let idle = !player?.item
		if (!deviceId) {
			// Nothing is active: start on any device Spotify knows about.
			const devices = await request(`${PLAYER}/devices`)
			const list = ((devices?.devices ?? []) as Raw[]).filter(
				device => device?.id && !device.is_restricted,
			)
			deviceId = list[0]?.id ?? null
			idle = true
		}
		if (!deviceId)
			throw new Error('Open Spotify on a device first, then try again.')
		const device = `device_id=${encodeURIComponent(deviceId)}`

		let outcome: SearchOutcome
		if (idle && action !== 'queue') {
			await request(`${PLAYER}/play?${device}`, 'PUT', { uris: [track.uri] })
			outcome = 'played'
		} else {
			await request(
				`${PLAYER}/queue?uri=${encodeURIComponent(track.uri)}&${device}`,
				'POST',
			)
			outcome = 'queued'
			if (action === 'now') {
				// Spotify needs a moment to register the queued song before it can be skipped to.
				await new Promise(resolve => setTimeout(resolve, 350))
				if (stale()) throw new Error('Spotify Controls was stopped.')
				await request(`${PLAYER}/next?${device}`, 'POST')
				outcome = 'played'
			}
		}
		if (stale()) throw new Error('Spotify Controls was stopped.')

		// Spotify reports the new state late: poll until the played track shows up.
		generation++
		pollInFlight = null
		const waitForTrack = outcome === 'played'
		for (const delay of waitForTrack ? [0, 400, 800, 1200] : [600]) {
			if (delay) await new Promise(resolve => setTimeout(resolve, delay))
			if (stale()) break
			await refresh()
			if (!waitForTrack) break
			if (state.playback?.id === track.id && state.playback.playing)
				return outcome
		}
		if (waitForTrack && !stale())
			setState({
				status:
					'Spotify has not confirmed the selected song. If another song from your queue is playing, it was queued before this one.',
			})
		return outcome
	} finally {
		if (!stale()) setState({ busy: false })
	}
}

/** Starts the Spotify session. The returned function stops it and drops all state. */
export function startSpotify(): () => void {
	running = true
	epoch++
	const undo: (() => void)[] = []

	undo.push(
		getStore<SpotifySocketStore>('SpotifyStore', store => {
			socketStore = store as unknown as SpotifySocketStore
			reconnect(false)
		}),
		getStore<ConnectedAccountsStore>('ConnectedAccountsStore', store => {
			accountsStore = store as unknown as ConnectedAccountsStore
			reconnect(false)
		}),
		getModules(
			withProps<SpotifyApiModule>('SpotifyAPI', 'getAccessToken', 'getDevices'),
			module => {
				apiModule = module
				reconnect(false)
			},
		),
		onFluxEventDispatched('SPOTIFY_ACCOUNT_ACCESS_TOKEN', (event: Raw) => {
			if (event.accountId && event.accessToken)
				fallbackCredentials = {
					accountId: event.accountId,
					accessToken: event.accessToken,
				}
			Promise.resolve().then(() => {
				if (running) refresh()
			})
			return event
		}),
		onFluxEventDispatched('SPOTIFY_PLAYER_STATE', (event: Raw) => {
			if (event.accountId === credentials()?.accountId) {
				generation++
				pollInFlight = null
				const playback = withOptimistic(
					event.device?.is_active === false
						? null
						: toPlayback({
								...event,
								shuffle: event.shuffle ?? state.playback?.shuffle,
								actual_repeat: event.actual_repeat ?? state.playback?.repeat,
							}),
				)
				setState({
					playback: playback
						? {
								...playback,
								deviceId: playback.deviceId ?? state.playback?.deviceId ?? null,
							}
						: null,
					connected: true,
					status: playback
						? 'Connected to Spotify'
						: 'Start a song in Spotify to show the player.',
				})
			}
			return event
		}),
	)

	for (const type of ['LOGOUT', 'SPOTIFY_ACCOUNT_ACCESS_TOKEN_REVOKED'])
		undo.push(
			onFluxEventDispatched(type, (event: Raw) => {
				epoch++
				generation++
				pollInFlight = connectInFlight = null
				clearTimers()
				for (const controller of controllers) controller.abort()
				controllers.clear()
				fallbackCredentials = null
				setState({
					playback: null,
					connected: false,
					busy: false,
					status: 'Spotify disconnected. Tap Reconnect in settings.',
				})
				return event
			}),
		)

	const appState = AppState.addEventListener('change', next => {
		if (next === 'active') reconnect(false)
	})
	undo.push(() => appState.remove())

	const poll = setInterval(() => {
		if (!state.busy) refresh()
	}, POLL_MS)
	undo.push(() => clearInterval(poll))

	return () => {
		running = false
		epoch++
		for (const fn of undo.reverse()) fn()
		clearTimers()
		for (const controller of controllers) controller.abort()
		controllers.clear()
		fallbackCredentials = null
		socketStore = accountsStore = apiModule = null
		pollInFlight = connectInFlight = null
		setState({
			playback: null,
			connected: false,
			busy: false,
			status: 'Spotify Controls is stopped.',
		})
	}
}

import type { JsonStorage } from '@valenced/json-storage'

export interface Settings {
	compact: boolean
	closed: boolean
	alwaysShow: boolean
	animatedWave: boolean
	expandedShuffle: boolean
	expandedPrevious: boolean
	expandedPlay: boolean
	expandedNext: boolean
	expandedRepeat: boolean
	expandedSearch: boolean
	compactShuffle: boolean
	compactPrevious: boolean
	compactPlay: boolean
	compactNext: boolean
	compactRepeat: boolean
	compactSearch: boolean
}

export const DefaultSettings: Settings = {
	compact: false,
	closed: false,
	alwaysShow: false,
	animatedWave: true,
	expandedShuffle: true,
	expandedPrevious: true,
	expandedPlay: true,
	expandedNext: true,
	expandedRepeat: true,
	expandedSearch: true,
	compactShuffle: false,
	compactPrevious: true,
	compactPlay: true,
	compactNext: true,
	compactRepeat: false,
	compactSearch: false,
}

export type ButtonId =
	| 'Shuffle'
	| 'Previous'
	| 'Play'
	| 'Next'
	| 'Repeat'
	| 'Search'

export const ButtonIds: ButtonId[] = [
	'Shuffle',
	'Previous',
	'Play',
	'Next',
	'Repeat',
	'Search',
]

export type PlayerMode = 'expanded' | 'compact'
export type DockMode = 'closed' | 'collapsed' | 'expanded'

export const dockModeOf = (settings: Settings): DockMode =>
	settings.closed ? 'closed' : settings.compact ? 'collapsed' : 'expanded'

let storage: JsonStorage<Settings> | undefined

export function setStorage(next: JsonStorage<Settings> | undefined) {
	storage = next
}

/** Keeps only known boolean keys, so a corrupted storage file cannot break the player. */
function normalize(raw: Record<string, unknown> | undefined): Settings {
	const settings = { ...DefaultSettings }
	if (!raw) return settings
	for (const key of Object.keys(DefaultSettings) as (keyof Settings)[]) {
		const value = raw[key]
		if (typeof value === 'boolean') settings[key] = value
	}
	// Migrate the beta flag that was replaced by `animatedWave`
	if (raw.waveShape === false && typeof raw.animatedWave !== 'boolean')
		settings.animatedWave = false
	return settings
}

/** React hook: current settings, re-renders when they change. */
export function useSettings(): Settings {
	return normalize(storage?.use() as Record<string, unknown> | undefined)
}

export function setSetting<K extends keyof Settings>(
	key: K,
	value: Settings[K],
) {
	storage?.set({ [key]: value }).catch(() => {})
}

export function setDockMode(mode: DockMode) {
	storage
		?.set({ closed: mode === 'closed', compact: mode !== 'expanded' })
		.catch(() => {})
}

/** Discord's design API only exists after init, so styles are created on first use rather than at import. */
export function lazyStyles<T>(create: () => () => T) {
	let hook: (() => T) | undefined
	return () => (hook ??= create())()
}

import { getAssetIdByName } from '@valenced/assets'

/** First asset id that exists, so a renamed icon degrades instead of crashing. */
export function iconId(...names: string[]) {
	for (const name of names) {
		const id = getAssetIdByName(name)
		if (id) return id
	}
	return undefined
}

export const Icons = {
	Shuffle: ['ShuffleIcon', 'ArrowsLeftRightIcon'],
	Previous: ['SkipBackwardIcon', 'SkipBackIcon', 'ArrowSmallLeftIcon'],
	Play: ['PlayIcon', 'MediaPlayIcon'],
	Pause: ['PauseIcon', 'MediaPauseIcon'],
	Next: ['SkipForwardIcon', 'SkipNextIcon', 'ArrowSmallRightIcon'],
	Repeat: ['RepeatIcon', 'LoopIcon', 'RefreshIcon'],
	Search: ['MagnifyingGlassIcon'],
	More: ['MoreHorizontalIcon', 'MoreVerticalIcon'],
} as const

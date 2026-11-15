import { ActionSheetActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { BottomSheet } from '@valenced/externals/gorhom'
import { useEffect, useState } from 'react'
import { Image, useWindowDimensions, View } from 'react-native'
import { iconId } from './icons'
import { lazyStyles } from './shared'
import { playSearchResult, searchTracks, useSpotify } from './spotify'
import type { SearchAction, SearchTrack } from './spotify'

const KEY = 'dariuss.spotify.search'
const IDLE_HINT = 'Search by song or artist.'
const RESULT_HINT =
	'Tap a song to play it now. Use the buttons to play it next or add it to the queue.'

function ResultAction({
	names,
	text,
	label,
	disabled,
	onPress,
}: {
	names: string[]
	text: string
	label: string
	disabled: boolean
	onPress(): void
}) {
	const icon = iconId(...names)
	return icon ? (
		<Design.IconButton
			icon={icon}
			size="sm"
			variant="tertiary"
			accessibilityLabel={label}
			disabled={disabled}
			onPress={onPress}
		/>
	) : (
		<Design.Button
			text={text}
			size="sm"
			variant="secondary"
			disabled={disabled}
			onPress={onPress}
		/>
	)
}

function SearchSheet() {
	const styles = useStyles()
	const spotify = useSpotify()
	const { height } = useWindowDimensions()
	const [query, setQuery] = useState('')
	const [results, setResults] = useState<SearchTrack[]>([])
	const [hint, setHint] = useState(IDLE_HINT)

	useEffect(() => {
		setResults([])
		if (!query.trim()) {
			setHint(IDLE_HINT)
			return
		}
		setHint('Searching…')
		const controller = new AbortController()
		let alive = true
		const timer = setTimeout(() => {
			searchTracks(query, controller.signal)
				.then(found => {
					if (!alive) return
					setResults(found)
					setHint(found.length ? RESULT_HINT : 'No songs found.')
				})
				.catch(error => {
					if (alive)
						setHint(
							error instanceof Error
								? error.message
								: 'Could not search Spotify.',
						)
				})
		}, 400)
		return () => {
			alive = false
			clearTimeout(timer)
			controller.abort()
		}
	}, [query])

	const act = (track: SearchTrack, action: SearchAction) => {
		playSearchResult(track, action)
			.then(outcome => {
				if (outcome === 'played') ActionSheetActionCreators.hideActionSheet(KEY)
				else setHint(`Added "${track.title}" to your queue.`)
			})
			.catch(error =>
				setHint(
					error instanceof Error ? error.message : 'Could not play this song.',
				),
			)
	}

	return (
		<Design.ActionSheet
			startExpanded
			scrollable
			startHeight={Math.round(height * 0.8)}
			maxHeight={Math.round(height * 0.92)}
			header={<Design.BottomSheetTitleHeader title="Search Spotify" />}
		>
			<Design.Stack spacing={8} style={styles.top}>
				<Design.TextInput
					label="Song or artist"
					value={query}
					onChange={setQuery}
					placeholder="Search Spotify"
					autoFocus
					maxLength={200}
				/>
				<Design.Text variant="text-xs/normal" color="text-muted">
					{hint}
				</Design.Text>
			</Design.Stack>
			<BottomSheet.BottomSheetScrollView
				keyboardShouldPersistTaps="handled"
				contentContainerStyle={styles.list}
			>
				{results.length > 0 && (
					<Design.TableRowGroup>
						{results.map(track => (
							<Design.TableRow
								key={track.id}
								label={track.title}
								subLabel={track.artist}
								labelLineClamp={1}
								subLabelLineClamp={1}
								disabled={spotify.busy}
								icon={
									track.artwork ? (
										<Image source={{ uri: track.artwork }} style={styles.art} />
									) : undefined
								}
								trailing={
									<View style={styles.actions}>
										<ResultAction
											names={['SkipForwardIcon', 'ArrowSmallRightIcon']}
											text="Next"
											label={`Play ${track.title} next`}
											disabled={spotify.busy}
											onPress={() => act(track, 'next')}
										/>
										<ResultAction
											names={['PlusLargeIcon', 'PlusSmallIcon']}
											text="Queue"
											label={`Add ${track.title} to the queue`}
											disabled={spotify.busy}
											onPress={() => act(track, 'queue')}
										/>
									</View>
								}
								onPress={() => act(track, 'now')}
							/>
						))}
					</Design.TableRowGroup>
				)}
			</BottomSheet.BottomSheetScrollView>
		</Design.ActionSheet>
	)
}

export function openSearch() {
	ActionSheetActionCreators.openLazy(
		Promise.resolve({ default: SearchSheet }),
		KEY,
		{},
	)
}

export function closeSearch() {
	ActionSheetActionCreators.hideActionSheet(KEY)
}

const useStyles = lazyStyles(() =>
	Design.createStyles({
		top: { paddingHorizontal: 16, paddingBottom: 12 },
		list: { paddingHorizontal: 16, paddingBottom: 24 },
		art: { width: 40, height: 40, borderRadius: 4 },
		actions: { flexDirection: 'row', alignItems: 'center' },
	}),
)

import Page from '@valenced/components/Page'
import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { ScrollView } from 'react-native'
import manifest from '../manifest.json'
import { Player } from './player'
import { openSearch } from './search'
import { ButtonIds, setSetting, useSettings } from './shared'
import { reconnect, refresh, restorePlayer, useSpotify } from './spotify'
import type { ComponentProps } from 'react'
import type { ButtonId, PlayerMode, Settings } from './shared'

type RowProps = Omit<ComponentProps<typeof Design.TableRow>, 'icon'> & {
	icon: string
}
type SwitchProps = Omit<
	ComponentProps<typeof Design.TableSwitchRow>,
	'icon'
> & {
	icon: string
}

const Row = ({ icon, ...props }: RowProps) => (
	<Design.TableRow {...props} icon={<TableRowAssetIcon name={icon} />} />
)
const SwitchRow = ({ icon, ...props }: SwitchProps) => (
	<Design.TableSwitchRow {...props} icon={<TableRowAssetIcon name={icon} />} />
)

const BUTTON_LABELS: Record<ButtonId, { label: string; icon: string }> = {
	Shuffle: { label: 'Shuffle', icon: 'ArrowsLeftRightIcon' },
	Previous: { label: 'Previous', icon: 'ArrowSmallLeftIcon' },
	Play: { label: 'Play / pause', icon: 'PlayIcon' },
	Next: { label: 'Next', icon: 'ArrowSmallRightIcon' },
	Repeat: { label: 'Repeat', icon: 'RefreshIcon' },
	Search: { label: 'Search', icon: 'MagnifyingGlassIcon' },
}

const GUIDE: [string, string, string][] = [
	[
		'Start listening',
		'MusicIcon',
		'Connect Spotify in Discord > Connections and play a song. The player appears above your YouBar.',
	],
	[
		'Playback controls',
		'PlayIcon',
		'Pause, resume, skip and go back. Tap or drag the progress bar to seek. Spotify may require Premium for playback controls.',
	],
	[
		'Swipe the player',
		'ChevronSmallDownIcon',
		'Swipe left or right to hide it for this music session, then tap the music button beside the YouBar buttons to restore it. Drag the card up or down, or tap its handle, to switch between closed, small and expanded. A new session shows the player again.',
	],
	[
		'Nothing playing',
		'MusicIcon',
		'With Always show player on, a small bar stays when nothing plays. Drag it up or tap its handle to open Search and start a song.',
	],
	[
		'Animated wave',
		'WaveformIcon',
		'Turn Animated waves on for a moving wave or off for the standard slider. Motion pauses with playback and respects Reduce Motion. The wave is decorative, not an audio visualizer.',
	],
	[
		'Search and queue',
		'MagnifyingGlassIcon',
		'Tap a result to play it now, or use the buttons on the row to play it next or add it to the queue. Your queue is kept: the songs that were coming up still follow. Only the song you pick is added.',
	],
	[
		'Automatic hiding',
		'EyeSlashIcon',
		'The player disappears when Spotify reports no active playback device or song, or after five minutes paused. It returns when playback resumes.',
	],
]

function ButtonGroup({ mode }: { mode: PlayerMode }) {
	const settings = useSettings()
	return (
		<Design.TableRowGroup
			title={
				mode === 'expanded'
					? 'Expanded player buttons'
					: 'Compact player buttons'
			}
		>
			{ButtonIds.map(id => {
				const key = `${mode}${id}` as keyof Settings
				return (
					<SwitchRow
						key={key}
						icon={BUTTON_LABELS[id].icon}
						label={BUTTON_LABELS[id].label}
						value={settings[key]}
						onValueChange={value => setSetting(key, value)}
					/>
				)
			})}
		</Design.TableRowGroup>
	)
}

export default function SettingsComponent() {
	const settings = useSettings()
	const spotify = useSpotify()

	return (
		<ScrollView keyboardShouldPersistTaps="handled">
			<Page>
				<Design.Stack spacing={24}>
					<Design.TableRowGroup title="Spotify connection">
						<Row
							icon="LinkIcon"
							label={spotify.connected ? 'Connected' : 'Connection status'}
							subLabel={spotify.status}
						/>
						<Row
							icon="LinkIcon"
							label="Reconnect"
							subLabel="Use the Spotify account already linked to Discord."
							arrow
							onPress={() => {
								reconnect()
							}}
						/>
						<Row
							icon="RefreshIcon"
							label="Refresh playback"
							arrow
							onPress={() => {
								refresh()
							}}
						/>
					</Design.TableRowGroup>
					<Design.TableRowGroup title="Player">
						<SwitchRow
							icon="ChevronSmallDownIcon"
							label="Compact player"
							subLabel="Start with the compact player. Tap the song to expand it."
							value={settings.compact}
							onValueChange={value => setSetting('compact', value)}
						/>
						<SwitchRow
							icon="MusicIcon"
							label="Always show player"
							subLabel="Keep the player on screen when nothing is playing, so you can start any song from Search."
							value={settings.alwaysShow}
							onValueChange={value => setSetting('alwaysShow', value)}
						/>
						<SwitchRow
							icon="WaveformIcon"
							label="Animated waves"
							subLabel="On: animated waves. Off: the standard slider."
							value={settings.animatedWave}
							onValueChange={value => setSetting('animatedWave', value)}
						/>
						<Row
							icon="MagnifyingGlassIcon"
							label="Search Spotify"
							subLabel="Find a song, then play it now, play it next or add it to the queue."
							arrow
							onPress={openSearch}
						/>
						{spotify.dismissed && (
							<Row
								icon="MusicIcon"
								label="Restore player"
								subLabel="Show the player you swiped away."
								arrow
								onPress={restorePlayer}
							/>
						)}
					</Design.TableRowGroup>
					<ButtonGroup mode="expanded" />
					<ButtonGroup mode="compact" />
					<Design.TableRowGroup title="Expanded player preview">
						<Player previewMode="expanded" />
					</Design.TableRowGroup>
					<Design.TableRowGroup title="Compact player preview">
						<Player previewMode="compact" />
					</Design.TableRowGroup>
					<Design.TableRowGroup title="Quick guide">
						{GUIDE.map(([label, icon, subLabel]) => (
							<Row key={label} icon={icon} label={label} subLabel={subLabel} />
						))}
					</Design.TableRowGroup>
					<Design.Stack align="center">
						<Design.Text variant="text-xs/normal" color="text-muted">
							{`Spotify Controls ${manifest.version}`}
						</Design.Text>
					</Design.Stack>
				</Design.Stack>
			</Page>
		</ScrollView>
	)
}

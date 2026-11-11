import React, { useSyncExternalStore } from 'react';
import { ScrollView, View } from 'react-native';
import { Design } from '@valenced/discord/design';
import { startSpotify, getState, subscribe, reconnect, refresh } from './spotify';
import { startIntegration } from './integration';
import { Player } from './player';
import manifest from '../manifest.json';

function Settings() {
  const state = useSyncExternalStore(subscribe, getState);
  return <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 36, gap: 16 }}>
    <Design.TableRowGroup title="Spotify connection">
      <Design.TableRow label={state.connected ? 'Connected' : 'Connection status'} subLabel={state.status} />
      <Design.TableRow label="Reconnect" subLabel="Use the Spotify account already linked to Discord." onPress={() => { void reconnect(); }} arrow />
      <Design.TableRow label="Refresh playback" onPress={() => { void refresh(); }} arrow />
    </Design.TableRowGroup>
    <Player preview />
    <Design.TableRowGroup title="Quick guide">
      <Design.TableRow label="Start listening" subLabel="Connect Spotify in Discord → Connections and play a song. The player appears above your YOUBAR." />
      <Design.TableRow label="Playback controls" subLabel="Pause, resume, skip and go back. Tap the wave to seek. Spotify may require Premium for playback controls." />
      <Design.TableRow label="Animated wave" subLabel="The wave moves while music plays and stops on pause. It respects Reduce Motion. The animation is decorative, not an audio visualizer." />
    </Design.TableRowGroup>
    <View style={{ alignItems: 'center' }}><Design.Text variant="text-xs/normal" color="text-muted">Spotify Controls {manifest.version}</Design.Text></View>
  </ScrollView>;
}
export default plugin({
  start({ cleanup, plugin: instance }) {
    cleanup(startSpotify());
    cleanup(startIntegration(error => instance.reportError(error)));
    if (instance.startedLate) instance.requireReload();
  },
  SettingsComponent: Settings,
});

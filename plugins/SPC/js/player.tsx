import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Animated, AppState, Easing, Image, Linking, Pressable, View } from 'react-native';
import { Design } from '@valenced/discord/design';
import { getAssetIdByName } from '@valenced/assets';
import { lookupModule } from '@valenced/modules/finders';
import { withProps } from '@valenced/modules/finders/filters';
import { Tokens } from '@valenced/discord/common/tokens';
import { command, getState, refresh, subscribe } from './spotify';
import { formatTime, positionAt, type Command } from './playback';
const MotionView = Animated.View;

function useForeground() {
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  useEffect(() => { const listener = AppState.addEventListener('change', value => setForeground(value === 'active')); return () => listener.remove(); }, []);
  return foreground;
}
export function wavePath(width: number) {
  const points = Array.from({ length: Math.ceil(width / 2) + 1 }, (_, i) => {
    const x = i * 2, y = 9 + Math.sin(x / 24 * Math.PI * 2) * 3;
    return (i ? 'L' : 'M') + x + ',' + y.toFixed(2);
  });
  return points.join(' ');
}
function Wave({ progress, playing, onSeek, accent, muted }: { progress: number; playing: boolean; onSeek: (ratio: number) => void; accent: string; muted: string }) {
  const [width, setWidth] = useState(1), [reduceMotion, setReduceMotion] = useState(false);
  const phase = useRef(new Animated.Value(0)).current;
  const svg = useMemo(() => lookupModule(withProps('Svg', 'Path'))[0] as any, []);
  const path = useMemo(() => wavePath(width + 28), [width]);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (live) setReduceMotion(value); });
    const listener = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { live = false; listener.remove(); };
  }, []);
  useEffect(() => {
    if (!playing || reduceMotion) return;
    phase.setValue(0);
    const animation = Animated.loop(Animated.timing(phase, { toValue: -24, duration: 1400, easing: Easing.linear, useNativeDriver: true, isInteraction: false }));
    animation.start(); return () => animation.stop();
  }, [playing, reduceMotion, phase]);
  const line = (color: string) => <MotionView pointerEvents="none" style={{ width: width + 28, height: 18, transform: [{ translateX: phase }] }}>
    {svg ? React.createElement(svg.Svg, { width: width + 28, height: 18 }, React.createElement(svg.Path, { d: path, stroke: color, strokeWidth: 2, strokeLinecap: 'round', fill: 'none' }))
      : Array.from({ length: Math.ceil((width + 28) / 3) }, (_, i) => <View key={i} style={{ position: 'absolute', left: i * 3, top: 8 + Math.sin(i * 3 / 24 * Math.PI * 2) * 3, width: 4, height: 2, borderRadius: 1, backgroundColor: color, transform: [{ rotate: Math.atan(Math.cos(i * 3 / 24 * Math.PI * 2) * Math.PI / 4) + 'rad' }] }} />)}
  </MotionView>;
  return <Pressable accessibilityRole="adjustable" accessibilityLabel="Song progress" accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
    accessibilityActions={[{ name: 'increment', label: 'Forward ten percent' }, { name: 'decrement', label: 'Back ten percent' }]}
    onAccessibilityAction={e => onSeek(Math.max(0, Math.min(1, progress + (e.nativeEvent.actionName === 'increment' ? 0.1 : -0.1))))}
    onLayout={e => setWidth(Math.max(1, e.nativeEvent.layout.width))} onPress={e => onSeek(Math.max(0, Math.min(1, e.nativeEvent.locationX / width)))}
    style={{ height: 32, justifyContent: 'center', overflow: 'hidden' }}>
    <View pointerEvents="none" style={{ height: 18, overflow: 'hidden' }}>{line(muted)}
      <View style={{ position: 'absolute', top: 0, left: 0, width: Math.max(0, Math.min(width, width * progress)), overflow: 'hidden' }}>{line(accent)}</View>
    </View>
    <View pointerEvents="none" style={{ position: 'absolute', width: 8, height: 8, borderRadius: 4, backgroundColor: accent, left: Math.max(0, Math.min(width - 8, progress * width - 4)) }} />
  </Pressable>;
}
function Control({ icons, label, action, disabled, active }: { icons: string[]; label: string; action: Command; disabled: boolean; active?: boolean }) {
  const icon = icons.map(name => getAssetIdByName(name)).find(Boolean);
  const Button = Design.IconButton as any;
  return icon ? <Button icon={icon} accessibilityLabel={label} size="md" variant={active ? 'primary' : 'tertiary'} disabled={disabled} onPress={() => { void command(action); }} />
    : <Design.Button text={label} size="sm" variant="secondary" disabled={disabled} onPress={() => { void command(action); }} />;
}
export function Player({ preview = false }: { preview?: boolean }) {
  const state = useSyncExternalStore(subscribe, getState);
  const context = (Design as any).useThemeContext();
  const palette = useMemo(() => {
    const { colors, internal } = Tokens.default;
    const resolve = (names: string[], fallback: string) => {
      for (const name of names) {
        try {
          if (!colors[name]) continue;
          const value = internal.resolveSemanticColor(context.theme, colors[name]);
          if (typeof value === 'string' && value !== 'transparent') return value;
        } catch { /* Fall back on Discord builds with different token names. */ }
      }
      return fallback;
    };
    let surface = resolve(['BACKGROUND_SURFACE_HIGH', 'BACKGROUND_SECONDARY', 'BACKGROUND_BASE_LOW'], context.theme === 'light' ? '#F2F3F5' : '#111827');
    // An overlay must cover the chat list, even when a theme makes ordinary cards translucent.
    surface = surface.replace(/^rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)$/, 'rgb($1,$2,$3)');
    if (/^#[\da-f]{8}$/i.test(surface)) surface = surface.slice(0, 7);
    return { surface, accent: resolve(['TEXT_LINK'], '#859BFF'), muted: resolve(['TEXT_MUTED'], '#64748B') };
  }, [context.theme]);
  const foreground = useForeground();
  const [, tick] = useState(0);
  const track = state.playback;
  useEffect(() => {
    if (!foreground || !track) return;
    const progressTimer = setInterval(() => tick(n => n + 1), 1000);
    // Native Spotify events drive updates; a slow foreground refresh repairs missed events.
    const refreshTimer = setInterval(() => { void refresh(); }, 15000);
    return () => { clearInterval(progressTimer); clearInterval(refreshTimer); };
  }, [foreground, !!track]);
  if (!track) return preview ? <Design.TableRow label="Spotify Controls" subLabel={state.status} /> : null;
  const position = positionAt(track), ratio = track.duration ? position / track.duration : 0;
  return <View style={{ marginHorizontal: 12, marginBottom: 8, flexShrink: 0, borderRadius: 16, overflow: 'hidden', backgroundColor: palette.surface }}>
    <Design.TableRowGroup>
      <View style={{ paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 }}>
        <Pressable accessibilityRole="link" accessibilityLabel={'Open ' + track.title + ' in Spotify'} onPress={() => { void Linking.openURL('https://open.spotify.com/track/' + encodeURIComponent(track.id)).catch(() => {}); }} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          {track.artwork ? <Image source={{ uri: track.artwork }} style={{ width: 42, height: 42, borderRadius: 6 }} /> : null}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Design.Text variant="text-sm/semibold" color="text-default" numberOfLines={1}>{track.title}</Design.Text>
            <Design.Text variant="text-xs/normal" color="text-muted" numberOfLines={1}>{track.artist}</Design.Text>
          </View>
        </Pressable>
        <Wave progress={ratio} playing={track.playing && foreground} accent={palette.accent} muted={palette.muted} onSeek={value => { if (!state.busy) void command('seek', value * track.duration); }} />
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: -4 }}>
          <Design.Text variant="text-xs/normal" color="text-muted">{formatTime(position)}</Design.Text>
          <Design.Text variant="text-xs/normal" color="text-muted">{formatTime(track.duration)}</Design.Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, marginTop: 4 }}>
          <Control icons={['ShuffleIcon', 'ArrowsLeftRightIcon']} label="Shuffle" action="shuffle" active={track.shuffle} disabled={state.busy} />
          <Control icons={['SkipBackIcon', 'MediaPreviousIcon', 'PreviousIcon', 'ArrowSmallLeftIcon']} label="Previous" action="previous" disabled={state.busy} />
          <Control icons={track.playing ? ['PauseIcon', 'MediaPauseIcon'] : ['PlayIcon', 'MediaPlayIcon']} label={track.playing ? 'Pause' : 'Play'} action={track.playing ? 'pause' : 'play'} active disabled={state.busy} />
          <Control icons={['SkipForwardIcon', 'MediaNextIcon', 'NextIcon', 'ArrowSmallRightIcon']} label="Next" action="next" disabled={state.busy} />
          <Control icons={['RepeatIcon', 'LoopIcon', 'RefreshIcon']} label={track.repeat === 'track' ? 'Repeat one' : 'Repeat'} action="repeat" active={track.repeat !== 'off'} disabled={state.busy} />
        </View>
        {state.status !== 'Connected to Spotify' && <Design.Text variant="text-xs/normal" color="text-muted">{state.status}</Design.Text>}
      </View>
    </Design.TableRowGroup>
  </View>;
}

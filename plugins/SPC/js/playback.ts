export type Playback = {
  id: string; title: string; artist: string; artwork: string | null;
  duration: number; position: number; updatedAt: number; playing: boolean;
  shuffle: boolean; repeat: 'off' | 'track' | 'context'; deviceId: string | null;
};
export type Command = 'play' | 'pause' | 'next' | 'previous' | 'seek' | 'shuffle' | 'repeat';
export const clamp = (n: number, max: number) => Math.max(0, Math.min(max, Number.isFinite(n) ? n : 0));
export function positionAt(state: Pick<Playback, 'position' | 'updatedAt' | 'playing' | 'duration'>, now = Date.now()) {
  return clamp(state.position + (state.playing ? Math.max(0, now - state.updatedAt) : 0), state.duration);
}
export function normalizePlayback(raw: any, now = Date.now()): Playback | null {
  const track = raw?.item ?? raw?.track;
  if (!track?.id) return null;
  const repeat = raw.repeat_state ?? raw.actual_repeat ?? (typeof raw.repeat === 'string' ? raw.repeat : 'off');
  const duration = Math.max(0, Number(track.duration_ms ?? track.duration) || 0);
  return {
    id: String(track.id), title: String(track.name || 'Unknown track'),
    artist: (track.artists || []).map((a: any) => a.name).filter(Boolean).join(', ') || 'Unknown artist',
    artwork: track.album?.images?.[0]?.url ?? track.album?.image?.url ?? null,
    duration, position: clamp(Number(raw.progress_ms ?? raw.position) || 0, duration), updatedAt: now,
    playing: !!(raw.is_playing ?? raw.isPlaying), shuffle: !!(raw.shuffle_state ?? raw.shuffle),
    repeat: ['off', 'track', 'context'].includes(repeat) ? repeat : 'off',
    deviceId: raw.device?.id ?? null,
  };
}
export function commandRequest(action: Command, state: Partial<Playback>, deviceId: string, value?: number) {
  let route: string = action;
  const query = ['device_id=' + encodeURIComponent(deviceId)];
  if (action === 'seek') query.push('position_ms=' + Math.round(clamp(value ?? 0, state.duration ?? 0)));
  else if (action === 'shuffle') query.push('state=' + !state.shuffle);
  else if (action === 'repeat') query.push('state=' + ({ off: 'context', context: 'track', track: 'off' }[state.repeat ?? 'off']));
  else if (!['play', 'pause', 'next', 'previous'].includes(action)) throw new Error('Unknown playback action');
  return { url: 'https://api.spotify.com/v1/me/player/' + route + '?' + query.join('&'),
    method: action === 'next' || action === 'previous' ? 'POST' : 'PUT' };
}
export function formatTime(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

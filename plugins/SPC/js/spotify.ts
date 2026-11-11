import { getModules } from '@valenced/modules/finders';
import { withProps } from '@valenced/modules/finders/filters';
import { getStore, onFluxEventDispatched } from '@valenced/discord/flux';
import { AppState } from 'react-native';
import { commandRequest, normalizePlayback, positionAt, type Command, type Playback } from './playback';

export type State = { playback: Playback | null; status: string; busy: boolean; connected: boolean };
const listeners = new Set<() => void>();
let state: State = { playback: null, status: 'Connecting to Discord’s Spotify session…', busy: false, connected: false };
let active = false, generation = 0, readRevision = 0;
let spotify: any, accounts: any, actions: any;
let credential: { accountId: string; accessToken: string } | null = null;
const pending = new Set<AbortController>();
let refreshPromise: Promise<void> | null = null;
let bootstrapPromise: Promise<void> | null = null;
function update(change: Partial<State>) { state = { ...state, ...change }; for (const fn of listeners) fn(); }
export const getState = () => state;
export const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
function session() {
  try {
    const current = spotify?.getActiveSocketAndDevice?.();
    if (current?.socket?.accessToken) return { accountId: current.socket.accountId, accessToken: current.socket.accessToken };
  } catch { /* Session may still be connecting. */ }
  return credential;
}
function safeError(status: number): string {
  if (status === 401) return 'Spotify session expired. Tap Reconnect in settings.';
  if (status === 403) return 'Spotify rejected this control. Check Premium and playback permissions.';
  if (status === 404) return 'Start a song on a Spotify device, then refresh.';
  if (status === 429) return 'Spotify is limiting requests. Wait a moment before trying again.';
  return 'Spotify could not complete the request (' + status + ').';
}
async function request(url: string, method = 'GET') {
  if (!active) throw new Error('Spotify Controls is stopped');
  const auth = session();
  if (!auth) throw new Error('Connect Spotify under Discord’s Connections, then tap Reconnect.');
  const controller = new AbortController(); pending.add(controller);
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    // Only Spotify receives its own token. No credentials are stored or logged.
    const response = await fetch(url, { method, headers: { Authorization: 'Bearer ' + auth.accessToken }, signal: controller.signal });
    if (!response.ok) throw new Error(safeError(response.status));
    return method !== 'GET' || response.status === 204 || response.status === 202 ? null : await response.json();
  } finally { clearTimeout(timeout); pending.delete(controller); }
}
export function refresh(): Promise<void> {
  if (!active || AppState.currentState !== 'active') return Promise.resolve();
  if (refreshPromise) return refreshPromise;
  const epoch = generation;
  const revision = ++readRevision;
  refreshPromise = (async () => {
    try {
      const raw = await request('https://api.spotify.com/v1/me/player');
      if (!active || epoch !== generation || revision !== readRevision) return;
      const playback = normalizePlayback(raw) ?? (state.playback ? { ...state.playback, playing: false, position: positionAt(state.playback), updatedAt: Date.now() } : null);
      update({ playback, connected: true, status: playback ? 'Connected to Spotify' : 'Start a song in Spotify to show the player.' });
    } catch (error) {
      if (active && epoch === generation && revision === readRevision) update({ status: error instanceof Error ? error.message : 'Could not connect to Spotify.' });
    } finally { if (epoch === generation && revision === readRevision) refreshPromise = null; }
  })();
  return refreshPromise;
}
export async function reconnect(renew = true) {
  if (!active || bootstrapPromise) return bootstrapPromise;
  const epoch = generation;
  bootstrapPromise = (async () => {
    await Promise.resolve();
    try {
      const list = accounts?.getAccounts?.() ?? [];
      const account = (Array.isArray(list) ? list : Object.values(list)).find((a: any) => a.type === 'spotify');
      const accountId = account?.id ?? session()?.accountId;
      if (accountId && actions?.getAccessToken && (renew || !session())) {
        update({ status: 'Connecting to the Spotify account linked to Discord…' });
        await actions.getAccessToken(accountId);
        if (active && epoch === generation) await refresh();
      } else if (session()) await refresh();
      else update({ status: !actions || !accounts ? 'Waiting for Discord’s Spotify modules…' : 'Connect Spotify in Discord → Connections first.' });
    } catch { if (active && epoch === generation) update({ status: 'Could not refresh the Discord Spotify connection.' }); }
    finally { if (epoch === generation) bootstrapPromise = null; }
  })();
  return bootstrapPromise;
}
export async function command(action: Command, value?: number) {
  if (!active || state.busy || !state.playback) return;
  const epoch = generation, track = state.playback;
  if (!track.deviceId) { update({ status: 'Start playback on a Spotify device first.' }); return; }
  readRevision++; refreshPromise = null;
  update({ busy: true });
  try {
    const req = commandRequest(action, track, track.deviceId, value);
    await request(req.url, req.method);
    if (!active || epoch !== generation) return;
    readRevision++; refreshPromise = null;
    // No automatic retries: a skip accepted with 202 must not skip twice.
    if (state.playback?.id === track.id) {
      if (action === 'pause' || action === 'play') update({ playback: { ...state.playback, playing: action === 'play', position: action === 'pause' ? Math.min(track.duration, track.position + Math.max(0, Date.now() - track.updatedAt)) : track.position, updatedAt: Date.now() } });
      if (action === 'seek') update({ playback: { ...state.playback!, position: Math.max(0, Math.min(track.duration, value ?? 0)), updatedAt: Date.now() } });
    }
    await refresh();
  } catch (error) {
    if (active && epoch === generation) update({ status: error instanceof Error ? error.message : 'Spotify control failed.' });
  } finally { if (active && epoch === generation) update({ busy: false }); }
}
export function startSpotify() {
  active = true; generation++;
  const undo: (() => void)[] = [];
  undo.push(getStore('SpotifyStore', value => { spotify = value; void reconnect(false); }));
  undo.push(getStore('ConnectedAccountsStore', value => { accounts = value; void reconnect(false); }));
  undo.push(getModules(withProps('SpotifyAPI', 'getAccessToken', 'getDevices'), value => { actions = value; void reconnect(false); }));
  undo.push(onFluxEventDispatched('SPOTIFY_ACCOUNT_ACCESS_TOKEN', (event: any) => {
    if (event.accountId && event.accessToken) credential = { accountId: event.accountId, accessToken: event.accessToken };
    Promise.resolve().then(() => { if (active) void refresh(); });
    return event;
  }));
  undo.push(onFluxEventDispatched('SPOTIFY_PLAYER_STATE', (event: any) => {
    if (event.accountId === session()?.accountId) {
      const playback = normalizePlayback(event);
      if (playback) update({ playback: { ...playback, deviceId: playback.deviceId ?? state.playback?.deviceId ?? null }, connected: true, status: 'Connected to Spotify' });
    }
    return event;
  }));
  for (const type of ['LOGOUT', 'SPOTIFY_ACCOUNT_ACCESS_TOKEN_REVOKED']) undo.push(onFluxEventDispatched(type, event => {
    generation++; readRevision++; refreshPromise = bootstrapPromise = null;
    for (const controller of pending) controller.abort(); pending.clear();
    credential = null; update({ playback: null, connected: false, busy: false, status: 'Spotify disconnected. Tap Reconnect in settings.' }); return event;
  }));
  const app = AppState.addEventListener('change', value => { if (value === 'active') void reconnect(false); });
  undo.push(() => app.remove());
  return () => {
    active = false; generation++; for (const fn of undo.reverse()) fn();
    for (const controller of pending) controller.abort(); pending.clear();
    credential = null; spotify = accounts = actions = null; refreshPromise = bootstrapPromise = null;
    update({ playback: null, connected: false, busy: false, status: 'Spotify Controls is stopped.' });
  };
}

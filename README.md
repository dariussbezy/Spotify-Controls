# Spotify Controls

A native Discord player above the YOUBAR, with an animated wave progress bar. **1.0.0-beta** for Valenced Plugin API 1.

## Install

Add this URL in **Valenced → Plugins → Advanced**, then install **Spotify Controls** from **beta** and restart Discord:

```text
https://raw.githubusercontent.com/dariussbezy/Spotify-Controls/main/index.json
```

Connect Spotify in Discord's **Connections** and start a song on your Spotify device. The plugin reuses that connection; no separate API key or login is needed.

## Controls

- Cover, title and artist; tap to open the song in Spotify.
- Previous, play/pause, next, shuffle and repeat.
- Tap the wave to seek. The blue portion represents elapsed time.
- The decorative wave moves while playing, pauses with playback and respects Reduce Motion.
- Native settings include connection status, Reconnect, Refresh and a quick guide.

Spotify's playback API can require Premium. An active Spotify device is required. Android and iOS share the same JavaScript implementation; iOS still requires device testing.

The plugin sends playback requests only to Spotify using Discord's existing Spotify session. It does not store or log access tokens. Playback is refreshed from Discord events with a slow foreground-only fallback; animation runs on the native driver. The wave is not an audio visualizer.

## Development

Run `bun install --frozen-lockfile`, `npm run build`, `npm run lint:types`, and `npm test`. Use `npm run publish:local` to package the JavaScript-only ZIP and regenerate the catalog.

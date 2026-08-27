# Likedle

A Songless/Heardle-style game that draws exclusively from your own Spotify Liked Songs.
Hear a 1-second snippet, guess the track, and unlock more seconds with every miss or skip (1s, 2s, 4s, 7s, 11s, 16s).
Unlimited rounds, per-browser stats, no server - everything runs client-side against the Spotify Web API.

Live at: https://darahaas15.github.io/likedle/

## Setup (one time, ~2 minutes)

1. Open https://developer.spotify.com/dashboard and log in with your Spotify account.
2. Click "Create app"; name and description can be anything.
3. Add the exact Redirect URI shown on the Likedle setup screen (for the hosted version: `https://darahaas15.github.io/likedle/`).
4. Tick "Web API" and "Web Playback SDK" under the APIs question, then save.
5. Copy the app's Client ID from its Settings page and paste it into Likedle.

The Client ID is stored only in your browser's localStorage.
The OAuth flow is Authorization Code + PKCE, so no client secret exists anywhere.

## Playback modes

- **In this browser** (default): full-track snippets via the Spotify Web Playback SDK. Requires Spotify Premium. Desktop browsers only.
- **On a Spotify device**: Likedle remote-controls the Spotify app on your Mac or iPhone via Spotify Connect. Requires Premium. This is the mode to use when playing from an iPhone browser.
- **30s previews**: matches each track to Apple's public 30-second previews. Works without Premium; a small number of tracks may have no preview (those rounds are re-drawn).

If the browser player is unavailable (e.g. iOS) or the account is not Premium, the app auto-falls back and tells you.

## Development

No build step.
Serve the directory with any static file server, e.g. `python3 -m http.server 4173`, and open `http://localhost:4173/`.
For local play you would need to register `http://127.0.0.1:4173/` as an additional Redirect URI in your Spotify app (Spotify only allows loopback HTTP; localhost hostnames must use HTTPS).

Game tuning lives in `js/config.js` (stage lengths, scopes, storage keys).

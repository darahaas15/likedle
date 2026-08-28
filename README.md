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

## Library loading

The game never blocks on syncing a large library.
On load it fetches a few random pages of your Liked Songs (a fresh random sample every visit) and starts immediately; the full library then syncs quietly in the background so autocomplete and answers eventually cover everything, cached in the browser for future visits.
"Re-sync Liked Songs" in Settings rebuilds the cache (also in the background).

## Playback modes

- **Play on my computer** (recommended): keep Likedle open on your phone while Spotify on your Mac plays the snippets.
  Likedle refreshes changing Spotify device IDs, transfers playback when needed, verifies that the track started, and retries one dropped connection.
- **Play directly on this phone or browser**: matches each track to Apple's public previews, trying your Spotify country's storefront first.
  It needs no Premium account or open Spotify app, but a few songs may not have previews.
- **Spotify inside this browser** (advanced): plays full-track snippets through a managed Spotify Web Playback SDK receiver.
  It requires Premium and a browser that supports protected audio.

Non-Premium accounts are locked to previews (Spotify does not allow playback control otherwise); Premium users get a one-time hint that the full-track modes exist.
Spotify on an iPhone is only a best-effort remote receiver because iOS can suspend it when playback is paused or the Spotify app is closed.
The game and Settings show playback readiness, and Settings includes a one-second sound test that does not consume a guess.

## Development

No build step.
Serve the directory with any static file server, e.g. `python3 -m http.server 4173`, and open `http://localhost:4173/`.
For local play you would need to register `http://127.0.0.1:4173/` as an additional Redirect URI in your Spotify app (Spotify only allows loopback HTTP; localhost hostnames must use HTTPS).
Run the playback regression suite with `npm test`.

Game tuning lives in `js/config.js` (stage lengths, scopes, storage keys).

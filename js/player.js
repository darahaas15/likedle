import { LS, SPOTIFY_LATENCY_PAD_MS } from './config.js';
import { getAccessToken } from './auth.js';
import { apiFetch, playOnDevice, pauseOnDevice, normalize } from './spotify.js';

// Errors thrown by playSnippet carry a `code`:
//   'premium'   - Spotify account is not Premium (browser mode)
//   'init'      - Web Playback SDK unsupported in this browser (e.g. iOS)
//   'auth'      - SDK auth failure
//   'no-device' - device mode: chosen device is gone / none selected
//   'no-preview'- preview mode: no 30s preview found for this track
//   'restricted'- Spotify rejected the play command (403)

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Web Playback SDK (browser mode) ----------

let sdkPlayer = null;
let sdkDeviceId = null;
let sdkReadyPromise = null;
let sdkScriptInjected = false;

function initSdk() {
  if (sdkDeviceId) return Promise.resolve(sdkDeviceId);
  if (sdkReadyPromise) return sdkReadyPromise;
  sdkReadyPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(codedError('init', 'The Spotify web player took too long to start.'));
    }, 15000);
    const done = (fn) => (arg) => { clearTimeout(timeout); fn(arg); };
    const start = () => {
      if (!window.Spotify || !window.Spotify.Player) {
        done(reject)(codedError('init', 'Spotify web player is not supported in this browser.'));
        return;
      }
      sdkPlayer = new window.Spotify.Player({
        name: 'Likedle',
        getOAuthToken: (cb) => { getAccessToken().then(cb).catch(() => {}); },
        volume: 0.85,
      });
      sdkPlayer.addListener('ready', done(({ device_id }) => {
        sdkDeviceId = device_id;
        resolve(device_id);
      }));
      sdkPlayer.addListener('initialization_error', done(({ message }) => {
        reject(codedError('init', message || 'Spotify web player failed to start here.'));
      }));
      sdkPlayer.addListener('authentication_error', done(({ message }) => {
        reject(codedError('auth', message || 'Spotify web player authentication failed.'));
      }));
      sdkPlayer.addListener('account_error', done(({ message }) => {
        reject(codedError('premium', message || 'Spotify Premium is required for the web player.'));
      }));
      sdkPlayer.connect();
    };
    if (window.Spotify && window.Spotify.Player) {
      start();
    } else {
      window.onSpotifyWebPlaybackSDKReady = start;
      if (!sdkScriptInjected) {
        sdkScriptInjected = true;
        const s = document.createElement('script');
        s.src = 'https://sdk.scdn.co/spotify-player.js';
        s.onerror = () => done(reject)(codedError('init', 'Could not load the Spotify web player.'));
        document.head.appendChild(s);
      }
    }
  });
  sdkReadyPromise.catch(() => {
    if (sdkPlayer) { try { sdkPlayer.disconnect(); } catch { /* best-effort */ } }
    sdkReadyPromise = null;
    sdkPlayer = null;
  });
  return sdkReadyPromise;
}

// The OS "Now Playing" widget (and browser media hub) would display the real
// track name during playback - mask it so the answer is not spoiled.
function maskMediaSession() {
  try {
    if ('mediaSession' in navigator && window.MediaMetadata) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'Mystery song',
        artist: 'Likedle',
        album: 'No peeking',
      });
    }
  } catch { /* unsupported */ }
}

// Waits until the SDK is audibly playing (position advancing past the seek
// point). The SDK buffers for up to a few seconds before sound starts, so a
// wall-clock stop timer would eat short snippets entirely.
async function sdkWaitForStart(token, startMs) {
  const t0 = performance.now();
  while (performance.now() - t0 < 8000) {
    if (token !== playToken) throw codedError('canceled', 'Playback canceled');
    const st = await sdkPlayer.getCurrentState();
    if (st && !st.paused && !st.loading && st.position > startMs) return st.position;
    await sleep(90);
  }
  throw codedError('start-timeout', 'The Spotify player did not start in time - press play again.');
}

// Position-aware stop: pauses once the player has actually SOUNDED durMs of
// audio, regardless of buffering stalls.
async function sdkStopWhenDone(token, endMs, onEnded) {
  while (token === playToken) {
    let st = null;
    try { st = await sdkPlayer.getCurrentState(); } catch { break; }
    if (!st || st.paused) return; // stopped externally
    const remaining = endMs - st.position;
    if (remaining <= 70) break;
    maskMediaSession();
    await sleep(Math.min(Math.max(remaining - 40, 40), 150));
  }
  if (token !== playToken) return;
  try { await sdkPlayer.pause(); } catch { /* best-effort */ }
  if (onEnded) onEnded();
}

// Right after `ready`, the SDK device sometimes is not yet visible to the Web
// API and the play command 404s. Retry briefly before giving up.
async function playWithRetry(deviceId, uri, positionMs) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await apiFetch(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
        method: 'PUT',
        body: JSON.stringify({ uris: [uri], position_ms: Math.max(0, Math.round(positionMs)) }),
      });
      return;
    } catch (e) {
      lastErr = e;
      if (e.status === 404 || e.status === 502) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// ---------- iTunes 30s previews (default mode, no Premium needed) ----------

let audioEl = null;
let audioPrimed = false;

const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

function jsonp(url) {
  return new Promise((resolve, reject) => {
    const cb = `likedle_cb_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    const cleanup = () => { delete window[cb]; script.remove(); clearTimeout(timer); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Preview lookup timed out')); }, 10000);
    window[cb] = (data) => { cleanup(); resolve(data); };
    script.src = `${url}${url.includes('?') ? '&' : '?'}callback=${cb}`;
    script.onerror = () => { cleanup(); reject(new Error('Preview lookup failed')); };
    document.head.appendChild(script);
  });
}

function loadPreviewCache() {
  try { return JSON.parse(localStorage.getItem(LS.previewCache)) || {}; } catch { return {}; }
}

function savePreviewCache(cache) {
  const keys = Object.keys(cache);
  if (keys.length > 600) {
    for (const k of keys.slice(0, keys.length - 600)) delete cache[k];
  }
  try { localStorage.setItem(LS.previewCache, JSON.stringify(cache)); } catch { /* quota */ }
}

function matchFromResults(track, results) {
  const wantName = normalize(track.name);
  const wantArtist = normalize(track.artists[0] ? track.artists[0].name : '');
  for (const r of results) {
    if (!r.url) continue;
    const gotName = normalize(r.name || '');
    const gotArtist = normalize(r.artist || '');
    const nameOk = gotName === wantName || gotName.includes(wantName) || wantName.includes(gotName);
    const artistOk = !wantArtist || gotArtist.includes(wantArtist) || wantArtist.includes(gotArtist);
    if (nameOk && artistOk) return r.url;
  }
  return null;
}

async function lookupItunes(track, country) {
  const artist = track.artists[0] ? track.artists[0].name : '';
  const term = encodeURIComponent(`${track.name} ${artist}`);
  const cc = country ? `&country=${encodeURIComponent(country)}` : '';
  const data = await jsonp(`https://itunes.apple.com/search?media=music&entity=song&limit=8${cc}&term=${term}`);
  return matchFromResults(track, (data.results || []).map((r) => ({
    name: r.trackName, artist: r.artistName, url: r.previewUrl,
  })));
}

// Tries the user's Spotify country storefront first (better regional catalog
// coverage), then the default US storefront. Exported for the UI test probe.
export async function findPreviewUrl(track, country) {
  const cache = loadPreviewCache();
  if (track.id in cache) return cache[track.id] || null;
  const storefronts = [...new Set([country || null, null])];
  let anySourceAnswered = false;
  let url = null;
  for (const cc of storefronts) {
    try {
      url = await lookupItunes(track, cc);
      anySourceAnswered = true;
      if (url) break;
    } catch { /* try the next storefront */ }
  }
  if (anySourceAnswered) {
    cache[track.id] = url || 0;
    savePreviewCache(cache);
  }
  return url;
}

function ensureAudio() {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = 'auto';
  }
  return audioEl;
}

// Must be called synchronously inside a user-gesture handler once, so that
// later programmatic play() calls are allowed on iOS Safari.
export function primeAudio() {
  if (audioPrimed) return;
  audioPrimed = true;
  const a = ensureAudio();
  a.src = SILENT_WAV;
  const p = a.play();
  if (p && p.then) p.then(() => a.pause()).catch(() => {});
}

// ---------- Public interface ----------

let stopTimer = null;
let playToken = 0; // invalidates stale scheduled stops
let current = null; // { mode, deviceId }

async function stopEngine(mode, deviceId) {
  try {
    if (mode === 'browser' && sdkPlayer) await sdkPlayer.pause();
    else if (mode === 'device' && deviceId) await pauseOnDevice(deviceId);
    else if (mode === 'preview' && audioEl) audioEl.pause();
  } catch { /* pausing best-effort */ }
}

export async function stop() {
  playToken += 1;
  if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
  if (current) await stopEngine(current.mode, current.deviceId);
}

// Plays `durMs` of the track starting at `startMs`, per settings
// ({mode, deviceId, deviceName, country}). Resolves once playback started;
// auto-stops after durMs; onEnded fires when the snippet finishes on its own.
export async function playSnippet(track, startMs, durMs, settings, onEnded) {
  await stop();
  const token = ++playToken;
  const mode = settings.mode;

  if (mode === 'browser') {
    const deviceId = await initSdk();
    if (sdkPlayer && sdkPlayer.activateElement) {
      try { await sdkPlayer.activateElement(); } catch { /* older SDK */ }
    }
    try {
      await playWithRetry(deviceId, track.uri, startMs);
    } catch (e) {
      if (e.status === 403) throw codedError('premium', 'Spotify Premium is required to play snippets.');
      if (e.status === 404) { sdkDeviceId = null; sdkReadyPromise = null; throw codedError('init', 'The web player disconnected - try again.'); }
      throw e;
    }
    // Resolve only once audio is audibly rolling, and stop after durMs of
    // HEARD audio - so the progress bar and the sound stay in sync.
    const pos = await sdkWaitForStart(token, startMs);
    current = { mode, deviceId };
    maskMediaSession();
    sdkStopWhenDone(token, pos + durMs, onEnded);
    return { durMs };
  }

  if (mode === 'device') {
    if (!settings.deviceId) throw codedError('no-device', 'Pick a Spotify device in Settings first.');
    try {
      await playOnDevice(settings.deviceId, track.uri, startMs);
    } catch (e) {
      if (e.status === 404) throw codedError('no-device', `"${settings.deviceName || 'Your device'}" is not available. Open Spotify on it (play/pause any song once), then re-pick it in Settings.`);
      if (e.status === 403) throw codedError('premium', 'Spotify Premium is required to control playback.');
      throw e;
    }
    current = { mode, deviceId: settings.deviceId };
    scheduleStop(token, durMs + SPOTIFY_LATENCY_PAD_MS, onEnded);
    return { durMs };
  }

  // preview mode
  const url = await findPreviewUrl(track, settings.country);
  if (!url) throw codedError('no-preview', 'No 30s preview exists for this track.');
  const audio = ensureAudio();
  if (audio.src !== url) {
    audio.src = url;
    await new Promise((resolve, reject) => {
      const ok = () => { cleanup(); resolve(); };
      const bad = () => { cleanup(); reject(codedError('no-preview', 'Could not load the preview audio.')); };
      const cleanup = () => {
        audio.removeEventListener('canplaythrough', ok);
        audio.removeEventListener('error', bad);
        clearTimeout(t);
      };
      const t = setTimeout(bad, 10000);
      audio.addEventListener('canplaythrough', ok);
      audio.addEventListener('error', bad);
      audio.load();
    });
  }
  // Previews are ~30s; keep the snippet window inside them.
  const maxStart = Math.max(0, 29000 - durMs);
  audio.currentTime = Math.min(startMs, maxStart) / 1000;
  await audio.play();
  maskMediaSession();
  current = { mode, deviceId: null };
  scheduleStop(token, durMs, onEnded);
  return { durMs };
}

function scheduleStop(token, afterMs, onEnded) {
  stopTimer = setTimeout(async () => {
    if (token !== playToken) return;
    stopTimer = null;
    await stopEngine(current.mode, current.deviceId);
    if (onEnded) onEnded();
  }, afterMs);
}

export { initSdk };

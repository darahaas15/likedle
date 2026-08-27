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
  sdkReadyPromise.catch(() => { sdkReadyPromise = null; sdkPlayer = null; });
  return sdkReadyPromise;
}

// ---------- iTunes 30s previews (fallback mode) ----------

let audioEl = null;

function jsonp(url) {
  return new Promise((resolve, reject) => {
    const cb = `likedle_cb_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    const cleanup = () => { delete window[cb]; script.remove(); clearTimeout(timer); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Preview lookup timed out')); }, 10000);
    window[cb] = (data) => { cleanup(); resolve(data); };
    script.src = `${url}&callback=${cb}`;
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
  localStorage.setItem(LS.previewCache, JSON.stringify(cache));
}

async function getPreviewUrl(track) {
  const cache = loadPreviewCache();
  if (track.id in cache) return cache[track.id] || null;
  const artist = track.artists[0] ? track.artists[0].name : '';
  const term = encodeURIComponent(`${track.name} ${artist}`);
  let url = null;
  try {
    const data = await jsonp(`https://itunes.apple.com/search?media=music&entity=song&limit=8&term=${term}`);
    const wantName = normalize(track.name);
    const wantArtist = normalize(artist);
    for (const r of data.results || []) {
      if (!r.previewUrl) continue;
      const gotName = normalize(r.trackName || '');
      const gotArtist = normalize(r.artistName || '');
      const nameOk = gotName === wantName || gotName.includes(wantName) || wantName.includes(gotName);
      const artistOk = !wantArtist || gotArtist.includes(wantArtist) || wantArtist.includes(gotArtist);
      if (nameOk && artistOk) { url = r.previewUrl; break; }
    }
  } catch {
    return null; // lookup failure: do not cache, may work next time
  }
  cache[track.id] = url || 0;
  savePreviewCache(cache);
  return url;
}

function ensureAudio() {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = 'auto';
  }
  return audioEl;
}

// ---------- Public interface ----------

let stopTimer = null;
let playToken = 0; // invalidates stale scheduled stops

async function stopEngine(mode, deviceId) {
  try {
    if (mode === 'browser' && sdkPlayer) await sdkPlayer.pause();
    else if (mode === 'device' && deviceId) await pauseOnDevice(deviceId);
    else if (mode === 'preview' && audioEl) audioEl.pause();
  } catch { /* pausing best-effort */ }
}

let current = null; // { mode, deviceId }

export async function stop() {
  playToken += 1;
  if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
  if (current) await stopEngine(current.mode, current.deviceId);
}

// Plays `durMs` of the track starting at `startMs`, per settings.
// Resolves (with {durMs}) once playback has started; auto-stops after durMs.
// onEnded is called when the snippet finishes on its own.
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
      await apiFetch(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
        method: 'PUT',
        body: JSON.stringify({ uris: [track.uri], position_ms: startMs }),
      });
    } catch (e) {
      if (e.status === 403) throw codedError('premium', 'Spotify Premium is required to play snippets.');
      if (e.status === 404) { sdkDeviceId = null; sdkReadyPromise = null; throw codedError('init', 'The web player disconnected - try again.'); }
      throw e;
    }
    current = { mode, deviceId };
    scheduleStop(token, durMs + SPOTIFY_LATENCY_PAD_MS, onEnded);
    return { durMs };
  }

  if (mode === 'device') {
    if (!settings.deviceId) throw codedError('no-device', 'Pick a Spotify device in Settings first.');
    try {
      await playOnDevice(settings.deviceId, track.uri, startMs);
    } catch (e) {
      if (e.status === 404) throw codedError('no-device', `"${settings.deviceName || 'Your device'}" is not available. Open Spotify on it, then re-pick it in Settings.`);
      if (e.status === 403) throw codedError('premium', 'Spotify Premium is required to control playback.');
      throw e;
    }
    current = { mode, deviceId: settings.deviceId };
    scheduleStop(token, durMs + SPOTIFY_LATENCY_PAD_MS, onEnded);
    return { durMs };
  }

  // preview mode
  const url = await getPreviewUrl(track);
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

// Devices helper re-exported for the settings UI.
export { initSdk };

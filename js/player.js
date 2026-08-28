import { LS } from './config.js';
import { getAccessToken } from './auth.js';
import {
  apiFetch, getDevices, getPlaybackState, transferPlayback,
  playOnDevice, pauseOnDevice, resolveDevice, normalize,
} from './spotify.js';

// Errors thrown by playSnippet carry a `code`:
//   'premium'   - Spotify account is not Premium (browser mode)
//   'init'      - Web Playback SDK unsupported in this browser (e.g. iOS)
//   'auth'      - SDK auth failure
//   'no-device' - device mode: chosen device is gone / none selected
//   'no-preview'- preview mode: no 30s preview found for this track
//   'restricted'- selected device is marked as not remotely controllable
//   'forbidden' - Spotify rejected remote playback; account status may be stale
//   'gesture-required' - browser receiver became ready after the click gesture

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
let sdkLoadPromise = null;
let sdkScriptInjected = false;
let sdkGeneration = 0;
let sdkRuntimeError = null;
let sdkRuntimeErrorVersion = 0;
let sdkActivatedGeneration = null;
let sdkActivationAttempt = 0;
let receiverStatus = { state: 'idle', message: 'Not started' };
let receiverStatusListener = null;

const BROWSER_DEVICE_NAME = 'Likedle browser';

function publishReceiverStatus(state, message) {
  receiverStatus = { state, message };
  if (receiverStatusListener) receiverStatusListener(receiverStatus);
}

export function getBrowserReceiverStatus() {
  return { ...receiverStatus };
}

export function onBrowserReceiverStatus(listener) {
  receiverStatusListener = listener;
  if (listener) listener(getBrowserReceiverStatus());
  return () => {
    if (receiverStatusListener === listener) receiverStatusListener = null;
  };
}

function runtimeSdkError(code, message) {
  sdkRuntimeError = codedError(code, message);
  sdkRuntimeErrorVersion += 1;
  publishReceiverStatus('error', message);
  return sdkRuntimeError;
}

function loadSdkScript() {
  if (window.Spotify && window.Spotify.Player) return Promise.resolve();
  if (sdkLoadPromise) return sdkLoadPromise;

  sdkLoadPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(codedError('init', 'The Spotify web player script took too long to load.'));
    }, 15000);
    const previousReady = window.onSpotifyWebPlaybackSDKReady;
    window.onSpotifyWebPlaybackSDKReady = () => {
      clearTimeout(timeout);
      if (typeof previousReady === 'function') previousReady();
      resolve();
    };
    if (!sdkScriptInjected) {
      sdkScriptInjected = true;
      const script = document.createElement('script');
      script.src = 'https://sdk.scdn.co/spotify-player.js';
      script.onerror = () => {
        clearTimeout(timeout);
        reject(codedError('init', 'Could not load the Spotify web player script.'));
      };
      document.head.appendChild(script);
    }
  }).catch((error) => {
    sdkLoadPromise = null;
    sdkScriptInjected = false;
    throw error;
  });
  return sdkLoadPromise;
}

function disconnectSdk() {
  sdkGeneration += 1;
  if (sdkPlayer) {
    try { sdkPlayer.disconnect(); } catch { /* best-effort */ }
  }
  sdkPlayer = null;
  sdkDeviceId = null;
  sdkReadyPromise = null;
  sdkRuntimeError = null;
  sdkActivatedGeneration = null;
  sdkActivationAttempt += 1;
}

function initSdk() {
  if (sdkDeviceId) return Promise.resolve(sdkDeviceId);
  if (sdkReadyPromise) return sdkReadyPromise;
  publishReceiverStatus('connecting', 'Connecting to Spotify');
  sdkReadyPromise = loadSdkScript().then(() => new Promise((resolve, reject) => {
    if (!window.Spotify || !window.Spotify.Player) {
      reject(codedError('init', 'Spotify web player is not supported in this browser.'));
      return;
    }

    if (sdkPlayer) {
      try { sdkPlayer.disconnect(); } catch { /* best-effort */ }
      sdkPlayer = null;
      sdkDeviceId = null;
      sdkRuntimeError = null;
    }
    const generation = ++sdkGeneration;
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) reject(codedError('init', 'The Spotify web player took too long to start.'));
    }, 15000);
    const rejectStartup = (error) => {
      if (generation !== sdkGeneration) return;
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      } else {
        runtimeSdkError(error.code, error.message);
      }
    };

    sdkPlayer = new window.Spotify.Player({
      name: BROWSER_DEVICE_NAME,
      getOAuthToken: (cb) => {
        getAccessToken().then(cb).catch((error) => {
          rejectStartup(codedError('auth', error.message || 'Spotify authentication failed.'));
        });
      },
      volume: 0.85,
      enableMediaSession: false,
    });

    sdkPlayer.addListener('ready', ({ device_id }) => {
      if (generation !== sdkGeneration) return;
      sdkDeviceId = device_id;
      sdkRuntimeError = null;
      publishReceiverStatus('ready', 'Ready');
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(device_id);
      }
    });
    sdkPlayer.addListener('not_ready', () => {
      if (generation !== sdkGeneration) return;
      sdkDeviceId = null;
      sdkReadyPromise = null;
      runtimeSdkError('disconnected', 'Spotify disconnected the browser player.');
    });
    sdkPlayer.addListener('initialization_error', ({ message }) => {
      rejectStartup(codedError('init', message || 'Spotify web player failed to start here.'));
    });
    sdkPlayer.addListener('authentication_error', ({ message }) => {
      rejectStartup(codedError('auth', message || 'Spotify web player authentication failed.'));
    });
    sdkPlayer.addListener('account_error', ({ message }) => {
      rejectStartup(codedError('premium', message || 'Spotify Premium is required for the web player.'));
    });
    sdkPlayer.addListener('playback_error', ({ message }) => {
      runtimeSdkError('playback', message || 'Spotify could not load this track.');
    });
    sdkPlayer.addListener('autoplay_failed', () => {
      runtimeSdkError('autoplay', 'Your browser blocked Spotify audio. Press Play again.');
    });

    Promise.resolve(sdkPlayer.connect()).then((connected) => {
      if (connected === false) {
        rejectStartup(codedError('init', 'Spotify could not connect the browser player.'));
      }
    }).catch((error) => {
      rejectStartup(codedError('init', error.message || 'Spotify could not connect the browser player.'));
    });
  }));
  sdkReadyPromise.catch((error) => {
    disconnectSdk();
    publishReceiverStatus('error', error.message || 'Browser player unavailable');
  });
  return sdkReadyPromise;
}

export function prepareBrowserReceiver() {
  return initSdk();
}

// Invoke this directly in the Play click stack. Calling it after an awaited
// network request is too late for browsers that enforce autoplay gestures.
export function activateBrowserElement() {
  if (!sdkPlayer || !sdkPlayer.activateElement) return false;
  sdkRuntimeError = null;
  if (sdkDeviceId) publishReceiverStatus('ready', 'Ready');
  const generation = sdkGeneration;
  const activationAttempt = ++sdkActivationAttempt;
  sdkActivatedGeneration = null;
  try {
    const result = sdkPlayer.activateElement();
    sdkActivatedGeneration = generation;
    if (result && result.catch) {
      result.catch(() => {
        if (generation !== sdkGeneration) return;
        if (activationAttempt !== sdkActivationAttempt) return;
        if (sdkActivatedGeneration === generation) sdkActivatedGeneration = null;
        runtimeSdkError('autoplay', 'Your browser blocked Spotify audio. Press Play again.');
      });
    }
    return true;
  } catch {
    return false;
  }
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
async function sdkWaitForStart(token, uri, startMs, errorVersion) {
  const t0 = performance.now();
  while (performance.now() - t0 < 8000) {
    if (token !== playToken) throw codedError('canceled', 'Playback canceled');
    if (sdkRuntimeErrorVersion !== errorVersion && sdkRuntimeError) throw sdkRuntimeError;
    const st = await sdkPlayer.getCurrentState();
    const currentUri = st && st.track_window && st.track_window.current_track
      ? st.track_window.current_track.uri
      : null;
    if (st && currentUri === uri && !st.paused && !st.loading && st.position > startMs) {
      return st.position;
    }
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
    if (!st || st.paused) {
      current = null;
      publishReceiverStatus('ready', 'Ready');
      if (onEnded) onEnded();
      return;
    }
    const remaining = endMs - st.position;
    if (remaining <= 70) break;
    maskMediaSession();
    await sleep(Math.min(Math.max(remaining - 40, 40), 150));
  }
  if (token !== playToken) return;
  try { await sdkPlayer.pause(); } catch { /* best-effort */ }
  publishReceiverStatus('ready', 'Ready');
  current = null;
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

function sameDeviceIdentity(device, preference) {
  if (!device) return false;
  if (preference.deviceId && device.id === preference.deviceId) return true;
  const wantedName = (preference.deviceName || '').trim().toLocaleLowerCase();
  const wantedType = (preference.deviceType || '').trim().toLocaleLowerCase();
  return !!wantedName
    && (device.name || '').trim().toLocaleLowerCase() === wantedName
    && (!wantedType || (device.type || '').trim().toLocaleLowerCase() === wantedType);
}

async function resolveFreshDevice(preference) {
  const devices = await getDevices();
  const selected = devices.find((d) => sameDeviceIdentity(d, preference));
  if (selected && selected.is_restricted) {
    throw codedError('restricted', `"${selected.name}" does not allow remote playback control.`);
  }
  return resolveDevice(devices, preference);
}

async function waitForRemoteStart(token, deviceId, uri, startMs) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < 6500) {
    if (token !== playToken) throw codedError('canceled', 'Playback canceled');
    let state = null;
    try { state = await getPlaybackState(); } catch { /* retry until timeout */ }
    const sameDevice = state && state.device && state.device.id === deviceId;
    const sameTrack = state && state.item && (state.item.uri === uri || `spotify:track:${state.item.id}` === uri);
    if (sameDevice && sameTrack && state.is_playing && state.progress_ms > startMs) {
      return Math.max(0, state.progress_ms - startMs);
    }
    await sleep(250);
  }
  throw codedError('start-timeout', 'Spotify accepted the command but the selected device did not start playing.');
}

async function startOnRemoteDevice(token, track, startMs, settings) {
  if (!settings.deviceId && !settings.deviceName) {
    throw codedError('no-device', 'Choose your computer in Settings first.');
  }

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const device = await resolveFreshDevice(settings);
    if (!device) {
      const isPhone = (settings.deviceType || '').toLocaleLowerCase() === 'smartphone';
      const recovery = isPhone
        ? 'Open Spotify on the phone and start any song once, then refresh devices.'
        : 'Open Spotify on it, then refresh devices.';
      throw codedError('no-device', `"${settings.deviceName || 'Your device'}" is offline. ${recovery}`);
    }

    try {
      if (!device.is_active) {
        await transferPlayback(device.id, false);
        await sleep(250);
      }
      await playOnDevice(device.id, track.uri, startMs);
      current = { mode: 'device', deviceId: device.id };
      const alreadyHeardMs = await waitForRemoteStart(token, device.id, track.uri, startMs);
      return { device, alreadyHeardMs };
    } catch (error) {
      lastError = error;
      current = null;
      try { await pauseOnDevice(device.id); } catch { /* best-effort */ }
      if (error.code === 'canceled') throw error;
      if (error.status === 403) {
        throw codedError('forbidden', `Spotify refused playback on "${device.name}".`);
      }
      if (attempt === 0 && (error.status === 404 || error.status === 502 || error.code === 'start-timeout')) {
        await sleep(350);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

async function resolveBrowserApiDevice(deviceId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const devices = await getDevices();
      const exact = devices.find((d) => d.id === deviceId && !d.is_restricted);
      if (exact) return exact;
    } catch { /* the play endpoint still gets a chance */ }
    await sleep(300 * (attempt + 1));
  }
  return { id: deviceId, is_active: false };
}

function canReconnectBrowser(error) {
  return error && (
    error.code === 'disconnected'
    || error.code === 'playback'
    || error.code === 'start-timeout'
    || error.status === 404
    || error.status === 502
  );
}

async function startInBrowser(token, track, startMs, durMs, onEnded) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const readyId = await initSdk();
      if (sdkActivatedGeneration !== sdkGeneration) {
        publishReceiverStatus('ready', 'Ready - press Play again');
        throw codedError(
          'gesture-required',
          'The Spotify browser receiver is ready. Press Play again to allow audio.',
        );
      }
      const errorVersion = sdkRuntimeErrorVersion;
      if (sdkRuntimeError) throw sdkRuntimeError;
      const device = await resolveBrowserApiDevice(readyId);
      await transferPlayback(device.id, false);
      await sleep(250);

      await playWithRetry(device.id, track.uri, startMs);
      current = { mode: 'browser', deviceId: device.id };
      const position = await sdkWaitForStart(token, track.uri, startMs, errorVersion);
      publishReceiverStatus('playing', 'Playing');
      maskMediaSession();
      sdkStopWhenDone(token, position + durMs, onEnded);
      return;
    } catch (error) {
      lastError = error;
      const active = current;
      current = null;
      if (active) await stopEngine(active.mode, active.deviceId);
      if (error.code === 'canceled') throw error;
      if (error.status === 403) {
        throw codedError('premium', 'Spotify Premium is required to play full tracks in the browser.');
      }
      if (attempt === 0 && canReconnectBrowser(error)) {
        disconnectSdk();
        publishReceiverStatus('connecting', 'Reconnecting to Spotify');
        await sleep(300);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
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

const previewLookups = new Map();

// Tries the user's Spotify country storefront first (better regional catalog
// coverage), then the default US storefront. Exported for the UI test probe.
export function findPreviewUrl(track, country) {
  const cache = loadPreviewCache();
  if (track.id in cache) return Promise.resolve(cache[track.id] || null);
  if (previewLookups.has(track.id)) return previewLookups.get(track.id);

  const lookup = (async () => {
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
      // Another track lookup may have completed while this request was in
      // flight, so merge into a fresh cache snapshot instead of overwriting it.
      const latestCache = loadPreviewCache();
      latestCache[track.id] = url || 0;
      savePreviewCache(latestCache);
    }
    return url;
  })().finally(() => {
    previewLookups.delete(track.id);
  });
  previewLookups.set(track.id, lookup);
  return lookup;
}

export function prefetchPreview(track, country) {
  return findPreviewUrl(track, country);
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
    if (mode === 'browser' && sdkPlayer) {
      await sdkPlayer.pause();
      publishReceiverStatus('ready', 'Ready');
    }
    else if (mode === 'device' && deviceId) await pauseOnDevice(deviceId);
    else if (mode === 'preview' && audioEl) audioEl.pause();
  } catch { /* pausing best-effort */ }
}

export async function stop() {
  playToken += 1;
  if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
  const active = current;
  current = null;
  if (active) await stopEngine(active.mode, active.deviceId);
}

// Plays `durMs` of the track starting at `startMs`, per settings
// ({mode, deviceId, deviceName, deviceType, country}). Resolves once playback started;
// auto-stops after durMs; onEnded fires when the snippet finishes on its own.
export async function playSnippet(track, startMs, durMs, settings, onEnded) {
  await stop();
  const token = ++playToken;
  const mode = settings.mode;

  if (mode === 'browser') {
    await startInBrowser(token, track, startMs, durMs, onEnded);
    return { durMs };
  }

  if (mode === 'device') {
    const { device, alreadyHeardMs } = await startOnRemoteDevice(token, track, startMs, settings);
    current = { mode, deviceId: device.id };
    scheduleStop(token, Math.max(50, durMs - alreadyHeardMs), onEnded);
    return { durMs, device };
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
    const active = current;
    current = null;
    if (active) await stopEngine(active.mode, active.deviceId);
    if (onEnded) onEnded();
  }, afterMs);
}

export { initSdk };

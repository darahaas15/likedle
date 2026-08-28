import {
  STAGES_MS, MAX_GUESSES, LS, LEGACY_KEYS, TOP_UP_AFTER_MS,
  loadSettings, saveSettings,
} from './config.js';
import {
  getClientId, setClientId, clearClientId, redirectUri, beginLogin,
  handleRedirect, isLoggedIn, logout,
} from './auth.js';
import {
  loadProfile, fetchAndCacheProfile, getDevices, searchLibrary,
  fetchQuickBatch, loadLibCache, backgroundSync, topUpLibCache, clearLibCache,
  resolveDevice,
} from './spotify.js';
import {
  playSnippet, stop as stopPlayback, primeAudio, findPreviewUrl,
  prefetchPreview, prepareBrowserReceiver, activateBrowserElement,
  getBrowserReceiverStatus, onBrowserReceiverStatus,
} from './player.js';
import { newRound, submitGuess, skip, loadStats, recordResult } from './game.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  settings: loadSettings(),
  profile: null,
  cache: null,        // persistent library cache (fills in the background)
  quickBatch: null,   // random sample used for answers until the cache completes
  total: null,        // library size reported by Spotify
  searchPool: [],     // union of cache + quick batch, for autocomplete
  round: null,
  selectedGuess: null,
  playing: false,
  audioPreparing: false,
  poolReady: false,
  syncGen: 0,
  syncError: false,
  suggestionIndex: -1,
  previewGeneration: 0,
  browserReceiver: getBrowserReceiverStatus(),
  playbackHealth: {
    status: 'idle',
    shortLabel: 'not checked',
    title: 'Sound not checked',
    message: 'Likedle will check your selected playback option.',
  },
  healthGeneration: 0,
  deviceListGeneration: 0,
  soundTestGeneration: 0,
  testingSound: false,
  uitest: false,
};

// ---------- Toasts ----------

function toast(message, kind = 'info', ms = 4200) {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  $('#toastWrap').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

// ---------- Screens ----------

function showScreen(name) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
  $('#topbarActions').hidden = name !== 'game';
}

function route() {
  if (!getClientId()) {
    $('#redirectUriText').textContent = redirectUri();
    showScreen('setup');
  } else if (!isLoggedIn()) {
    showScreen('login');
  } else {
    startGame();
  }
}

// ---------- Setup screen ----------

$('#copyUriBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(redirectUri());
    $('#copyUriBtn').textContent = 'Copied!';
    setTimeout(() => { $('#copyUriBtn').textContent = 'Copy'; }, 1600);
  } catch {
    toast('Copy failed - select the text manually.', 'error');
  }
});

$('#saveClientIdBtn').addEventListener('click', () => {
  const id = $('#clientIdInput').value.trim();
  if (!/^[0-9a-f]{32}$/i.test(id)) {
    toast('That does not look like a Spotify Client ID (32 hex characters).', 'error');
    return;
  }
  setClientId(id);
  route();
});

$('#clientIdInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#saveClientIdBtn').click();
});

// ---------- Login screen ----------

$('#loginBtn').addEventListener('click', () => beginLogin());
$('#changeClientIdBtn').addEventListener('click', () => {
  clearClientId();
  route();
});

// ---------- Playback mode resolution ----------

function effectiveMode() {
  if (state.profile && state.profile.product && state.profile.product !== 'premium') {
    return 'preview'; // Spotify playback control needs Premium
  }
  if (!state.settings.mode && state.settings.deviceName && state.settings.deviceType === 'Computer') {
    return 'device';
  }
  return state.settings.mode || 'preview';
}

function effectiveSettings() {
  return {
    ...state.settings,
    mode: effectiveMode(),
    country: state.profile ? state.profile.country : null,
  };
}

function modeLabel() {
  switch (effectiveMode()) {
    case 'browser': return 'this browser via Spotify';
    case 'device': return `Spotify on ${state.settings.deviceName || 'your computer'}`;
    default: return 'this device using 30-second previews';
  }
}

function updateModeLine() {
  $('#modeLine').textContent = `Sound: ${modeLabel()} - ${state.playbackHealth.shortLabel} - change`;
  $('#modeLine').dataset.status = state.playbackHealth.status;
}

function setPlaybackHealth(status, shortLabel, title, message) {
  state.playbackHealth = { status, shortLabel, title, message };
  const panel = $('#playbackHealth');
  if (panel) {
    panel.dataset.status = status;
    $('#healthTitle').textContent = title;
    $('#healthMessage').textContent = message;
  }
  if ($('#modeLine')) updateModeLine();
}

onBrowserReceiverStatus((status) => {
  state.browserReceiver = status;
  if (effectiveMode() !== 'browser') return;
  if (status.state === 'connecting') {
    setPlaybackHealth('checking', 'connecting', 'Connecting browser audio', status.message);
  } else if (status.state === 'ready') {
    setPlaybackHealth('ready', 'ready', 'Browser audio ready', status.message);
  } else if (status.state === 'playing') {
    setPlaybackHealth('ready', 'playing', 'Browser audio is playing', status.message);
  } else if (status.state === 'error' || status.state === 'disconnected') {
    setPlaybackHealth('error', 'needs attention', 'Browser audio unavailable', status.message);
  }
});

function matchesRememberedDevice(device) {
  if (!device) return false;
  if (state.settings.deviceId && device.id === state.settings.deviceId) return true;
  const sameName = state.settings.deviceName
    && device.name.toLocaleLowerCase() === state.settings.deviceName.toLocaleLowerCase();
  const sameType = !state.settings.deviceType
    || device.type.toLocaleLowerCase() === state.settings.deviceType.toLocaleLowerCase();
  return sameName && sameType;
}

async function checkPlaybackHealth() {
  const generation = ++state.healthGeneration;
  const mode = effectiveMode();
  setPlaybackHealth('checking', 'checking', 'Checking sound', 'Confirming that the selected playback option is available.');

  try {
    if (mode === 'browser') {
      await prepareBrowserReceiver();
      if (generation !== state.healthGeneration || effectiveMode() !== mode) return;
      setPlaybackHealth('ready', 'ready', 'Browser audio ready', 'Protected Spotify audio is connected in this browser.');
      return;
    }

    if (mode === 'preview') {
      if (!state.round) {
        setPlaybackHealth('ready', 'ready', 'Direct audio ready', 'Previews will play directly on this device.');
        return;
      }
      const url = await prefetchPreview(
        state.round.track,
        state.profile ? state.profile.country : null,
      );
      if (generation !== state.healthGeneration || effectiveMode() !== mode) return;
      if (url) {
        setPlaybackHealth('ready', 'ready', 'Direct audio ready', 'This round is preloaded and will play directly on this device.');
      } else {
        setPlaybackHealth('warning', 'finding another song', 'Preview unavailable', 'Likedle is finding another liked song with playable audio.');
      }
      return;
    }

    if (!state.settings.deviceId && !state.settings.deviceName) {
      setPlaybackHealth('warning', 'choose a computer', 'Choose a receiver', 'Select your Mac or another Spotify receiver below.');
      return;
    }
    const devices = await getDevices();
    if (generation !== state.healthGeneration || effectiveMode() !== mode) return;
    const remembered = devices.find(matchesRememberedDevice);
    if (remembered && remembered.is_restricted) {
      setPlaybackHealth('error', 'cannot control', 'Receiver cannot be controlled', `${remembered.name} rejects Spotify remote commands.`);
      return;
    }
    const resolved = resolveDevice(devices, state.settings);
    if (!resolved) {
      setPlaybackHealth('error', 'offline', 'Receiver is offline', `Open Spotify on ${state.settings.deviceName || 'your computer'}, then refresh.`);
      return;
    }
    if (
      state.settings.deviceId !== resolved.id
      || state.settings.deviceName !== resolved.name
      || state.settings.deviceType !== resolved.type
    ) {
      state.settings.deviceId = resolved.id;
      state.settings.deviceName = resolved.name;
      state.settings.deviceType = resolved.type;
      saveSettings(state.settings);
    }
    setPlaybackHealth(
      'ready',
      'ready',
      `${resolved.name} is ready`,
      resolved.is_active
        ? 'Spotify reports this receiver as active.'
        : 'Likedle will activate this receiver when you press Play.',
    );
  } catch (error) {
    if (generation !== state.healthGeneration || effectiveMode() !== mode) return;
    setPlaybackHealth('error', 'check failed', 'Could not check sound', error.message);
  }
}

function maybeShowPremiumHint() {
  if (
    state.profile && state.profile.product === 'premium'
    && !state.settings.mode
    && !localStorage.getItem(LS.premiumHintShown)
  ) {
    localStorage.setItem(LS.premiumHintShown, '1');
    toast('You have Premium: switch to full-track snippets in Settings if you prefer them over previews.', 'info', 7000);
  }
}

// ---------- Library loading (quick start + background sync) ----------

function currentAnswers() {
  if (state.cache && state.cache.complete && state.cache.tracks.length) return state.cache.tracks;
  if (state.quickBatch && state.quickBatch.length) return state.quickBatch;
  return (state.cache && state.cache.tracks) || [];
}

function rebuildSearchPool() {
  const seen = new Set();
  const pool = [];
  const sources = [state.cache ? state.cache.tracks : [], state.quickBatch || []];
  for (const src of sources) {
    for (const t of src) {
      if (!seen.has(t.id)) { seen.add(t.id); pool.push(t); }
    }
  }
  state.searchPool = pool;
}

function updateFooter(syncDone, syncTotal) {
  const foot = $('#gameFoot');
  const cache = state.cache;
  if (cache && cache.complete) {
    foot.textContent = `${cache.tracks.length.toLocaleString()} Liked Songs`;
  } else if (typeof syncDone === 'number' && syncTotal) {
    foot.textContent = `Playing from a random sample - syncing your library in the background: ${syncDone.toLocaleString()} / ${syncTotal.toLocaleString()}`;
  } else if (state.syncError && state.total) {
    foot.textContent = `Playing from a random sample of your ${state.total.toLocaleString()} Liked Songs`;
  } else if (state.total) {
    foot.textContent = `${state.total.toLocaleString()} Liked Songs`;
  } else {
    foot.textContent = '';
  }
}

function setPoolLoading(loading) {
  state.poolReady = !loading;
  $('#playBtn').disabled = loading;
  $('#skipBtn').disabled = loading;
  if (loading) $('#playBtnLabel').textContent = 'Loading songs...';
}

function showLoadError(message) {
  $('#syncStatus').textContent = message;
  $('#syncRetryBtn').hidden = false;
  showScreen('sync');
}

async function startGame() {
  showScreen('game');
  buildTimeline();
  setPoolLoading(true);
  $('#modeLine').hidden = true;

  // Profile (Premium? country?) - cached across sessions.
  if (!state.profile) {
    state.profile = loadProfile();
    if (!state.profile) {
      try { state.profile = await fetchAndCacheProfile(); } catch { state.profile = null; }
    }
  }

  try {
    state.cache = loadLibCache();
    if (state.cache.complete) {
      state.total = state.cache.total || state.cache.tracks.length;
      rebuildSearchPool();
      poolReady();
      if (Date.now() - state.cache.updatedAt > TOP_UP_AFTER_MS) {
        topUpLibCache(state.cache).then((n) => {
          if (n) { rebuildSearchPool(); updateFooter(); }
        }).catch(() => {});
      }
    } else {
      // Quick start: a random sample across the whole library, in ~2 requests.
      const batch = await fetchQuickBatch();
      if (!batch.total) {
        showLoadError('Your Liked Songs list is empty - like some songs on Spotify first, then retry.');
        return;
      }
      state.quickBatch = batch.tracks;
      state.total = batch.total;
      rebuildSearchPool();
      poolReady();
      runBackgroundSync();
    }
  } catch (e) {
    if (e.status === 403) {
      showLoadError('Spotify said "403 Forbidden". If you just created the app, make sure you are logged into the SAME Spotify account that owns it (development mode apps only allow the owner + invited users).');
    } else {
      showLoadError(`Could not load your Liked Songs: ${e.message}`);
    }
  }
}

function poolReady() {
  setPoolLoading(false);
  $('#modeLine').hidden = false;
  updateModeLine();
  maybeShowPremiumHint();
  startRound();
}

function runBackgroundSync() {
  const gen = ++state.syncGen;
  state.syncError = false;
  backgroundSync(state.cache, {
    shouldContinue: () => gen === state.syncGen,
    onProgress: (done, total, complete) => {
      if (gen !== state.syncGen) return;
      state.total = total;
      rebuildSearchPool();
      updateFooter(done, total);
      if (complete) updateFooter();
    },
  }).catch(() => {
    if (gen !== state.syncGen) return;
    state.syncError = true;
    updateFooter();
  });
}

$('#syncRetryBtn').addEventListener('click', () => {
  $('#syncRetryBtn').hidden = true;
  startGame();
});

// ---------- Game: rendering ----------

function buildTimeline() {
  const totalMs = STAGES_MS[STAGES_MS.length - 1];
  const timeline = $('#timeline');
  timeline.querySelectorAll('.timeline-sep').forEach((n) => n.remove());
  const labels = $('#timelineLabels');
  labels.innerHTML = '';
  for (let i = 0; i < STAGES_MS.length; i++) {
    const pct = (STAGES_MS[i] / totalMs) * 100;
    if (i < STAGES_MS.length - 1) {
      const sep = document.createElement('div');
      sep.className = 'timeline-sep';
      sep.style.left = `${pct}%`;
      timeline.appendChild(sep);
    }
    const label = document.createElement('span');
    label.className = 'timeline-label';
    label.style.left = `${pct}%`;
    label.textContent = `${STAGES_MS[i] / 1000}s`;
    labels.appendChild(label);
  }
}

function renderGuessRows() {
  const list = $('#guessRows');
  list.innerHTML = '';
  for (let i = 0; i < MAX_GUESSES; i++) {
    const li = document.createElement('li');
    const g = state.round ? state.round.guesses[i] : null;
    if (!g) {
      const isCurrent = state.round && i === state.round.guesses.length && state.round.status === 'playing';
      li.className = `guess-row empty${isCurrent ? ' current' : ''}`;
      li.innerHTML = '<span class="guess-dot"></span>';
    } else if (g.type === 'skip') {
      li.className = 'guess-row skipped';
      li.innerHTML = '<span class="guess-ic">&raquo;</span><span class="guess-text">Skipped</span>';
    } else {
      const cls = g.correct ? 'correct' : (g.artistMatch ? 'artist' : 'wrong');
      const ic = g.correct ? '&check;' : (g.artistMatch ? '&asymp;' : '&times;');
      li.className = `guess-row ${cls}`;
      li.innerHTML = `<span class="guess-ic">${ic}</span><span class="guess-text"><strong></strong><em></em></span>`;
      li.querySelector('strong').textContent = g.track.name;
      li.querySelector('em').textContent = g.track.artists.map((a) => a.name).join(', ');
      if (g.artistMatch) li.title = 'Right artist, wrong song';
    }
    list.appendChild(li);
  }
}

function updateStageUi() {
  const round = state.round;
  if (!round) return;
  const totalMs = STAGES_MS[STAGES_MS.length - 1];
  const unlockedMs = STAGES_MS[Math.min(round.stage, STAGES_MS.length - 1)];
  const unlockedPct = (unlockedMs / totalMs) * 100;
  $('#timelineLocked').style.left = round.status === 'playing' ? `${unlockedPct}%` : '100%';
  $('#playBtnLabel').textContent = `Play ${(round.status === 'playing' ? unlockedMs : totalMs) / 1000}s`;

  const next = STAGES_MS[round.stage + 1];
  $('#skipBtn').textContent = next ? `Skip (+${(next - unlockedMs) / 1000}s)` : 'Give up';
  updateFooter();
}

function resetFill() {
  const fill = $('#timelineFill');
  fill.style.transition = 'none';
  fill.style.width = '0%';
  void fill.offsetWidth; // reflow so the next transition starts from 0
}

function setPlayingUi(playing) {
  state.playing = playing;
  $('#playBtn').querySelector('.ic-play').hidden = playing;
  $('#playBtn').querySelector('.ic-stop').hidden = !playing;
  const label = $('#playBtnLabel');
  if (playing) {
    label.textContent = 'Stop';
  } else if (state.round) {
    const totalMs = STAGES_MS[STAGES_MS.length - 1];
    const unlockedMs = state.round.status === 'playing'
      ? STAGES_MS[Math.min(state.round.stage, STAGES_MS.length - 1)]
      : totalMs;
    label.textContent = `Play ${unlockedMs / 1000}s`;
  }
  if (!playing) resetFill();
}

function animateFill(durMs) {
  const totalMs = STAGES_MS[STAGES_MS.length - 1];
  const pct = (durMs / totalMs) * 100;
  const fill = $('#timelineFill');
  resetFill();
  fill.style.transition = `width ${durMs}ms linear`;
  fill.style.width = `${pct}%`;
}

// ---------- Game: flow ----------

function startRound(previewAttempt = 0) {
  cancelSoundTest();
  stopPlayback();
  state.previewGeneration += 1;
  state.healthGeneration += 1;
  state.audioPreparing = false;
  const answers = currentAnswers();
  if (!answers.length) return;
  state.round = newRound(answers, state.settings);
  $('#testSoundBtn').disabled = false;
  state.selectedGuess = null;
  $('#revealCard').hidden = true;
  $('#controls').hidden = false;
  $('#guessInput').value = '';
  $('#submitBtn').disabled = true;
  hideSuggestions();
  renderGuessRows();
  updateStageUi();
  setPlayingUi(false);
  prepareRoundPlayback(state.round, previewAttempt);
  if (effectiveMode() === 'device') checkPlaybackHealth();
}

async function prepareRoundPlayback(round, previewAttempt = 0) {
  const mode = effectiveMode();
  if (mode === 'browser') {
    checkPlaybackHealth();
    return;
  }
  if (mode !== 'preview') return;

  const generation = ++state.previewGeneration;
  state.healthGeneration += 1;
  state.audioPreparing = true;
  setPlaybackHealth('checking', 'preloading', 'Preparing direct audio', 'Finding a playable preview for this round.');
  const btn = $('#playBtn');
  btn.disabled = true;
  $('#playBtnLabel').textContent = 'Finding audio...';
  let url = null;
  try {
    url = await prefetchPreview(round.track, state.profile ? state.profile.country : null);
  } catch { /* play will surface a source error if needed */ }
  if (
    generation !== state.previewGeneration
    || state.round !== round
  ) return;

  if (!url && previewAttempt < 5) {
    startRound(previewAttempt + 1);
    return;
  }
  state.audioPreparing = false;
  btn.disabled = false;
  updateStageUi();
  if (!url) {
    setPlaybackHealth('warning', 'preview unavailable', 'Preview unavailable', 'Try Play again or choose your computer as the receiver.');
    toast('Could not pre-load a preview after several songs. You can retry Play or choose your computer in Settings.', 'error', 6500);
  } else {
    setPlaybackHealth('ready', 'ready', 'Direct audio ready', 'This round is preloaded and will play directly on this device.');
  }
}

function rememberResolvedDevice(device) {
  if (!device) return;
  const changed = state.settings.deviceId !== device.id
    || state.settings.deviceName !== device.name
    || state.settings.deviceType !== device.type;
  if (!changed) return;
  state.settings.deviceId = device.id;
  state.settings.deviceName = device.name;
  state.settings.deviceType = device.type;
  saveSettings(state.settings);
}

function markPlaybackHealthy(device, playing) {
  const mode = effectiveMode();
  if (mode === 'device') {
    const name = (device && device.name) || state.settings.deviceName || 'Spotify receiver';
    setPlaybackHealth(
      'ready',
      playing ? 'playing' : 'ready',
      playing ? `${name} is playing` : `${name} is ready`,
      playing ? 'The snippet started on your selected receiver.' : 'The receiver is available for the next snippet.',
    );
  } else if (mode === 'preview') {
    setPlaybackHealth(
      'ready',
      playing ? 'playing' : 'ready',
      playing ? 'Direct audio is playing' : 'Direct audio ready',
      playing ? 'The snippet is playing on this device.' : 'This round is preloaded on this device.',
    );
  }
}

function finishSoundTest(generation = null) {
  if (generation !== null && generation !== state.soundTestGeneration) return;
  state.testingSound = false;
  const button = $('#testSoundBtn');
  button.disabled = !state.round;
  button.textContent = 'Test sound';
}

function cancelSoundTest() {
  state.soundTestGeneration += 1;
  finishSoundTest();
}

async function onTestSound() {
  if (!state.round || state.testingSound) return;
  primeAudio();
  if (effectiveMode() === 'browser') activateBrowserElement();
  const generation = ++state.soundTestGeneration;
  state.testingSound = true;
  const button = $('#testSoundBtn');
  button.disabled = true;
  button.textContent = 'Testing...';
  setPlayingUi(false);
  state.healthGeneration += 1;

  let result = null;
  try {
    result = await playSnippet(
      state.round.track,
      state.round.startMs,
      STAGES_MS[0],
      effectiveSettings(),
      () => {
        if (generation !== state.soundTestGeneration) return;
        markPlaybackHealthy(result && result.device, false);
        finishSoundTest(generation);
      },
    );
    if (generation !== state.soundTestGeneration) return;
    rememberResolvedDevice(result.device);
    updateModeLine();
    markPlaybackHealthy(result.device, true);
    button.textContent = 'Playing...';
  } catch (error) {
    if (generation !== state.soundTestGeneration) return;
    finishSoundTest(generation);
    await handlePlayError(error, 'test');
  }
}

async function onPlay() {
  if (!state.round) return;
  cancelSoundTest();
  primeAudio(); // synchronous, inside the gesture: unlocks audio on iOS
  if (effectiveMode() === 'browser') {
    activateBrowserElement(); // must run before the first await
  }
  if (state.playing) {
    await stopPlayback();
    setPlayingUi(false);
    markPlaybackHealthy(null, false);
    return;
  }
  const round = state.round;
  const durMs = round.status === 'playing'
    ? STAGES_MS[round.stage]
    : STAGES_MS[STAGES_MS.length - 1];
  const btn = $('#playBtn');
  btn.disabled = true;
  $('#playBtnLabel').textContent = 'Starting...';
  state.healthGeneration += 1;
  let result = null;
  try {
    result = await playSnippet(
      round.track,
      round.startMs,
      durMs,
      effectiveSettings(),
      () => {
        setPlayingUi(false);
        markPlaybackHealthy(result && result.device, false);
      },
    );
    rememberResolvedDevice(result.device);
    updateModeLine();
    markPlaybackHealthy(result.device, true);
    setPlayingUi(true);
    animateFill(durMs);
  } catch (e) {
    await handlePlayError(e);
  } finally {
    btn.disabled = state.audioPreparing;
    if (!state.playing && !state.audioPreparing) setPlayingUi(false);
  }
}

async function handlePlayError(e, source = 'game') {
  setPlayingUi(false);
  switch (e.code) {
    case 'canceled':
      return; // user stopped/advanced while starting - not an error
    case 'start-timeout':
      setPlaybackHealth('error', 'did not start', 'Playback did not start', e.message);
      toast(e.message, 'error', 5000);
      return;
    case 'premium':
      state.settings.mode = 'preview';
      saveSettings(state.settings);
      syncPlaybackModeControls();
      updateModeLine();
      prepareRoundPlayback(state.round);
      toast('Spotify Premium is needed for that mode. Switched to previews played directly here.', 'error', 6000);
      break;
    case 'forbidden':
      try {
        state.profile = await fetchAndCacheProfile();
      } catch { /* retain the last known profile */ }
      if (state.profile && state.profile.product !== 'premium') {
        state.settings.mode = 'preview';
        saveSettings(state.settings);
        syncPlaybackModeControls();
        updateModeLine();
        prepareRoundPlayback(state.round);
        toast('Spotify playback now requires Premium. Switched to previews played directly here.', 'error', 6500);
      } else {
        setPlaybackHealth('error', 'playback refused', 'Spotify refused playback', e.message);
        toast(`${e.message} Refresh the receiver list or choose another playback option.`, 'error', 6500);
        openSettings();
      }
      break;
    case 'init':
      setPlaybackHealth('error', 'unavailable', 'Browser audio unavailable', e.message);
      toast(`The Spotify browser receiver could not start: ${e.message}`, 'error', 7000);
      openSettings();
      break;
    case 'auth':
      setPlaybackHealth('error', 'sign-in failed', 'Spotify rejected browser audio', e.message);
      toast('Spotify rejected the web player session. Check that "Web Playback SDK" is ticked in your Spotify app settings, or switch to previews in Settings.', 'error', 7000);
      break;
    case 'autoplay':
      setPlaybackHealth('warning', 'try again', 'Browser permission needed', e.message);
      toast(
        source === 'test'
          ? 'Your browser blocked Spotify audio. Press Test sound once more.'
          : 'Your browser blocked Spotify audio. Press Play once more, or use your computer as the Spotify receiver.',
        'error',
        6500,
      );
      break;
    case 'gesture-required':
      setPlaybackHealth(
        'ready',
        'ready',
        'Browser audio ready',
        source === 'test' ? 'Press Test sound again to allow protected audio.' : 'Press Play again to allow protected audio.',
      );
      toast(
        source === 'test'
          ? 'The browser receiver is ready. Press Test sound again.'
          : e.message,
        'info',
        5000,
      );
      break;
    case 'playback':
    case 'disconnected':
      setPlaybackHealth('error', 'disconnected', 'Browser audio disconnected', e.message);
      toast(`${e.message} The receiver was reconnected once; choose your computer or direct previews if this continues.`, 'error', 7500);
      break;
    case 'restricted':
      setPlaybackHealth('error', 'cannot control', 'Receiver cannot be controlled', e.message);
      toast(e.message, 'error', 6500);
      openSettings();
      break;
    case 'no-device':
      setPlaybackHealth('error', 'offline', 'Receiver is offline', e.message);
      toast(e.message, 'error', 6000);
      openSettings();
      break;
    case 'no-preview':
      toast('No preview found for this song - drawing another one.', 'info');
      startRound();
      break;
    default:
      setPlaybackHealth('error', 'playback failed', 'Playback failed', e.message);
      toast(`Playback failed: ${e.message}`, 'error', 6000);
  }
}

function endRound() {
  cancelSoundTest();
  stopPlayback();
  setPlayingUi(false);
  markPlaybackHealthy(null, false);
  const round = state.round;
  const won = round.status === 'won';
  if (!state.uitest) recordResult(won, round.guesses.length);
  renderGuessRows();
  updateStageUi();
  $('#controls').hidden = true;
  hideSuggestions();

  const t = round.track;
  $('#revealArt').src = t.art || '';
  $('#revealArt').hidden = !t.art;
  $('#revealTitle').textContent = t.name;
  $('#revealArtist').textContent = t.artists.map((a) => a.name).join(', ');
  $('#revealOpenLink').href = `https://open.spotify.com/track/${t.id}`;
  const heard = STAGES_MS[Math.min(round.guesses.length - 1, STAGES_MS.length - 1)] / 1000;
  const resultEl = $('#revealResult');
  if (won) {
    resultEl.textContent = `Got it in ${round.guesses.length}/${MAX_GUESSES} after ${heard}s`;
    resultEl.className = 'reveal-result win';
  } else {
    resultEl.textContent = 'Out of guesses!';
    resultEl.className = 'reveal-result loss';
  }
  $('#revealCard').hidden = false;
  $('#nextBtn').focus();
}

function afterAttempt() {
  const round = state.round;
  if (round.status === 'playing') {
    cancelSoundTest();
    stopPlayback();
    setPlayingUi(false);
    markPlaybackHealthy(null, false);
    renderGuessRows();
    updateStageUi();
  } else {
    endRound();
  }
}

$('#playBtn').addEventListener('click', onPlay);

$('#skipBtn').addEventListener('click', () => {
  if (!state.round || state.round.status !== 'playing') return;
  skip(state.round);
  afterAttempt();
});

$('#submitBtn').addEventListener('click', () => {
  if (!state.selectedGuess || !state.round || state.round.status !== 'playing') return;
  submitGuess(state.round, state.selectedGuess);
  state.selectedGuess = null;
  $('#guessInput').value = '';
  $('#submitBtn').disabled = true;
  hideSuggestions();
  afterAttempt();
});

$('#nextBtn').addEventListener('click', startRound);
$('#modeLine').addEventListener('click', () => openSettings());

// ---------- Suggestions ----------

function hideSuggestions() {
  $('#suggestions').hidden = true;
  $('#suggestions').innerHTML = '';
  state.suggestionIndex = -1;
}

function renderSuggestions(items) {
  const box = $('#suggestions');
  box.innerHTML = '';
  if (!items.length) { hideSuggestions(); return; }
  items.forEach((t, i) => {
    const div = document.createElement('div');
    div.className = 'suggestion';
    div.dataset.index = i;
    div.innerHTML = '<strong></strong><em></em>';
    div.querySelector('strong').textContent = t.name;
    div.querySelector('em').textContent = t.artists.map((a) => a.name).join(', ');
    div.addEventListener('mousedown', (e) => {
      e.preventDefault();
      chooseSuggestion(t);
    });
    box.appendChild(div);
  });
  box.hidden = false;
  state.suggestions = items;
  state.suggestionIndex = -1;
}

function chooseSuggestion(track) {
  state.selectedGuess = track;
  $('#guessInput').value = `${track.name} - ${track.artists.map((a) => a.name).join(', ')}`;
  $('#submitBtn').disabled = false;
  hideSuggestions();
}

$('#guessInput').addEventListener('input', () => {
  state.selectedGuess = null;
  $('#submitBtn').disabled = true;
  const q = $('#guessInput').value;
  if (q.trim().length < 2) { hideSuggestions(); return; }
  renderSuggestions(searchLibrary(state.searchPool, q));
});

$('#guessInput').addEventListener('keydown', (e) => {
  const box = $('#suggestions');
  const items = state.suggestions || [];
  if (!box.hidden && items.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      state.suggestionIndex = (state.suggestionIndex + dir + items.length) % items.length;
      $$('.suggestion').forEach((el, i) => el.classList.toggle('active', i === state.suggestionIndex));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      chooseSuggestion(items[state.suggestionIndex >= 0 ? state.suggestionIndex : 0]);
      return;
    }
    if (e.key === 'Escape') { hideSuggestions(); return; }
  }
  if (e.key === 'Enter' && state.selectedGuess) $('#submitBtn').click();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.guess-box')) hideSuggestions();
});

// ---------- Settings modal ----------

function syncPlaybackModeControls() {
  const isFree = state.profile && state.profile.product && state.profile.product !== 'premium';
  const mode = effectiveMode();
  $$('input[name="mode"]').forEach((r) => {
    r.checked = r.value === mode;
    r.disabled = isFree && r.value !== 'preview';
    r.closest('.radio-row').classList.toggle('disabled', isFree && r.value !== 'preview');
  });
  $('#premiumNote').hidden = !isFree;
  toggleDevicePicker();
  return mode;
}

function openSettings() {
  const mode = syncPlaybackModeControls();
  $$('input[name="snippetStart"]').forEach((r) => { r.checked = r.value === state.settings.snippetStart; });
  $('#testSoundBtn').disabled = !state.round || state.testingSound;
  const cache = state.cache;
  let info = '';
  if (cache && cache.complete) {
    info = `${cache.tracks.length.toLocaleString()} songs cached, updated ${new Date(cache.updatedAt).toLocaleString()}. Liked something new? Re-sync to include it.`;
  } else if (state.total) {
    info = `Playing from a random sample while your ${state.total.toLocaleString()} Liked Songs sync in the background.`;
  } else {
    info = 'Library not loaded yet.';
  }
  $('#libraryInfo').textContent = info;
  $('#settingsModal').hidden = false;
  if (mode !== 'device') checkPlaybackHealth();
}

function toggleDevicePicker() {
  const mode = effectiveMode();
  $('#devicePicker').hidden = mode !== 'device';
  if (mode === 'device') refreshDevices();
}

async function refreshDevices() {
  const listGeneration = ++state.deviceListGeneration;
  const healthGeneration = ++state.healthGeneration;
  const updateHealth = (...args) => {
    if (healthGeneration === state.healthGeneration) setPlaybackHealth(...args);
  };
  setPlaybackHealth('checking', 'checking', 'Checking receivers', 'Asking Spotify which devices are currently available.');
  const list = $('#deviceList');
  list.innerHTML = '<div class="device-empty">Looking for devices...</div>';
  try {
    const devices = await getDevices();
    if (listGeneration !== state.deviceListGeneration || effectiveMode() !== 'device') return;
    list.innerHTML = '';
    if (!devices.length) {
      list.innerHTML = '<div class="device-empty">No receivers are online. Open Spotify on your Mac, then hit Refresh. An iPhone disappears again when iOS suspends Spotify.</div>';
      updateHealth('error', 'offline', 'No receivers online', 'Open Spotify on your Mac, then refresh the receiver list.');
      return;
    }

    const remembered = devices.find(matchesRememberedDevice);
    const refreshedSelection = resolveDevice(devices, state.settings);
    if (refreshedSelection && refreshedSelection.id !== state.settings.deviceId) {
      state.settings.deviceId = refreshedSelection.id;
      state.settings.deviceName = refreshedSelection.name;
      state.settings.deviceType = refreshedSelection.type;
      saveSettings(state.settings);
      updateModeLine();
    }
    if (remembered && remembered.is_restricted) {
      updateHealth('error', 'cannot control', 'Receiver cannot be controlled', `${remembered.name} rejects Spotify remote commands.`);
    } else if (refreshedSelection) {
      updateHealth(
        'ready',
        'ready',
        `${refreshedSelection.name} is ready`,
        refreshedSelection.is_active
          ? 'Spotify reports this receiver as active.'
          : 'Likedle will activate this receiver when you test or play a snippet.',
      );
    } else if (state.settings.deviceName) {
      updateHealth('error', 'offline', 'Receiver is offline', `Open Spotify on ${state.settings.deviceName}, then refresh.`);
    } else {
      updateHealth('warning', 'choose a computer', 'Choose a receiver', 'Select your Mac or another Spotify receiver below.');
    }

    const rank = { Computer: 0, Speaker: 1, Smartphone: 2 };
    devices.sort((a, b) => (rank[a.type] ?? 3) - (rank[b.type] ?? 3) || a.name.localeCompare(b.name));
    devices.forEach((d) => {
      const btn = document.createElement('button');
      const selected = d.id === state.settings.deviceId;
      btn.className = `device-item${selected ? ' selected' : ''}${d.is_restricted ? ' disabled' : ''}`;
      btn.disabled = d.is_restricted;
      btn.innerHTML = '<strong></strong><small></small>';
      btn.querySelector('strong').textContent = d.name;
      const details = [d.type];
      if (d.type === 'Computer') details.push('recommended');
      if (d.type === 'Smartphone') details.push('disconnects when Spotify sleeps');
      if (d.is_active) details.push('active');
      if (d.is_restricted) details.push('cannot be controlled');
      btn.querySelector('small').textContent = details.join(' - ');
      btn.addEventListener('click', () => {
        state.settings.deviceId = d.id;
        state.settings.deviceName = d.name;
        state.settings.deviceType = d.type;
        saveSettings(state.settings);
        $$('.device-item').forEach((el) => el.classList.remove('selected'));
        btn.classList.add('selected');
        setPlaybackHealth(
          'ready',
          'ready',
          `${d.name} is ready`,
          d.is_active ? 'Spotify reports this receiver as active.' : 'Likedle will activate it when you test or play a snippet.',
        );
        toast(
          d.type === 'Computer'
            ? `Your phone can stay on Likedle while "${d.name}" plays the snippets.`
            : `Snippets will play on "${d.name}".`,
          'success',
        );
      });
      list.appendChild(btn);
    });
  } catch (error) {
    if (listGeneration !== state.deviceListGeneration || effectiveMode() !== 'device') return;
    list.innerHTML = `<div class="device-empty">Could not load receivers: ${error.message}</div>`;
    updateHealth('error', 'check failed', 'Could not check receivers', error.message);
  }
}

$('#settingsBtn').addEventListener('click', openSettings);
$('#refreshDevicesBtn').addEventListener('click', refreshDevices);
$('#testSoundBtn').addEventListener('click', onTestSound);

$$('input[name="mode"]').forEach((r) => r.addEventListener('change', () => {
  if (r.value === 'browser') activateBrowserElement();
  stopPlayback();
  cancelSoundTest();
  setPlayingUi(false);
  state.previewGeneration += 1;
  state.healthGeneration += 1;
  state.audioPreparing = false;
  state.settings.mode = r.value;
  saveSettings(state.settings);
  updateModeLine();
  toggleDevicePicker();
  if (state.round) {
    $('#playBtn').disabled = false;
    updateStageUi();
    prepareRoundPlayback(state.round);
  } else if (r.value !== 'device') {
    checkPlaybackHealth();
  }
}));

$$('input[name="snippetStart"]').forEach((r) => r.addEventListener('change', () => {
  state.settings.snippetStart = r.value;
  saveSettings(state.settings);
  toast(r.value === 'random' ? 'New rounds will start at a random position.' : 'New rounds will start at the beginning of the song.', 'info');
}));

$('#resyncBtn').addEventListener('click', () => {
  $('#settingsModal').hidden = true;
  state.syncGen += 1; // cancel any running sync
  clearLibCache();
  state.cache = null;
  state.quickBatch = null;
  toast('Re-syncing your library in the background.', 'info');
  startGame();
});

$('#logoutBtn').addEventListener('click', () => logout());

// ---------- Stats modal ----------

function openStats() {
  const s = loadStats();
  $('#statPlayed').textContent = s.played;
  $('#statWinPct').textContent = s.played ? `${Math.round((s.wins / s.played) * 100)}%` : '0%';
  $('#statStreak').textContent = s.streak;
  $('#statMaxStreak').textContent = s.maxStreak;
  const max = Math.max(1, ...s.dist);
  const bars = $('#distBars');
  bars.innerHTML = '';
  s.dist.forEach((n, i) => {
    const row = document.createElement('div');
    row.className = 'dist-row';
    row.innerHTML = `<span class="dist-n">${i + 1}</span><div class="dist-bar-track"><div class="dist-bar" style="width:${Math.max(6, (n / max) * 100)}%">${n}</div></div>`;
    bars.appendChild(row);
  });
  $('#statsModal').hidden = false;
}

$('#statsBtn').addEventListener('click', openStats);

$$('.modal-backdrop').forEach((backdrop) => {
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop || e.target.closest('[data-close]')) backdrop.hidden = true;
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $$('.modal-backdrop').forEach((m) => { m.hidden = true; });
});

// ---------- UI test harness (no Spotify needed; ?uitest=fresh|mid|reveal|probe) ----------

function runUiTest(kind) {
  const art = (hue) => `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,45%)"/><stop offset="1" stop-color="hsl(${hue + 60},70%,25%)"/></linearGradient></defs><rect width="300" height="300" fill="url(#g)"/></svg>`
  )}`;
  const mk = (id, name, artistId, artistName, hue) => ({
    id, uri: `spotify:track:${id}`, name,
    artists: [{ id: artistId, name: artistName }], durMs: 210000, art: art(hue),
  });
  state.uitest = true;
  state.profile = { product: 'premium', country: 'US', name: 'UI Test' };
  const tracks = [
    mk('t1', 'Pyramids', 'fo', 'Frank Ocean', 140),
    mk('t2', 'Nights', 'fo', 'Frank Ocean', 20),
    mk('t3', 'Alright', 'kl', 'Kendrick Lamar', 260),
    mk('t4', 'Ivy', 'fo', 'Frank Ocean', 80),
    mk('t5', 'Money Trees', 'kl', 'Kendrick Lamar', 320),
  ];
  state.cache = { tracks, nextOffset: 250, total: tracks.length, complete: true, updatedAt: Date.now() };
  state.total = tracks.length;
  showScreen('game');
  buildTimeline();
  rebuildSearchPool();
  setPoolLoading(false);
  $('#modeLine').hidden = false;
  updateModeLine();
  if (kind === 'probe') { runPreviewProbe(); return; }
  startRound();
  state.round.track = tracks[0];
  if (kind === 'mid' || kind === 'reveal') {
    submitGuess(state.round, tracks[2]); // wrong artist
    skip(state.round);
    submitGuess(state.round, tracks[1]); // right artist, wrong song
    renderGuessRows();
    updateStageUi();
  }
  if (kind === 'reveal') {
    submitGuess(state.round, tracks[0]);
    endRound();
  }
}

// Real end-to-end check of the preview pipeline (JSONP lookups + audio.play)
// from whatever origin the app is served on. Renders results into the page.
async function runPreviewProbe() {
  const out = document.createElement('pre');
  out.id = 'probeOut';
  out.style.cssText = 'white-space:pre-wrap;font-size:13px;line-height:1.6;color:#eef1f6;background:#12151c;border:1px solid #242b38;padding:16px;border-radius:10px;';
  $('.game-col') ? $('.game-col').prepend(out) : document.body.prepend(out);
  const log = (s) => { out.textContent += `${s}\n`; };
  const tests = [
    { id: 'probe_a', name: 'Blinding Lights', artists: [{ id: 'x1', name: 'The Weeknd' }] },
    { id: 'probe_b', name: 'Tum Hi Ho', artists: [{ id: 'x2', name: 'Arijit Singh' }] },
    { id: 'probe_c', name: 'Kesariya', artists: [{ id: 'x3', name: 'Arijit Singh' }] },
  ];
  for (const t of tests) {
    try {
      const url = await findPreviewUrl(t, 'IN');
      if (!url) { log(`${t.name}: NO MATCH`); continue; }
      const a = new Audio(url);
      await a.play();
      await new Promise((r) => setTimeout(r, 500));
      log(`${t.name}: FOUND, playing=${!a.paused}, position=${a.currentTime.toFixed(2)}s`);
      a.pause();
    } catch (e) {
      log(`${t.name}: ERROR ${e.message}`);
    }
  }
  log('PROBE DONE');
}

// ---------- Boot ----------

(async function boot() {
  LEGACY_KEYS.forEach((k) => localStorage.removeItem(k));
  buildTimeline();
  const uitest = new URLSearchParams(window.location.search).get('uitest');
  if (uitest !== null) {
    runUiTest(uitest || 'fresh');
    return;
  }
  try {
    await handleRedirect();
  } catch (e) {
    toast(e.message, 'error', 8000);
  }
  route();
})();

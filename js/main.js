import { STAGES_MS, MAX_GUESSES, loadSettings, saveSettings } from './config.js';
import {
  getClientId, setClientId, clearClientId, redirectUri, beginLogin,
  handleRedirect, isLoggedIn, logout,
} from './auth.js';
import {
  syncLibrary, getLibrary, getLibrarySyncedAt, getDevices, searchLibrary,
} from './spotify.js';
import { playSnippet, stop as stopPlayback } from './player.js';
import { newRound, submitGuess, skip, loadStats, recordResult } from './game.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  settings: loadSettings(),
  library: null,
  round: null,
  selectedGuess: null,
  playing: false,
  suggestionIndex: -1,
  roundsThisSession: 0,
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
  } else if (!getLibrary()) {
    showScreen('sync');
    startSync();
  } else {
    state.library = getLibrary();
    showScreen('game');
    startRound();
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

// ---------- Sync screen ----------

async function startSync() {
  $('#syncRetryBtn').hidden = true;
  $('#syncStatus').textContent = 'Contacting Spotify...';
  $('#syncProgress').style.width = '0%';
  try {
    const tracks = await syncLibrary((done, total) => {
      $('#syncStatus').textContent = `${done.toLocaleString()} / ${total.toLocaleString()} songs`;
      $('#syncProgress').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    });
    if (!tracks.length) {
      $('#syncStatus').textContent = 'Your Liked Songs list is empty - like some songs on Spotify first, then retry.';
      $('#syncRetryBtn').hidden = false;
      return;
    }
    toast(`Loaded ${tracks.length.toLocaleString()} Liked Songs.`, 'success');
    route();
  } catch (e) {
    if (e.status === 403) {
      $('#syncStatus').textContent = 'Spotify said "403 Forbidden". If you just created the app, make sure you are logged into the SAME Spotify account that owns it (development mode apps only allow the owner + invited users).';
    } else {
      $('#syncStatus').textContent = `Could not load your library: ${e.message}`;
    }
    $('#syncRetryBtn').hidden = false;
  }
}

$('#syncRetryBtn').addEventListener('click', startSync);

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
    const g = state.round.guesses[i];
    if (!g) {
      li.className = `guess-row empty${i === state.round.guesses.length && state.round.status === 'playing' ? ' current' : ''}`;
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
  const totalMs = STAGES_MS[STAGES_MS.length - 1];
  const unlockedMs = STAGES_MS[Math.min(round.stage, STAGES_MS.length - 1)];
  const unlockedPct = (unlockedMs / totalMs) * 100;
  $('#timelineLocked').style.left = round.status === 'playing' ? `${unlockedPct}%` : '100%';
  $('#playBtnLabel').textContent = `Play ${(round.status === 'playing' ? unlockedMs : totalMs) / 1000}s`;

  const next = STAGES_MS[round.stage + 1];
  $('#skipBtn').textContent = next ? `Skip (+${(next - unlockedMs) / 1000}s)` : 'Give up';

  const synced = getLibrarySyncedAt();
  $('#gameFoot').textContent =
    `${state.library.length.toLocaleString()} Liked Songs` +
    (synced ? ` - synced ${new Date(synced).toLocaleDateString()}` : '');
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

function startRound() {
  stopPlayback();
  state.round = newRound(state.library, state.settings);
  state.selectedGuess = null;
  state.roundsThisSession += 1;
  $('#revealCard').hidden = true;
  $('#controls').hidden = false;
  $('#guessInput').value = '';
  $('#submitBtn').disabled = true;
  hideSuggestions();
  buildTimeline();
  renderGuessRows();
  updateStageUi();
  setPlayingUi(false);
}

async function onPlay() {
  if (state.playing) {
    await stopPlayback();
    setPlayingUi(false);
    return;
  }
  const round = state.round;
  const durMs = round.status === 'playing'
    ? STAGES_MS[round.stage]
    : STAGES_MS[STAGES_MS.length - 1];
  const btn = $('#playBtn');
  btn.disabled = true;
  try {
    await playSnippet(round.track, round.startMs, durMs, state.settings, () => setPlayingUi(false));
    setPlayingUi(true);
    animateFill(durMs);
  } catch (e) {
    handlePlayError(e);
  } finally {
    btn.disabled = false;
  }
}

function handlePlayError(e) {
  setPlayingUi(false);
  switch (e.code) {
    case 'premium':
      state.settings.mode = 'preview';
      saveSettings(state.settings);
      toast('Spotify Premium is needed for full-track snippets. Switched to 30s previews - press play again.', 'error', 6500);
      break;
    case 'init':
      state.settings.mode = 'device';
      saveSettings(state.settings);
      toast('The in-browser player is not supported here. Pick a Spotify device in Settings (open Spotify on your Mac/iPhone first).', 'error', 7000);
      openSettings();
      break;
    case 'auth':
      toast('Spotify rejected the web player session. If you just created the Spotify app, make sure "Web Playback SDK" is ticked in its settings.', 'error', 7000);
      break;
    case 'no-device':
      toast(e.message, 'error', 6000);
      openSettings();
      break;
    case 'no-preview':
      toast('No preview found for this song - drawing another one.', 'info');
      finishRoundSilently();
      break;
    default:
      toast(`Playback failed: ${e.message}`, 'error', 6000);
  }
}

// Used when preview mode cannot play the drawn track: abandon without stats.
function finishRoundSilently() {
  startRound();
}

function endRound() {
  stopPlayback();
  setPlayingUi(false);
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
    stopPlayback();
    setPlayingUi(false);
    renderGuessRows();
    updateStageUi();
  } else {
    endRound();
  }
}

$('#playBtn').addEventListener('click', onPlay);

$('#skipBtn').addEventListener('click', () => {
  if (state.round.status !== 'playing') return;
  skip(state.round);
  afterAttempt();
});

$('#submitBtn').addEventListener('click', () => {
  if (!state.selectedGuess || state.round.status !== 'playing') return;
  submitGuess(state.round, state.selectedGuess);
  state.selectedGuess = null;
  $('#guessInput').value = '';
  $('#submitBtn').disabled = true;
  hideSuggestions();
  afterAttempt();
});

$('#nextBtn').addEventListener('click', startRound);

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
  renderSuggestions(searchLibrary(state.library, q));
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

function openSettings() {
  $$('input[name="mode"]').forEach((r) => { r.checked = r.value === state.settings.mode; });
  $$('input[name="snippetStart"]').forEach((r) => { r.checked = r.value === state.settings.snippetStart; });
  toggleDevicePicker();
  const synced = getLibrarySyncedAt();
  $('#libraryInfo').textContent = state.library
    ? `${state.library.length.toLocaleString()} songs, synced ${synced ? new Date(synced).toLocaleString() : 'never'}. Liked something new? Re-sync to include it.`
    : 'Library not synced yet.';
  $('#settingsModal').hidden = false;
}

function toggleDevicePicker() {
  const show = state.settings.mode === 'device';
  $('#devicePicker').hidden = !show;
  if (show) refreshDevices();
}

async function refreshDevices() {
  const list = $('#deviceList');
  list.innerHTML = '<div class="device-empty">Looking for devices...</div>';
  try {
    const devices = await getDevices();
    list.innerHTML = '';
    if (!devices.length) {
      list.innerHTML = '<div class="device-empty">No devices found. Open the Spotify app on your Mac or iPhone (and start/pause any song once so it registers), then hit Refresh.</div>';
      return;
    }
    devices.forEach((d) => {
      const btn = document.createElement('button');
      btn.className = `device-item${d.id === state.settings.deviceId ? ' selected' : ''}`;
      btn.innerHTML = '<strong></strong><small></small>';
      btn.querySelector('strong').textContent = d.name;
      btn.querySelector('small').textContent = d.type + (d.is_active ? ' - active' : '');
      btn.addEventListener('click', () => {
        state.settings.deviceId = d.id;
        state.settings.deviceName = d.name;
        saveSettings(state.settings);
        $$('.device-item').forEach((el) => el.classList.remove('selected'));
        btn.classList.add('selected');
        toast(`Snippets will play on "${d.name}".`, 'success');
      });
      list.appendChild(btn);
    });
  } catch (e) {
    list.innerHTML = '<div class="device-empty">Could not load devices.</div>';
  }
}

$('#settingsBtn').addEventListener('click', openSettings);
$('#refreshDevicesBtn').addEventListener('click', refreshDevices);

$$('input[name="mode"]').forEach((r) => r.addEventListener('change', () => {
  state.settings.mode = r.value;
  saveSettings(state.settings);
  toggleDevicePicker();
}));

$$('input[name="snippetStart"]').forEach((r) => r.addEventListener('change', () => {
  state.settings.snippetStart = r.value;
  saveSettings(state.settings);
  toast(r.value === 'random' ? 'New rounds will start at a random position.' : 'New rounds will start at the beginning of the song.', 'info');
}));

$('#resyncBtn').addEventListener('click', () => {
  $('#settingsModal').hidden = true;
  showScreen('sync');
  startSync();
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

// ---------- UI test harness (no Spotify needed; ?uitest=fresh|mid|reveal) ----------

function runUiTest(kind) {
  const art = (hue) => `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,45%)"/><stop offset="1" stop-color="hsl(${hue + 60},70%,25%)"/></linearGradient></defs><rect width="300" height="300" fill="url(#g)"/></svg>`
  )}`;
  const mk = (id, name, artistId, artistName, hue) => ({
    id, uri: `spotify:track:${id}`, name,
    artists: [{ id: artistId, name: artistName }], durMs: 210000, art: art(hue),
  });
  state.uitest = true;
  state.library = [
    mk('t1', 'Pyramids', 'fo', 'Frank Ocean', 140),
    mk('t2', 'Nights', 'fo', 'Frank Ocean', 20),
    mk('t3', 'Alright', 'kl', 'Kendrick Lamar', 260),
    mk('t4', 'Ivy', 'fo', 'Frank Ocean', 80),
    mk('t5', 'Money Trees', 'kl', 'Kendrick Lamar', 320),
  ];
  showScreen('game');
  startRound();
  state.round.track = state.library[0];
  if (kind === 'mid' || kind === 'reveal') {
    submitGuess(state.round, state.library[2]); // wrong artist
    skip(state.round);
    submitGuess(state.round, state.library[1]); // right artist, wrong song
    renderGuessRows();
    updateStageUi();
  }
  if (kind === 'reveal') {
    submitGuess(state.round, state.library[0]);
    endRound();
  }
}

// ---------- Boot ----------

(async function boot() {
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

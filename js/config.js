// Snippet stage lengths, cumulative (classic Heardle progression).
export const STAGES_MS = [1000, 2000, 4000, 7000, 11000, 16000];
export const MAX_GUESSES = STAGES_MS.length;

// Extra time scheduled after the snippet in Spotify modes, to absorb
// play-command latency so the user never hears LESS than the stage length.
export const SPOTIFY_LATENCY_PAD_MS = 150;

export const SCOPES = [
  'user-library-read',
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');

export const LS = {
  clientId: 'likedle.clientId',
  tokens: 'likedle.tokens',
  library: 'likedle.library',
  librarySyncedAt: 'likedle.librarySyncedAt',
  settings: 'likedle.settings',
  stats: 'likedle.stats',
  recent: 'likedle.recent',
  previewCache: 'likedle.previewCache',
};

export const DEFAULT_SETTINGS = {
  mode: 'browser', // 'browser' | 'device' | 'preview'
  deviceId: null,
  deviceName: null,
  snippetStart: 'start', // 'start' | 'random'
};

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(LS.settings)) || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(LS.settings, JSON.stringify(settings));
}

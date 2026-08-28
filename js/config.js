// Snippet stage lengths, cumulative (classic Heardle progression).
export const STAGES_MS = [1000, 2000, 4000, 7000, 11000, 16000];
export const MAX_GUESSES = STAGES_MS.length;

// Extra time scheduled after the snippet in Spotify modes, to absorb
// play-command latency so the user never hears LESS than the stage length.
export const SPOTIFY_LATENCY_PAD_MS = 150;

// Library loading: the game starts from a few random pages of Liked Songs
// (instant), while the full library syncs in the background for autocomplete.
export const PAGE_SIZE = 50;
export const QUICK_BATCH_PAGES = 3;
export const BG_SYNC_DELAY_MS = 250;
export const MAX_CACHE_TRACKS = 10000;
export const TOP_UP_AFTER_MS = 24 * 60 * 60 * 1000;

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
  libcache: 'likedle.libcache.v2',
  profile: 'likedle.profile',
  settings: 'likedle.settings',
  stats: 'likedle.stats',
  recent: 'likedle.recent',
  previewCache: 'likedle.previewCache.v2',
  premiumHintShown: 'likedle.premiumHintShown',
};

// Keys from the v1 storage layout, cleared at boot.
export const LEGACY_KEYS = ['likedle.library', 'likedle.librarySyncedAt', 'likedle.previewCache'];

export const DEFAULT_SETTINGS = {
  mode: null, // null = auto | 'browser' | 'device' | 'preview'
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

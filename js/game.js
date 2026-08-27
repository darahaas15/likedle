import { STAGES_MS, MAX_GUESSES, LS } from './config.js';
import { normalize } from './spotify.js';

function loadRecent() {
  try { return JSON.parse(localStorage.getItem(LS.recent)) || []; } catch { return []; }
}

export function newRound(library, settings) {
  const recent = loadRecent();
  const recentSet = new Set(recent);
  const pool = library.filter((t) => !recentSet.has(t.id));
  const source = pool.length ? pool : library;
  const track = source[Math.floor(Math.random() * source.length)];

  recent.push(track.id);
  const cap = Math.max(1, Math.min(100, Math.floor(library.length / 2)));
  while (recent.length > cap) recent.shift();
  localStorage.setItem(LS.recent, JSON.stringify(recent));

  const maxSnippet = STAGES_MS[STAGES_MS.length - 1];
  const maxStart = Math.max(0, track.durMs - maxSnippet - 4000);
  const startMs = settings.snippetStart === 'random' ? Math.floor(Math.random() * (maxStart + 1)) : 0;

  return { track, startMs, stage: 0, guesses: [], status: 'playing' };
}

export function isCorrect(round, guess) {
  if (guess.id === round.track.id) return true;
  // Same song saved from a different album/single counts as correct.
  const sameName = normalize(guess.name) === normalize(round.track.name);
  return sameName && sharesArtist(round.track, guess);
}

function sharesArtist(a, b) {
  return a.artists.some((x) => b.artists.some((y) => x.id === y.id));
}

export function submitGuess(round, guess) {
  const correct = isCorrect(round, guess);
  round.guesses.push({
    type: 'guess',
    track: guess,
    correct,
    artistMatch: !correct && sharesArtist(round.track, guess),
  });
  if (correct) round.status = 'won';
  else if (round.guesses.length >= MAX_GUESSES) round.status = 'lost';
  else round.stage += 1;
  return correct;
}

export function skip(round) {
  round.guesses.push({ type: 'skip' });
  if (round.guesses.length >= MAX_GUESSES) round.status = 'lost';
  else round.stage += 1;
}

// ---------- Stats ----------

const EMPTY_STATS = { played: 0, wins: 0, streak: 0, maxStreak: 0, dist: [0, 0, 0, 0, 0, 0] };

export function loadStats() {
  try {
    return { ...EMPTY_STATS, ...(JSON.parse(localStorage.getItem(LS.stats)) || {}) };
  } catch {
    return { ...EMPTY_STATS };
  }
}

export function recordResult(won, attempts) {
  const stats = loadStats();
  stats.played += 1;
  if (won) {
    stats.wins += 1;
    stats.streak += 1;
    stats.maxStreak = Math.max(stats.maxStreak, stats.streak);
    stats.dist[Math.min(attempts, MAX_GUESSES) - 1] += 1;
  } else {
    stats.streak = 0;
  }
  localStorage.setItem(LS.stats, JSON.stringify(stats));
  return stats;
}

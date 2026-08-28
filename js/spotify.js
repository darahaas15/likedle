import { LS, PAGE_SIZE, QUICK_BATCH_PAGES, BG_SYNC_DELAY_MS, MAX_CACHE_TRACKS } from './config.js';
import { getAccessToken, invalidateAccessToken } from './auth.js';

const API = 'https://api.spotify.com/v1';

export async function apiFetch(path, opts = {}, retried = false) {
  const token = await getAccessToken();
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 429 && !retried) {
    const wait = (parseInt(res.headers.get('Retry-After'), 10) || 1) * 1000;
    await new Promise((r) => setTimeout(r, wait + 200));
    return apiFetch(path, opts, true);
  }
  if (res.status === 401 && !retried) {
    invalidateAccessToken();
    return apiFetch(path, opts, true);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Spotify API error ${res.status}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---------- Profile ----------

export function loadProfile() {
  try {
    return JSON.parse(localStorage.getItem(LS.profile));
  } catch {
    return null;
  }
}

export async function fetchAndCacheProfile() {
  const p = await apiFetch('/me');
  const slim = { product: p.product || null, country: p.country || null, name: p.display_name || null };
  localStorage.setItem(LS.profile, JSON.stringify(slim));
  return slim;
}

// ---------- Playback devices ----------

export async function getDevices() {
  const data = await apiFetch('/me/player/devices');
  return (data && data.devices) || [];
}

export function playOnDevice(deviceId, uri, positionMs) {
  return apiFetch(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
    method: 'PUT',
    body: JSON.stringify({ uris: [uri], position_ms: Math.max(0, Math.round(positionMs)) }),
  });
}

export function pauseOnDevice(deviceId) {
  return apiFetch(`/me/player/pause?device_id=${encodeURIComponent(deviceId)}`, { method: 'PUT' });
}

// ---------- Library pages ----------

function mapItems(items) {
  const tracks = [];
  for (const item of items) {
    const t = item.track;
    if (!t || t.is_local || !t.id) continue;
    tracks.push({
      id: t.id,
      uri: t.uri,
      name: t.name,
      artists: t.artists.map((a) => ({ id: a.id, name: a.name })),
      durMs: t.duration_ms,
      art: (t.album && (t.album.images[1] || t.album.images[0]) || {}).url || null,
    });
  }
  return tracks;
}

export async function fetchLibraryPage(offset, limit = PAGE_SIZE) {
  const page = await apiFetch(`/me/tracks?limit=${limit}&offset=${offset}`);
  return { tracks: mapItems(page.items), total: page.total, count: page.items.length };
}

// Spread `pages` non-overlapping windows of `pageSize` randomly across the
// library, so quick-batch answers are unbiased across the whole collection.
export function pickRandomOffsets(total, pages = QUICK_BATCH_PAGES, pageSize = PAGE_SIZE) {
  if (total <= 0) return [];
  if (total <= pages * pageSize) {
    return Array.from({ length: Math.ceil(total / pageSize) }, (_, i) => i * pageSize);
  }
  const maxOffset = total - pageSize;
  const offsets = [];
  let guard = 0;
  while (offsets.length < pages && guard++ < 60) {
    const o = Math.floor(Math.random() * (maxOffset + 1));
    if (offsets.every((x) => Math.abs(x - o) >= pageSize)) offsets.push(o);
  }
  return offsets;
}

// A fast random sample of the library: 1 request for the total, then a few
// random pages in parallel. Playable in a second or two even for huge libraries.
export async function fetchQuickBatch() {
  const first = await fetchLibraryPage(0, 1);
  const total = first.total;
  if (!total) return { total: 0, tracks: [] };
  const offsets = pickRandomOffsets(total);
  const results = await Promise.all(
    offsets.map((o) => fetchLibraryPage(o).catch(() => ({ tracks: [] }))),
  );
  const seen = new Set();
  const tracks = [];
  for (const r of results) {
    for (const t of r.tracks) {
      if (!seen.has(t.id)) { seen.add(t.id); tracks.push(t); }
    }
  }
  return { total, tracks };
}

// ---------- Persistent library cache (filled in the background) ----------

export function loadLibCache() {
  try {
    const c = JSON.parse(localStorage.getItem(LS.libcache));
    if (c && Array.isArray(c.tracks)) return c;
  } catch { /* fall through */ }
  return { tracks: [], nextOffset: 0, total: null, complete: false, updatedAt: 0 };
}

export function saveLibCache(cache) {
  cache.updatedAt = Date.now();
  try {
    localStorage.setItem(LS.libcache, JSON.stringify(cache));
  } catch {
    // Quota exceeded: keep playing from memory; stop persisting.
  }
}

export function clearLibCache() {
  localStorage.removeItem(LS.libcache);
}

// Sequentially fills the cache page by page. Never blocks the game; call
// without awaiting. `shouldContinue` lets the caller cancel (e.g. re-sync).
export async function backgroundSync(cache, { onProgress, shouldContinue } = {}) {
  while (!cache.complete) {
    if (shouldContinue && !shouldContinue()) return cache;
    const { tracks, total, count } = await fetchLibraryPage(cache.nextOffset);
    cache.total = total;
    const seen = new Set(cache.tracks.map((t) => t.id));
    for (const t of tracks) {
      if (!seen.has(t.id)) cache.tracks.push(t);
    }
    cache.nextOffset += PAGE_SIZE;
    if (cache.nextOffset >= total || count === 0 || cache.tracks.length >= MAX_CACHE_TRACKS) {
      cache.complete = true;
    }
    saveLibCache(cache);
    if (onProgress) onProgress(Math.min(cache.nextOffset, total), total, cache.complete);
    if (!cache.complete) await new Promise((r) => setTimeout(r, BG_SYNC_DELAY_MS));
  }
  return cache;
}

// Picks up songs liked since the last full sync (saved tracks are returned
// newest-first, so new likes appear at the front). Cheap: usually 1 request.
export async function topUpLibCache(cache, maxPages = 5) {
  const ids = new Set(cache.tracks.map((t) => t.id));
  const fresh = [];
  for (let p = 0; p < maxPages; p++) {
    const { tracks, total, count } = await fetchLibraryPage(p * PAGE_SIZE);
    cache.total = total;
    const newOnes = tracks.filter((t) => !ids.has(t.id));
    fresh.push(...newOnes);
    if (newOnes.length < tracks.length || count === 0) break;
  }
  if (fresh.length) {
    cache.tracks = [...fresh, ...cache.tracks];
    saveLibCache(cache);
  } else {
    saveLibCache(cache); // refresh updatedAt so we do not re-check every load
  }
  return fresh.length;
}

// ---------- Search / matching helpers ----------

export function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\((feat|with|ft)[^)]*\)/g, '')
    .replace(/\s*-\s*(remaster(ed)?( \d{4})?|single version|radio edit|album version|mono|stereo|live|bonus track)\s*$/g, '')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function searchLibrary(library, query, limit = 8) {
  const nq = normalize(query);
  if (!nq) return [];
  const seen = new Set();
  const scored = [];
  for (const t of library) {
    const name = normalize(t.name);
    const artists = t.artists.map((a) => normalize(a.name)).join(' ');
    const key = `${name}::${normalize(t.artists[0] ? t.artists[0].name : '')}`;
    if (seen.has(key)) continue;
    let score = null;
    if (name.startsWith(nq)) score = 0;
    else if (name.includes(nq)) score = 1;
    else if (artists.includes(nq)) score = 2;
    else if (`${name} ${artists}`.includes(nq)) score = 3;
    if (score !== null) {
      seen.add(key);
      scored.push({ t, score });
    }
  }
  scored.sort((a, b) => a.score - b.score || a.t.name.localeCompare(b.t.name));
  return scored.slice(0, limit).map((x) => x.t);
}

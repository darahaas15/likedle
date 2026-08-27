import { LS } from './config.js';
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

export function getProfile() {
  return apiFetch('/me');
}

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

// ---------- Library ----------

export async function syncLibrary(onProgress) {
  const tracks = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const page = await apiFetch(`/me/tracks?limit=50&offset=${offset}`);
    total = page.total;
    for (const item of page.items) {
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
    offset += page.items.length;
    if (onProgress) onProgress(Math.min(offset, total), total);
    if (!page.items.length) break;
  }
  localStorage.setItem(LS.library, JSON.stringify(tracks));
  localStorage.setItem(LS.librarySyncedAt, String(Date.now()));
  return tracks;
}

export function getLibrary() {
  try {
    const lib = JSON.parse(localStorage.getItem(LS.library));
    return Array.isArray(lib) && lib.length ? lib : null;
  } catch {
    return null;
  }
}

export function getLibrarySyncedAt() {
  const v = localStorage.getItem(LS.librarySyncedAt);
  return v ? parseInt(v, 10) : null;
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

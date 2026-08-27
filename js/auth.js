import { LS, SCOPES } from './config.js';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

export function getClientId() {
  return localStorage.getItem(LS.clientId) || '';
}

export function setClientId(id) {
  localStorage.setItem(LS.clientId, id.trim());
}

export function clearClientId() {
  localStorage.removeItem(LS.clientId);
}

// The app's own URL, normalized so it can be registered verbatim in the
// Spotify dashboard (origin + path, trailing slash, no index.html).
export function redirectUri() {
  let path = window.location.pathname.replace(/index\.html$/, '');
  if (!path.endsWith('/')) path += '/';
  return window.location.origin + path;
}

function b64url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function beginLogin() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
  sessionStorage.setItem('likedle.verifier', verifier);
  sessionStorage.setItem('likedle.state', state);
  const params = new URLSearchParams({
    client_id: getClientId(),
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state,
    code_challenge_method: 'S256',
    code_challenge: b64url(digest),
  });
  window.location.assign(`${AUTH_URL}?${params}`);
}

export function getTokens() {
  try {
    return JSON.parse(localStorage.getItem(LS.tokens));
  } catch {
    return null;
  }
}

function saveTokens(data) {
  const prev = getTokens();
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || (prev && prev.refresh_token) || null,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  };
  localStorage.setItem(LS.tokens, JSON.stringify(tokens));
  return tokens;
}

// Call once on page load. Returns tokens if this load is an OAuth redirect,
// null otherwise. Throws on OAuth errors.
export async function handleRedirect() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const error = params.get('error');
  if (!code && !error) return null;
  const returnedState = params.get('state');
  window.history.replaceState({}, '', redirectUri());
  if (error) throw new Error(`Spotify authorization failed: ${error}`);
  if (returnedState !== sessionStorage.getItem('likedle.state')) {
    throw new Error('Login state mismatch - please try connecting again.');
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: getClientId(),
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      code_verifier: sessionStorage.getItem('likedle.verifier') || '',
    }),
  });
  if (!res.ok) {
    throw new Error(`Spotify login failed (${res.status}). Check that the Redirect URI in your Spotify app matches exactly.`);
  }
  sessionStorage.removeItem('likedle.verifier');
  sessionStorage.removeItem('likedle.state');
  return saveTokens(await res.json());
}

let refreshPromise = null;

export async function getAccessToken() {
  const tokens = getTokens();
  if (!tokens) throw new Error('Not logged in');
  if (Date.now() < tokens.expires_at) return tokens.access_token;
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: getClientId(),
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
        }),
      });
      if (!res.ok) {
        logout(false);
        throw new Error('Your Spotify session expired - please connect again.');
      }
      return saveTokens(await res.json()).access_token;
    })().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

// Used by the API layer to force a refresh after a 401.
export function invalidateAccessToken() {
  const tokens = getTokens();
  if (tokens) {
    tokens.expires_at = 0;
    localStorage.setItem(LS.tokens, JSON.stringify(tokens));
  }
}

export function isLoggedIn() {
  return !!getTokens();
}

export function logout(reload = true) {
  localStorage.removeItem(LS.tokens);
  if (reload) window.location.reload();
}

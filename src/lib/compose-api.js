// import.meta.env?. — node-safe (plain `node --test` imports this module
// without Vite; same pattern as agentServer.js).
export const COMPOSE_API_TOKEN = import.meta.env?.VITE_COMPOSE_API_TOKEN || '';

let _runtimeToken = null;

export function setSensitiveToken(t) {
  _runtimeToken = t || null;
}

export function getSensitiveToken() {
  return _runtimeToken || COMPOSE_API_TOKEN || '';
}

export function withComposeToken(headers = {}) {
  const tok = getSensitiveToken();
  if (!tok) return headers;
  return { ...headers, 'x-compose-token': tok };
}

// ── Mobile pairing token storage (COMP-MOBILE-REMOTE S05) ────────────────────

export const ACCESS_KEY = 'compose:mobile:accessToken';
export const REFRESH_KEY = 'compose:mobile:refreshToken';
export const EXPIRY_KEY = 'compose:mobile:accessExpiry';

let _refreshPromise = null;
// Callback injected by wsFetch at module load — avoids a circular import
// (wsFetch imports compose-api; compose-api must NOT import wsFetch).
let _authModeCallback = null;

export function injectAuthModeCallback(fn) {
  _authModeCallback = fn;
}

export async function getValidAccessToken() {
  const tok = localStorage.getItem(ACCESS_KEY);
  const exp = parseInt(localStorage.getItem(EXPIRY_KEY) || '0', 10);
  if (tok && exp > Date.now() + 30_000) {
    // Keep the in-memory token in sync — on a fresh boot the stored access
    // JWT is valid but setSensitiveToken was never called this session.
    if (getSensitiveToken() !== tok) setSensitiveToken(tok);
    return tok; // 30s skew
  }
  return refreshAccessToken();
}

export async function refreshAccessToken() {
  if (_refreshPromise) return _refreshPromise;
  const refresh = localStorage.getItem(REFRESH_KEY);
  if (!refresh) throw new Error('NoRefreshToken');
  _refreshPromise = fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refresh }),
  }).then(async (r) => {
    if (!r.ok) {
      // Clear stored JWT state and drop to legacy mode (dual-mode contract).
      // Restore the in-memory token to what legacy mode would have: the
      // legacy ?token= pairing value if this device ever had one, else null
      // (NOT the stale access JWT). Whether the next request then succeeds
      // (localhost / legacy server) or gate-401s (remote server → wsFetch's
      // catch path redirects to /m/pair) is the server's call.
      localStorage.removeItem(ACCESS_KEY);
      localStorage.removeItem(REFRESH_KEY);
      localStorage.removeItem(EXPIRY_KEY);
      setSensitiveToken(localStorage.getItem('compose:mobile:sensitiveToken') || null);
      _authModeCallback?.('cockpit'); // legacy
      throw new Error('RefreshFailed');
    }
    const j = await r.json();
    localStorage.setItem(ACCESS_KEY, j.access_token);
    localStorage.setItem(REFRESH_KEY, j.refresh_token);
    localStorage.setItem(EXPIRY_KEY, String(Date.now() + j.expires_in * 1000));
    setSensitiveToken(j.access_token);
    return j.access_token;
  }).finally(() => { _refreshPromise = null; });
  return _refreshPromise;
}

# COMP-MOBILE-REMOTE S05: Client Auth + Mobile Pairing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add JWT-based token refresh, auth-aware wsFetch, a shared WS/SSE URL module, hook migrations to function-URL WS, and the PairPage component — all client-side, strictly additive (zero behavior change on plain localhost).

**Architecture:** wsFetch becomes auth-aware with a `_mode` flag (`'cockpit'` default, `'mobile-paired'`). Token lifecycle lives in compose-api.js. A new wsUrl.js module computes WS/SSE URLs — appending `?token=` only when auth mode + token warrant it. Four raw-WS mobile hooks migrate to createReconnectingWS with function URLs. PairPage handles `/m/pair?code=` consumption and the codeless re-pair screen.

**Tech Stack:** React 18, Vitest + @testing-library/react, jsdom, native browser APIs (localStorage, fetch, WebSocket, EventSource), ES modules — no new npm deps.

**Bare-URL exactness rule (non-negotiable):** With no auth mode set (`'cockpit'` mode, no token), every URL and header this slice touches must be byte-identical to today. Tests assert exact equality.

---

## File Plan

| File | Action | Responsibility |
|---|---|---|
| `src/lib/compose-api.js` | edit | Add token storage constants + getValidAccessToken + refreshAccessToken |
| `src/lib/wsFetch.js` | edit | Add setAuthMode/getAuthMode, paired-mode pre-refresh, gate-coded 401 ladder |
| `src/lib/wsUrl.js` | new | visionWsUrl(), filesWsUrl(), streamUrl(path), setRemoteMode()/isRemoteMode() |
| `src/lib/wsReconnect.js` | edit | Accept url: string \| () => string, resolve fresh per connect() |
| `src/lib/agentStream.js` | edit | defaultAgentStreamUrl() mode switch → proxy path in paired mode |
| `src/mobile/hooks/useActiveBuild.js` | edit | Raw WS → createReconnectingWS(() => visionWsUrl()) |
| `src/mobile/hooks/useIdeas.js` | edit | Raw WS → createReconnectingWS(() => visionWsUrl()) |
| `src/mobile/hooks/useLiveAgents.js` | edit | Raw WS → createReconnectingWS(() => visionWsUrl()) |
| `src/mobile/hooks/usePendingGates.js` | edit | Raw WS → createReconnectingWS(() => visionWsUrl()) |
| `src/mobile/hooks/useRoadmapItems.js` | edit | Static visionWsUrl() string → () => visionWsUrl() function call |
| `src/mobile/hooks/useInteractiveSession.js` | edit | Helper + poll → wsFetch + proxy paths in paired mode |
| `src/mobile/components/AgentCard.jsx` | edit | Fix 404: agentServerUrl('/api/agent/:id/stop') → relative wsFetch |
| `src/mobile/components/AgentDetailView.jsx` | edit | Fix 404: same stop-route fix |
| `src/components/vision/useVisionStore.js` | edit | Desktop WS URL → () => visionWsUrl() (function form) |
| `src/components/vision/useIdeaboxStore.js` | edit | Desktop WS URL → () => visionWsUrl() (function form) |
| `src/components/Canvas.jsx` | edit | /ws/files WS URL → () => filesWsUrl() (function form) |
| `src/components/PopoutView.jsx` | edit | /ws/files WS URL → () => filesWsUrl() (function form) |
| `src/components/vision/useDesignStore.js` | edit | EventSource URL → streamUrl('/api/design/stream') + existing query params |
| `src/mobile/pages/PairPage.jsx` | new | /m/pair?code= flow + codeless re-pair screen |
| `src/mobile/MobileApp.jsx` | edit | /m/pair route before tab parsing; dual-mode boot |
| `test/ui/mobile-pair.test.jsx` | new | PairPage + MobileApp routing + boot mode tests |
| `test/ui/mobile-remote-auth.test.jsx` | new | wsFetch matrix + wsUrl builders + wsReconnect function-URL + hook migration tests |

---

## Task 1: compose-api.js — token storage constants + getValidAccessToken

**Files:**
- Modify: `src/lib/compose-api.js` (existing, 17 LOC)
- Test: `test/ui/mobile-remote-auth.test.jsx` (new, write failing tests first)

### Circular-import resolution

`wsFetch.js` needs `getValidAccessToken()` from compose-api, and refreshAccessToken needs `setSensitiveToken`/`setAuthMode`. The cleanest resolution: **compose-api does NOT import wsFetch**. Instead, wsFetch imports compose-api (for getValidAccessToken/getSensitiveToken/setSensitiveToken), and compose-api accepts `setAuthMode` via a **setter injection** — `refreshAccessToken` calls `_setAuthMode` which is a module-level variable set by `injectAuthModeCallback(fn)` called once from wsFetch at module load time. This avoids any circular dependency.

- `wsFetch.js` imports from `compose-api.js` (getValidAccessToken, getSensitiveToken, setSensitiveToken)
- `wsFetch.js` exports `setAuthMode` / `getAuthMode` (owns the `_mode` variable)
- `compose-api.js` exports `injectAuthModeCallback(fn)` — called by wsFetch.js at module load with its own `setAuthMode`; refreshAccessToken calls `_authModeCallback?.('cockpit')`

- [ ] **Step 1: Write failing tests for token storage constants**

Create `test/ui/mobile-remote-auth.test.jsx`:

```jsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── compose-api token storage ────────────────────────────────────────────────
describe('compose-api token storage', () => {
  let mod;
  beforeEach(async () => {
    localStorage.clear();
    // Re-import fresh module each test via dynamic import with cache-bust won't work
    // in vitest — use the module's exported functions directly
    mod = await import('../../src/lib/compose-api.js');
    mod.setSensitiveToken(null);
  });
  afterEach(() => {
    localStorage.clear();
    mod.setSensitiveToken(null);
  });

  it('exports ACCESS_KEY, REFRESH_KEY, EXPIRY_KEY constants', () => {
    expect(mod.ACCESS_KEY).toBe('compose:mobile:accessToken');
    expect(mod.REFRESH_KEY).toBe('compose:mobile:refreshToken');
    expect(mod.EXPIRY_KEY).toBe('compose:mobile:accessExpiry');
  });

  it('getValidAccessToken returns stored token when not expired (30s skew)', async () => {
    const future = Date.now() + 60_000; // 60s from now, past 30s skew
    localStorage.setItem(mod.ACCESS_KEY, 'my-token');
    localStorage.setItem(mod.EXPIRY_KEY, String(future));
    const tok = await mod.getValidAccessToken();
    expect(tok).toBe('my-token');
  });

  it('getValidAccessToken calls refreshAccessToken when expired', async () => {
    const past = Date.now() - 1000; // expired
    localStorage.setItem(mod.ACCESS_KEY, 'stale-token');
    localStorage.setItem(mod.EXPIRY_KEY, String(past));
    localStorage.setItem(mod.REFRESH_KEY, 'refresh-tok');
    // Mock fetch to return a successful refresh
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 900,
      }),
    }));
    const tok = await mod.getValidAccessToken();
    expect(tok).toBe('new-access');
    expect(localStorage.getItem(mod.ACCESS_KEY)).toBe('new-access');
    expect(localStorage.getItem(mod.REFRESH_KEY)).toBe('new-refresh');
  });

  it('getValidAccessToken calls refreshAccessToken when no token at all', async () => {
    localStorage.setItem(mod.REFRESH_KEY, 'refresh-tok');
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'brand-new',
        refresh_token: 'brand-new-refresh',
        expires_in: 900,
      }),
    }));
    const tok = await mod.getValidAccessToken();
    expect(tok).toBe('brand-new');
  });
});

describe('refreshAccessToken single-flight', () => {
  let mod;
  beforeEach(async () => {
    localStorage.clear();
    mod = await import('../../src/lib/compose-api.js');
    mod.setSensitiveToken(null);
  });
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('concurrent calls share the same promise', async () => {
    localStorage.setItem(mod.REFRESH_KEY, 'refresh-tok');
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({
          access_token: 'tok-a',
          refresh_token: 'ref-a',
          expires_in: 900,
        }),
      };
    });
    const [a, b] = await Promise.all([mod.refreshAccessToken(), mod.refreshAccessToken()]);
    expect(callCount).toBe(1);
    expect(a).toBe('tok-a');
    expect(b).toBe('tok-a');
  });

  it('failure path: clears 3 keys, falls back to legacy token, throws RefreshFailed', async () => {
    localStorage.setItem(mod.REFRESH_KEY, 'bad-refresh');
    localStorage.setItem(mod.ACCESS_KEY, 'stale');
    localStorage.setItem(mod.EXPIRY_KEY, String(Date.now()));
    localStorage.setItem('compose:mobile:sensitiveToken', 'legacy-tok');
    // Inject a mock setAuthMode callback so we can observe it
    let capturedMode = null;
    mod.injectAuthModeCallback((m) => { capturedMode = m; });
    globalThis.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    await expect(mod.refreshAccessToken()).rejects.toThrow('RefreshFailed');
    expect(localStorage.getItem(mod.ACCESS_KEY)).toBeNull();
    expect(localStorage.getItem(mod.REFRESH_KEY)).toBeNull();
    expect(localStorage.getItem(mod.EXPIRY_KEY)).toBeNull();
    expect(capturedMode).toBe('cockpit');
    // sensitiveToken restored to legacy
    expect(mod.getSensitiveToken()).toBe('legacy-tok');
  });

  it('no refresh token → throws NoRefreshToken', async () => {
    await expect(mod.refreshAccessToken()).rejects.toThrow('NoRefreshToken');
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /Users/ruze/reg/my/forge/compose && npx vitest run test/ui/mobile-remote-auth.test.jsx 2>&1 | head -40
```

Expected: FAIL — `ACCESS_KEY` not exported from compose-api.js, functions not found.

- [ ] **Step 3: Implement compose-api.js additions**

Replace `src/lib/compose-api.js` with:

```js
export const COMPOSE_API_TOKEN = import.meta.env.VITE_COMPOSE_API_TOKEN || '';

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

// ── Mobile pairing token storage ─────────────────────────────────────────────

export const ACCESS_KEY = 'compose:mobile:accessToken';
export const REFRESH_KEY = 'compose:mobile:refreshToken';
export const EXPIRY_KEY = 'compose:mobile:accessExpiry';

let _refreshPromise = null;
// Callback injected by wsFetch to avoid circular imports.
let _authModeCallback = null;

export function injectAuthModeCallback(fn) {
  _authModeCallback = fn;
}

export async function getValidAccessToken() {
  const tok = localStorage.getItem(ACCESS_KEY);
  const exp = parseInt(localStorage.getItem(EXPIRY_KEY) || '0', 10);
  if (tok && exp > Date.now() + 30_000) return tok; // 30s skew
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
      localStorage.removeItem(ACCESS_KEY);
      localStorage.removeItem(REFRESH_KEY);
      localStorage.removeItem(EXPIRY_KEY);
      setSensitiveToken(localStorage.getItem('compose:mobile:sensitiveToken') || null);
      _authModeCallback?.('cockpit');
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
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /Users/ruze/reg/my/forge/compose && npx vitest run test/ui/mobile-remote-auth.test.jsx 2>&1 | tail -20
```

Expected: all compose-api token storage tests PASS.

---

## Task 2: wsFetch.js — setAuthMode, paired-mode pre-refresh, 401 ladder

**Files:**
- Modify: `src/lib/wsFetch.js` (existing, 28 LOC)
- Test: `test/ui/mobile-remote-auth.test.jsx` (extend)

- [ ] **Step 1: Write failing tests for wsFetch auth mode**

Append to `test/ui/mobile-remote-auth.test.jsx`:

```jsx
// ─── wsFetch auth mode ────────────────────────────────────────────────────────
describe('wsFetch auth mode', () => {
  let wsMod, apiMod;
  beforeEach(async () => {
    localStorage.clear();
    wsMod = await import('../../src/lib/wsFetch.js');
    apiMod = await import('../../src/lib/compose-api.js');
    wsMod.setAuthMode('cockpit');
    apiMod.setSensitiveToken(null);
    wsMod.setWorkspaceId(null);
  });
  afterEach(() => {
    localStorage.clear();
    wsMod.setAuthMode('cockpit');
    apiMod.setSensitiveToken(null);
    vi.restoreAllMocks();
  });

  it('cockpit mode + no token: URL and headers unchanged (bare-URL exactness)', async () => {
    let capturedHeaders = null;
    globalThis.fetch = vi.fn(async (url, opts) => {
      capturedHeaders = opts?.headers || {};
      return { ok: true, status: 200 };
    });
    await wsMod.wsFetch('/api/foo');
    expect(capturedHeaders['Authorization']).toBeUndefined();
    expect(capturedHeaders['x-compose-token']).toBeUndefined();
  });

  it('cockpit mode + token set: attaches x-compose-token', async () => {
    apiMod.setSensitiveToken('my-cockpit-token');
    let capturedHeaders = null;
    globalThis.fetch = vi.fn(async (url, opts) => {
      capturedHeaders = opts?.headers || {};
      return { ok: true, status: 200 };
    });
    await wsMod.wsFetch('/api/foo');
    expect(capturedHeaders['x-compose-token']).toBe('my-cockpit-token');
  });

  it('paired mode + valid token: attaches Authorization Bearer header', async () => {
    // Set a valid access token
    const future = Date.now() + 60_000;
    localStorage.setItem(apiMod.ACCESS_KEY, 'paired-jwt');
    localStorage.setItem(apiMod.EXPIRY_KEY, String(future));
    wsMod.setAuthMode('mobile-paired');
    let capturedHeaders = null;
    globalThis.fetch = vi.fn(async (url, opts) => {
      capturedHeaders = opts?.headers || {};
      return { ok: true, status: 200 };
    });
    await wsMod.wsFetch('/api/foo');
    expect(capturedHeaders['Authorization']).toBe('Bearer paired-jwt');
  });

  it('401 with no code: returns response normally (legacy failure)', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      clone() { return this; },
      json: async () => ({}), // no code
    }));
    const res = await wsMod.wsFetch('/api/foo');
    expect(res.status).toBe(401);
  });

  it('401 TokenExpired + successful refresh: retries and returns 200', async () => {
    const future = Date.now() + 60_000;
    localStorage.setItem(apiMod.ACCESS_KEY, 'old-jwt');
    localStorage.setItem(apiMod.EXPIRY_KEY, String(future));
    localStorage.setItem(apiMod.REFRESH_KEY, 'ref-tok');
    wsMod.setAuthMode('mobile-paired');
    let callCount = 0;
    globalThis.fetch = vi.fn(async (url) => {
      callCount++;
      if (url === '/api/auth/refresh') {
        return {
          ok: true,
          json: async () => ({
            access_token: 'new-jwt',
            refresh_token: 'new-ref',
            expires_in: 900,
          }),
        };
      }
      if (callCount === 1) {
        // First request to /api/foo returns 401 TokenExpired
        return {
          ok: false,
          status: 401,
          clone() { return this; },
          json: async () => ({ code: 'TokenExpired' }),
        };
      }
      // Retry succeeds
      return { ok: true, status: 200 };
    });
    const res = await wsMod.wsFetch('/api/foo');
    expect(res.status).toBe(200);
  });

  it('401 TokenExpired + refresh fails: redirects to /m/pair and throws NeedsPairing', async () => {
    const future = Date.now() + 60_000;
    localStorage.setItem(apiMod.ACCESS_KEY, 'old-jwt');
    localStorage.setItem(apiMod.EXPIRY_KEY, String(future));
    localStorage.setItem(apiMod.REFRESH_KEY, 'bad-ref');
    wsMod.setAuthMode('mobile-paired');
    // Track location redirect
    const replaced = [];
    const origReplaceState = window.history.replaceState.bind(window.history);
    // Stub window.location.href setter via Object.defineProperty won't work in jsdom;
    // intercept via replaceState (wsFetch uses window.location.href = '/m/pair'):
    // jsdom allows assignment to window.location.href — we just track it was called
    // by checking the value afterwards or by spying on navigation.
    // For jsdom: stub history.replaceState to capture, and the href assignment
    // happens on window.location.href — jsdom routes it through location.assign internally.
    // Simplest: use a writable stub on window.location (jsdom allows this in test mode)
    const originalHref = window.location.href;
    let redirectedTo = null;
    // Intercept location navigation in jsdom: delete and redefine
    Object.defineProperty(window, 'location', {
      writable: true,
      value: {
        ...window.location,
        get href() { return redirectedTo || originalHref; },
        set href(v) { redirectedTo = v; },
      },
    });
    globalThis.fetch = vi.fn(async (url) => {
      if (url === '/api/auth/refresh') {
        return { ok: false, json: async () => ({}) };
      }
      return {
        ok: false,
        status: 401,
        clone() { return this; },
        json: async () => ({ code: 'TokenExpired' }),
      };
    });
    await expect(wsMod.wsFetch('/api/foo')).rejects.toThrow('NeedsPairing');
    expect(redirectedTo).toBe('/m/pair');
  });

  it('401 TokenInvalid on retry: redirects to /m/pair and throws NeedsPairing', async () => {
    localStorage.setItem(apiMod.REFRESH_KEY, 'ref');
    localStorage.setItem(apiMod.ACCESS_KEY, 'jwt');
    localStorage.setItem(apiMod.EXPIRY_KEY, String(Date.now() + 60_000));
    wsMod.setAuthMode('mobile-paired');
    let redirectedTo = null;
    Object.defineProperty(window, 'location', {
      writable: true,
      value: {
        ...window.location,
        get href() { return redirectedTo || '/'; },
        set href(v) { redirectedTo = v; },
      },
    });
    globalThis.fetch = vi.fn(async (url) => {
      if (url === '/api/auth/refresh') {
        return {
          ok: true,
          json: async () => ({ access_token: 'new', refresh_token: 'new-r', expires_in: 900 }),
        };
      }
      // Both attempts return TokenInvalid
      return {
        ok: false,
        status: 401,
        clone() { return this; },
        json: async () => ({ code: 'TokenInvalid' }),
      };
    });
    await expect(wsMod.wsFetch('/api/foo')).rejects.toThrow('NeedsPairing');
    expect(redirectedTo).toBe('/m/pair');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/ruze/reg/my/forge/compose && npx vitest run test/ui/mobile-remote-auth.test.jsx --reporter=verbose 2>&1 | grep -E "(FAIL|PASS|Error)" | head -30
```

Expected: wsFetch tests FAIL — setAuthMode not exported.

- [ ] **Step 3: Implement wsFetch.js additions**

Replace `src/lib/wsFetch.js` with:

```js
/**
 * wsFetch.js — workspace-aware, auth-aware fetch wrapper.
 *
 * COMP-WORKSPACE-HTTP T1: workspace header injection.
 * COMP-MOBILE-REMOTE S05: auth mode ('cockpit' | 'mobile-paired'), gate-coded
 *   401 ladder, token-refresh coordination.
 */

import {
  getValidAccessToken,
  getSensitiveToken,
  setSensitiveToken,
  injectAuthModeCallback,
  refreshAccessToken,
} from './compose-api.js';

let _workspaceId = null;
let _mode = 'cockpit'; // 'cockpit' | 'mobile-paired'

// Register our setAuthMode with compose-api so refreshAccessToken can call back.
injectAuthModeCallback((mode) => { _mode = mode; });

export function setWorkspaceId(id) {
  _workspaceId = id ?? null;
}

export function getWorkspaceId() {
  return _workspaceId;
}

export function setAuthMode(mode) {
  _mode = mode;
}

export function getAuthMode() {
  return _mode;
}

export async function wsFetch(url, opts = {}) {
  if (_mode === 'mobile-paired') {
    // Ensure access token is fresh BEFORE the request. Refresh failure drops us
    // to legacy mode via the injectAuthModeCallback; proceed from there.
    try { await getValidAccessToken(); } catch { /* now in legacy mode */ }
  }

  const headers = { ...(opts.headers || {}) };
  if (_workspaceId) headers['X-Compose-Workspace-Id'] = _workspaceId;
  const tok = getSensitiveToken();
  if (tok) {
    // cockpit mode: x-compose-token (back-compat + new always-attach)
    // paired mode: Authorization Bearer (getSensitiveToken() = access JWT after refresh)
    if (_mode === 'mobile-paired') {
      headers['Authorization'] = `Bearer ${tok}`;
    } else {
      headers['x-compose-token'] = tok;
    }
  }

  let r = await fetch(url, { ...opts, headers });

  // 401 ladder — keyed on gate body codes, NOT on _mode.
  // Localhost (gate unmounted) and requireSensitiveToken 401s carry no `code`,
  // so this branch can never trigger on a non-remote server.
  if (r.status === 401) {
    const body = await r.clone().json().catch(() => ({}));
    if (body.code === 'TokenExpired') {
      try {
        await refreshAccessToken(); // re-enters paired mode on success
      } catch {
        // Gate demanded a JWT and we can't mint one — re-pair is the only path.
        window.location.href = '/m/pair';
        throw new Error('NeedsPairing');
      }
      // Retry once with fresh token
      const freshTok = getSensitiveToken();
      const retryHeaders = { ...headers };
      if (freshTok) retryHeaders['Authorization'] = `Bearer ${freshTok}`;
      r = await fetch(url, { ...opts, headers: retryHeaders });
    }
    if (r.status === 401) {
      const again = await r.clone().json().catch(() => ({}));
      if (again.code === 'TokenExpired' || again.code === 'TokenInvalid') {
        window.location.href = '/m/pair';
        throw new Error('NeedsPairing');
      }
      // 401 without a gate code: legacy sensitive-token failure — surface normally
    }
  }

  return r;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /Users/ruze/reg/my/forge/compose && npx vitest run test/ui/mobile-remote-auth.test.jsx 2>&1 | tail -20
```

Expected: wsFetch auth mode tests PASS.

---

## Task 3: wsUrl.js — shared WS/SSE URL builders

**Files:**
- Create: `src/lib/wsUrl.js` (new)
- Test: `test/ui/mobile-remote-auth.test.jsx` (extend)

- [ ] **Step 1: Write failing tests for wsUrl builders**

Append to `test/ui/mobile-remote-auth.test.jsx`:

```jsx
// ─── wsUrl builders ───────────────────────────────────────────────────────────
describe('wsUrl builders — bare-URL exactness', () => {
  let urlMod, wsMod, apiMod;
  beforeEach(async () => {
    localStorage.clear();
    urlMod = await import('../../src/lib/wsUrl.js');
    wsMod = await import('../../src/lib/wsFetch.js');
    apiMod = await import('../../src/lib/compose-api.js');
    wsMod.setAuthMode('cockpit');
    urlMod.setRemoteMode(false);
    apiMod.setSensitiveToken(null);
    localStorage.clear();
    // jsdom: window.location is http://localhost/
  });
  afterEach(() => {
    localStorage.clear();
    wsMod.setAuthMode('cockpit');
    urlMod.setRemoteMode(false);
    apiMod.setSensitiveToken(null);
  });

  it('visionWsUrl() with no mode/token = today\'s exact URL', () => {
    // Today: `${protocol}//${window.location.host}/ws/vision`
    const expected = `ws://localhost/ws/vision`;
    expect(urlMod.visionWsUrl()).toBe(expected);
  });

  it('filesWsUrl() with no mode/token = today\'s exact URL', () => {
    const expected = `ws://localhost/ws/files`;
    expect(urlMod.filesWsUrl()).toBe(expected);
  });

  it('streamUrl(path) with no params = bare path', () => {
    expect(urlMod.streamUrl('/api/design/stream')).toBe('/api/design/stream');
  });

  it('visionWsUrl() in paired mode with token appends ?token=', () => {
    const future = Date.now() + 60_000;
    localStorage.setItem(apiMod.ACCESS_KEY, 'access-jwt');
    localStorage.setItem(apiMod.EXPIRY_KEY, String(future));
    wsMod.setAuthMode('mobile-paired');
    expect(urlMod.visionWsUrl()).toBe('ws://localhost/ws/vision?token=access-jwt');
  });

  it('filesWsUrl() in paired mode with token appends ?token=', () => {
    const future = Date.now() + 60_000;
    localStorage.setItem(apiMod.ACCESS_KEY, 'access-jwt');
    localStorage.setItem(apiMod.EXPIRY_KEY, String(future));
    wsMod.setAuthMode('mobile-paired');
    expect(urlMod.filesWsUrl()).toBe('ws://localhost/ws/files?token=access-jwt');
  });

  it('visionWsUrl() in cockpit remote mode with sensitive token appends ?token=', () => {
    apiMod.setSensitiveToken('sensitive-token');
    urlMod.setRemoteMode(true);
    expect(urlMod.visionWsUrl()).toBe('ws://localhost/ws/vision?token=sensitive-token');
  });

  it('visionWsUrl() in paired mode with NO token stored = bare URL (token not yet acquired)', () => {
    wsMod.setAuthMode('mobile-paired');
    // No token in localStorage
    expect(urlMod.visionWsUrl()).toBe('ws://localhost/ws/vision');
  });

  it('isRemoteMode() reflects setRemoteMode()', () => {
    urlMod.setRemoteMode(true);
    expect(urlMod.isRemoteMode()).toBe(true);
    urlMod.setRemoteMode(false);
    expect(urlMod.isRemoteMode()).toBe(false);
  });

  it('streamUrl with paired mode + token appends ?token= before other params', () => {
    const future = Date.now() + 60_000;
    localStorage.setItem(apiMod.ACCESS_KEY, 'jwt');
    localStorage.setItem(apiMod.EXPIRY_KEY, String(future));
    wsMod.setAuthMode('mobile-paired');
    // Caller appends own params after
    const base = urlMod.streamUrl('/api/design/stream');
    expect(base).toContain('?token=jwt');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/ruze/reg/my/forge/compose && npx vitest run test/ui/mobile-remote-auth.test.jsx 2>&1 | grep -E "wsUrl|FAIL" | head -20
```

Expected: FAIL — wsUrl.js does not exist.

- [ ] **Step 3: Create src/lib/wsUrl.js**

```js
/**
 * wsUrl.js — COMP-MOBILE-REMOTE S05.
 *
 * Shared URL builders for WebSocket and SSE connections. Appends ?token= only
 * when auth mode + stored token warrant it. With no auth mode set (default
 * 'cockpit') and no token, every URL is byte-identical to today.
 *
 * Desktop sets remoteMode never in v1 (localhost works without tokens since the
 * auth gate is off there). MobileApp / PairPage sets it true when paired.
 */

import { getAuthMode } from './wsFetch.js';
import { ACCESS_KEY } from './compose-api.js';
import { getSensitiveToken } from './compose-api.js';

let _remoteMode = false;

export function setRemoteMode(flag) {
  _remoteMode = !!flag;
}

export function isRemoteMode() {
  return _remoteMode;
}

function wsBase(path) {
  if (typeof window === 'undefined' || !window.location) return path;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
}

function appendToken(url) {
  const mode = getAuthMode();
  if (mode === 'mobile-paired') {
    // Paired: use access JWT (raw read — fresh read per URL computation,
    // which happens per connect() attempt in wsReconnect)
    const tok = localStorage.getItem(ACCESS_KEY);
    if (tok) return `${url}?token=${encodeURIComponent(tok)}`;
  } else if (_remoteMode) {
    // Cockpit remote mode: use sensitive token
    const tok = getSensitiveToken();
    if (tok) return `${url}?token=${encodeURIComponent(tok)}`;
  }
  return url;
}

/**
 * visionWsUrl() — bare ws://host/ws/vision (or with ?token= in remote modes).
 * Use as a function reference: () => visionWsUrl() so the URL is fresh per reconnect.
 */
export function visionWsUrl() {
  return appendToken(wsBase('/ws/vision'));
}

/**
 * filesWsUrl() — bare ws://host/ws/files (or with ?token= in remote modes).
 */
export function filesWsUrl() {
  return appendToken(wsBase('/ws/files'));
}

/**
 * streamUrl(path) — returns the path string, optionally with ?token= prepended
 * as the first query param. The caller appends additional params with &.
 *
 * Example: streamUrl('/api/design/stream') + '&scope=product'
 */
export function streamUrl(path) {
  if (typeof window === 'undefined') return path;
  const mode = getAuthMode();
  if (mode === 'mobile-paired') {
    const tok = localStorage.getItem(ACCESS_KEY);
    if (tok) return `${path}?token=${encodeURIComponent(tok)}`;
  } else if (_remoteMode) {
    const tok = getSensitiveToken();
    if (tok) return `${path}?token=${encodeURIComponent(tok)}`;
  }
  return path;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /Users/ruze/reg/my/forge/compose && npx vitest run test/ui/mobile-remote-auth.test.jsx 2>&1 | tail -20
```

Expected: wsUrl builder tests PASS.

---

## Task 4: wsReconnect.js — accept function URL

**Files:**
- Modify: `src/lib/wsReconnect.js` (existing, 87 LOC)
- Test: `test/ui/mobile-remote-auth.test.jsx` (extend)

- [ ] **Step 1: Write failing test for function-URL wsReconnect**

Append to `test/ui/mobile-remote-auth.test.jsx`:

```jsx
// ─── wsReconnect function-URL ────────────────────────────────────────────────
describe('wsReconnect function URL', () => {
  it('resolves fresh URL per connect() attempt', () => {
    let callCount = 0;
    const urlFn = () => {
      callCount++;
      return `ws://localhost/ws/vision?attempt=${callCount}`;
    };

    const openedUrls = [];
    class TrackWS {
      constructor(url) { openedUrls.push(url); this.onopen = null; this.onclose = null; this.onmessage = null; this.onerror = null; }
      close() { this.onclose?.(); }
    }
    globalThis.WebSocket = TrackWS;

    const { createReconnectingWS } = require('../../src/lib/wsReconnect.js');
    // re-import dynamically in vitest requires a different approach:
    // Since vitest modules are cached, we test via calling close + reconnect
    // We test this via: on first connect, URL is the function result
    expect(openedUrls.length).toBe(0); // pre-check

    // The actual test: passing a function should work without throwing
    // and should use the returned string
    const handle = createReconnectingWS({
      url: urlFn,
      onMessage: () => {},
    });
    expect(openedUrls.length).toBe(1);
    expect(openedUrls[0]).toBe('ws://localhost/ws/vision?attempt=1');
    handle.close();
  });

  it('still works with a plain string URL (backward compat)', () => {
    const openedUrls = [];
    class TrackWS {
      constructor(url) { openedUrls.push(url); this.onopen = null; this.onclose = null; this.onmessage = null; this.onerror = null; }
      close() { this.onclose?.(); }
    }
    globalThis.WebSocket = TrackWS;

    const { createReconnectingWS } = require('../../src/lib/wsReconnect.js');
    const handle = createReconnectingWS({ url: 'ws://localhost/ws/vision', onMessage: () => {} });
    expect(openedUrls[0]).toBe('ws://localhost/ws/vision');
    handle.close();
  });
});
```

> **Note:** vitest doesn't support `require()` — use `await import()`. Adjust:

Actually, since vitest ESM modules are cached, test via a simpler approach — just verify that createReconnectingWS accepts a function without throwing. Write the test like this instead:

```jsx
// ─── wsReconnect function-URL ────────────────────────────────────────────────
describe('wsReconnect function URL', () => {
  beforeEach(() => {
    const openedUrls = [];
    class TrackWS {
      constructor(url) {
        openedUrls.push(url);
        TrackWS.opened = openedUrls;
        this.onopen = null; this.onclose = null; this.onmessage = null; this.onerror = null;
      }
      close() {}
    }
    TrackWS.opened = [];
    globalThis.WebSocket = TrackWS;
    globalThis._trackWSOpened = () => TrackWS.opened;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves fresh URL per connect() when url is a function', async () => {
    const { createReconnectingWS } = await import('../../src/lib/wsReconnect.js');
    let callCount = 0;
    const handle = createReconnectingWS({
      url: () => {
        callCount++;
        return `ws://localhost/ws/vision?attempt=${callCount}`;
      },
      onMessage: () => {},
    });
    // First connect should have called the function once
    const opened = globalThis._trackWSOpened();
    expect(opened.length).toBe(1);
    expect(opened[0]).toBe('ws://localhost/ws/vision?attempt=1');
    handle.close();
  });

  it('string URL still works (backward compat)', async () => {
    const { createReconnectingWS } = await import('../../src/lib/wsReconnect.js');
    const handle = createReconnectingWS({
      url: 'ws://localhost/ws/vision',
      onMessage: () => {},
    });
    const opened = globalThis._trackWSOpened();
    expect(opened[opened.length - 1]).toBe('ws://localhost/ws/vision');
    handle.close();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/ruze/reg/my/forge/compose && npx vitest run test/ui/mobile-remote-auth.test.jsx 2>&1 | grep -E "wsReconnect|resolves fresh" | head -10
```

Expected: FAIL — function URL not supported yet.

- [ ] **Step 3: Edit wsReconnect.js to support function URLs**

In `src/lib/wsReconnect.js`, add a helper before `connect()` and update the `new WebSocket(url)` line:

```js
// Add after the let declarations (line ~26):
function resolveUrl(u) { return typeof u === 'function' ? u() : u; }

// In connect() replace:
//   ws = new WebSocket(url);
// with:
//   ws = new WebSocket(resolveUrl(url));
```

Full diff — edit these lines in `src/lib/wsReconnect.js`:

Find:
```js
  function connect() {
    if (stopped) return;
    try {
      ws = new WebSocket(url);
```

Replace with:
```js
  function resolveUrl(u) { return typeof u === 'function' ? u() : u; }

  function connect() {
    if (stopped) return;
    try {
      ws = new WebSocket(resolveUrl(url));
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /Users/ruze/reg/my/forge/compose && npx vitest run test/ui/mobile-remote-auth.test.jsx 2>&1 | tail -15
```

Expected: wsReconnect function-URL tests PASS.

---

## Task 5: agentStream.js — defaultAgentStreamUrl mode switch

**Files:**
- Modify: `src/lib/agentStream.js` (existing)
- No new tests needed — covered by existing mobile-coverage-sweep + new mobile-remote-auth

- [ ] **Step 1: Edit agentStream.js**

In `src/lib/agentStream.js`, update the imports and `defaultAgentStreamUrl()`:

Find at the top of the file:
```js
import { agentServerUrl } from './agentServer.js';
```

Replace with:
```js
import { agentServerUrl } from './agentServer.js';
import { getAuthMode } from './wsFetch.js';
import { streamUrl } from './wsUrl.js';
```

Find:
```js
export function defaultAgentStreamUrl() {
  if (typeof window === 'undefined' || !window.location) return '';
  return agentServerUrl('/api/agent/stream');
}
```

Replace with:
```js
export function defaultAgentStreamUrl() {
  if (typeof window === 'undefined' || !window.location) return '';
  if (getAuthMode() === 'mobile-paired') {
    // In paired mode, agent stream goes through the 4001 proxy
    return streamUrl('/api/agent/proxy/stream');
  }
  return agentServerUrl('/api/agent/stream');
}
```

- [ ] **Step 2: Verify the build still works**

```bash
cd /Users/ruze/reg/my/forge/compose && npx vitest run test/ui/mobile-remote-auth.test.jsx 2>&1 | tail -5
```

Expected: no regressions — all passing tests stay green.

---

## Task 6: Hook migrations — raw WS → createReconnectingWS(urlFn)

**Files:**
- Modify: `src/mobile/hooks/useActiveBuild.js`
- Modify: `src/mobile/hooks/useIdeas.js`
- Modify: `src/mobile/hooks/useLiveAgents.js`
- Modify: `src/mobile/hooks/usePendingGates.js`
- Modify: `src/mobile/hooks/useRoadmapItems.js`
- Test: `test/ui/mobile-remote-auth.test.jsx` (extend with hook migration check)

Each of these four hooks has a duplicate ~25-line reconnect loop (lines ~60–100). All four get replaced with a `createReconnectingWS(urlFn)` call. Message handling is preserved verbatim — only the WS lifecycle boilerplate is deleted.

- [ ] **Step 1: Write failing test for hook WS migration**

Append to `test/ui/mobile-remote-auth.test.jsx`:

```jsx
// ─── Hook WS migration ────────────────────────────────────────────────────────
describe('hook WS migration: createReconnectingWS with function URL', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async (url) => {
      if (url.includes('/api/build/state')) return { ok: true, json: async () => ({ state: null }) };
      if (url.includes('/api/vision/gates')) return { ok: true, json: async () => ({ gates: [] }) };
      if (url.includes('/api/vision/items')) return { ok: true, json: async () => ({ items: [] }) };
      if (url.includes('/api/agents/tree')) return { ok: true, json: async () => ({ agents: [] }) };
      return { ok: true, json: async () => ({}) };
    });
    class FakeWS {
      constructor(url) { FakeWS.created.push(url); this.onopen = null; this.onclose = null; this.onmessage = null; this.onerror = null; }
      close() {}
    }
    FakeWS.created = [];
    globalThis.WebSocket = FakeWS;
    globalThis._wsCreated = () => FakeWS.created;
  });
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  it('useActiveBuild opens WS to /ws/vision URL (no duplicate loops)', async () => {
    const { renderHook } = await import('@testing-library/react');
    const { useActiveBuild } = await import('../../src/mobile/hooks/useActiveBuild.js');
    const { unmount } = renderHook(() => useActiveBuild());
    // Should have opened exactly one WS (no duplicate setup)
    await new Promise(r => setTimeout(r, 10));
    const urls = globalThis._wsCreated();
    const visionUrls = urls.filter(u => u.includes('/ws/vision'));
    expect(visionUrls.length).toBe(1);
    unmount();
  });

  it('usePendingGates opens WS to /ws/vision', async () => {
    const { renderHook } = await import('@testing-library/react');
    const { usePendingGates } = await import('../../src/mobile/hooks/usePendingGates.js');
    const { unmount } = renderHook(() => usePendingGates());
    await new Promise(r => setTimeout(r, 10));
    const urls = globalThis._wsCreated();
    expect(urls.some(u => u.includes('/ws/vision'))).toBe(true);
    unmount();
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd /Users/ruze/reg/my/forge/compose && npx vitest run test/ui/mobile-remote-auth.test.jsx 2>&1 | grep -E "hook WS|FAIL|PASS" | head -15
```

Expected: runs (existing hooks already open WS, test passes if basic — the real assertion is no double loops after migration).

- [ ] **Step 3: Migrate useActiveBuild.js**

In `src/mobile/hooks/useActiveBuild.js`:

Add import at top:
```js
import { createReconnectingWS } from '../../lib/wsReconnect.js';
import { visionWsUrl } from '../../lib/wsUrl.js';
```

Replace the entire second `useEffect` block (the WS subscription, lines ~62–102) with:

```js
  useEffect(() => {
    let disposed = false;
    const handle = createReconnectingWS({
      url: () => visionWsUrl(),
      onMessage: (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (!msg || !msg.type) return;
          if (msg.type === 'buildState') {
            refetch();
          }
        } catch { /* */ }
      },
    });
    return () => {
      disposed = true;
      try { handle.close(); } catch { /* */ }
    };
  }, [refetch]);
```

Also remove these imports since they're no longer needed by the WS loop:
- `useRef` from 'react' if it was only used by the WS loop (check — it's used by `aliveRef` so keep it)

- [ ] **Step 4: Migrate useIdeas.js**

In `src/mobile/hooks/useIdeas.js`:

Add imports after existing imports:
```js
import { createReconnectingWS } from '../../lib/wsReconnect.js';
import { visionWsUrl } from '../../lib/wsUrl.js';
```

Replace the entire WS subscription `useEffect` block (~lines 75–113) with:

```js
  useEffect(() => {
    let disposed = false;
    const handle = createReconnectingWS({
      url: () => visionWsUrl(),
      onMessage: (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg && msg.type === 'ideaboxUpdated') {
            refetch();
          }
        } catch { /* ignore */ }
      },
    });
    return () => {
      disposed = true;
      try { handle.close(); } catch { /* */ }
    };
  }, [refetch]);
```

- [ ] **Step 5: Migrate useLiveAgents.js**

In `src/mobile/hooks/useLiveAgents.js`:

Add imports after existing imports:
```js
import { createReconnectingWS } from '../../lib/wsReconnect.js';
import { visionWsUrl } from '../../lib/wsUrl.js';
```

Replace the entire WS subscription `useEffect` block (~lines 50–95) with:

```js
  useEffect(() => {
    let disposed = false;
    const handle = createReconnectingWS({
      url: () => visionWsUrl(),
      onMessage: (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (!msg || !msg.type) return;
          if (
            msg.type === 'agentSpawned' ||
            msg.type === 'agentStopped' ||
            msg.type === 'agentStatusChanged' ||
            msg.type === 'agentTreeUpdated'
          ) {
            refetch();
          }
        } catch { /* */ }
      },
    });
    return () => {
      disposed = true;
      try { handle.close(); } catch { /* */ }
    };
  }, [refetch]);
```

- [ ] **Step 6: Migrate usePendingGates.js**

In `src/mobile/hooks/usePendingGates.js`:

Add imports after existing imports:
```js
import { createReconnectingWS } from '../../lib/wsReconnect.js';
import { visionWsUrl } from '../../lib/wsUrl.js';
```

Replace the entire WS subscription `useEffect` block (~lines 46–85) with:

```js
  useEffect(() => {
    let disposed = false;
    const handle = createReconnectingWS({
      url: () => visionWsUrl(),
      onMessage: (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (!msg || !msg.type) return;
          if (msg.type === 'gateCreated' || msg.type === 'gateResolved' || msg.type === 'gateUpdated') {
            refetch();
          }
        } catch { /* */ }
      },
    });
    return () => {
      disposed = true;
      try { handle.close(); } catch { /* */ }
    };
  }, [refetch]);
```

- [ ] **Step 7: Migrate useRoadmapItems.js — string URL → function call**

In `src/mobile/hooks/useRoadmapItems.js`:

At the top of the file, remove the local `visionWsUrl()` function:
```js
// Remove this:
function visionWsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/vision`;
}
```

Add import after existing imports:
```js
import { visionWsUrl } from '../../lib/wsUrl.js';
```

In the `useEffect` that calls `createReconnectingWS`, change:
```js
// From:
    const handle = createReconnectingWS({
      url: visionWsUrl(),
// To:
    const handle = createReconnectingWS({
      url: () => visionWsUrl(),
```

- [ ] **Step 8: Run full vitest suite**

```bash
cd /Users/ruze/reg/my/forge/compose && npx vitest run 2>&1 | tail -20
```

Expected: all tests still green — hook migrations are behavior-preserving.

---

## Task 7: Desktop WS sites — swap inline URL construction for shared builders

**Files:**
- Modify: `src/components/vision/useVisionStore.js`
- Modify: `src/components/vision/useIdeaboxStore.js`
- Modify: `src/components/Canvas.jsx`
- Modify: `src/components/PopoutView.jsx`
- Modify: `src/components/vision/useDesignStore.js`

These are mechanical swaps. Desktop localhost behavior is unchanged (remoteMode=false, no token → bare URL identical to today).

- [ ] **Step 1: Edit useVisionStore.js**

Add import near the top (after existing wsFetch/createReconnectingWS imports):
```js
import { visionWsUrl } from '../../lib/wsUrl.js';
```

Find in `connect()` function (~line 193):
```js
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws/vision`;
    refs.ws = createReconnectingWS({
      url,
```

Replace with:
```js
    refs.ws = createReconnectingWS({
      url: () => visionWsUrl(),
```

- [ ] **Step 2: Edit useIdeaboxStore.js**

Add import after existing imports:
```js
import { visionWsUrl } from '../../lib/wsUrl.js';
```

In `attachWSListener`, find:
```js
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws/vision`);
```

Replace with:
```js
  const ws = new WebSocket(visionWsUrl());
```

- [ ] **Step 3: Edit Canvas.jsx**

Add import after existing imports:
```js
import { filesWsUrl } from '../lib/wsUrl.js';
```

In the WebSocket `useEffect` (~line 267):
```js
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/files`);
```

Replace with:
```js
      const ws = new WebSocket(filesWsUrl());
```

Also remove the `function connect()` wrapper since Canvas.jsx manages its own reconnect via `setTimeout`. The replacement is local to the `new WebSocket(...)` line only — keep the rest of the function intact.

- [ ] **Step 4: Edit PopoutView.jsx**

Add import after existing imports:
```js
import { filesWsUrl } from '../lib/wsUrl.js';
```

In the WS `useEffect` (~line 120):
```js
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/files`);
```

Replace with:
```js
    const ws = new WebSocket(filesWsUrl());
```

- [ ] **Step 5: Edit useDesignStore.js — EventSource → streamUrl**

Add import after existing imports:
```js
import { streamUrl } from '../../lib/wsUrl.js';
```

In `connectSSE()` (~line 237):
```js
    const params = new URLSearchParams({ scope: scope || 'product' });
    if (featureCode) params.set('featureCode', featureCode);
    const es = new EventSource(`/api/design/stream?${params}`);
```

Replace with:
```js
    const params = new URLSearchParams({ scope: scope || 'product' });
    if (featureCode) params.set('featureCode', featureCode);
    const base = streamUrl('/api/design/stream');
    // If streamUrl already added ?token=, use & for additional params; otherwise use ?
    const sep = base.includes('?') ? '&' : '?';
    const es = new EventSource(`${base}${sep}${params}`);
```

- [ ] **Step 6: Run full vitest suite to confirm no regressions**

```bash
cd /Users/ruze/reg/my/forge/compose && npx vitest run 2>&1 | tail -20
```

Expected: all tests green.

---

## Task 8: useInteractiveSession.js — proxy paths in paired mode

**Files:**
- Modify: `src/mobile/hooks/useInteractiveSession.js` (existing)
- Test: `test/ui/mobile-remote-auth.test.jsx` (extend)

- [ ] **Step 1: Write failing test**

Append to `test/ui/mobile-remote-auth.test.jsx`:

```jsx
// ─── useInteractiveSession proxy paths ───────────────────────────────────────
describe('useInteractiveSession proxy paths in paired mode', () => {
  beforeEach(async () => {
    const wsMod = await import('../../src/lib/wsFetch.js');
    wsMod.setAuthMode('cockpit'); // start in legacy mode
    const future = Date.now() + 60_000;
    const apiMod = await import('../../src/lib/compose-api.js');
    localStorage.setItem(apiMod.ACCESS_KEY, 'jwt');
    localStorage.setItem(apiMod.EXPIRY_KEY, String(future));
  });
  afterEach(async () => {
    const wsMod = await import('../../src/lib/wsFetch.js');
    wsMod.setAuthMode('cockpit');
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('legacy mode: status poll calls agentServerUrl (4002)', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ active: false }) };
    });
    const { renderHook } = await import('@testing-library/react');
    const { useInteractiveSession } = await import('../../src/mobile/hooks/useInteractiveSession.js');
    const { unmount } = renderHook(() => useInteractiveSession());
    await new Promise(r => setTimeout(r, 10));
    // Legacy mode: should call via agentServerUrl (contains :4002 or VITE_AGENT_PORT)
    const statusCall = calls.find(u => u.includes('session/status'));
    expect(statusCall).toBeTruthy();
    expect(statusCall).toContain('4002');
    unmount();
  });

  it('paired mode: status poll calls proxy path (/api/agent/proxy/session/status)', async () => {
    const wsMod = await import('../../src/lib/wsFetch.js');
    wsMod.setAuthMode('mobile-paired');
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ active: false }) };
    });
    const { renderHook } = await import('@testing-library/react');
    const { useInteractiveSession } = await import('../../src/mobile/hooks/useInteractiveSession.js');
    const { unmount } = renderHook(() => useInteractiveSession());
    await new Promise(r => setTimeout(r, 10));
    const statusCall = calls.find(u => u.includes('session/status'));
    expect(statusCall).toBeTruthy();
    expect(statusCall).toBe('/api/agent/proxy/session/status');
    unmount();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/ruze/reg/my/forge/compose && npx vitest run test/ui/mobile-remote-auth.test.jsx 2>&1 | grep -E "proxy paths|FAIL" | head -10
```

Expected: FAIL — proxy paths not implemented yet.

- [ ] **Step 3: Edit useInteractiveSession.js**

Replace the file content:

```js
/**
 * useInteractiveSession — tracks the singleton interactive agent session
 * (agent-server.js). Polls GET /api/agent/session/status and exposes
 * sendMessage(text) which posts to /api/agent/session (first message) or
 * /api/agent/message (follow-up). Sends x-compose-token via withComposeToken.
 *
 * In mobile-paired mode, routes through the 4001 proxy instead of hitting
 * agent-server:4002 directly.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { withComposeToken } from '../../lib/compose-api.js';
import { wsFetch, getAuthMode } from '../../lib/wsFetch.js';
import { agentServerUrl } from '../../lib/agentServer.js';

const POLL_MS = 5000;

function resolveAgentPath(path) {
  if (getAuthMode() === 'mobile-paired') {
    // Route through 4001 proxy
    const proxyMap = {
      '/api/agent/session': '/api/agent/proxy/session',
      '/api/agent/message': '/api/agent/proxy/message',
      '/api/agent/interrupt': '/api/agent/proxy/interrupt',
      '/api/agent/session/status': '/api/agent/proxy/session/status',
    };
    return proxyMap[path] || path;
  }
  return agentServerUrl(path);
}

async function postSensitive(path, body) {
  const resolvedPath = resolveAgentPath(path);
  const res = await wsFetch(resolvedPath, {
    method: 'POST',
    headers: withComposeToken({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* */ }
  if (!res.ok) {
    const msg = (data && data.error) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

export function useInteractiveSession() {
  const [active, setActive] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const statusPath = resolveAgentPath('/api/agent/session/status');
      const res = await wsFetch(statusPath);
      const data = await res.json().catch(() => ({}));
      if (!aliveRef.current) return;
      setActive(!!data.active);
      setSessionId(data.sessionId || null);
      setError(null);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err.message);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => {
      aliveRef.current = false;
      clearInterval(id);
    };
  }, [refresh]);

  const sendMessage = useCallback(async (text) => {
    const trimmed = (text || '').trim();
    if (!trimmed) throw new Error('message is empty');
    setSending(true);
    try {
      const path = sessionId ? '/api/agent/message' : '/api/agent/session';
      const result = await postSensitive(path, { prompt: trimmed });
      refresh();
      return result;
    } finally {
      setSending(false);
    }
  }, [sessionId, refresh]);

  const interrupt = useCallback(async () => {
    return postSensitive('/api/agent/interrupt', {});
  }, []);

  return { active, sessionId, loading, error, sending, sendMessage, interrupt, refresh };
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/ruze/reg/my/forge/compose && npx vitest run test/ui/mobile-remote-auth.test.jsx 2>&1 | tail -20
```

Expected: proxy path tests PASS.

---

## Task 9: AgentCard.jsx + AgentDetailView.jsx — fix latent 404

**Files:**
- Modify: `src/mobile/components/AgentCard.jsx`
- Modify: `src/mobile/components/AgentDetailView.jsx`
- Test: `test/ui/mobile-agents.test.jsx` (check existing tests still pass after URL change)

- [ ] **Step 1: Fix AgentCard.jsx**

In `src/mobile/components/AgentCard.jsx`, find at line ~34:
```js
      const res = await wsFetch(agentServerUrl(`/api/agent/${encodeURIComponent(id)}/stop`), {
```

Replace with:
```js
      const res = await wsFetch(`/api/agent/${encodeURIComponent(id)}/stop`, {
```

Also remove the unused `agentServerUrl` import if it's now only used for this:
```js
// Remove this line:
import { agentServerUrl } from '../../lib/agentServer.js';
```

- [ ] **Step 2: Fix AgentDetailView.jsx**

In `src/mobile/components/AgentDetailView.jsx`, find at line ~31:
```js
      const res = await wsFetch(agentServerUrl(`/api/agent/${encodeURIComponent(id)}/stop`), {
```

Replace with:
```js
      const res = await wsFetch(`/api/agent/${encodeURIComponent(id)}/stop`, {
```

Remove unused `agentServerUrl` import:
```js
// Remove this line:
import { agentServerUrl } from '../../lib/agentServer.js';
```

- [ ] **Step 3: Run mobile-agents tests to verify no regressions**

```bash
cd /Users/ruze/reg/my/forge/compose && npx vitest run test/ui/mobile-agents.test.jsx 2>&1 | tail -15
```

Expected: all green.

---

## Task 10: PairPage.jsx — new component

**Files:**
- Create: `src/mobile/pages/PairPage.jsx` (new)
- Create: `src/mobile/pages/` directory
- Test: `test/ui/mobile-pair.test.jsx` (new, write failing tests first)

- [ ] **Step 1: Create test file with failing tests**

Create `test/ui/mobile-pair.test.jsx`:

```jsx
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ACCESS_KEY, REFRESH_KEY, EXPIRY_KEY, getSensitiveToken, setSensitiveToken } from '../../src/lib/compose-api.js';
import { getAuthMode, setAuthMode } from '../../src/lib/wsFetch.js';
import { isRemoteMode, setRemoteMode } from '../../src/lib/wsUrl.js';

// Helper to set URL
function setLocation(path) {
  window.history.replaceState({}, '', path);
}

class FakeWS {
  constructor(url) { this.url = url; FakeWS.instances.push(this); }
  close() {}
  set onmessage(_) {}
  set onerror(_) {}
  set onclose(_) {}
  set onopen(_) {}
}
FakeWS.instances = [];

describe('<PairPage> with code', () => {
  beforeEach(() => {
    localStorage.clear();
    setSensitiveToken(null);
    setAuthMode('cockpit');
    setRemoteMode(false);
    FakeWS.instances = [];
    globalThis.WebSocket = FakeWS;
    // Pre-set location to /m/pair?code=TESTCODE123
    setLocation('/m/pair?code=TESTCODE123');
    globalThis.fetch = vi.fn(async (url) => {
      if (url === '/api/auth/pair/complete') {
        return {
          ok: true,
          json: async () => ({
            access_token: 'access-jwt',
            refresh_token: 'refresh-tok',
            device_id: 'dev_abc',
            expires_in: 900,
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
  });
  afterEach(() => {
    localStorage.clear();
    setSensitiveToken(null);
    setAuthMode('cockpit');
    setRemoteMode(false);
    vi.restoreAllMocks();
  });

  it('renders the device-name form with prefilled name from UA', async () => {
    const { default: PairPage } = await import('../../src/mobile/pages/PairPage.jsx');
    render(<PairPage />);
    const input = screen.getByTestId('mobile-pair-device-name-input');
    expect(input).toBeTruthy();
    // Input should be prefilled (not empty)
    expect(input.value.length).toBeGreaterThan(0);
  });

  it('submit button is labeled "Pair this device"', async () => {
    const { default: PairPage } = await import('../../src/mobile/pages/PairPage.jsx');
    render(<PairPage />);
    expect(screen.getByTestId('mobile-pair-submit-btn')).toBeTruthy();
  });

  it('form submission POSTs to /api/auth/pair/complete with code + device_name', async () => {
    const { default: PairPage } = await import('../../src/mobile/pages/PairPage.jsx');
    render(<PairPage />);
    const input = screen.getByTestId('mobile-pair-device-name-input');
    fireEvent.change(input, { target: { value: 'My iPhone' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-pair-submit-btn'));
    });
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(c => c[0] === '/api/auth/pair/complete');
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.code).toBe('TESTCODE123');
      expect(body.device_name).toBe('My iPhone');
    });
  });

  it('on success: stores 3 keys in localStorage', async () => {
    const { default: PairPage } = await import('../../src/mobile/pages/PairPage.jsx');
    render(<PairPage />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-pair-submit-btn'));
    });
    await waitFor(() => {
      expect(localStorage.getItem(ACCESS_KEY)).toBe('access-jwt');
      expect(localStorage.getItem(REFRESH_KEY)).toBe('refresh-tok');
      expect(localStorage.getItem(EXPIRY_KEY)).toBeTruthy();
    });
  });

  it('on success: setSensitiveToken called with access_token', async () => {
    const { default: PairPage } = await import('../../src/mobile/pages/PairPage.jsx');
    render(<PairPage />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-pair-submit-btn'));
    });
    await waitFor(() => {
      expect(getSensitiveToken()).toBe('access-jwt');
    });
  });

  it('on success: setAuthMode("mobile-paired") and setRemoteMode(true) called', async () => {
    const { default: PairPage } = await import('../../src/mobile/pages/PairPage.jsx');
    render(<PairPage />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-pair-submit-btn'));
    });
    await waitFor(() => {
      expect(getAuthMode()).toBe('mobile-paired');
      expect(isRemoteMode()).toBe(true);
    });
  });

  it('on error: shows error text and suggests compose remote pair', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: 'Code expired' }),
    }));
    const { default: PairPage } = await import('../../src/mobile/pages/PairPage.jsx');
    render(<PairPage />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-pair-submit-btn'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('mobile-pair-error')).toBeTruthy();
      // Should suggest compose remote pair
      expect(screen.getByTestId('mobile-pair-error').textContent).toContain('compose remote pair');
    });
  });
});

describe('<PairPage> codeless screen (no ?code)', () => {
  beforeEach(() => {
    localStorage.clear();
    setSensitiveToken(null);
    setLocation('/m/pair');
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('renders codeless instructions without making any API calls', async () => {
    const { default: PairPage } = await import('../../src/mobile/pages/PairPage.jsx');
    render(<PairPage />);
    expect(screen.getByTestId('mobile-pair-codeless-instructions')).toBeTruthy();
    // No fetch calls should be made on render
    expect(vi.mocked(fetch).mock.calls.length).toBe(0);
  });

  it('shows a paste-URL input for camera-less fallback', async () => {
    const { default: PairPage } = await import('../../src/mobile/pages/PairPage.jsx');
    render(<PairPage />);
    expect(screen.getByTestId('mobile-pair-url-input')).toBeTruthy();
  });

  it('extracting code from pasted URL shows the device-name form', async () => {
    const { default: PairPage } = await import('../../src/mobile/pages/PairPage.jsx');
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'a',
        refresh_token: 'r',
        device_id: 'dev1',
        expires_in: 900,
      }),
    }));
    render(<PairPage />);
    const urlInput = screen.getByTestId('mobile-pair-url-input');
    fireEvent.change(urlInput, { target: { value: 'https://myhost.example.com/m/pair?code=XYZ789' } });
    await waitFor(() => {
      expect(screen.getByTestId('mobile-pair-device-name-input')).toBeTruthy();
    });
    // Verify code was extracted correctly
    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-pair-submit-btn'));
    });
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(c => c[0] === '/api/auth/pair/complete');
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.code).toBe('XYZ789');
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/ruze/reg/my/forge/compose && npx vitest run test/ui/mobile-pair.test.jsx 2>&1 | head -30
```

Expected: FAIL — PairPage.jsx doesn't exist.

- [ ] **Step 3: Create src/mobile/pages/ directory and PairPage.jsx**

```bash
mkdir -p /Users/ruze/reg/my/forge/compose/src/mobile/pages
```

Create `src/mobile/pages/PairPage.jsx`:

```jsx
/**
 * PairPage — /m/pair?code=XXX
 *
 * COMP-MOBILE-REMOTE S05. Two states:
 * 1. With ?code= → device-name form → POST pair/complete → store tokens → redirect
 * 2. Without ?code= → codeless re-pair instructions + paste-URL fallback
 *
 * Uses raw fetch (NOT wsFetch) — this is the bootstrap path, before auth exists.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ACCESS_KEY, REFRESH_KEY, EXPIRY_KEY,
  setSensitiveToken, injectAuthModeCallback,
} from '../../lib/compose-api.js';
import { setAuthMode } from '../../lib/wsFetch.js';
import { setRemoteMode } from '../../lib/wsUrl.js';

function parsePlatformFromUA(ua) {
  if (!ua) return 'Unknown';
  if (/iPad|iPhone|iPod/.test(ua)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'macOS';
  if (/Win/.test(ua)) return 'Windows';
  return 'Unknown';
}

function parseBrowserFromUA(ua) {
  if (!ua) return 'Browser';
  if (/CriOS|Chrome/.test(ua)) return 'Chrome';
  if (/FxiOS|Firefox/.test(ua)) return 'Firefox';
  if (/Safari/.test(ua) && !/Chrome/.test(ua)) return 'Safari';
  return 'Browser';
}

function extractCodeFromUrl(input) {
  try {
    const url = new URL(input);
    return url.searchParams.get('code') || null;
  } catch {
    // Try as relative URL
    try {
      const idx = input.indexOf('?');
      if (idx === -1) return null;
      const params = new URLSearchParams(input.slice(idx + 1));
      return params.get('code') || null;
    } catch {
      return null;
    }
  }
}

export default function PairPage() {
  const [code, setCode] = useState(() => {
    try {
      return new URL(window.location.href).searchParams.get('code') || null;
    } catch {
      return null;
    }
  });
  const [deviceName, setDeviceName] = useState(() => {
    const ua = navigator?.userAgent || '';
    return `${parsePlatformFromUA(ua)} (${parseBrowserFromUA(ua)})`;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [pastedUrl, setPastedUrl] = useState('');

  const handlePastedUrl = useCallback((e) => {
    const val = e.target.value;
    setPastedUrl(val);
    const extracted = extractCodeFromUrl(val);
    if (extracted) {
      setCode(extracted);
      setError(null);
    }
  }, []);

  const handleSubmit = useCallback(async (e) => {
    e?.preventDefault();
    if (!code) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/pair/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, device_name: deviceName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data?.error || `HTTP ${res.status}`;
        setError(`Pairing failed: ${msg}. On your desktop, run \`compose remote pair\` to generate a new code.`);
        return;
      }
      // Store tokens
      const expiresAt = Date.now() + data.expires_in * 1000;
      localStorage.setItem(ACCESS_KEY, data.access_token);
      localStorage.setItem(REFRESH_KEY, data.refresh_token);
      localStorage.setItem(EXPIRY_KEY, String(expiresAt));
      setSensitiveToken(data.access_token);
      setAuthMode('mobile-paired');
      setRemoteMode(true);
      // Redirect to /m/agents
      window.location.href = '/m/agents';
    } catch (err) {
      setError(`Pairing failed: ${err.message}. On your desktop, run \`compose remote pair\` to generate a new code.`);
    } finally {
      setLoading(false);
    }
  }, [code, deviceName]);

  if (!code) {
    // Codeless re-pair screen
    return (
      <div className="m-pair-page" data-testid="mobile-pair-codeless-screen">
        <h1 className="m-pair-title">Pair this device</h1>
        <p data-testid="mobile-pair-codeless-instructions" className="m-pair-instructions">
          This device is not yet paired (or pairing has expired). On your desktop, run{' '}
          <code>compose remote pair</code> or open Cockpit → Pair mobile, then scan the
          QR code. If your camera is unavailable, paste the pairing URL below:
        </p>
        <div className="m-pair-field">
          <label htmlFor="m-pair-url-input" className="m-pair-label">Pairing URL</label>
          <input
            id="m-pair-url-input"
            data-testid="mobile-pair-url-input"
            className="m-pair-input"
            type="text"
            placeholder="https://your-host/m/pair?code=..."
            value={pastedUrl}
            onChange={handlePastedUrl}
          />
        </div>
        {error && (
          <p data-testid="mobile-pair-error" className="m-pair-error">{error}</p>
        )}
      </div>
    );
  }

  // Code present — device-name form
  return (
    <div className="m-pair-page" data-testid="mobile-pair-code-screen">
      <h1 className="m-pair-title">Complete pairing</h1>
      <p className="m-pair-instructions">
        Give this device a name so you can recognize it in the paired devices list.
      </p>
      <form onSubmit={handleSubmit} className="m-pair-form">
        <div className="m-pair-field">
          <label htmlFor="m-pair-device-name" className="m-pair-label">Device name</label>
          <input
            id="m-pair-device-name"
            data-testid="mobile-pair-device-name-input"
            className="m-pair-input"
            type="text"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            disabled={loading}
            required
          />
        </div>
        {error && (
          <p data-testid="mobile-pair-error" className="m-pair-error">{error}</p>
        )}
        <button
          type="submit"
          data-testid="mobile-pair-submit-btn"
          className="m-pair-btn"
          disabled={loading || !deviceName.trim()}
        >
          {loading ? 'Pairing…' : 'Pair this device'}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /Users/ruze/reg/my/forge/compose && npx vitest run test/ui/mobile-pair.test.jsx 2>&1 | tail -25
```

Expected: all PairPage tests PASS.

---

## Task 11: MobileApp.jsx — /m/pair routing + dual-mode boot

**Files:**
- Modify: `src/mobile/MobileApp.jsx`
- Test: `test/ui/mobile-pair.test.jsx` (extend)

- [ ] **Step 1: Write failing tests for MobileApp routing + boot**

Append to `test/ui/mobile-pair.test.jsx`:

```jsx
// ─── MobileApp routing + dual-mode boot ──────────────────────────────────────
describe('MobileApp: /m/pair routing', () => {
  let FakeEventSource;
  beforeEach(() => {
    localStorage.clear();
    setSensitiveToken(null);
    setAuthMode('cockpit');
    setRemoteMode(false);
    class FWS {
      constructor(url) { this.url = url; FWS.instances.push(this); }
      close() {}
      set onmessage(_) {} set onerror(_) {} set onclose(_) {} set onopen(_) {}
    }
    FWS.instances = [];
    globalThis.WebSocket = FWS;
    FakeEventSource = class {
      constructor(url) { this.url = url; }
      addEventListener() {} close() {}
      set onopen(_) {} set onmessage(_) {} set onerror(_) {}
    };
    globalThis.EventSource = FakeEventSource;
    globalThis.fetch = vi.fn(async (url) => {
      if (url.includes('/api/build/state')) return { ok: true, json: async () => ({ state: null }) };
      if (url.includes('/api/vision/gates')) return { ok: true, json: async () => ({ gates: [] }) };
      if (url.includes('/api/vision/items')) return { ok: true, json: async () => ({ items: [] }) };
      if (url.includes('/api/agents/tree')) return { ok: true, json: async () => ({ agents: [] }) };
      if (url.includes('/api/auth/pair/complete')) return { ok: false, json: async () => ({ error: 'test' }) };
      return { ok: true, json: async () => ({}) };
    });
  });
  afterEach(() => {
    localStorage.clear();
    setSensitiveToken(null);
    setAuthMode('cockpit');
    setRemoteMode(false);
    vi.restoreAllMocks();
  });

  it('renders PairPage (not the shell nav) when pathname is /m/pair', async () => {
    window.history.replaceState({}, '', '/m/pair');
    const { default: MobileApp } = await import('../../src/mobile/MobileApp.jsx');
    render(<MobileApp />);
    // Should render the pair page, not the bottom nav
    expect(screen.queryByTestId('mobile-nav-agents')).toBeFalsy();
    expect(screen.getByTestId('mobile-pair-codeless-screen')).toBeTruthy();
  });

  it('renders PairPage with code-form when pathname is /m/pair?code=ABC', async () => {
    window.history.replaceState({}, '', '/m/pair?code=ABC123');
    const { default: MobileApp } = await import('../../src/mobile/MobileApp.jsx');
    render(<MobileApp />);
    expect(screen.queryByTestId('mobile-nav-agents')).toBeFalsy();
    expect(screen.getByTestId('mobile-pair-code-screen')).toBeTruthy();
    expect(screen.getByTestId('mobile-pair-device-name-input')).toBeTruthy();
  });

  it('renders normal tab shell (with nav) at /m/agents', async () => {
    window.history.replaceState({}, '', '/m/agents');
    const { default: MobileApp } = await import('../../src/mobile/MobileApp.jsx');
    render(<MobileApp />);
    expect(screen.getByTestId('mobile-nav-agents')).toBeTruthy();
    expect(screen.queryByTestId('mobile-pair-codeless-screen')).toBeFalsy();
  });
});

describe('MobileApp: dual-mode boot', () => {
  beforeEach(() => {
    localStorage.clear();
    setSensitiveToken(null);
    setAuthMode('cockpit');
    setRemoteMode(false);
    class FWS {
      constructor(url) { this.url = url; }
      close() {}
      set onmessage(_) {} set onerror(_) {} set onclose(_) {} set onopen(_) {}
    }
    globalThis.WebSocket = FWS;
    globalThis.EventSource = class {
      constructor() {}
      addEventListener() {} close() {}
      set onopen(_) {} set onmessage(_) {} set onerror(_) {}
    };
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    window.history.replaceState({}, '', '/m/agents');
  });
  afterEach(() => {
    localStorage.clear();
    setSensitiveToken(null);
    setAuthMode('cockpit');
    setRemoteMode(false);
    vi.restoreAllMocks();
  });

  it('refresh token present → setAuthMode("mobile-paired") on mount', async () => {
    localStorage.setItem(REFRESH_KEY, 'stored-refresh');
    const { default: MobileApp } = await import('../../src/mobile/MobileApp.jsx');
    render(<MobileApp />);
    await waitFor(() => {
      expect(getAuthMode()).toBe('mobile-paired');
    });
  });

  it('no refresh token → stays in cockpit mode (legacy)', async () => {
    // No refresh token
    const { default: MobileApp } = await import('../../src/mobile/MobileApp.jsx');
    render(<MobileApp />);
    await new Promise(r => setTimeout(r, 20));
    expect(getAuthMode()).toBe('cockpit');
  });

  it('legacy ?token= flow intact when no refresh token', async () => {
    window.history.replaceState({}, '', '/m/agents?token=legacy-tok');
    const { default: MobileApp } = await import('../../src/mobile/MobileApp.jsx');
    render(<MobileApp />);
    await waitFor(() => {
      expect(getSensitiveToken()).toBe('legacy-tok');
    });
    expect(getAuthMode()).toBe('cockpit');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/ruze/reg/my/forge/compose && npx vitest run test/ui/mobile-pair.test.jsx 2>&1 | grep -E "routing|dual-mode|FAIL" | head -15
```

Expected: FAIL — `/m/pair` currently falls through to agents tab.

- [ ] **Step 3: Edit MobileApp.jsx**

Add import near the top of file:
```js
import { setAuthMode } from '../lib/wsFetch.js';
import { setRemoteMode } from '../lib/wsUrl.js';
import { REFRESH_KEY } from '../lib/compose-api.js';
import PairPage from './pages/PairPage.jsx';
```

In the component, before `const [tab, setTab] = useState(...)`, add:

```js
  // Route: /m/pair → PairPage (no bottom nav)
  const isPairPage = window.location.pathname === '/m/pair' ||
    window.location.pathname.startsWith('/m/pair?') ||
    (window.location.pathname === '/m/pair');
```

Actually since `pathname` doesn't include the query string, just check:
```js
  const isPairPage = window.location.pathname === '/m/pair';
```

Add a `useEffect` for dual-mode boot (BEFORE the existing token useEffect):

```js
  // Dual-mode boot: if refresh token is present, enter paired mode
  useEffect(() => {
    try {
      const hasRefresh = !!localStorage.getItem(REFRESH_KEY);
      if (hasRefresh) {
        setAuthMode('mobile-paired');
        setRemoteMode(true);
      }
    } catch {
      // best-effort; localStorage failures must not crash the shell
    }
  }, []);
```

Before the return statement, add early return for pair page:

```jsx
  if (isPairPage) {
    return <PairPage />;
  }
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/ruze/reg/my/forge/compose && npx vitest run test/ui/mobile-pair.test.jsx 2>&1 | tail -25
```

Expected: all routing + boot tests PASS.

---

## Task 12: Full test suite run + build verification

**Files:** None changed — validation only.

- [ ] **Step 1: Run all vitest UI tests**

```bash
cd /Users/ruze/reg/my/forge/compose && npx vitest run 2>&1 | tail -30
```

Expected: all tests GREEN. Count the total.

- [ ] **Step 2: Run node --test suite**

```bash
cd /Users/ruze/reg/my/forge/compose && node --test --test-timeout=90000 test/*.test.js 2>&1 | tail -30
```

Expected: green. If `lifecycle-guard-e2e` or `cli-remote` fail alone under load, rerun standalone:

```bash
node --test --test-timeout=90000 test/lifecycle-guard-e2e.test.js 2>&1 | tail -15
node --test --test-timeout=90000 test/cli-remote.test.js 2>&1 | tail -15
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/ruze/reg/my/forge/compose && npm run build 2>&1 | tail -20
```

Expected: build SUCCESS, no import errors.

- [ ] **Step 4: Write breadcrumb**

```bash
echo "$(date -Iseconds) | S05 COMP-MOBILE-REMOTE: client auth + mobile pairing complete" >> /Users/ruze/reg/my/forge/compose/.compose/breadcrumbs.log
```

---

## Self-Review

### Spec coverage check

| Requirement | Task |
|---|---|
| ACCESS_KEY/REFRESH_KEY/EXPIRY_KEY constants | Task 1 |
| getValidAccessToken (30s skew) | Task 1 |
| refreshAccessToken (single-flight, failure path VERBATIM) | Task 1 |
| injectAuthModeCallback (circular-import resolution) | Task 1 |
| setAuthMode / getAuthMode | Task 2 |
| wsFetch paired mode pre-refresh | Task 2 |
| wsFetch cockpit mode x-compose-token always-when-set | Task 2 |
| wsFetch 401 ladder keyed on body.code | Task 2 |
| visionWsUrl / filesWsUrl / streamUrl builders | Task 3 |
| setRemoteMode / isRemoteMode | Task 3 |
| wsReconnect function URL | Task 4 |
| agentStream defaultAgentStreamUrl mode switch | Task 5 |
| useActiveBuild raw-WS → createReconnectingWS | Task 6 |
| useIdeas raw-WS → createReconnectingWS | Task 6 |
| useLiveAgents raw-WS → createReconnectingWS | Task 6 |
| usePendingGates raw-WS → createReconnectingWS | Task 6 |
| useRoadmapItems static URL → function call | Task 6 |
| Desktop WS sites: useVisionStore, useIdeaboxStore, Canvas, PopoutView | Task 7 |
| useDesignStore EventSource → streamUrl | Task 7 |
| useInteractiveSession proxy paths in paired mode | Task 8 |
| AgentCard + AgentDetailView 404 fix | Task 9 |
| PairPage with code: form → POST → store → redirect | Task 10 |
| PairPage error path: show error + suggest compose remote pair | Task 10 |
| PairPage codeless screen: no API calls, paste-URL extraction | Task 10 |
| MobileApp /m/pair routing before tab parsing | Task 11 |
| MobileApp dual-mode boot (refresh key → paired mode) | Task 11 |
| Bare-URL exactness (no mode/token = today's URLs) | Tasks 3, 7 |

### Placeholder scan

No placeholder steps — all code is complete.

### Type/name consistency

- `ACCESS_KEY`, `REFRESH_KEY`, `EXPIRY_KEY` — consistent across compose-api, wsUrl, PairPage, tests
- `setAuthMode`/`getAuthMode` — exported from wsFetch, imported by wsUrl + useInteractiveSession + MobileApp + PairPage
- `setRemoteMode`/`isRemoteMode` — exported from wsUrl, imported by MobileApp + PairPage
- `injectAuthModeCallback` — exported from compose-api, called by wsFetch at module load
- `visionWsUrl`, `filesWsUrl`, `streamUrl` — exported from wsUrl, used in hooks + desktop components
- `createReconnectingWS` — all 4 hook migrations use the same import path `../../lib/wsReconnect.js`

### Desktop remote token decision

Desktop (`useVisionStore`, `useIdeaboxStore`, `Canvas`, `PopoutView`) use `visionWsUrl()`/`filesWsUrl()` in function-URL form. In v1, **desktop never calls `setRemoteMode(true)`** — it's not wired to any env/build flag. The WS URL functions check `_remoteMode` before appending any token; without it, they return bare localhost URLs. This is correct: desktop localhost works without tokens (auth gate is off on localhost). If/when a desktop remote use-case arises, a single `setRemoteMode(true)` call at app boot is sufficient — that's the extension seam, no code refactoring required.

### Circular import resolution

`wsFetch.js` imports from `compose-api.js` (getValidAccessToken, getSensitiveToken, setSensitiveToken). `compose-api.js` does NOT import from `wsFetch.js`. Instead, `compose-api.js` exports `injectAuthModeCallback(fn)` and `wsFetch.js` calls it at module load time with its own `setAuthMode`. This is a one-directional dependency with a single callback injection point — no circular import.

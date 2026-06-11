import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── compose-api token storage ────────────────────────────────────────────────
describe('compose-api token storage', () => {
  let mod;
  beforeEach(async () => {
    localStorage.clear();
    mod = await import('../../src/lib/compose-api.js');
    mod.setSensitiveToken(null);
  });
  afterEach(() => {
    localStorage.clear();
    mod.setSensitiveToken(null);
    vi.restoreAllMocks();
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

  it('getValidAccessToken refreshes when token is within the 30s skew window', async () => {
    const nearExpiry = Date.now() + 10_000; // inside 30s skew
    localStorage.setItem(mod.ACCESS_KEY, 'nearly-stale');
    localStorage.setItem(mod.EXPIRY_KEY, String(nearExpiry));
    localStorage.setItem(mod.REFRESH_KEY, 'refresh-tok');
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'fresh', refresh_token: 'fresh-ref', expires_in: 900,
      }),
    }));
    const tok = await mod.getValidAccessToken();
    expect(tok).toBe('fresh');
  });

  it('getValidAccessToken calls refreshAccessToken when expired', async () => {
    const past = Date.now() - 1000; // expired
    localStorage.setItem(mod.ACCESS_KEY, 'stale-token');
    localStorage.setItem(mod.EXPIRY_KEY, String(past));
    localStorage.setItem(mod.REFRESH_KEY, 'refresh-tok');
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

  it('refreshAccessToken success calls setSensitiveToken with the access token', async () => {
    localStorage.setItem(mod.REFRESH_KEY, 'refresh-tok');
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'acc-x', refresh_token: 'ref-x', expires_in: 900,
      }),
    }));
    await mod.refreshAccessToken();
    expect(mod.getSensitiveToken()).toBe('acc-x');
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
    mod.setSensitiveToken(null);
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

  it('failure path: clears 3 keys, falls back to legacy token, sets cockpit mode, throws RefreshFailed', async () => {
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

  it('failure path with no legacy token: setSensitiveToken(null)', async () => {
    localStorage.setItem(mod.REFRESH_KEY, 'bad-refresh');
    mod.setSensitiveToken('current-jwt');
    mod.injectAuthModeCallback(() => {});
    globalThis.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    await expect(mod.refreshAccessToken()).rejects.toThrow('RefreshFailed');
    // No legacy token → runtime token cleared (falls back to build-time, '' in tests)
    expect(mod.getSensitiveToken()).toBe('');
  });

  it('no refresh token → throws NoRefreshToken', async () => {
    await expect(mod.refreshAccessToken()).rejects.toThrow('NoRefreshToken');
  });
});

// ─── wsFetch auth mode ────────────────────────────────────────────────────────
describe('wsFetch auth mode', () => {
  let wsMod, apiMod;
  let savedLocation;

  function stubLocationHref() {
    const state = { redirectedTo: null };
    savedLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: {
        protocol: 'http:',
        host: 'localhost',
        hostname: 'localhost',
        pathname: '/',
        search: '',
        hash: '',
        get href() { return state.redirectedTo || 'http://localhost/'; },
        set href(v) { state.redirectedTo = v; },
      },
    });
    return state;
  }

  beforeEach(async () => {
    localStorage.clear();
    savedLocation = null;
    wsMod = await import('../../src/lib/wsFetch.js');
    apiMod = await import('../../src/lib/compose-api.js');
    wsMod.setAuthMode('cockpit');
    apiMod.setSensitiveToken(null);
    wsMod.setWorkspaceId(null);
  });
  afterEach(() => {
    if (savedLocation) {
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: savedLocation,
      });
    }
    localStorage.clear();
    wsMod.setAuthMode('cockpit');
    apiMod.setSensitiveToken(null);
    vi.restoreAllMocks();
  });

  it('exports setAuthMode/getAuthMode with cockpit default', () => {
    expect(wsMod.getAuthMode()).toBe('cockpit');
    wsMod.setAuthMode('mobile-paired');
    expect(wsMod.getAuthMode()).toBe('mobile-paired');
    wsMod.setAuthMode('cockpit');
    expect(wsMod.getAuthMode()).toBe('cockpit');
  });

  it('cockpit mode + no token: URL and headers unchanged (bare exactness)', async () => {
    let capturedUrl = null;
    let capturedHeaders = null;
    globalThis.fetch = vi.fn(async (url, opts) => {
      capturedUrl = url;
      capturedHeaders = opts?.headers || {};
      return { ok: true, status: 200 };
    });
    await wsMod.wsFetch('/api/foo');
    expect(capturedUrl).toBe('/api/foo');
    expect(capturedHeaders).toEqual({});
  });

  it('cockpit mode + token set: attaches x-compose-token (always, not just withComposeToken callers)', async () => {
    apiMod.setSensitiveToken('my-cockpit-token');
    let capturedHeaders = null;
    globalThis.fetch = vi.fn(async (url, opts) => {
      capturedHeaders = opts?.headers || {};
      return { ok: true, status: 200 };
    });
    await wsMod.wsFetch('/api/foo');
    expect(capturedHeaders['x-compose-token']).toBe('my-cockpit-token');
    expect(capturedHeaders['Authorization']).toBeUndefined();
  });

  it('workspace header behavior untouched', async () => {
    wsMod.setWorkspaceId('ws-1');
    let capturedHeaders = null;
    globalThis.fetch = vi.fn(async (url, opts) => {
      capturedHeaders = opts?.headers || {};
      return { ok: true, status: 200 };
    });
    await wsMod.wsFetch('/api/foo');
    expect(capturedHeaders['X-Compose-Workspace-Id']).toBe('ws-1');
    wsMod.setWorkspaceId(null);
  });

  it('paired mode + valid token: attaches Authorization Bearer header', async () => {
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
    expect(capturedHeaders['x-compose-token']).toBeUndefined();
  });

  it('paired mode + failed pre-refresh: proceeds in legacy mode (no throw)', async () => {
    // No tokens stored at all → getValidAccessToken throws NoRefreshToken
    wsMod.setAuthMode('mobile-paired');
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200 }));
    const res = await wsMod.wsFetch('/api/foo');
    expect(res.status).toBe(200);
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

  it('401 TokenExpired + successful refresh: retries once with fresh Bearer and returns 200', async () => {
    const future = Date.now() + 60_000;
    localStorage.setItem(apiMod.ACCESS_KEY, 'old-jwt');
    localStorage.setItem(apiMod.EXPIRY_KEY, String(future));
    localStorage.setItem(apiMod.REFRESH_KEY, 'ref-tok');
    wsMod.setAuthMode('mobile-paired');
    let fooCalls = 0;
    let retryAuth = null;
    globalThis.fetch = vi.fn(async (url, opts) => {
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
      fooCalls++;
      if (fooCalls === 1) {
        return {
          ok: false,
          status: 401,
          clone() { return this; },
          json: async () => ({ code: 'TokenExpired' }),
        };
      }
      retryAuth = opts?.headers?.Authorization;
      return { ok: true, status: 200 };
    });
    const res = await wsMod.wsFetch('/api/foo');
    expect(res.status).toBe(200);
    expect(fooCalls).toBe(2);
    expect(retryAuth).toBe('Bearer new-jwt');
  });

  it('401 TokenExpired + refresh fails: redirects to /m/pair and throws NeedsPairing', async () => {
    const state = stubLocationHref();
    const future = Date.now() + 60_000;
    localStorage.setItem(apiMod.ACCESS_KEY, 'old-jwt');
    localStorage.setItem(apiMod.EXPIRY_KEY, String(future));
    localStorage.setItem(apiMod.REFRESH_KEY, 'bad-ref');
    wsMod.setAuthMode('mobile-paired');
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
    expect(state.redirectedTo).toBe('/m/pair');
  });

  it('still-401 TokenInvalid after retry: redirects to /m/pair and throws NeedsPairing', async () => {
    const state = stubLocationHref();
    localStorage.setItem(apiMod.REFRESH_KEY, 'ref');
    localStorage.setItem(apiMod.ACCESS_KEY, 'jwt');
    localStorage.setItem(apiMod.EXPIRY_KEY, String(Date.now() + 60_000));
    wsMod.setAuthMode('mobile-paired');
    globalThis.fetch = vi.fn(async (url) => {
      if (url === '/api/auth/refresh') {
        return {
          ok: true,
          json: async () => ({ access_token: 'new', refresh_token: 'new-r', expires_in: 900 }),
        };
      }
      return {
        ok: false,
        status: 401,
        clone() { return this; },
        json: async () => ({ code: 'TokenExpired' }),
      };
    });
    // First 401 TokenExpired → refresh OK → retry still 401 TokenExpired → redirect
    await expect(wsMod.wsFetch('/api/foo')).rejects.toThrow('NeedsPairing');
    expect(state.redirectedTo).toBe('/m/pair');
  });

  it('401 TokenInvalid on first response (not TokenExpired): redirect + NeedsPairing without refresh attempt', async () => {
    const state = stubLocationHref();
    wsMod.setAuthMode('mobile-paired');
    let refreshCalled = false;
    globalThis.fetch = vi.fn(async (url) => {
      if (url === '/api/auth/refresh') { refreshCalled = true; return { ok: false, json: async () => ({}) }; }
      return {
        ok: false,
        status: 401,
        clone() { return this; },
        json: async () => ({ code: 'TokenInvalid' }),
      };
    });
    await expect(wsMod.wsFetch('/api/foo')).rejects.toThrow('NeedsPairing');
    expect(refreshCalled).toBe(false);
    expect(state.redirectedTo).toBe('/m/pair');
  });
});

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
  });
  afterEach(() => {
    localStorage.clear();
    wsMod.setAuthMode('cockpit');
    urlMod.setRemoteMode(false);
    apiMod.setSensitiveToken(null);
  });

  it("visionWsUrl() with no mode/token = today's exact URL", () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const expected = `${protocol}//${window.location.host}/ws/vision`;
    expect(urlMod.visionWsUrl()).toBe(expected);
  });

  it("filesWsUrl() with no mode/token = today's exact URL", () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const expected = `${protocol}//${window.location.host}/ws/files`;
    expect(urlMod.filesWsUrl()).toBe(expected);
  });

  it('streamUrl(path) with no mode/token = bare path (byte-identical)', () => {
    expect(urlMod.streamUrl('/api/design/stream')).toBe('/api/design/stream');
    expect(urlMod.streamUrl('/api/agent/proxy/stream')).toBe('/api/agent/proxy/stream');
  });

  it('cockpit mode + sensitive token but remoteMode OFF = bare URLs (desktop localhost)', () => {
    apiMod.setSensitiveToken('some-token');
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    expect(urlMod.visionWsUrl()).toBe(`${protocol}//${window.location.host}/ws/vision`);
    expect(urlMod.streamUrl('/api/design/stream')).toBe('/api/design/stream');
  });

  it('visionWsUrl() in paired mode with stored access token appends ?token=', () => {
    localStorage.setItem(apiMod.ACCESS_KEY, 'access-jwt');
    wsMod.setAuthMode('mobile-paired');
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    expect(urlMod.visionWsUrl()).toBe(`${protocol}//${window.location.host}/ws/vision?token=access-jwt`);
  });

  it('filesWsUrl() in paired mode with stored access token appends ?token=', () => {
    localStorage.setItem(apiMod.ACCESS_KEY, 'access-jwt');
    wsMod.setAuthMode('mobile-paired');
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    expect(urlMod.filesWsUrl()).toBe(`${protocol}//${window.location.host}/ws/files?token=access-jwt`);
  });

  it('paired mode with NO stored token = bare URL (token not yet acquired)', () => {
    wsMod.setAuthMode('mobile-paired');
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    expect(urlMod.visionWsUrl()).toBe(`${protocol}//${window.location.host}/ws/vision`);
  });

  it('cockpit mode + remoteMode ON + sensitive token appends ?token=<sensitive>', () => {
    apiMod.setSensitiveToken('sensitive-token');
    urlMod.setRemoteMode(true);
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    expect(urlMod.visionWsUrl()).toBe(`${protocol}//${window.location.host}/ws/vision?token=sensitive-token`);
  });

  it('cockpit mode + remoteMode ON but NO token = bare URL', () => {
    urlMod.setRemoteMode(true);
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    expect(urlMod.visionWsUrl()).toBe(`${protocol}//${window.location.host}/ws/vision`);
  });

  it('isRemoteMode() reflects setRemoteMode()', () => {
    expect(urlMod.isRemoteMode()).toBe(false);
    urlMod.setRemoteMode(true);
    expect(urlMod.isRemoteMode()).toBe(true);
    urlMod.setRemoteMode(false);
    expect(urlMod.isRemoteMode()).toBe(false);
  });

  it('streamUrl in paired mode appends ?token= as first param', () => {
    localStorage.setItem(apiMod.ACCESS_KEY, 'jwt');
    wsMod.setAuthMode('mobile-paired');
    expect(urlMod.streamUrl('/api/design/stream')).toBe('/api/design/stream?token=jwt');
  });
});

// ─── wsReconnect function URL ────────────────────────────────────────────────
describe('wsReconnect function URL', () => {
  let TrackWS;
  beforeEach(() => {
    TrackWS = class {
      constructor(url) {
        TrackWS.opened.push(url);
        this.onopen = null; this.onclose = null; this.onmessage = null; this.onerror = null;
      }
      close() {}
    };
    TrackWS.opened = [];
    globalThis.WebSocket = TrackWS;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
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
    expect(TrackWS.opened.length).toBe(1);
    expect(TrackWS.opened[0]).toBe('ws://localhost/ws/vision?attempt=1');
    handle.close();
  });

  it('re-invokes the URL function on reconnect (fresh token per attempt)', async () => {
    vi.useFakeTimers();
    const { createReconnectingWS } = await import('../../src/lib/wsReconnect.js');
    let callCount = 0;
    const handle = createReconnectingWS({
      url: () => {
        callCount++;
        return `ws://localhost/ws/vision?attempt=${callCount}`;
      },
      onMessage: () => {},
    });
    expect(TrackWS.opened.length).toBe(1);
    // Simulate a close → schedules reconnect with backoff
    const ws1 = TrackWS.opened;
    const instance = handle.socket;
    instance.onclose?.();
    vi.advanceTimersByTime(2000);
    expect(TrackWS.opened.length).toBe(2);
    expect(TrackWS.opened[1]).toBe('ws://localhost/ws/vision?attempt=2');
    handle.close();
    vi.useRealTimers();
  });

  it('string URL still works (backward compat)', async () => {
    const { createReconnectingWS } = await import('../../src/lib/wsReconnect.js');
    const handle = createReconnectingWS({
      url: 'ws://localhost/ws/vision',
      onMessage: () => {},
    });
    expect(TrackWS.opened[TrackWS.opened.length - 1]).toBe('ws://localhost/ws/vision');
    handle.close();
  });
});

// ─── agentStream default URL mode switch ─────────────────────────────────────
describe('defaultAgentStreamUrl mode switch', () => {
  let wsMod, apiMod;
  beforeEach(async () => {
    localStorage.clear();
    wsMod = await import('../../src/lib/wsFetch.js');
    apiMod = await import('../../src/lib/compose-api.js');
    wsMod.setAuthMode('cockpit');
  });
  afterEach(() => {
    localStorage.clear();
    wsMod.setAuthMode('cockpit');
  });

  it("legacy mode: today's exact agentServerUrl URL", async () => {
    const { defaultAgentStreamUrl } = await import('../../src/lib/agentStream.js');
    const { agentServerUrl } = await import('../../src/lib/agentServer.js');
    expect(defaultAgentStreamUrl()).toBe(agentServerUrl('/api/agent/stream'));
  });

  it('paired mode: proxy stream path with ?token=', async () => {
    localStorage.setItem(apiMod.ACCESS_KEY, 'jwt-x');
    wsMod.setAuthMode('mobile-paired');
    const { defaultAgentStreamUrl } = await import('../../src/lib/agentStream.js');
    expect(defaultAgentStreamUrl()).toBe('/api/agent/proxy/stream?token=jwt-x');
  });
});

// ─── Hook WS migration ────────────────────────────────────────────────────────
describe('hook WS migration: createReconnectingWS with function URL', () => {
  let FakeWS;
  beforeEach(() => {
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/api/build/state')) return { ok: true, status: 200, json: async () => ({ state: null }) };
      if (u.includes('/api/vision/gates')) return { ok: true, status: 200, json: async () => ({ gates: [] }) };
      if (u.includes('/api/vision/items')) return { ok: true, status: 200, json: async () => ({ items: [] }) };
      if (u.includes('/api/agents/tree')) return { ok: true, status: 200, json: async () => ({ agents: [] }) };
      if (u.includes('/api/ideabox')) return { ok: true, status: 200, json: async () => ({ ideas: [], killed: [] }) };
      return { ok: true, status: 200, json: async () => ({}) };
    });
    FakeWS = class {
      constructor(url) {
        FakeWS.created.push(url);
        this.onopen = null; this.onclose = null; this.onmessage = null; this.onerror = null;
      }
      close() {}
    };
    FakeWS.created = [];
    globalThis.WebSocket = FakeWS;
  });
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  async function rendersOneVisionWS(hookImport, hookName) {
    const { renderHook } = await import('@testing-library/react');
    const mod = await import(hookImport);
    const { unmount } = renderHook(() => mod[hookName]());
    await new Promise(r => setTimeout(r, 10));
    const visionUrls = FakeWS.created.filter(u => String(u).includes('/ws/vision'));
    expect(visionUrls.length).toBe(1);
    // Bare URL — no token on plain localhost
    expect(visionUrls[0]).toBe(`ws://${window.location.host}/ws/vision`);
    unmount();
  }

  it('useActiveBuild opens exactly one bare /ws/vision WS', async () => {
    await rendersOneVisionWS('../../src/mobile/hooks/useActiveBuild.js', 'useActiveBuild');
  });

  it('usePendingGates opens exactly one bare /ws/vision WS', async () => {
    await rendersOneVisionWS('../../src/mobile/hooks/usePendingGates.js', 'usePendingGates');
  });

  it('useLiveAgents opens exactly one bare /ws/vision WS', async () => {
    await rendersOneVisionWS('../../src/mobile/hooks/useLiveAgents.js', 'useLiveAgents');
  });

  it('useIdeas opens exactly one bare /ws/vision WS', async () => {
    await rendersOneVisionWS('../../src/mobile/hooks/useIdeas.js', 'useIdeas');
  });

  it('useActiveBuild WS message buildState triggers refetch (message handling preserved)', async () => {
    const instances = [];
    const Tracking = class {
      constructor(url) { instances.push(this); this.url = url; this.onopen = null; this.onclose = null; this.onmessage = null; this.onerror = null; }
      close() {}
    };
    globalThis.WebSocket = Tracking;
    const { renderHook, act } = await import('@testing-library/react');
    const { useActiveBuild } = await import('../../src/mobile/hooks/useActiveBuild.js');
    const { unmount } = renderHook(() => useActiveBuild());
    await new Promise(r => setTimeout(r, 10));
    const buildStateCalls = () => vi.mocked(fetch).mock.calls.filter(c => String(c[0]).includes('/api/build/state')).length;
    const before = buildStateCalls();
    expect(instances.length).toBe(1);
    await act(async () => {
      instances[0].onmessage?.({ data: JSON.stringify({ type: 'buildState' }) });
      await new Promise(r => setTimeout(r, 10));
    });
    expect(buildStateCalls()).toBeGreaterThan(before);
    unmount();
  });
});

// ─── useInteractiveSession proxy paths ───────────────────────────────────────
describe('useInteractiveSession proxy paths', () => {
  let wsMod, apiMod;
  beforeEach(async () => {
    localStorage.clear();
    wsMod = await import('../../src/lib/wsFetch.js');
    apiMod = await import('../../src/lib/compose-api.js');
    wsMod.setAuthMode('cockpit');
    apiMod.setSensitiveToken(null);
  });
  afterEach(() => {
    wsMod.setAuthMode('cockpit');
    apiMod.setSensitiveToken(null);
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('legacy mode: status poll calls agentServerUrl (4002 direct)', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ active: false }) };
    });
    const { renderHook } = await import('@testing-library/react');
    const { useInteractiveSession } = await import('../../src/mobile/hooks/useInteractiveSession.js');
    const { unmount } = renderHook(() => useInteractiveSession());
    await new Promise(r => setTimeout(r, 10));
    const statusCall = calls.find(u => u.includes('session/status'));
    expect(statusCall).toBeTruthy();
    expect(statusCall).toContain(':4002');
    expect(statusCall).not.toContain('/proxy/');
    unmount();
  });

  it('paired mode: status poll calls /api/agent/proxy/session/status', async () => {
    localStorage.setItem(apiMod.ACCESS_KEY, 'jwt');
    localStorage.setItem(apiMod.EXPIRY_KEY, String(Date.now() + 60_000));
    wsMod.setAuthMode('mobile-paired');
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ active: false }) };
    });
    const { renderHook } = await import('@testing-library/react');
    const { useInteractiveSession } = await import('../../src/mobile/hooks/useInteractiveSession.js');
    const { unmount } = renderHook(() => useInteractiveSession());
    await new Promise(r => setTimeout(r, 10));
    const statusCall = calls.find(u => u.includes('session/status'));
    expect(statusCall).toBe('/api/agent/proxy/session/status');
    unmount();
  });

  it('paired mode: interrupt posts to /api/agent/proxy/interrupt', async () => {
    localStorage.setItem(apiMod.ACCESS_KEY, 'jwt');
    localStorage.setItem(apiMod.EXPIRY_KEY, String(Date.now() + 60_000));
    wsMod.setAuthMode('mobile-paired');
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ active: false }) };
    });
    const { renderHook, act } = await import('@testing-library/react');
    const { useInteractiveSession } = await import('../../src/mobile/hooks/useInteractiveSession.js');
    const { result, unmount } = renderHook(() => useInteractiveSession());
    await act(async () => { await result.current.interrupt(); });
    expect(calls).toContain('/api/agent/proxy/interrupt');
    unmount();
  });

  it('paired mode: first sendMessage posts to /api/agent/proxy/session', async () => {
    localStorage.setItem(apiMod.ACCESS_KEY, 'jwt');
    localStorage.setItem(apiMod.EXPIRY_KEY, String(Date.now() + 60_000));
    wsMod.setAuthMode('mobile-paired');
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ active: false }) };
    });
    const { renderHook, act } = await import('@testing-library/react');
    const { useInteractiveSession } = await import('../../src/mobile/hooks/useInteractiveSession.js');
    const { result, unmount } = renderHook(() => useInteractiveSession());
    await act(async () => { await result.current.sendMessage('hello'); });
    expect(calls).toContain('/api/agent/proxy/session');
    unmount();
  });

  it('legacy mode: interrupt posts to agentServerUrl path (unchanged)', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ active: false }) };
    });
    const { renderHook, act } = await import('@testing-library/react');
    const { useInteractiveSession } = await import('../../src/mobile/hooks/useInteractiveSession.js');
    const { result, unmount } = renderHook(() => useInteractiveSession());
    await act(async () => { await result.current.interrupt(); });
    const intCall = calls.find(u => u.includes('/api/agent/interrupt'));
    expect(intCall).toContain(':4002');
    unmount();
  });
});

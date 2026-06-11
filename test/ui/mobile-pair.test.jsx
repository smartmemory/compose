import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import {
  ACCESS_KEY, REFRESH_KEY, EXPIRY_KEY,
  getSensitiveToken, setSensitiveToken,
} from '../../src/lib/compose-api.js';
import { getAuthMode, setAuthMode } from '../../src/lib/wsFetch.js';
import { isRemoteMode, setRemoteMode } from '../../src/lib/wsUrl.js';

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

class FakeEventSource {
  constructor(url) { this.url = url; }
  addEventListener() {}
  close() {}
  set onopen(_) {}
  set onmessage(_) {}
  set onerror(_) {}
}

function resetAuthState() {
  localStorage.clear();
  setSensitiveToken(null);
  setAuthMode('cockpit');
  setRemoteMode(false);
}

// PairPage redirects via window.location.href = '/m/agents' — stub the
// location object so jsdom doesn't attempt a real navigation.
let _locationState = null;
let _savedLocation = null;
function stubLocation(initialPath, initialSearch = '') {
  _locationState = { redirectedTo: null };
  _savedLocation = window.location;
  const state = _locationState;
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: {
      protocol: 'http:',
      host: 'localhost',
      hostname: 'localhost',
      pathname: initialPath,
      search: initialSearch,
      hash: '',
      get href() {
        return state.redirectedTo || `http://localhost${initialPath}${initialSearch}`;
      },
      set href(v) { state.redirectedTo = v; },
    },
  });
  return state;
}
function restoreLocation() {
  if (_savedLocation) {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: _savedLocation,
    });
    _savedLocation = null;
  }
}

describe('<PairPage> with code', () => {
  beforeEach(() => {
    resetAuthState();
    FakeWS.instances = [];
    globalThis.WebSocket = FakeWS;
    globalThis.EventSource = FakeEventSource;
    stubLocation('/m/pair', '?code=TESTCODE123');
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
    restoreLocation();
    resetAuthState();
    vi.restoreAllMocks();
  });

  it('renders the device-name form with prefilled name from UA', async () => {
    const { default: PairPage } = await import('../../src/mobile/pages/PairPage.jsx');
    render(<PairPage />);
    const input = screen.getByTestId('mobile-pair-device-name-input');
    expect(input).toBeTruthy();
    expect(input.value.length).toBeGreaterThan(0);
    expect(input.value).toContain('(');
  });

  it('renders a submit button', async () => {
    const { default: PairPage } = await import('../../src/mobile/pages/PairPage.jsx');
    render(<PairPage />);
    expect(screen.getByTestId('mobile-pair-submit-btn')).toBeTruthy();
  });

  it('submission POSTs raw fetch to /api/auth/pair/complete with code + device_name', async () => {
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
      // Raw fetch — no workspace header, no auth header
      expect(call[1].headers).toEqual({ 'Content-Type': 'application/json' });
    });
  });

  it('on success: stores 3 keys, sets sensitive token, paired mode, remote mode, redirects', async () => {
    const { default: PairPage } = await import('../../src/mobile/pages/PairPage.jsx');
    render(<PairPage />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-pair-submit-btn'));
    });
    await waitFor(() => {
      expect(localStorage.getItem(ACCESS_KEY)).toBe('access-jwt');
      expect(localStorage.getItem(REFRESH_KEY)).toBe('refresh-tok');
      expect(Number(localStorage.getItem(EXPIRY_KEY))).toBeGreaterThan(Date.now());
      expect(getSensitiveToken()).toBe('access-jwt');
      expect(getAuthMode()).toBe('mobile-paired');
      expect(isRemoteMode()).toBe(true);
      expect(_locationState.redirectedTo).toBe('/m/agents');
    });
  });

  it('on error: shows error and suggests compose remote pair; no tokens stored', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 410,
      json: async () => ({ error: 'Code expired' }),
    }));
    const { default: PairPage } = await import('../../src/mobile/pages/PairPage.jsx');
    render(<PairPage />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-pair-submit-btn'));
    });
    await waitFor(() => {
      const err = screen.getByTestId('mobile-pair-error');
      expect(err.textContent).toContain('Code expired');
      expect(err.textContent).toContain('compose remote pair');
    });
    expect(localStorage.getItem(ACCESS_KEY)).toBeNull();
    expect(getAuthMode()).toBe('cockpit');
    expect(_locationState.redirectedTo).toBeNull();
  });
});

describe('<PairPage> codeless screen (no ?code)', () => {
  beforeEach(() => {
    resetAuthState();
    globalThis.WebSocket = FakeWS;
    globalThis.EventSource = FakeEventSource;
    stubLocation('/m/pair');
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  });
  afterEach(() => {
    restoreLocation();
    resetAuthState();
    vi.restoreAllMocks();
  });

  it('renders codeless instructions without making any API calls', async () => {
    const { default: PairPage } = await import('../../src/mobile/pages/PairPage.jsx');
    render(<PairPage />);
    expect(screen.getByTestId('mobile-pair-codeless-instructions')).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.length).toBe(0);
  });

  it('mentions compose remote pair in the instructions', async () => {
    const { default: PairPage } = await import('../../src/mobile/pages/PairPage.jsx');
    render(<PairPage />);
    expect(screen.getByTestId('mobile-pair-codeless-instructions').textContent)
      .toContain('compose remote pair');
  });

  it('shows a paste-URL input for camera-less fallback', async () => {
    const { default: PairPage } = await import('../../src/mobile/pages/PairPage.jsx');
    render(<PairPage />);
    expect(screen.getByTestId('mobile-pair-url-input')).toBeTruthy();
  });

  it('pasting a pairing URL extracts the code and shows the device-name form', async () => {
    const { default: PairPage } = await import('../../src/mobile/pages/PairPage.jsx');
    render(<PairPage />);
    const urlInput = screen.getByTestId('mobile-pair-url-input');
    fireEvent.change(urlInput, { target: { value: 'https://myhost.example.com/m/pair?code=XYZ789' } });
    await waitFor(() => {
      expect(screen.getByTestId('mobile-pair-device-name-input')).toBeTruthy();
    });
    // No fetch fired by extraction alone
    expect(vi.mocked(fetch).mock.calls.length).toBe(0);
    // Submitting uses the extracted code
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'a', refresh_token: 'r', device_id: 'dev1', expires_in: 900,
      }),
    }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-pair-submit-btn'));
    });
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(c => c[0] === '/api/auth/pair/complete');
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body).code).toBe('XYZ789');
    });
  });

  it('pasting a non-URL string without a code does nothing (stays codeless)', async () => {
    const { default: PairPage } = await import('../../src/mobile/pages/PairPage.jsx');
    render(<PairPage />);
    const urlInput = screen.getByTestId('mobile-pair-url-input');
    fireEvent.change(urlInput, { target: { value: 'not a url at all' } });
    expect(screen.queryByTestId('mobile-pair-device-name-input')).toBeFalsy();
    expect(vi.mocked(fetch).mock.calls.length).toBe(0);
  });
});

describe('MobileApp: /m/pair routing', () => {
  beforeEach(() => {
    resetAuthState();
    FakeWS.instances = [];
    globalThis.WebSocket = FakeWS;
    globalThis.EventSource = FakeEventSource;
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/api/build/state')) return { ok: true, status: 200, json: async () => ({ state: null }) };
      if (u.includes('/api/vision/gates')) return { ok: true, status: 200, json: async () => ({ gates: [] }) };
      if (u.includes('/api/vision/items')) return { ok: true, status: 200, json: async () => ({ items: [] }) };
      if (u.includes('/api/agents/tree')) return { ok: true, status: 200, json: async () => ({ agents: [] }) };
      return { ok: true, status: 200, json: async () => ({}) };
    });
  });
  afterEach(() => {
    resetAuthState();
    setLocation('/m');
    vi.restoreAllMocks();
  });

  it('renders PairPage without BottomNav when pathname is /m/pair (codeless)', async () => {
    setLocation('/m/pair');
    const { default: MobileApp } = await import('../../src/mobile/MobileApp.jsx');
    render(<MobileApp />);
    expect(screen.getByTestId('mobile-pair-codeless-instructions')).toBeTruthy();
    expect(screen.queryByTestId('mobile-nav-agents')).toBeFalsy();
    expect(screen.queryByTestId('mobile-main')).toBeFalsy();
  });

  it('renders PairPage code form when pathname is /m/pair?code=ABC', async () => {
    setLocation('/m/pair?code=ABC123');
    const { default: MobileApp } = await import('../../src/mobile/MobileApp.jsx');
    render(<MobileApp />);
    expect(screen.getByTestId('mobile-pair-device-name-input')).toBeTruthy();
    expect(screen.queryByTestId('mobile-nav-agents')).toBeFalsy();
  });

  it('renders normal tab shell (with nav) at /m/agents', async () => {
    setLocation('/m/agents');
    const { default: MobileApp } = await import('../../src/mobile/MobileApp.jsx');
    render(<MobileApp />);
    expect(screen.getByTestId('mobile-nav-agents')).toBeTruthy();
    expect(screen.queryByTestId('mobile-pair-codeless-instructions')).toBeFalsy();
  });
});

describe('MobileApp: dual-mode boot', () => {
  beforeEach(() => {
    resetAuthState();
    FakeWS.instances = [];
    globalThis.WebSocket = FakeWS;
    globalThis.EventSource = FakeEventSource;
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    setLocation('/m/agents');
  });
  afterEach(() => {
    resetAuthState();
    setLocation('/m');
    vi.restoreAllMocks();
  });

  it('refresh token present → paired mode + remote mode on mount', async () => {
    localStorage.setItem(REFRESH_KEY, 'stored-refresh');
    const { default: MobileApp } = await import('../../src/mobile/MobileApp.jsx');
    render(<MobileApp />);
    await waitFor(() => {
      expect(getAuthMode()).toBe('mobile-paired');
      expect(isRemoteMode()).toBe(true);
    });
  });

  it('no refresh token → stays cockpit (legacy) mode', async () => {
    const { default: MobileApp } = await import('../../src/mobile/MobileApp.jsx');
    render(<MobileApp />);
    await new Promise(r => setTimeout(r, 20));
    expect(getAuthMode()).toBe('cockpit');
    expect(isRemoteMode()).toBe(false);
  });

  it('legacy ?token= flow intact when no refresh token', async () => {
    setLocation('/m/agents?token=legacy-tok');
    const { default: MobileApp } = await import('../../src/mobile/MobileApp.jsx');
    render(<MobileApp />);
    await waitFor(() => {
      expect(getSensitiveToken()).toBe('legacy-tok');
    });
    expect(getAuthMode()).toBe('cockpit');
    expect(localStorage.getItem('compose:mobile:sensitiveToken')).toBe('legacy-tok');
    expect(window.location.search).toBe('');
  });

  it('legacy stored token restored from localStorage when no refresh token', async () => {
    localStorage.setItem('compose:mobile:sensitiveToken', 'persisted-token');
    const { default: MobileApp } = await import('../../src/mobile/MobileApp.jsx');
    render(<MobileApp />);
    await waitFor(() => {
      expect(getSensitiveToken()).toBe('persisted-token');
    });
    expect(getAuthMode()).toBe('cockpit');
  });
});

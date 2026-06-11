import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import MobileApp from '../../src/mobile/MobileApp.jsx';
import { getSensitiveToken, setSensitiveToken } from '../../src/lib/compose-api.js';

const TOKEN_KEY = 'compose:mobile:sensitiveToken';

// WebSocket stub needed for lifted hooks (usePendingGates, useActiveBuild, useRoadmapItems
// all open WS connections in the shell now)
class FakeWS {
  constructor(url) { this.url = url; FakeWS.instances.push(this); }
  close() {}
  set onmessage(_) {}
  set onerror(_) {}
  set onclose(_) {}
  set onopen(_) {}
}
FakeWS.instances = [];

// EventSource stub for useAgentStream
class FakeEventSource {
  constructor(url) { this.url = url; FakeEventSource.instances.push(this); }
  addEventListener() {}
  close() {}
  set onopen(_) {}
  set onmessage(_) {}
  set onerror(_) {}
}
FakeEventSource.instances = [];

function setLocation(path) {
  window.history.replaceState({}, '', path);
}

describe('<MobileApp> shell', () => {
  beforeEach(() => {
    localStorage.clear();
    setSensitiveToken(null);
    setLocation('/m');
    FakeWS.instances = [];
    FakeEventSource.instances = [];
    globalThis.WebSocket = FakeWS;
    globalThis.EventSource = FakeEventSource;
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/api/build/state')) return { ok: true, status: 200, json: async () => ({ state: null }) };
      if (u.includes('/api/vision/gates')) return { ok: true, status: 200, json: async () => ({ gates: [] }) };
      if (u.includes('/api/vision/items')) return { ok: true, status: 200, json: async () => ({ items: [] }) };
      if (u.includes('/api/agents/tree')) return { ok: true, status: 200, json: async () => ({ agents: [] }) };
      if (u.includes('/api/agent/session/status')) return { ok: true, status: 200, json: async () => ({ active: false }) };
      return { ok: true, status: 200, json: async () => ({}) };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the mobile shell with all 4 nav buttons', () => {
    render(<MobileApp />);
    expect(screen.getByTestId('mobile-root')).toBeTruthy();
    expect(screen.getByTestId('mobile-nav-agents')).toBeTruthy();
    expect(screen.getByTestId('mobile-nav-roadmap')).toBeTruthy();
    expect(screen.getByTestId('mobile-nav-builds')).toBeTruthy();
    expect(screen.getByTestId('mobile-nav-ideas')).toBeTruthy();
  });

  it('defaults to the agents tab', () => {
    render(<MobileApp />);
    expect(screen.getByTestId('mobile-tab-agents')).toBeTruthy();
    expect(screen.getByTestId('mobile-nav-agents').getAttribute('aria-pressed')).toBe('true');
  });

  it('switches to roadmap tab on nav click and updates URL', () => {
    render(<MobileApp />);
    act(() => {
      fireEvent.click(screen.getByTestId('mobile-nav-roadmap'));
    });
    expect(screen.getByTestId('mobile-tab-roadmap')).toBeTruthy();
    expect(window.location.pathname).toBe('/m/roadmap');
  });

  it('switches to ideas, builds tabs and updates URL', () => {
    render(<MobileApp />);
    act(() => { fireEvent.click(screen.getByTestId('mobile-nav-ideas')); });
    expect(screen.getByTestId('mobile-tab-ideas')).toBeTruthy();
    expect(window.location.pathname).toBe('/m/ideas');

    act(() => { fireEvent.click(screen.getByTestId('mobile-nav-builds')); });
    expect(screen.getByTestId('mobile-tab-builds')).toBeTruthy();
    expect(window.location.pathname).toBe('/m/builds');
  });

  it('reads tab from initial pathname', () => {
    setLocation('/m/builds');
    render(<MobileApp />);
    expect(screen.getByTestId('mobile-tab-builds')).toBeTruthy();
  });

  it('persists ?token=... to localStorage, applies to compose-api, and strips from URL', () => {
    setLocation('/m/agents?token=abc123');
    render(<MobileApp />);
    expect(localStorage.getItem(TOKEN_KEY)).toBe('abc123');
    expect(getSensitiveToken()).toBe('abc123');
    // URL stripped of ?token=
    expect(window.location.search).toBe('');
    expect(window.location.pathname).toBe('/m/agents');
  });

  it('restores token from localStorage on mount when no ?token= present', () => {
    localStorage.setItem(TOKEN_KEY, 'persisted-token');
    setLocation('/m');
    render(<MobileApp />);
    expect(getSensitiveToken()).toBe('persisted-token');
  });

  it('renders the MobileAlertBar in the shell (mounts and shows alert on compose:notify)', async () => {
    render(<MobileApp />);
    // Fire a compose:notify event — MobileAlertBar should render and display it
    act(() => {
      window.dispatchEvent(new CustomEvent('compose:notify', {
        detail: { message: 'Shell test alert', level: 'info', ttl: 0 },
      }));
    });
    await waitFor(() => {
      expect(screen.getByTestId('mobile-alert-bar')).toBeTruthy();
    });
    expect(screen.getByTestId('mobile-alert-info').textContent).toContain('Shell test alert');
  });
});

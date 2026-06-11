import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { renderHook, act as hookAct } from '@testing-library/react';
import BottomNav from '../../src/mobile/components/BottomNav.jsx';
import MobileAlertBar from '../../src/mobile/components/MobileAlertBar.jsx';
import { setSensitiveToken } from '../../src/lib/compose-api.js';

// WebSocket stub for hooks used in MobileApp
class FakeWS {
  constructor() { FakeWS.instances.push(this); }
  close() {}
  set onmessage(_) {}
  set onerror(_) {}
  set onclose(_) {}
  set onopen(_) {}
}
FakeWS.instances = [];

beforeEach(() => {
  globalThis.WebSocket = FakeWS;
  FakeWS.instances = [];
  setSensitiveToken('test-token');
  globalThis.fetch = vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({}),
  }));
});

afterEach(() => {
  setSensitiveToken(null);
  vi.restoreAllMocks();
});

// ─── BottomNav badge tests ────────────────────────────────────────────────

describe('<BottomNav> badges', () => {
  it('renders no badge elements when badges prop is absent', () => {
    render(<BottomNav active="agents" onSelect={() => {}} />);
    expect(screen.queryByTestId('mobile-nav-badge-agents')).toBeFalsy();
    expect(screen.queryByTestId('mobile-nav-badge-builds')).toBeFalsy();
  });

  it('renders a pill badge with count on the agents tab', () => {
    render(<BottomNav active="agents" onSelect={() => {}} badges={{ agents: { count: 3, level: 'warn' } }} />);
    const badge = screen.getByTestId('mobile-nav-badge-agents');
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain('3');
    expect(badge.className).toContain('m-nav-badge-warn');
  });

  it('renders a dot badge (no count) on the builds tab', () => {
    render(<BottomNav active="agents" onSelect={() => {}} badges={{ builds: { level: 'error' } }} />);
    const badge = screen.getByTestId('mobile-nav-badge-builds');
    expect(badge).toBeTruthy();
    // Dot badge has empty text content
    expect(badge.textContent.trim()).toBe('');
    expect(badge.className).toContain('m-nav-badge-error');
  });

  it('renders badges for multiple tabs simultaneously', () => {
    render(
      <BottomNav
        active="agents"
        onSelect={() => {}}
        badges={{
          agents: { count: 2, level: 'warn' },
          builds: { level: 'error' },
        }}
      />
    );
    expect(screen.getByTestId('mobile-nav-badge-agents')).toBeTruthy();
    expect(screen.getByTestId('mobile-nav-badge-builds')).toBeTruthy();
    expect(screen.queryByTestId('mobile-nav-badge-roadmap')).toBeFalsy();
  });
});

// ─── MobileAlertBar tests ─────────────────────────────────────────────────

describe('<MobileAlertBar>', () => {
  function dispatch(message, level = 'info', ttl = 4000) {
    window.dispatchEvent(new CustomEvent('compose:notify', { detail: { message, level, ttl } }));
  }

  it('renders nothing initially (no alerts)', () => {
    render(<MobileAlertBar />);
    expect(screen.queryByTestId('mobile-alert-info')).toBeFalsy();
    expect(screen.queryByTestId('mobile-alert-warn')).toBeFalsy();
    expect(screen.queryByTestId('mobile-alert-error')).toBeFalsy();
  });

  it('shows an alert when compose:notify is dispatched', async () => {
    render(<MobileAlertBar />);
    act(() => { dispatch('Test message', 'info', 4000); });
    await waitFor(() => {
      expect(screen.getByTestId('mobile-alert-info')).toBeTruthy();
    });
    expect(screen.getByTestId('mobile-alert-info').textContent).toContain('Test message');
  });

  it('shows a warn-level alert', async () => {
    render(<MobileAlertBar />);
    act(() => { dispatch('Gate pending', 'warn', 0); });
    await waitFor(() => {
      expect(screen.getByTestId('mobile-alert-warn')).toBeTruthy();
    });
  });

  it('shows an error-level alert', async () => {
    render(<MobileAlertBar />);
    act(() => { dispatch('Build failed', 'error', 0); });
    await waitFor(() => {
      expect(screen.getByTestId('mobile-alert-error')).toBeTruthy();
    });
  });

  it('sticky alert (ttl=0) does not auto-dismiss', () => {
    vi.useFakeTimers();
    try {
      render(<MobileAlertBar />);
      act(() => { dispatch('Sticky alert', 'warn', 0); });
      // With fake timers waitFor polling is synchronous via fake ticks
      act(() => { vi.runAllTicks(); });
      expect(screen.getByTestId('mobile-alert-warn')).toBeTruthy();
      act(() => { vi.advanceTimersByTime(10000); });
      expect(screen.getByTestId('mobile-alert-warn')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('non-sticky alert (ttl>0) auto-dismisses after ttl', () => {
    vi.useFakeTimers();
    try {
      render(<MobileAlertBar />);
      act(() => { dispatch('Auto dismiss', 'info', 2000); });
      act(() => { vi.runAllTicks(); });
      expect(screen.getByTestId('mobile-alert-info')).toBeTruthy();
      act(() => { vi.advanceTimersByTime(2100); });
      expect(screen.queryByTestId('mobile-alert-info')).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('X button dismisses an alert', async () => {
    render(<MobileAlertBar />);
    act(() => { dispatch('Dismiss me', 'info', 0); });
    await waitFor(() => expect(screen.getByTestId('mobile-alert-info')).toBeTruthy());
    const dismissBtn = screen.getByTestId('mobile-alert-info').querySelector('[aria-label="Dismiss"]');
    act(() => { fireEvent.click(dismissBtn); });
    expect(screen.queryByTestId('mobile-alert-info')).toBeFalsy();
  });

  it('stacks max 3 alerts, dropping the oldest on overflow', async () => {
    render(<MobileAlertBar />);
    act(() => {
      dispatch('Msg 1', 'info', 0);
      dispatch('Msg 2', 'info', 0);
      dispatch('Msg 3', 'info', 0);
    });
    await waitFor(() => expect(screen.getAllByTestId('mobile-alert-info')).toHaveLength(3));
    // Add a 4th — oldest should drop
    act(() => { dispatch('Msg 4', 'info', 0); });
    await waitFor(() => {
      const alerts = screen.getAllByTestId('mobile-alert-info');
      expect(alerts).toHaveLength(3);
      const texts = alerts.map(a => a.textContent);
      expect(texts.some(t => t.includes('Msg 1'))).toBe(false);
      expect(texts.some(t => t.includes('Msg 4'))).toBe(true);
    });
  });
});

// ─── useMonitorEvents tests ───────────────────────────────────────────────

describe('useMonitorEvents: gate appearance triggers alert', () => {
  it('gate-appearance triggers a warn alert with item title', async () => {
    const { default: useMonitorEvents } = await import('../../src/mobile/hooks/useMonitorEvents.js');

    const items = [{ id: 'item-1', title: 'Alpha feature', featureCode: 'COMP-A' }];

    const notifyEvents = [];
    const handler = (e) => notifyEvents.push(e.detail);
    window.addEventListener('compose:notify', handler);

    const { rerender } = renderHook(
      ({ gates, active }) => useMonitorEvents({ active, gates, items }),
      { initialProps: { gates: [], active: null } }
    );

    // Gate appears
    act(() => {
      rerender({ gates: [{ id: 'gate-1', itemId: 'item-1', resolvedAt: null }], active: null });
    });

    await waitFor(() => {
      expect(notifyEvents.some(e => e.message.includes('Alpha feature') && e.level === 'warn')).toBe(true);
    });

    window.removeEventListener('compose:notify', handler);
  });

  it('initial gate population does NOT trigger an alert', async () => {
    const { default: useMonitorEvents } = await import('../../src/mobile/hooks/useMonitorEvents.js');

    const items = [{ id: 'item-1', title: 'Alpha feature', featureCode: 'COMP-A' }];
    const initialGates = [{ id: 'gate-1', itemId: 'item-1', resolvedAt: null }];

    const notifyEvents = [];
    const handler = (e) => notifyEvents.push(e.detail);
    window.addEventListener('compose:notify', handler);

    renderHook(
      ({ gates, active }) => useMonitorEvents({ active, gates, items }),
      { initialProps: { gates: initialGates, active: null } }
    );

    // Wait for effects to run
    await new Promise(r => setTimeout(r, 50));

    window.removeEventListener('compose:notify', handler);
    expect(notifyEvents.filter(e => e.level === 'warn')).toHaveLength(0);
  });

  it('build failed transition triggers sticky error alert', async () => {
    const { default: useMonitorEvents } = await import('../../src/mobile/hooks/useMonitorEvents.js');

    const items = [];
    const gates = [];
    const notifyEvents = [];
    const handler = (e) => notifyEvents.push(e.detail);
    window.addEventListener('compose:notify', handler);

    const { rerender } = renderHook(
      ({ active }) => useMonitorEvents({ active, gates, items }),
      { initialProps: { active: { flowId: 'f1', featureCode: 'COMP-A', status: 'running' } } }
    );

    act(() => {
      rerender({ active: { flowId: 'f1', featureCode: 'COMP-A', status: 'failed' } });
    });

    await waitFor(() => {
      expect(notifyEvents.some(e =>
        e.level === 'error' &&
        e.message.includes('COMP-A') &&
        (e.ttl === 0 || e.ttl === null || e.ttl === Infinity)
      )).toBe(true);
    });

    window.removeEventListener('compose:notify', handler);
  });

  it('build complete transition triggers info alert with 4s ttl', async () => {
    const { default: useMonitorEvents } = await import('../../src/mobile/hooks/useMonitorEvents.js');

    const items = [];
    const gates = [];
    const notifyEvents = [];
    const handler = (e) => notifyEvents.push(e.detail);
    window.addEventListener('compose:notify', handler);

    const { rerender } = renderHook(
      ({ active }) => useMonitorEvents({ active, gates, items }),
      { initialProps: { active: { flowId: 'f2', featureCode: 'COMP-B', status: 'running' } } }
    );

    act(() => {
      rerender({ active: { flowId: 'f2', featureCode: 'COMP-B', status: 'complete' } });
    });

    await waitFor(() => {
      expect(notifyEvents.some(e =>
        e.level === 'info' &&
        e.message.includes('COMP-B') &&
        e.ttl === 4000
      )).toBe(true);
    });

    window.removeEventListener('compose:notify', handler);
  });
});

/**
 * workspace-remote-mode.test.jsx — COMP-MOBILE-REMOTE coverage sweep
 *
 * Tests for WorkspaceProvider's /api/health → setRemoteMode wiring.
 * Priority target #1 from the sweep spec.
 *
 * Cases:
 *   A. /api/health returns {remote:true}  → setRemoteMode(true)
 *   B. /api/health returns {remote:false} → remote mode stays off
 *   C. /api/health returns no 'remote' field → remote mode stays off
 *   D. /api/health fetch throws (network error) → remote mode stays off
 *   E. /api/health returns ok:false → remote mode stays off
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { setRemoteMode, isRemoteMode } from '../../src/lib/wsUrl.js';
import { WorkspaceProvider } from '../../src/contexts/WorkspaceContext.jsx';

function makeWorkspaceFetch({ healthBody = null, healthStatus = 200, healthThrows = false } = {}) {
  globalThis.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/api/workspace')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'ws-test', root: '/tmp/test' }),
      };
    }
    if (u.includes('/api/health')) {
      if (healthThrows) throw new Error('network error');
      return {
        ok: healthStatus === 200,
        status: healthStatus,
        json: async () => (healthBody ?? { ok: true }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

beforeEach(() => {
  setRemoteMode(false);
  vi.clearAllMocks();
});

afterEach(() => {
  setRemoteMode(false);
  vi.restoreAllMocks();
});

describe('WorkspaceProvider — /api/health remote-mode wiring', () => {
  it('/api/health {remote:true} → setRemoteMode(true)', async () => {
    makeWorkspaceFetch({ healthBody: { ok: true, remote: true } });
    render(
      <WorkspaceProvider>
        <div data-testid="child" />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(isRemoteMode()).toBe(true));
  });

  it('/api/health {remote:false} → remote mode stays off', async () => {
    makeWorkspaceFetch({ healthBody: { ok: true, remote: false } });
    render(
      <WorkspaceProvider>
        <div />
      </WorkspaceProvider>,
    );
    // Give async effects time to run
    await waitFor(() => {
      const fetchCalls = vi.mocked(fetch).mock.calls.map(c => String(c[0]));
      expect(fetchCalls.some(u => u.includes('/api/health'))).toBe(true);
    });
    expect(isRemoteMode()).toBe(false);
  });

  it('/api/health returns no remote field → remote mode stays off', async () => {
    makeWorkspaceFetch({ healthBody: { ok: true } /* no remote field */ });
    render(<WorkspaceProvider><div /></WorkspaceProvider>);
    await waitFor(() => {
      const fetchCalls = vi.mocked(fetch).mock.calls.map(c => String(c[0]));
      expect(fetchCalls.some(u => u.includes('/api/health'))).toBe(true);
    });
    expect(isRemoteMode()).toBe(false);
  });

  it('/api/health fetch throws (network error) → remote mode stays off, no crash', async () => {
    makeWorkspaceFetch({ healthThrows: true });
    // Should not throw; best-effort catch inside WorkspaceProvider
    let threw = false;
    try {
      render(<WorkspaceProvider><div /></WorkspaceProvider>);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // After settling, remote mode must still be off
    await waitFor(() => {
      const fetchCalls = vi.mocked(fetch).mock.calls.map(c => String(c[0]));
      expect(fetchCalls.some(u => u.includes('/api/workspace'))).toBe(true);
    });
    // health fetch throws, so setRemoteMode is never called
    expect(isRemoteMode()).toBe(false);
  });

  it('/api/health non-ok status → remote mode stays off (json might be {})', async () => {
    makeWorkspaceFetch({ healthBody: {}, healthStatus: 503 });
    render(<WorkspaceProvider><div /></WorkspaceProvider>);
    await waitFor(() => {
      const fetchCalls = vi.mocked(fetch).mock.calls.map(c => String(c[0]));
      expect(fetchCalls.some(u => u.includes('/api/health'))).toBe(true);
    });
    // {}.remote is undefined — hj?.remote === true is false
    expect(isRemoteMode()).toBe(false);
  });
});

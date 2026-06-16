/**
 * COMP-PARITY-3: EnvironmentHealthPanel — header dot reflects summary; popover
 * renders dep/version/hook detail; ↻ refetches with ?refresh=1; the fetch
 * re-runs when the resolved workspace identity changes (in-app project switch).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', () => ({ wsFetch: vi.fn() }));

// Mutable workspace the mocked hook returns; tests reassign to simulate switches.
let mockWs = { loading: false, workspace: { id: 'ws-1', root: '/repo/one' } };
vi.mock('../../src/contexts/WorkspaceContext.jsx', () => ({
  useWorkspace: () => mockWs,
}));

import { wsFetch } from '../../src/lib/wsFetch.js';
import EnvironmentHealthPanel from '../../src/components/cockpit/EnvironmentHealthPanel.jsx';

function healthResponse(overrides = {}) {
  return {
    summary: 'warn',
    dependencies: { present: [{ id: 'superpowers:tdd' }], missing: [{ id: 'refactor', optional: false }] },
    binaries: { present: [{ id: 'rtk' }], missing: [] },
    version: { current: '0.2.0', latest: '0.3.0', behind: true, source: 'cache' },
    hooks: {
      'post-commit': { state: 'absent' },
      'pre-push': { state: 'installed-stale', reason: 'STALE_WORKSPACE_ID', expected: { workspaceId: 'ws-1' } },
    },
    ...overrides,
  };
}

function mockHealth(body) {
  wsFetch.mockResolvedValue({ ok: true, json: async () => body });
}

describe('EnvironmentHealthPanel', () => {
  beforeEach(() => {
    wsFetch.mockReset();
    mockWs = { loading: false, workspace: { id: 'ws-1', root: '/repo/one' } };
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('fetches on mount and renders the dot (warn → amber)', async () => {
    mockHealth(healthResponse());
    render(<EnvironmentHealthPanel />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalledWith('/api/environment-health'));
    const dot = screen.getByTestId('env-health-dot');
    expect(dot.getAttribute('title')).toMatch(/warn/);
  });

  it('opens the popover and renders dependency, version, and hook detail', async () => {
    mockHealth(healthResponse());
    render(<EnvironmentHealthPanel />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('env-health-dot'));
    expect(screen.getByTestId('env-health-panel')).toBeTruthy();
    // missing required dep row
    expect(screen.getByTestId('env-health-dependency-refactor')).toBeTruthy();
    // version drift
    expect(screen.getByTestId('env-health-version').textContent).toMatch(/0\.2\.0 → 0\.3\.0/);
    // per-hook rows
    expect(screen.getByTestId('env-health-hook-post-commit').textContent).toMatch(/absent/);
    expect(screen.getByTestId('env-health-hook-pre-push').textContent).toMatch(/installed-stale.*STALE_WORKSPACE_ID/);
  });

  it('↻ refresh refetches with ?refresh=1', async () => {
    mockHealth(healthResponse());
    render(<EnvironmentHealthPanel />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('env-health-dot'));
    fireEvent.click(screen.getByTestId('env-health-refresh'));
    await waitFor(() => expect(wsFetch).toHaveBeenCalledWith('/api/environment-health?refresh=1'));
  });

  it('renders an error state when the fetch rejects, without throwing', async () => {
    wsFetch.mockRejectedValue(new Error('boom'));
    render(<EnvironmentHealthPanel />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('env-health-dot'));
    expect(screen.getByTestId('env-health-panel').textContent).toMatch(/Unavailable/);
  });

  it('refetches when the resolved workspace root changes (in-app project switch)', async () => {
    mockHealth(healthResponse());
    const { rerender } = render(<EnvironmentHealthPanel />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalledTimes(1));

    // Same id, different root — must still refetch (id-alone keying would miss this).
    mockWs = { loading: false, workspace: { id: 'ws-1', root: '/repo/two' } };
    rerender(<EnvironmentHealthPanel />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalledTimes(2));
  });

  it('ignores a stale out-of-order response (newer workspace wins)', async () => {
    // The initial fetch resolves LATE; a workspace switch triggers a second
    // fetch that resolves FIRST with fresh data. The stale late response must
    // NOT overwrite the newer one (else the dot shows the wrong workspace).
    let resolveStale;
    const stalePromise = new Promise((res) => { resolveStale = res; });
    wsFetch
      .mockImplementationOnce(() => stalePromise) // initial mount fetch — resolves last
      .mockResolvedValueOnce({ ok: true, json: async () => healthResponse({ summary: 'error' }) }); // switch fetch — resolves first

    const { rerender } = render(<EnvironmentHealthPanel />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalledTimes(1));

    // In-app project switch: same nothing, new root → effect refetches (call #2).
    mockWs = { loading: false, workspace: { id: 'ws-2', root: '/repo/two' } };
    rerender(<EnvironmentHealthPanel />);
    await waitFor(() => expect(screen.getByTestId('env-health-dot').getAttribute('title')).toMatch(/error/));

    // now let the stale initial fetch resolve — it must be ignored
    resolveStale({ ok: true, json: async () => healthResponse({ summary: 'ok' }) });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('env-health-dot').getAttribute('title')).toMatch(/error/);
  });

  it('offline version (null) renders "unavailable" and ok summary shows green dot', async () => {
    mockHealth(healthResponse({ summary: 'ok', version: null, dependencies: { present: [], missing: [] }, binaries: { present: [], missing: [] }, hooks: { 'post-commit': { state: 'absent' }, 'pre-push': { state: 'installed-current', workspace: 'ws-1' } } }));
    render(<EnvironmentHealthPanel />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('env-health-dot'));
    expect(screen.getByTestId('env-health-version').textContent).toMatch(/unavailable/);
    expect(screen.getByTestId('env-health-dot').getAttribute('title')).toMatch(/ok/);
  });
});

/** COMPOSE-STRAT-TAB-1: the Stratum tab renders @stratum/ui screens from a fake DataClient (no fetch). */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import StratumView from '../../src/components/cockpit/StratumView.jsx';
import { createStratumDataClient } from '../../src/lib/clients/stratum.js';
import { DEFAULT_MAIN_TABS } from '../../src/components/cockpit/viewTabsState.js';

const linked = typeof __STRATUM_UI__ !== 'undefined' && __STRATUM_UI__;
const run = (id) => ({
  id, flowName: `flow-${id}`, status: 'running', displayStatus: 'awaiting_gate', stepCount: 2, completedSteps: 1,
  currentStepId: 'g', round: 0, startedAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:01:00Z', spent: {}, waitingGates: 1,
});

afterEach(() => vi.unstubAllGlobals());

describe('Stratum tab', () => {
  it('is a default tab', () => expect(DEFAULT_MAIN_TABS).toContain('stratum'));

  it.skipIf(!linked)('renders runs and gates from the injected client without fetching', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('a component fetched'); });
    vi.stubGlobal('fetch', fetchSpy);
    const client = {
      listRuns: vi.fn(async () => [run('r1')]),
      getRun: vi.fn(async () => null),
      listGates: vi.fn(async () => []),
      resolveGate: vi.fn(),
    };
    render(<StratumView client={client} />);
    await waitFor(() => expect(client.listRuns).toHaveBeenCalled());
    expect(await screen.findByText(/flow-r1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Gates' }));
    await waitFor(() => expect(client.listGates).toHaveBeenCalled());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Compose stratum DataClient', () => {
  it('talks only to /api/stratum-ui and carries the gate token', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      calls.push([String(url), opts.method || 'GET', opts.body]);
      const ok = String(url).includes('/gates/') ? { ok: true, runId: 'r', stepId: 's', outcome: 'approve', result: 'done' } : [];
      return { ok: true, status: 200, json: async () => ok };
    }));
    const client = createStratumDataClient();
    await client.listRuns();
    await client.listGates();
    const out = await client.resolveGate({ runId: 'r 1', stepId: 's', action: 'approve', gateToken: 'tok' });
    expect(out.ok).toBe(true);
    expect(calls.every(([u]) => u.startsWith('/api/stratum-ui/'))).toBe(true);
    expect(calls[2][0]).toBe('/api/stratum-ui/gates/r%201/s/approve');
    expect(JSON.parse(calls[2][2]).gateToken).toBe('tok');
  });

  it('getRun returns null on 404 and refusals never throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    const client = createStratumDataClient();
    expect(await client.getRun('x')).toBeNull();
    const out = await client.resolveGate({ runId: 'x', stepId: 's', action: 'reject', gateToken: 't' });
    expect(out).toMatchObject({ ok: false, kind: 'error', code: 'HTTP_404' });
  });
});

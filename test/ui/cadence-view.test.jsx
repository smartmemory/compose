/** COMPOSE-CADENCE-TAB-1: the Cadence tab renders @cadence/ui screens from a fake DataClient (no fetch). */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import CadenceView from '../../src/components/cockpit/CadenceView.jsx';
import { createCadenceDataClient } from '../../src/lib/clients/cadence.js';
import { locateView } from '../../lib/view-keys.js';

const linked = typeof __CADENCE_UI__ !== 'undefined' && __CADENCE_UI__;
const at = '2026-10-30T00:00:00Z';
const unit = {
  id: 'FAKE-UNIT-1', lane: 'ops', column: 'ready', rawState: 'ready', title: 'a fake unit', priority: 'P1', model: null,
  since: at, blocker: null, blockers: [], decision: null, dependsOn: [], sha: null,
};

function fakeClient() {
  return {
    getBelt: vi.fn(async () => ({ generatedAt: at, units: [unit], lanes: ['ops'], landedWindowH: 24, offBelt: 0, readiness: null, errors: [] })),
    getSeats: vi.fn(async () => ({ generatedAt: at, source: 'cadence', seats: [], recommendation: null, unassignedJobs: [], errors: [] })),
    getChains: vi.fn(async () => ({ generatedAt: at, chains: [], errors: [] })),
    getAttention: vi.fn(async () => ({
      generatedAt: at, alerts: [], overdue: [], cadenceStatus: 'ok', cadenceTs: at, errors: [],
      asks: [{ id: 'ASK-1', by: 's2-coord', text: 'a fake owner ask', openedAt: at, unit: null }],
    })),
    getReview: vi.fn(async () => ({ generatedAt: at, inReview: [], inReviewByLane: {}, ungrouped: { count: 0, oldestLanded: null }, reviewMaxH: 24, errors: [] })),
    getDiary: vi.fn(async () => ({
      generatedAt: at, scanned: 1, skipped: 0, errors: [],
      events: [{ ts: at, kind: 'unit.land', family: 'unit', by: 'x', lane: 'ops', unit: 'FAKE-UNIT-1', detail: 'a fake landing' }],
    })),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Cadence tab', () => {
  it('is a sub-tab of the Fleet room', () => expect(locateView('cadence')).toEqual({ top: 'fleet', sub: 'cadence' }));

  it.skipIf(!linked)('renders every screen from the injected client without fetching', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('a component fetched'); });
    vi.stubGlobal('fetch', fetchSpy);
    const client = fakeClient();
    render(<CadenceView client={client} />);
    expect(await screen.findByText(/FAKE-UNIT-1/)).toBeTruthy();
    expect(client.getSeats).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Chains' }));
    await waitFor(() => expect(client.getChains).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Attention' }));
    expect(await screen.findByText(/a fake owner ask/)).toBeTruthy();
    expect(client.getReview).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Diary' }));
    expect(await screen.findByText(/a fake landing/)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Compose cadence DataClient', () => {
  it('reads only GET /api/cadence-ui/* and passes the diary query', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      calls.push([String(url), opts.method || 'GET']);
      return { ok: true, status: 200, json: async () => ({}) };
    }));
    const client = createCadenceDataClient();
    await client.getBelt();
    await client.getSeats();
    await client.getChains();
    await client.getAttention();
    await client.getReview();
    await client.getDiary();
    await client.getDiary({ family: 'job', limit: 5 });
    expect(calls.map(([u]) => u)).toEqual([
      '/api/cadence-ui/belt', '/api/cadence-ui/seats', '/api/cadence-ui/chains', '/api/cadence-ui/attention',
      '/api/cadence-ui/review', '/api/cadence-ui/diary', '/api/cadence-ui/diary?family=job&limit=5',
    ]);
    expect(calls.every(([, m]) => m === 'GET')).toBe(true);
  });

  it('throws the server message on an error status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'family must be one of' } }) })));
    await expect(createCadenceDataClient().getDiary({ family: 'x' })).rejects.toThrow('family must be one of');
  });
});

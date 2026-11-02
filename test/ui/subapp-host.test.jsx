/**
 * COMP-SUBAPP-HOST-1: each cockpit view passes the host (contracts/subapp-host.schema.json) into its package provider, the room
 * narrows to the selection with a "filtered to" chip, the chip's × shows everything, and with no host nothing is filtered.
 * Fake clients only (fetch throws).
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import StratumView from '../../src/components/cockpit/StratumView.jsx';
import CadenceView from '../../src/components/cockpit/CadenceView.jsx';
import WikiView from '../../src/components/cockpit/WikiView.jsx';
import { resetPaneMemory } from '../../src/components/cockpit/PaneSwitcher.jsx';
import { buildSubappHost, createAttentionSink } from '../../src/components/cockpit/subappHost.js';

const stratumLinked = typeof __STRATUM_UI__ !== 'undefined' && __STRATUM_UI__;
const cadenceLinked = typeof __CADENCE_UI__ !== 'undefined' && __CADENCE_UI__;
const wikiLinked = typeof __WIKI_COMPONENTS__ !== 'undefined' && __WIKI_COMPONENTS__;

const host = (featureCode) => buildSubappHost({ selectedItem: featureCode ? { id: 'i', featureCode } : null, attention: createAttentionSink().publish });
const fetchSpy = vi.fn(() => { throw new Error('a component fetched'); });
beforeEach(() => { resetPaneMemory(); vi.stubGlobal('fetch', fetchSpy); fetchSpy.mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); expect(fetchSpy).not.toHaveBeenCalled(); });

// ---- Stratum
const now = new Date().toISOString();
const run = (id, featureCode) => ({
  id, label: `label-${id}`, featureCode, flowName: `flow-${id}`, status: 'running', displayStatus: 'running', stepCount: 2, completedSteps: 1,
  currentStepId: 's', round: 0, startedAt: now, updatedAt: now, lastEventAt: now, stale: false, spent: {}, waitingGates: 0,
});
const stratumClient = () => ({
  listRuns: vi.fn(async () => [run('r1', 'COMP-TUI-4'), run('r2', 'OTHER-1'), run('r3', null)]),
  getRun: vi.fn(async () => null), listGates: vi.fn(async () => []), resolveGate: vi.fn(),
});
const runIds = (c) => [...c.querySelectorAll('[data-run-id]')].map((el) => el.getAttribute('data-run-id'));

describe.skipIf(!stratumLinked)('Stratum room scoped by the host', () => {
  it("shows only the selected feature's runs with a chip; the chip's x shows every run, and restore narrows again", async () => {
    const { container } = render(<StratumView client={stratumClient()} host={host('COMP-TUI-4')} />);
    await waitFor(() => expect(runIds(container)).toEqual(['r1']));
    expect(screen.getByTestId('host-scope-chip').textContent).toContain('filtered to COMP-TUI-4');
    fireEvent.click(screen.getByRole('button', { name: 'Clear the filter' }));
    await waitFor(() => expect(runIds(container)).toEqual(['r1', 'r2', 'r3']));
    fireEvent.click(screen.getByTestId('host-scope-restore'));
    await waitFor(() => expect(runIds(container)).toEqual(['r1']));
  });

  it('shows every run and no chip with no host, and with a host that selects nothing', async () => {
    for (const h of [undefined, host(null)]) {
      const { container, unmount } = render(<StratumView client={stratumClient()} host={h} />);
      await waitFor(() => expect(runIds(container)).toHaveLength(3));
      expect(screen.queryByTestId('host-scope-chip')).toBeNull();
      unmount();
    }
  });
});

// ---- Cadence
const at = '2026-10-30T00:00:00Z';
const unit = (id, lane = 'ops') => ({
  id, lane, column: 'ready', rawState: 'ready', title: `unit ${id}`, priority: 'P1', model: null,
  since: at, blocker: null, blockers: [], decision: null, dependsOn: [], sha: null,
});
const cadenceClient = () => ({
  getBelt: vi.fn(async () => ({ generatedAt: at, units: [unit('COMP-TUI-4'), unit('COMP-TUI-4-FIX'), unit('OTHER-1')], lanes: ['ops'], landedWindowH: 24, offBelt: 0, readiness: null, errors: [] })),
  getSeats: vi.fn(async () => ({ generatedAt: at, source: 'cadence', seats: [], recommendation: null, unassignedJobs: [], errors: [] })),
  getChains: vi.fn(async () => ({ generatedAt: at, chains: [], errors: [] })),
  getLive: vi.fn(async () => ({ generatedAt: at, lanes: [], errors: [] })),
  getAttention: vi.fn(async () => ({ generatedAt: at, alerts: [], overdue: [], cadenceStatus: 'ok', cadenceTs: at, errors: [], asks: [] })),
  getReview: vi.fn(async () => ({ generatedAt: at, inReview: [], inReviewByLane: {}, ungrouped: { count: 0, oldestLanded: null }, reviewMaxH: 24, errors: [] })),
  getDiary: vi.fn(async () => ({ generatedAt: at, scanned: 0, skipped: 0, errors: [], events: [] })),
});
const unitIds = (c) => [...c.querySelectorAll('[data-unit]')].map((el) => el.getAttribute('data-unit')).sort();

describe.skipIf(!cadenceLinked)('Cadence room scoped by the host', () => {
  it("the Board shows the selected feature's units with a chip; the chip's x shows every unit", async () => {
    const { container } = render(<CadenceView client={cadenceClient()} host={host('COMP-TUI-4')} />);
    await waitFor(() => expect(unitIds(container)).toEqual(['COMP-TUI-4', 'COMP-TUI-4-FIX']));
    expect(screen.getByTestId('host-scope-chip').textContent).toContain('filtered to COMP-TUI-4');
    fireEvent.click(screen.getByRole('button', { name: 'Clear the filter' }));
    await waitFor(() => expect(unitIds(container)).toEqual(['COMP-TUI-4', 'COMP-TUI-4-FIX', 'OTHER-1']));
  });

  it('a selected unit shows that unit alone; no host shows every unit and no chip', async () => {
    const one = render(<CadenceView client={cadenceClient()} host={buildSubappHost({ unit: 'OTHER-1' })} />);
    await waitFor(() => expect(unitIds(one.container)).toEqual(['OTHER-1']));
    expect(screen.getByTestId('host-scope-chip').textContent).toContain('filtered to unit OTHER-1');
    one.unmount();
    const all = render(<CadenceView client={cadenceClient()} />);
    await waitFor(() => expect(unitIds(all.container)).toHaveLength(3));
    expect(screen.queryByTestId('host-scope-chip')).toBeNull();
  });
});

// ---- Wiki
const feature = { feature_id: 'COMP-TUI-4', title: 'The TUI feature', roadmap_status: 'IN_PROGRESS', folder: 'f', owner: null, current_decision_ref: null, latest_output_ref: null, doc_count: 0, areas: [] };
const page = () => ({ items: [], total: 0, next_cursor: null, generated_at: 't' });
const wikiClient = () => ({
  graphAll: vi.fn(), graphPage: vi.fn(), note: vi.fn(), identity: vi.fn(),
  featureHub: vi.fn(async ({ featureId }) => ({ ...page(), feature: { ...feature, feature_id: featureId } })),
  decisions: vi.fn(async () => page()), decisionsPage: vi.fn(async () => page()), sourcesPage: vi.fn(async () => page()),
  docsByArea: vi.fn(async () => page()), ledger: vi.fn(), upcomingCalls: vi.fn(),
  search: vi.fn(async () => ({ groups: [], generated_at: 't' })),
});

describe.skipIf(!wikiLinked)('Wiki room scoped by the host', () => {
  it("opens the selected feature's hub over the session's feature, with a chip; the chip's x goes back to Search, unscoped", async () => {
    const client = wikiClient();
    render(<WikiView client={client} featureCode="SESSION-1" host={host('COMP-TUI-4')} workspace="wiki-eng" frameBase="http://127.0.0.1:8791" />);
    expect(await screen.findByText('The TUI feature')).toBeTruthy();
    expect(client.featureHub).toHaveBeenCalledWith({ workspace: 'wiki-eng', featureId: 'COMP-TUI-4' });
    expect(screen.getByTestId('host-scope-chip').textContent).toContain('filtered to COMP-TUI-4');
    fireEvent.click(screen.getByRole('button', { name: 'Clear the filter' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Search' }).getAttribute('aria-selected')).toBe('true'));
    expect(screen.getByLabelText('Feature code').value).toBe('');
    fireEvent.click(screen.getByTestId('host-scope-restore'));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Feature' }).getAttribute('aria-selected')).toBe('true'));
  });

  it('with no host selection it keeps the session feature as before, and shows no chip', async () => {
    const client = wikiClient();
    render(<WikiView client={client} featureCode="SESSION-1" host={host(null)} workspace="wiki-eng" frameBase="http://127.0.0.1:8791" />);
    await waitFor(() => expect(client.featureHub).toHaveBeenCalledWith({ workspace: 'wiki-eng', featureId: 'SESSION-1' }));
    expect(screen.queryByTestId('host-scope-chip')).toBeNull();
  });
});

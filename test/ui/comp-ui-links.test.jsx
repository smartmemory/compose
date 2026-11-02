/**
 * COMP-UI-LINKS-1: every link in the Fleet, Cadence and Stratum rooms lands somewhere. The Fleet pane is built from Cadence parts and
 * selects sessions, jobs and questions in place; units open the Cadence room through roomFocus.js; Stratum's feature chip and gate
 * links go through Compose's navigation. Fake DataClients only, no fetch.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { NavigationContext } from '../../src/lib/navigation.jsx';
import FleetView, { fleetSelectionFor } from '../../src/components/cockpit/FleetView.jsx';
import CadenceView, { cadenceRouteFor } from '../../src/components/cockpit/CadenceView.jsx';
import StratumView, { DEFAULT_RUNS_FILTER } from '../../src/components/cockpit/StratumView.jsx';
import { resetPaneMemory } from '../../src/components/cockpit/PaneSwitcher.jsx';
import { requestRoomFocus, resetRoomFocus } from '../../src/components/cockpit/roomFocus.js';

const cadenceLinked = typeof __CADENCE_UI__ !== 'undefined' && __CADENCE_UI__;
const stratumLinked = typeof __STRATUM_UI__ !== 'undefined' && __STRATUM_UI__;
const at = '2026-11-02T00:00:00Z';
const unit = (id, extra = {}) => ({
  id, lane: 'ops', column: 'ready', rawState: 'ready', title: `title of ${id}`, priority: 'P1', model: null,
  since: at, blocker: null, blockers: [], decision: 'launchable', dependsOn: [], sha: null, ...extra,
});

function fakeCadence() {
  return {
    getBelt: vi.fn(async () => ({ generatedAt: at, units: [unit('READY-1')], lanes: ['ops'], landedWindowH: 24, offBelt: 0, readiness: null, errors: [] })),
    getSeats: vi.fn(async () => ({ generatedAt: at, source: 'cadence', seats: [], recommendation: null, unassignedJobs: [], errors: [] })),
    getChains: vi.fn(async () => ({ generatedAt: at, chains: [], errors: [] })),
    getLive: vi.fn(async () => ({ generatedAt: at, lanes: [], errors: [] })),
    getAttention: vi.fn(async () => ({
      generatedAt: at, alerts: [], overdue: [], cadenceStatus: 'ok', cadenceTs: at, errors: [],
      asks: [{ id: 'ASK-1', by: 's2-coord', text: 'a fake owner ask', openedAt: at, unit: null }],
    })),
    getReview: vi.fn(async () => ({ generatedAt: at, inReview: [], inReviewByLane: {}, ungrouped: { count: 0, oldestLanded: null }, reviewMaxH: 24, errors: [] })),
    getDiary: vi.fn(async () => ({ generatedAt: at, scanned: 0, skipped: 0, errors: [], events: [] })),
    getSessions: vi.fn(async () => ({
      generatedAt: at, scannedAt: at, counts: { busy: 1, idle: 1, unknown: 0 }, errors: [],
      sessions: [
        { name: 'lane-a', seat: null, model: 'opus', busy: true, ctxTokens: 1000, idleS: 0, armed: true, openJobs: 1, error: null },
        { name: 'lane-b', seat: null, model: 'sonnet', busy: false, ctxTokens: 1000, idleS: 60, armed: true, openJobs: 1, error: null },
      ],
    })),
    getJobs: vi.fn(async () => ({
      generatedAt: at, capped: false, skipped: 0, counts: { alive: 0, stalled: 2, 'dead-open': 0, unknown: 0, done: 0 }, errors: [],
      jobs: [
        { id: 'job-a', session: 'lane-a', label: 'job-a', kind: 'detached', workKind: null, model: null, pid: 1, startedAt: at, logPath: null, state: 'stalled', ageMs: 1000, logAgeMs: 3_600_000, doneAt: null, outcome: null },
        { id: 'job-b', session: 'lane-b', label: 'job-b', kind: 'detached', workKind: null, model: null, pid: 2, startedAt: at, logPath: null, state: 'stalled', ageMs: 1000, logAgeMs: 3_600_000, doneAt: null, outcome: null },
      ],
    })),
    getGates: vi.fn(async () => ({ generatedAt: at, gates: [], engines: [], queue: { mode: null, waiting: [] }, lastLaunch: { label: null, ageS: null }, errors: [] })),
    getVitals: vi.fn(async () => ({ generatedAt: at, scannedAt: at, disk: { freeGb: 300, usedPct: '40%' }, spend: null, today: null, ledger: ['a READY-1 line'], errors: [] })),
  };
}

const navValue = (extra = {}) => ({ openRoom: vi.fn(), openFeature: vi.fn(), canNavigate: vi.fn(() => true), openFlowGate: vi.fn(() => false), ...extra });
const withNav = (nav, ui) => <NavigationContext.Provider value={nav}>{ui}</NavigationContext.Provider>;

beforeEach(() => { resetPaneMemory(); resetRoomFocus(); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('a component fetched'); })); });
afterEach(() => vi.unstubAllGlobals());

describe('route mapping', () => {
  it('fleetSelectionFor keeps the Fleet targets and refuses the rest', () => {
    expect(fleetSelectionFor({ kind: 'session', name: 's' })).toEqual({ session: 's' });
    expect(fleetSelectionFor({ kind: 'job', id: 'j' })).toEqual({ job: 'j' });
    expect(fleetSelectionFor({ kind: 'seat', id: 'seat1' })).toEqual({ seat: 'seat1' });
    expect(fleetSelectionFor({ kind: 'ask', id: 'A' })).toEqual({ ask: 'A' });
    expect(fleetSelectionFor({ kind: 'attention' })).toEqual({});
    expect(fleetSelectionFor({ kind: 'unit', id: 'U' })).toBeNull();
  });

  it('cadenceRouteFor matches the Cadence shell, keeping the lane only on the Board', () => {
    expect(cadenceRouteFor({ kind: 'unit', id: 'U' }, { view: 'belt', lane: 'ops' })).toEqual({ view: 'belt', unit: 'U', lane: 'ops' });
    expect(cadenceRouteFor({ kind: 'unit', id: 'U' }, { view: 'diary', lane: 'ops' })).toEqual({ view: 'belt', unit: 'U', lane: null });
    expect(cadenceRouteFor({ kind: 'lane', lane: 'ops' })).toEqual({ view: 'belt', unit: null, lane: 'ops' });
    expect(cadenceRouteFor({ kind: 'chain', id: 'C' })).toEqual({ view: 'chains', chain: 'C' });
    expect(cadenceRouteFor({ kind: 'session', name: 's' })).toBeNull();
  });
});

describe.skipIf(!cadenceLinked)('Fleet pane from Cadence parts', () => {
  it('renders every card, selects a session, a job and a question in place, and sends a ready unit to the Cadence room', async () => {
    const nav = navValue();
    render(withNav(nav, <FleetView client={fakeCadence()} />));
    const view = await screen.findByTestId('fleet-view');
    expect(view.getAttribute('data-fleet-source')).toBe('cadence');
    await screen.findByText('a fake owner ask');
    await screen.findByText('job-b');

    // a session's name shows only that session's jobs
    fireEvent.click(screen.getAllByText('lane-a').find((n) => n.closest('[data-session]')));
    await waitFor(() => expect(screen.getByTestId('fleet-scope').textContent).toContain('session lane-a'));
    expect(document.querySelector('[data-session="lane-a"]').getAttribute('aria-current')).toBe('true');
    await waitFor(() => expect(document.querySelector('[data-job="job-b"]')).toBeNull());

    // a job label naming no unit selects the job
    fireEvent.click(within(document.querySelector('[data-job="job-a"]')).getByText('job-a'));
    await waitFor(() => expect(document.querySelector('[data-job="job-a"]').getAttribute('aria-current')).toBe('true'));
    expect(screen.getByTestId('fleet-scope').textContent).toContain('job job-a');

    // the question's text selects it
    fireEvent.click(screen.getByText('a fake owner ask'));
    await waitFor(() => expect(document.querySelector('[data-ask="ASK-1"]').getAttribute('aria-current')).toBe('true'));

    // clear returns to everything
    fireEvent.click(within(screen.getByTestId('fleet-scope')).getByText('clear'));
    await waitFor(() => expect(screen.queryByTestId('fleet-scope')).toBeNull());

    // a ready unit opens the Cadence room on it
    const ready = await waitFor(() => { const r = document.querySelector('[data-ready="READY-1"]'); expect(r).toBeTruthy(); return r; });
    fireEvent.click(within(ready).getByTitle('open READY-1 on the Board'));
    expect(nav.openRoom).toHaveBeenCalledWith('cadence', { kind: 'unit', id: 'READY-1', lane: 'ops' });
    // the page-level availability check is the only request: every row came from the injected client
    expect(globalThis.fetch.mock.calls.map(([u]) => String(u)).filter((u) => !u.includes('/api/cadence-ui/available'))).toEqual([]);
  });

  it('applies a jump filed before it mounted', async () => {
    requestRoomFocus('fleet', { kind: 'session', name: 'lane-b' });
    render(withNav(navValue(), <FleetView client={fakeCadence()} />));
    await waitFor(() => expect(screen.getByTestId('fleet-scope').textContent).toContain('session lane-b'));
  });
});

describe.skipIf(!cadenceLinked)('Cadence room links', () => {
  it('a unit jump opens it on the Board; a session link goes to the Fleet room', async () => {
    const nav = navValue();
    const client = fakeCadence();
    client.getBelt = vi.fn(async () => ({
      generatedAt: at, units: [unit('READY-1')], lanes: ['ops'], landedWindowH: 24, offBelt: 0, readiness: null, errors: [],
    }));
    requestRoomFocus('cadence', { kind: 'unit', id: 'READY-1', lane: 'ops' });
    render(withNav(nav, <CadenceView client={client} />));
    expect(await screen.findByLabelText('unit READY-1')).toBeTruthy();
    act(() => requestRoomFocus('cadence', { kind: 'session', name: 'lane-a' }));
    expect(nav.openRoom).toHaveBeenCalledWith('fleet', { kind: 'session', name: 'lane-a' });
  });
});

describe.skipIf(!stratumLinked)('Stratum room links', () => {
  const run = (id, extra = {}) => ({
    id, flowName: `flow-${id}`, status: 'running', displayStatus: 'awaiting_gate', stepCount: 2, completedSteps: 1,
    currentStepId: 'g', round: 0, startedAt: at, updatedAt: at, spent: {}, waitingGates: 1, featureCode: 'FEAT-1', ...extra,
  });
  const client = () => ({
    listRuns: vi.fn(async () => [run('r1')]),
    getRun: vi.fn(async () => null),
    listGates: vi.fn(async () => []),
    resolveGate: vi.fn(),
  });

  it('the feature chip opens the Compose feature when Compose has it, and is text when not', async () => {
    const nav = navValue();
    const c = client();
    const { unmount } = render(withNav(nav, <StratumView client={c} />));
    fireEvent.click(await screen.findByTitle('feature FEAT-1'));
    expect(nav.openFeature).toHaveBeenCalledWith('FEAT-1');
    unmount();

    const none = navValue({ canNavigate: vi.fn(() => false) });
    render(withNav(none, <StratumView client={client()} />));
    const chip = await screen.findByTitle('feature FEAT-1');
    expect(chip.tagName).not.toBe('BUTTON');
    expect(chip.tagName).not.toBe('A');
  });

  it('a runs request with a filter selects that tab, and one with none returns to the default (the host owns the filter prop)', async () => {
    const c = client();
    render(withNav(navValue(), <StratumView client={c} />));
    await screen.findByText(/flow-r1/);
    const selectedTab = () => screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true' && t.getAttribute('aria-label') !== null).map((t) => t.getAttribute('aria-label'));
    expect(DEFAULT_RUNS_FILTER).toBe('recent');
    expect(selectedTab()).toEqual(['active, last 7 d']);
    act(() => requestRoomFocus('stratum', { kind: 'runs', filter: 'failed' }));
    await waitFor(() => expect(selectedTab()).toEqual(['failed']));
    act(() => requestRoomFocus('stratum', { kind: 'runs' }));
    await waitFor(() => expect(selectedTab()).toEqual(['active, last 7 d']));
  });

  it('a gate jump opens the Compose gate when Compose holds one, else Stratum\'s Gates pane', async () => {
    const held = navValue({ openFlowGate: vi.fn(() => true) });
    const c = client();
    const { unmount } = render(withNav(held, <StratumView client={c} />));
    await screen.findByText(/flow-r1/);
    act(() => requestRoomFocus('stratum', { kind: 'gates', runId: 'r1', stepId: 'g' }));
    expect(held.openFlowGate).toHaveBeenCalledWith('r1', 'g');
    expect(screen.getByRole('tab', { name: 'Runs' }).getAttribute('aria-selected')).toBe('true');
    unmount();

    const notHeld = navValue();
    const c2 = client();
    render(withNav(notHeld, <StratumView client={c2} />));
    await screen.findByText(/flow-r1/);
    act(() => requestRoomFocus('stratum', { kind: 'gates', runId: 'r1', stepId: 'g' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Gates' }).getAttribute('aria-selected')).toBe('true'));
    await waitFor(() => expect(c2.listGates).toHaveBeenCalled());
  });
});

describe.skipIf(!stratumLinked)('Stratum builder opens a run spec', () => {
  it('reads the run\'s own spec through the client and says so; a run with none is an error line', async () => {
    const { default: StratumBuilderPane } = await import('../../src/components/cockpit/StratumBuilderPane.jsx');
    const doc = { version: 1, flows: { entry: 'main', main: { steps: [{ id: 'g' }] } } };
    const c = {
      getRunSpec: vi.fn(async (id) => (id === 'r1' ? doc : id === 'bad' ? { version: '0.3', flows: {} } : null)),
      saveSpec: vi.fn(), listSpecs: vi.fn(async () => []), readSpec: vi.fn(),
    };
    const { rerender } = render(<StratumBuilderPane client={c} openRun={{ runId: 'r1', stepId: 'g', at: 1 }} />);
    await waitFor(() => expect(screen.getByTestId('builder-status').textContent).toBe("Opened run r1's spec at g (save to keep a copy)"));
    expect(c.getRunSpec).toHaveBeenCalledWith('r1');
    rerender(<StratumBuilderPane client={c} openRun={{ runId: 'r2', stepId: null, at: 2 }} />);
    await waitFor(() => expect(screen.getByTestId('builder-status').textContent).toBe('Run r2 has no spec on disk'));
    // a document the builder cannot import is an error in the pane, not the page in safe mode
    vi.spyOn(console, 'error').mockImplementation(() => {});
    rerender(<StratumBuilderPane client={c} openRun={{ runId: 'bad', stepId: null, at: 3 }} />);
    expect((await screen.findByTestId('builder-load-error')).textContent).toContain('Expected "version": 1');
    expect(screen.getByTestId('stratum-builder-pane')).toBeTruthy();
  });
});

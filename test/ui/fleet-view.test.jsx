/**
 * COMP-COCKPIT-12: Fleet view (Sessions tab), Ops strip pills and mobile Status tab against the REAL
 * GET /api/fleet route. The readers are the fixture scripts in test/fixtures/fleet, selected by the
 * COMPOSE_FLEET_* path overrides; the Cadence handler is the sibling's own (on its fixture roots) when the
 * sibling exists, all in test/fixtures/fleet/serve.mjs (its own Node process, since vitest cannot import the
 * sibling handler). fetch is only re-pointed from the page's relative URL to that loopback server.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { blockerReasons, proposedLine } from '../../src/components/cockpit/fleetLogic.js';
import { FLEET_POLL_MS, resetFleetPoller, subscribeFleet } from '../../src/lib/fleetPoller.js';

vi.mock('../../src/components/vision/useVisionStore.js', () => {
  const s = { activeBuild: null, gates: new Map(), items: new Map(), recentErrors: [], resolveGate: null, iterationStates: new Map() };
  return { useVisionStore: (sel) => (typeof sel === 'function' ? sel(s) : s) };
});

const { default: SessionsView } = await import('../../src/components/vision/SessionsView.jsx');
const { default: OpsStrip } = await import('../../src/components/cockpit/OpsStrip.jsx');
const { default: StatusTab } = await import('../../src/mobile/tabs/StatusTab.jsx');
const { default: BottomNav } = await import('../../src/mobile/components/BottomNav.jsx');

const FIX = join(process.cwd(), 'test', 'fixtures', 'fleet'); // vitest runs from the repo root; jsdom's import.meta.url is not a file URL
const realFetch = globalThis.fetch;

function fixtureEnv(overrides = {}) {
  return {
    PATH: process.env.PATH,
    COMPOSE_FLEET_PYTHON: process.execPath,
    COMPOSE_FLEET_SM_STATUS: join(FIX, 'sm-status.mjs'),
    COMPOSE_FLEET_STRATUM_BIN: join(FIX, 'stratum.mjs'),
    COMPOSE_FLEET_CADENCE_SHADOW: join(FIX, 'shadow.jsonl'),
    ...overrides,
  };
}

/** Start test/fixtures/fleet/serve.mjs (real route, real Cadence handler) and wait for its port. */
async function startServer(env, { cadence = true } = {}) {
  const child = spawn(process.execPath, [join(FIX, 'serve.mjs')], {
    env: { ...env, ...(cadence ? {} : { FLEET_FIXTURE_NO_CADENCE: '1' }) },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const line = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve(out); });
    child.on('exit', (code) => reject(new Error(`serve.mjs exited ${code}`)));
  });
  const [, port, withCadence] = line.match(/PORT (\d+) CADENCE (\d)/);
  return { stop: () => { child.stdin.end(); child.kill(); }, base: `http://127.0.0.1:${port}`, cadence: withCadence === '1' };
}

function pointFetchAt(base) {
  vi.stubGlobal('fetch', (url, opts) => realFetch(new URL(String(url), base), opts));
}

describe('Fleet UI on the real route (fixture readers)', () => {
  let srv;
  beforeAll(async () => { srv = await startServer(fixtureEnv()); });
  afterAll(() => srv.stop());
  beforeEach(() => { resetFleetPoller(); pointFetchAt(srv.base); });
  afterEach(() => vi.unstubAllGlobals());

  it('Sessions tab Fleet pane shows every panel, thresholds, Stratum liveness and a per-source unavailable card', async () => {
    let pane = 'sessions';
    const { rerender } = render(<SessionsView sessions={[]} pane={pane} onPaneChange={(p) => { pane = p; }} />);
    fireEvent.click(await screen.findByTestId('sessions-pane-fleet'));
    rerender(<SessionsView sessions={[]} pane={pane} onPaneChange={(p) => { pane = p; }} />);
    await screen.findByTestId('fleet-view', {}, { timeout: 10_000 });
    await screen.findByText('Pick the rollout order for the fixture unit', {}, { timeout: 10_000 });
    const ctx = screen.getAllByTestId('fleet-session-row').map((r) => r.querySelector('[data-ctx]').getAttribute('data-ctx'));
    expect(ctx).toEqual(['red', 'yellow', 'ok']);
    const from = screen.getAllByTestId('fleet-job-row').map((r) => r.querySelector('[data-alive-from]').getAttribute('data-alive-from'));
    expect(from).toEqual(['sm_status', 'stratum', 'stratum']);
    expect(screen.getByTestId('fleet-stratum').textContent).toContain('1 / 16');
    expect(screen.getByTestId('fleet-unavailable-spend').textContent).toBe('unavailable: RuntimeError: exit 2: attribute script missing');
    expect(screen.getByTestId('fleet-disk').textContent).toContain('80 GB free');
    expect(screen.getByTestId('fleet-ledger').textContent).toContain('fixture ledger line two');
    expect(screen.getByTestId('fleet-partial-ledger').textContent).toBe('unknown: UncertainSource: fixture partial read, line 3 unreadable (rows shown are a lower bound)');
    expect(document.body.textContent).not.toContain('must not leak');
    if (srv.cadence) {
      expect(screen.getByTestId('fleet-proposed').textContent).toBe('Cadence would start: forge/FIXTURE-1 · top blockers: parked-until 153, no-brief 125, held 49, claimed 22');
    } else {
      expect(screen.queryByTestId('fleet-cadence')).toBeNull();
    }
    expect(screen.getByTestId('fleet-view').querySelectorAll('button, a, input')).toHaveLength(0); // read-only: no actions
    expect(screen.getAllByRole('tab').map((b) => b.textContent)).toEqual(['Compose agent sessions', 'Fleet']);
  }, 20_000);

  it('Ops strip shows the three pills and a click opens the Fleet view', async () => {
    const onOpenFleet = vi.fn();
    render(<OpsStrip activeView="dashboard" onOpenFleet={onOpenFleet} />);
    const ctx = await screen.findByText('1 session >250K', {}, { timeout: 10_000 });
    expect(screen.getByText('1 owner question')).toBeTruthy();
    expect(screen.getByText('disk 80 GB free')).toBeTruthy();
    fireEvent.click(ctx);
    expect(onOpenFleet).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('mobile Status tab stacks the cards owner questions first, with no actions', async () => {
    render(<StatusTab />);
    await screen.findByTestId('fleet-owner', {}, { timeout: 10_000 });
    const ids = [...document.querySelectorAll('[data-testid^="fleet-"]')]
      .map((n) => n.getAttribute('data-testid'))
      .filter((id) => /^fleet-(owner|sessions|jobs|stratum|disk|spend|ceiling|cadence|ledger)$/.test(id));
    expect(ids[0]).toBe('fleet-owner');
    expect(ids.slice(1, 3)).toEqual(['fleet-sessions', 'fleet-jobs']);
    expect(ids.at(-1)).toBe('fleet-ledger');
    expect(screen.getByTestId('fleet-unavailable-spend')).toBeTruthy();
    expect(screen.getByTestId('mobile-tab-status').querySelectorAll('button')).toHaveLength(0);
    render(<BottomNav active="status" onSelect={() => {}} />);
    expect(screen.getByTestId('mobile-nav-status').getAttribute('aria-pressed')).toBe('true');
  }, 20_000);
});

describe('Fleet UI with every reader down', () => {
  let srv;
  beforeAll(async () => {
    srv = await startServer(fixtureEnv({ COMPOSE_FLEET_PYTHON: '/nonexistent/python3', COMPOSE_FLEET_STRATUM_BIN: '/nonexistent/stratum' }), { cadence: false });
  });
  afterAll(() => srv.stop());
  beforeEach(() => { resetFleetPoller(); pointFetchAt(srv.base); });
  afterEach(() => vi.unstubAllGlobals());

  it('hides the Fleet pane switch, the pills and the mobile cards', async () => {
    render(<SessionsView sessions={[]} />);
    await waitFor(() => expect(screen.queryByTestId('sessions-pane-fleet')).toBeNull(), { timeout: 10_000 });
    expect(screen.getByText('No sessions')).toBeTruthy();
    const { container } = render(<OpsStrip activeView="dashboard" onOpenFleet={() => {}} />);
    await waitFor(() => expect(container.querySelector('.ops-strip')).toBeNull());
    render(<StatusTab />);
    await screen.findByTestId('mobile-status-empty');
    expect(document.querySelector('[data-testid^="fleet-owner"]')).toBeNull();
  }, 20_000);
});

describe('fleet poller', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('pauses while the tab is hidden and fetches at once when shown again', async () => {
    vi.useFakeTimers();
    resetFleetPoller();
    const calls = [];
    vi.stubGlobal('fetch', async (url) => { calls.push(String(url)); return { ok: true, json: async () => ({ sources: {} }) }; });
    let visibility = 'visible';
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const stop = subscribeFleet(() => {});
    const stop2 = subscribeFleet(() => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(FLEET_POLL_MS * 2); });
    expect(calls).toHaveLength(3); // one at subscribe (shared by both subscribers) + two intervals
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => { await vi.advanceTimersByTimeAsync(FLEET_POLL_MS * 4); });
    expect(calls).toHaveLength(3);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(calls).toHaveLength(4);
    stop(); stop2();
    await act(async () => { await vi.advanceTimersByTimeAsync(FLEET_POLL_MS * 4); });
    expect(calls).toHaveLength(4);
    expect(calls.every((u) => u === '/api/fleet')).toBe(true);
    spy.mockRestore();
  });
});

// Cadence "proposed" line (forge-main/cadence-main addendum 2026-10-30): the three line states
// (nothing proposed, proposed with blockers, proposed at wall) plus the edges. [name, cadence value, expected line]
const PROPOSED_ROWS = [
  ['nothing proposed, top 4 blockers', { readiness: { byRule: { 'parked-until': 153, 'no-brief': 123, held: 49, claimed: 23, other: 2 } }, wouldLaunch: { value: { units: [], at_wall: '' } } },
    'Cadence would start: none · top blockers: parked-until 153, no-brief 123, held 49, claimed 23'],
  ['proposed with blockers', { readiness: { byRule: { held: 3, 'no-brief': 5 } }, wouldLaunch: { value: { units: ['forge/A-1', 'wiki/B-2'], at_wall: '' } } },
    'Cadence would start: forge/A-1, wiki/B-2 · top blockers: no-brief 5, held 3'],
  ['proposed at wall (at_wall empties the list)', { readiness: { byRule: { held: 3 } }, wouldLaunch: { value: { units: [], at_wall: 'fleet cap 8/8' } } },
    'Cadence would start: none · top blockers: held 3 · held: fleet cap 8/8'],
  ['no readiness and no shadow line', { readiness: null, wouldLaunch: { value: null, error: 'shadow log: ENOENT' } },
    'Cadence would start: none'],
];

// Ready-row blocker reasons: [name, belt unit, expected text]
const REASON_ROWS = [
  ['every blockers entry', { blockers: ['no-brief', 'held'], blocker: 'no-brief', decision: 'blocked' }, 'no-brief, held'],
  ['single blocker when blockers is empty', { blockers: [], blocker: 'parked-until', decision: 'blocked' }, 'parked-until'],
  ['verdict when unblocked', { blockers: [], blocker: null, decision: 'launchable' }, 'launchable'],
];

describe('Cadence proposed line', () => {
  it('is one line in every state, never an empty panel', () => {
    for (const [name, cadence, line] of PROPOSED_ROWS) expect(proposedLine(cadence), name).toBe(line);
  });
  it('ready rows carry their blocker reasons', () => {
    for (const [name, unit, text] of REASON_ROWS) expect(blockerReasons(unit), name).toBe(text);
  });
});

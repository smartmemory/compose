/**
 * COMP-COCKPIT-PROCESS-DATA-1: the three cockpit surfaces that now read data the builder and the fleet already carry.
 * One row table per surface: the Flow-of-work edges from summary.flow (through ProcessView, the real fixture), the
 * header pill's fleet line (AgentStatusPill on a stubbed /api/fleet), and the Usage view's "Seats and fleet" scope.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ProcessView from '../../src/components/cockpit/ProcessView.jsx';
import { AgentStatusPill } from '../../src/components/cockpit/HeaderStatus.jsx';
import UsageView from '../../src/components/usage/UsageView.jsx';
import { resetProcessPoller } from '../../src/lib/processPoller.js';
import { resetFleetPoller } from '../../src/lib/fleetPoller.js';

const FIX = join(process.cwd(), 'test', 'fixtures', 'process');
const envelope = () => structuredClone(JSON.parse(readFileSync(join(FIX, 'api-process.json'), 'utf8')));
const withFlow = (flow) => { const env = envelope(); env.sources.builder.value.pages.hub.value.flow = flow; return env; };
const sm = (panels) => ({ generated: '2026-10-31T11:00:00Z', sources: { sm_status: { value: { queue: { value: [], error: null }, ...panels }, error: null, ts: 1, stale: false } } });
const SM_DOWN = { generated: '2026-10-31T11:00:00Z', sources: { sm_status: { value: null, error: 'timed out after 60000 ms', ts: 1, stale: false } } };
const q = (id) => screen.queryByTestId(id);
const t = (id) => screen.getByTestId(id).textContent;

function stubFetch(routes) {
  const fn = vi.fn(async (url) => {
    const hit = Object.entries(routes).find(([p]) => String(url).startsWith(p));
    return { ok: true, status: 200, json: async () => (hit ? hit[1] : {}) };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const FLOW_EDGES = ['fix-loop', 'clean-gate', 'fix-gate', 'passed-landed'];
const FLOW_ROWS = [
  {
    name: 'all four counts recorded: solid edges carrying the number, the footnote says where they come from',
    flow: { fix_loop: 14, clean_to_gate: 15, fix_to_gate: 4, passed_to_landed: 1, basis: 'unit stamps' },
    want: { 'fix-loop': 14, 'clean-gate': 15, 'fix-gate': 4, 'passed-landed': 1 },
    note: ['Not in the data: per-stage time.', 'counted from the unit stamps'],
  },
  {
    name: 'a zero is a recorded count, not a missing one',
    flow: { fix_loop: 0, clean_to_gate: 0, fix_to_gate: 0, passed_to_landed: 0 },
    want: { 'fix-loop': 0, 'clean-gate': 0, 'fix-gate': 0, 'passed-landed': 0 },
    note: ['Not in the data: per-stage time.'],
  },
  {
    name: 'only some counts present: the rest stay dashed with no number and the footnote names them',
    flow: { fix_loop: 3, clean_to_gate: null, fix_to_gate: 'n/a', passed_to_landed: 7 },
    want: { 'fix-loop': 3, 'clean-gate': null, 'fix-gate': null, 'passed-landed': 7 },
    note: ['how clean vs fixed units split into gate runs'],
  },
  {
    name: 'no flow key (an older builder): exactly today\'s dashed edges and footnote',
    flow: undefined,
    want: { 'fix-loop': null, 'clean-gate': null, 'fix-gate': null, 'passed-landed': null },
    note: ['Not in the data: how clean vs fixed units split into gate runs, per-stage time, and gate-to-land counts'],
  },
];

describe('Flow of work edges from summary.flow', () => {
  for (const row of FLOW_ROWS) {
    it(row.name, async () => {
      resetProcessPoller();
      resetFleetPoller();
      stubFetch({ '/api/process': withFlow(row.flow), '/api/fleet': sm({}) });
      render(<ProcessView />);
      await screen.findByTestId('process-flow-hub');
      for (const edge of FLOW_EDGES) {
        const el = q(`flow-hub-edge-${edge}`);
        const want = row.want[edge];
        expect([edge, el.getAttribute('data-kind')]).toEqual([edge, want === null ? 'not-in-data' : 'recorded']);
        expect([edge, el.hasAttribute('stroke-dasharray')]).toEqual([edge, want === null]);
        expect([edge, q(`flow-hub-edge-val-${edge}`)?.textContent ?? null]).toEqual([edge, want === null ? null : String(want)]);
      }
      for (const part of row.note) expect(t('flow-hub-note')).toContain(part);
    });
  }
});

const SESSIONS = (busy) => ({ value: Array.from({ length: 4 }, (_, i) => ({ name: `s${i}`, busy: i < busy, ctx: 1000 })), error: null });
const JOBS = (alive) => ({ value: Array.from({ length: 8 }, (_, i) => ({ id: `j${i}`, alive: i < alive })), error: null });
const PILL_ROWS = [
  { name: 'fleet busy and jobs alive: Idle locally, the fleet line follows', fleet: sm({ sessions: SESSIONS(2), jobs: JOBS(3) }), want: 'Idle · 2 sessions busy · 3 jobs' },
  { name: 'one of each: singular words', fleet: sm({ sessions: SESSIONS(1), jobs: JOBS(1) }), want: 'Idle · 1 session busy · 1 job' },
  { name: 'jobs only', fleet: sm({ sessions: SESSIONS(0), jobs: JOBS(7) }), want: 'Idle · 7 jobs' },
  { name: 'nothing running: plain Idle', fleet: sm({ sessions: SESSIONS(0), jobs: JOBS(0) }), want: 'Idle' },
  { name: 'a panel errored: the other still counts', fleet: sm({ sessions: { value: null, error: 'exit 2' }, jobs: JOBS(2) }), want: 'Idle · 2 jobs' },
  { name: 'sm_status down: local state only, no error text', fleet: SM_DOWN, want: 'Idle' },
  { name: 'local agent working: its category leads, the fleet line follows', fleet: sm({ sessions: SESSIONS(2), jobs: JOBS(0) }), want: 'Writing · 2 sessions busy',
    after: () => window.dispatchEvent(new CustomEvent('compose:agent-status', { detail: { status: 'working', category: 'writing' } })) },
];

describe('Header agent pill reads the fleet', () => {
  for (const row of PILL_ROWS) {
    it(row.name, async () => {
      resetFleetPoller();
      const fetchFn = stubFetch({ '/api/fleet': row.fleet });
      render(<AgentStatusPill />);
      await waitFor(() => expect(fetchFn).toHaveBeenCalled());
      if (row.after) act(row.after);
      await waitFor(() => expect(t('header-agent-status')).toBe(row.want));
      expect(screen.getByTestId('header-agent-status').getAttribute('aria-label')).toBe(`Agent: ${row.want}`);
      expect(fetchFn.mock.calls.every(([u]) => String(u) === '/api/fleet')).toBe(true);
    });
  }
});

const SEAT = (id, label, status, five, seven, pts) => ({
  id, label, vendor: 'claude', status, today_pts: pts,
  five_h: { used_pct: five, resets_at: five === null ? null : '2026-10-31T13:00:00.000Z' },
  seven_d: { used_pct: seven, resets_at: seven === null ? null : '2026-11-03T12:00:00.000Z' },
});
const seatsBody = (value, error = null) => ({ v: 1, generated_at: '2026-10-31T12:00:00Z', seats: { value, error, ts: 1, stale: false } });
const statsClient = (extra) => ({ getStats: vi.fn(async () => ({ v: 1, current: null, previous: null })), ...extra });
const FLEET_SPEND = sm({
  ceiling: { value: { line: 'spend today $1,866 / $4,000 (47%)', pct: 46.6, warn: false }, error: null },
  spend: { value: { head: 'last 1h $214 API-equiv · 2111 calls · 28 sessions', rows: ['$   31.04  sm20-main', '$   19.25  forge-main'] }, error: null },
});
const USAGE_ROWS = [
  {
    name: 'fleet scope: day spend line, last hour by session, one quota row per seat',
    fleet: FLEET_SPEND,
    getSeats: async () => seatsBody({ generated_at: null, seats: [SEAT('seat1', 'Claude Team seat 1', 'ok', 39, null, null), SEAT('max', 'Claude Max 20x', 'stale', 0, 44, 0)] }),
    check() {
      expect(t('usage-fleet-ceiling')).toContain('spend today $1,866 / $4,000 (47%)');
      expect(t('usage-fleet-spend')).toContain('last 1h $214');
      expect(t('usage-fleet-spend')).toContain('forge-main');
      const s1 = [...screen.getByTestId('usage-seat-seat1').querySelectorAll('td')].map((c) => c.textContent);
      expect(s1).toEqual(['Claude Team seat 1', 'ok', '39%', '1.0h', '—', '—', '—']);
      const mx = [...screen.getByTestId('usage-seat-max').querySelectorAll('td')].map((c) => c.textContent);
      expect(mx).toEqual(['Claude Max 20x', 'stale', '0%', '1.0h', '44%', '3d', '0']);
      expect(q('usage-seats-error')).toBeNull();
      expect(t('usage-seats-note')).toContain('not per seat');
    },
  },
  {
    name: 'seat reader down: an error line, the fleet spend still shows',
    fleet: FLEET_SPEND,
    getSeats: async () => seatsBody(null, 'reader missing: /x/usage_watch.py'),
    check() {
      expect(t('usage-seats-error')).toContain('reader missing');
      expect(q('usage-seats-table')).toBeNull();
      expect(t('usage-fleet-ceiling')).toContain('$1,866');
    },
  },
  {
    name: 'sm_status down: both spend panels say unavailable, seats still render',
    fleet: SM_DOWN,
    getSeats: async () => seatsBody({ generated_at: null, seats: [SEAT('seat2', 'Claude Team seat 2', 'ok', 59, null, null)] }),
    check() {
      expect(t('usage-fleet-ceiling')).toContain('fleet status unavailable');
      expect(t('usage-fleet-spend')).toContain('fleet status unavailable');
      expect(q('usage-seat-seat2')).not.toBeNull();
    },
  },
  {
    name: 'seats route throws: the error line, no crash',
    fleet: FLEET_SPEND,
    getSeats: async () => { throw new Error('usage seats failed (502)'); },
    check() { expect(t('usage-seats-error')).toContain('usage seats failed (502)'); },
  },
];

describe('Usage view "Seats and fleet" scope', () => {
  it('the default scope starts no fleet poll and asks for no seats', async () => {
    resetFleetPoller();
    const fetchFn = stubFetch({});
    const client = statsClient({ getSeats: vi.fn() });
    render(<UsageView client={client} now="2026-10-31T12:00:00Z" />);
    await waitFor(() => expect(client.getStats).toHaveBeenCalled());
    expect(client.getSeats).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(q('usage-fleet')).toBeNull();
  });
  for (const row of USAGE_ROWS) {
    it(row.name, async () => {
      resetFleetPoller();
      stubFetch({ '/api/fleet': row.fleet });
      const client = statsClient({ getSeats: vi.fn(row.getSeats) });
      render(<UsageView client={client} now="2026-10-31T12:00:00Z" />);
      fireEvent.click(screen.getByRole('button', { name: 'Seats and fleet' }));
      await screen.findByTestId('usage-fleet');
      await waitFor(() => expect(client.getSeats).toHaveBeenCalledTimes(1));
      await waitFor(() => row.check());
    });
  }
});

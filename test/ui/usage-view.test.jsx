/** COMP-OBS-STATS-1: UsageView renders tiles, chart and table from a fake client, and an empty state. */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import UsageView from '../../src/components/usage/UsageView.jsx';
import { locateView } from '../../lib/view-keys.js';
import CostMeter from '../../src/components/cockpit/cost/CostMeter.jsx';
import HomeFleetGlance from '../../src/components/vision/HomeFleetGlance.jsx';
import HomeSections from '../../src/components/vision/HomeSections.jsx';
import { deriveHomeSections } from '../../src/components/vision/homeSectionsState.js';
import { resetFleetPoller } from '../../src/lib/fleetPoller.js';

const prov = (r, e, a) => ({ reported: { dispatch_count: r, usd: 0 }, estimated: { dispatch_count: e, usd: 0 }, absent: { dispatch_count: a, usd: 0 } });

function usage({ empty = false, usd = 3.5 } = {}) {
  return {
    empty,
    tiles: {
      total_cost: { usd: empty ? 0 : usd, provenance: empty ? prov(0, 0, 0) : prov(1, 1, 1) },
      total_tokens: { value: empty ? 0 : 1200, missing_count: 0 },
      output_tokens: { value: empty ? 0 : 200, missing_count: 0 },
      dispatches: { value: empty ? 0 : 3 },
      active_days: { value: empty ? 0 : 2 },
      retry_cost: { usd: 0.5, dispatch_count: 1, attempt_unknown_count: 0 },
      wasted_spend: { usd: 1, dispatch_count: 1, statuses: ['failed', 'aborted', 'killed'], joined_count: 1, unjoined_count: 0, no_build_count: 2 },
      cache_hit_rate: { scope: 'build', by_model: false, rate: empty ? null : 0.7, cache_read_tokens: 7, input_tokens: 3, builds_counted: 1, builds_excluded: 1 },
    },
    incomplete: { marked: !empty, usd_unknown_count: empty ? 0 : 2, dispatches_missing_usd: 0 },
    builds: { in_range: 1, statuses: { failed: 1 } },
    models: empty ? [] : [
      { model: 'model-a', unknown: false, dispatch_count: 2, usd: 3, tokens_total: 1000, tokens_out: 150, share: 3 / 3.5, provenance_counts: { reported: 1, estimated: 1, absent: 0 } },
      { model: null, unknown: true, dispatch_count: 1, usd: 0.5, tokens_total: 200, tokens_out: 50, share: 0.5 / 3.5, provenance_counts: { reported: 0, estimated: 0, absent: 1 } },
    ],
    days: [
      { date: '2026-10-01', dispatch_count: empty ? 0 : 2, usd: 3, tokens_total: 1000, by_model: empty ? {} : { 'model-a': { usd: 3, tokens_total: 1000, dispatch_count: 2 } }, by_site: {} },
      { date: '2026-10-02', dispatch_count: 0, usd: 0, tokens_total: 0, by_model: {}, by_site: {} },
      { date: '2026-10-03', dispatch_count: empty ? 0 : 1, usd: 0.5, tokens_total: 200, by_model: empty ? {} : { unknown: { usd: 0.5, tokens_total: 200, dispatch_count: 1 } }, by_site: {} },
    ],
  };
}

const fakeClient = (cur, prev = null) => ({
  getStats: vi.fn(async ({ compare }) => ({ v: 1, generated_at: '2026-10-04T12:00:00.000Z', current: cur, previous: compare ? prev : null })),
});

describe('UsageView', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is a sub-tab of the Fleet room', () => expect(locateView('usage')).toEqual({ top: 'fleet', sub: 'usage' }));

  it('renders tiles, chart and table from the client without fetching', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const client = fakeClient(usage(), usage({ usd: 2 }));
    const { container } = render(<UsageView client={client} now="2026-10-03T12:00:00" initialScope="compose" />);
    await waitFor(() => screen.getByTestId('usage-model-table'));
    expect(screen.getAllByTestId('usage-tile')).toHaveLength(8);
    expect(screen.getByText('~$3.50')).toBeTruthy(); // absent provenance -> ~$X + marker
    expect(screen.getAllByTestId('unknown-provenance').length).toBeGreaterThan(0);
    expect(screen.getByText('Cache hit rate (build-level)')).toBeTruthy();
    expect(screen.getByTestId('usage-incomplete')).toBeTruthy();
    expect(screen.getByText('Unknown')).toBeTruthy();
    expect(screen.getByText('~$3.00 est.')).toBeTruthy();
    expect(container.querySelectorAll('[data-day]')).toHaveLength(3); // zero-dispatch day kept
    expect(screen.getByText('Unknown model')).toBeTruthy(); // chart legend keeps the Unknown series
    expect(screen.getByText(/Compose dispatched in this workspace/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Compare with previous period/));
    await waitFor(() => expect(screen.getAllByText(/vs previous/).length).toBe(8));
    expect(client.getStats.mock.calls.at(-1)[0].compare).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('empty ledger renders an empty state, not a row of zeros', async () => {
    render(<UsageView client={fakeClient(usage({ empty: true }))} initialScope="compose" />);
    await waitFor(() => screen.getByText('No dispatches in this range'));
    expect(screen.queryAllByTestId('usage-tile')).toHaveLength(0);
    expect(screen.queryByTestId('usage-chart')).toBeNull();
    expect(screen.queryByTestId('usage-model-table')).toBeNull();
  });
});

// COMP-COCKPIT-COST-METER-1: the one cost meter. One row table, one loop.
const SEAT = (o) => ({
  id: 'seat1', label: 'Claude Team seat 1', vendor: 'claude', status: 'missing', today_pts: null,
  five_h: { used_pct: 37.400000001, resets_at: '2026-10-31T13:00:00.000Z' },
  seven_d: { used_pct: null, resets_at: null, status: 'missing' }, ...o,
});
const MAX = SEAT({ id: 'max', label: 'Claude Max 20x', retired: true, retire_state: 'retired', seven_d: { used_pct: 44, resets_at: null, status: 'stale' } });
const CODEX = (cap) => SEAT({ id: 'codex', label: 'Codex prolite', vendor: 'codex', today_pts: 6, codex_daily: { cap_pct: cap, state: 'ok', off: false } });
const SPEND_OK = { ceiling: { text: 'spend today $1,866 / $4,000 (47%)', pct: 46.6, warn: false }, spend: { text: 'last 1h $214', rows: ['$ 31.04  a', '$ 19.25  b', '$ 9.00  c', '$ 1.00  d', '$ 0.50  e'] } };
const NOW = '2026-10-31T12:00:00Z';
const mt = (id) => screen.getByTestId(id).textContent;
const FLEET_BODY = { generated: NOW, sources: { sm_status: { value: { queue: { value: [], error: null }, ceiling: { value: { line: 'spend today $1,866 / $4,000 (47%)', pct: 46.6, warn: false }, error: null }, spend: { value: { head: 'last 1h $214', rows: [] }, error: null } }, error: null, ts: 1, stale: false } } };
const seatsBody = (seats) => ({ v: 1, generated_at: NOW, seats: { value: { generated_at: NOW, seats }, error: null, ts: 1, stale: false } });

const COST_ROWS = [
  ['integer rounding: 37.400000001 prints 37%, no decimal anywhere', async () => {
    render(<CostMeter seats={[SEAT()]} spend={SPEND_OK} now={NOW} />);
    expect(mt('cost-meter-5h-seat1')).toContain('5h 37%');
    expect(mt('cost-meter')).not.toMatch(/\d\.\d+%/);
  }],
  ['a Team seat 7d column reads the 5h-only words, not a dash or 0%', async () => {
    render(<CostMeter seats={[SEAT()]} now={NOW} />);
    expect(mt('cost-meter-7d-seat1')).toBe('Team seats are 5h-only');
  }],
  ['retired seats get no row, a count note, and the name on hover', async () => {
    render(<CostMeter seats={[SEAT(), MAX]} now={NOW} />);
    expect(screen.queryByTestId('cost-meter-seat-max')).toBeNull();
    expect(mt('cost-meter-retired')).toBe('1 retired seat hidden');
    expect(screen.getByTestId('cost-meter-retired').getAttribute('title')).toBe('Claude Max 20x');
  }],
  ['codex line reads the cap from the data: 13 then 10', async () => {
    const { unmount } = render(<CostMeter seats={[SEAT(), CODEX(13)]} now={NOW} />);
    expect(mt('cost-meter-codex')).toContain('6 / 13 pts');
    unmount();
    render(<CostMeter seats={[SEAT(), CODEX(10)]} now={NOW} />);
    expect(mt('cost-meter-codex')).toContain('6 / 10 pts');
  }],
  ['seats pending: a skeleton, never 0%', async () => {
    render(<CostMeter seats={null} loading now={NOW} />);
    expect(screen.getByTestId('cost-meter-skeleton')).toBeTruthy();
    expect(mt('cost-meter')).not.toContain('0%');
  }],
  ['a source down says what is unavailable and why', async () => {
    render(<CostMeter seats={null} seatsError="reader missing: /x" spend={{ ceiling: { down: 'ceiling unavailable: timed out' }, spend: { down: 'spend unavailable: timed out' } }} now={NOW} />);
    expect(mt('cost-meter-seats-down')).toBe('usage_watch unavailable: reader missing: /x');
    expect(mt('cost-meter-dollars-down')).toBe('ceiling unavailable: timed out');
    expect(mt('cost-meter-hour-down')).toBe('spend unavailable: timed out');
  }],
  ['dollars: ceiling text and bar, last hour top 3 plus "+N more", per-seat not recorded, API credit muted, as-of', async () => {
    render(<CostMeter seats={[SEAT()]} spend={SPEND_OK} asOf={NOW} now="2026-10-31T12:03:00Z" />);
    expect(mt('cost-meter-ceiling')).toContain('$1,866');
    expect(screen.getByTestId('cost-meter-ceiling-bar').getAttribute('aria-valuenow')).toBe('47');
    expect(mt('cost-meter-hour')).toContain('+2 more');
    expect(mt('cost-meter-hour')).not.toContain('$ 1.00');
    expect(mt('cost-meter-per-seat-usd')).toContain('not recorded');
    expect(mt('cost-meter-api-credit')).toBe('API credit: no reader yet');
    expect(mt('cost-meter-asof')).toMatch(/^as of \d\d:\d\d \(3m ago\)$/);
  }],
  ['Home and Usage > Seats and fleet print the same seat numbers, with no Cadence package', async () => {
    const seats = [SEAT(), MAX];
    const client = { getStats: vi.fn(async () => ({ v: 1, current: null, previous: null })), getSeats: vi.fn(async () => seatsBody(seats)) };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => FLEET_BODY })));
    resetFleetPoller();
    render(<HomeFleetGlance client={client} />);
    await waitFor(() => screen.getByTestId('cost-meter-5h-seat1'));
    const pctOnly = (id) => mt(id).split(' · ')[0]; // Home has no `now` prop, so its reset clock is the real one
    const home = [pctOnly('cost-meter-5h-seat1'), mt('cost-meter-7d-seat1'), mt('cost-meter-retired')];
    cleanup();
    resetFleetPoller();
    render(<UsageView client={client} now={NOW} />);
    fireEvent.click(screen.getByRole('button', { name: 'Seats and fleet' }));
    await waitFor(() => screen.getByTestId('cost-meter-5h-seat1'));
    expect([pctOnly('cost-meter-5h-seat1'), mt('cost-meter-7d-seat1'), mt('cost-meter-retired')]).toEqual(home);
    expect(home[0]).toContain('37%');
  }],
  ['Home mounts the Fleet section with showFleet and no Cadence package (cadenceAvailable unset)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
    resetFleetPoller();
    render(<HomeSections sections={deriveHomeSections({})} showFleet />);
    expect(screen.getByTestId('cost-meter')).toBeTruthy();
    expect(screen.getByText('Fleet')).toBeTruthy();
  }],
];

describe('CostMeter', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  for (const [name, run] of COST_ROWS) it(name, run);
});

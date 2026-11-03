/** COMP-OBS-STATS-1: UsageView renders tiles, chart and table from a fake client, and an empty state. */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';
import UsageView from '../../src/components/usage/UsageView.jsx';
import { locateView } from '../../lib/view-keys.js';
import CostMeter from '../../src/components/cockpit/cost/CostMeter.jsx';
import FleetUsage, { FLEET_SEATS_POLL_MS } from '../../src/components/usage/FleetUsage.jsx';
import HomeFleetGlance from '../../src/components/vision/HomeFleetGlance.jsx';
import HomeSections from '../../src/components/vision/HomeSections.jsx';
import { deriveHomeSections } from '../../src/components/vision/homeSectionsState.js';
import { resetFleetPoller, FLEET_POLL_MS } from '../../src/lib/fleetPoller.js';

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

describe('UsageView (COMP-OBS-STATS-1-FU-1)', () => {
  afterEach(cleanup);

  it('an estimated-only ledger shows "est." on total, retry and wasted tiles', async () => {
    const cur = usage();
    cur.tiles.total_cost.provenance = prov(0, 2, 0);
    cur.tiles.retry_cost = { usd: 2, dispatch_count: 1, attempt_unknown_count: 0, provenance: prov(0, 1, 0) };
    cur.tiles.wasted_spend.usd = 2;
    cur.tiles.wasted_spend.provenance = prov(0, 1, 0);
    render(<UsageView client={fakeClient(cur)} now="2026-10-03T12:00:00" initialScope="compose" />);
    await waitFor(() => screen.getByTestId('usage-model-table'));
    const tiles = screen.getAllByTestId('usage-tile');
    const text = (label) => tiles.find((t) => t.textContent.startsWith(label)).textContent;
    expect(text('Total cost')).toContain('est.');
    expect(text('Retry cost')).toContain('~$2.00 est.');
    expect(text('Wasted spend')).toContain('~$2.00 est.');
  });

  it('unreadable build history is said on the page', async () => {
    const cur = usage();
    cur.incomplete = { marked: true, usd_unknown_count: 0, dispatches_missing_usd: 0, history_unreadable: 'build history unreadable (EACCES)' };
    render(<UsageView client={fakeClient(cur)} now="2026-10-03T12:00:00" initialScope="compose" />);
    await waitFor(() => screen.getByTestId('usage-incomplete'));
    expect(screen.getByTestId('usage-incomplete').textContent).toContain('Build history unreadable (build history unreadable (EACCES))');
    expect(screen.getByTestId('usage-incomplete').textContent).not.toContain('Cost incomplete');
  });

  it('a late Refresh answer cannot overwrite a newer range', async () => {
    const pending = [];
    const client = { getStats: vi.fn(() => new Promise((resolve) => pending.push(resolve))) };
    const answer = (i, usd) => pending[i]({ v: 1, generated_at: '2026-10-04T12:00:00.000Z', current: usage({ usd }), previous: null });
    render(<UsageView client={client} now="2026-10-03T12:00:00" initialScope="compose" />);
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => answer(0, 1));
    fireEvent.click(screen.getByLabelText('Refresh'));
    await waitFor(() => expect(pending).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
    await waitFor(() => expect(pending).toHaveLength(3));
    await act(async () => answer(2, 7));
    await waitFor(() => expect(screen.getAllByTestId('usage-tile')[0].textContent).toContain('$7.00'));
    await act(async () => answer(1, 2)); // the old Refresh resolves last
    expect(screen.getAllByTestId('usage-tile')[0].textContent).toContain('$7.00');
    expect(screen.getAllByTestId('usage-tile')[0].textContent).not.toContain('$2.00');
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
  ['a Codex account with no codex_daily block says "Codex daily: not reported", it is not a plain seat (COST-METER M2)', async () => {
    const bare = SEAT({ id: 'codex', label: 'Codex prolite', vendor: 'codex', today_pts: 4, five_h: { used_pct: null, resets_at: null }, seven_d: { used_pct: 19, resets_at: null, status: 'ok' } });
    const { unmount } = render(<CostMeter seats={[SEAT(), bare]} now={NOW} />);
    expect(mt('cost-meter-codex-unreported')).toBe('Codex daily: not reported');
    expect(screen.queryByTestId('cost-meter-seat-codex')).toBeNull();
    expect(screen.queryByTestId('cost-meter-seat-seat1')).toBeTruthy();
    unmount();
    render(<CostMeter bars seats={[SEAT(), bare]} now={NOW} />);
    expect(mt('cost-meter-codex-unreported')).toBe('Codex daily: not reported');
    expect(screen.getByTestId('cost-meter-codex').getAttribute('title')).toContain('Codex daily: not reported');
    expect(screen.queryByTestId('cost-meter-seat-codex')).toBeNull();
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
    render(<CostMeter seats={[SEAT()]} spend={SPEND_OK} asOf={NOW} now="2026-10-31T12:03:00Z" credit={{ value: { balance_usd: null, hold: true }, error: null }} />);
    expect(mt('cost-meter-ceiling')).toContain('$1,866');
    expect(screen.getByTestId('cost-meter-ceiling-bar').getAttribute('aria-valuenow')).toBe('47');
    expect(mt('cost-meter-hour')).toContain('+2 more');
    expect(mt('cost-meter-hour')).not.toContain('$ 1.00');
    expect(mt('cost-meter-per-seat-usd')).toContain('not recorded');
    expect(mt('cost-meter-api-credit')).toBe('API credit: balance not set · API billing on hold');
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

describe('FleetUsage seat polling (COST-METER M1 / PROCESS-DATA M1)', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  const body = (pct, stale) => ({ v: 1, generated_at: NOW, seats: { value: { generated_at: NOW, seats: [SEAT({ five_h: { used_pct: pct, resets_at: null } })] }, error: null, ts: 1, stale } });

  it('the second poll reaches the meter, and a stale body says so until then', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => FLEET_BODY })));
    resetFleetPoller();
    const answers = [body(10, true), body(90, false)];
    const client = { getSeats: vi.fn(async () => answers[Math.min(client.getSeats.mock.calls.length - 1, 1)]) };
    render(<FleetUsage client={client} now={NOW} />);
    await waitFor(() => expect(mt('usage-seat-seat1')).toContain('10%'));
    expect(mt('usage-seats-stale')).toContain('stale');
    expect(client.getSeats).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(FLEET_SEATS_POLL_MS); });
    await waitFor(() => expect(mt('usage-seat-seat1')).toContain('90%'));
    expect(client.getSeats).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('usage-seats-stale')).toBeNull();
  });

  it('an older answer never lands over a newer one, and unmount stops the poll', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => FLEET_BODY })));
    resetFleetPoller();
    const pending = [];
    const client = { getSeats: vi.fn(() => new Promise((r) => pending.push(r))) };
    const { unmount } = render(<FleetUsage client={client} now={NOW} />);
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.click(screen.getByLabelText('Refresh seats'));
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => pending[1](body(90, false)));
    await act(async () => pending[0](body(10, false))); // the older read resolves last
    expect(mt('usage-seat-seat1')).toContain('90%');
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(FLEET_SEATS_POLL_MS * 2); });
    expect(client.getSeats).toHaveBeenCalledTimes(2);
  });
});

describe('COMP-FLEET-USAGE-FU-1', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); delete document.visibilityState; });
  const setVisibility = (v) => { Object.defineProperty(document, 'visibilityState', { value: v, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); };
  const seatsClient = () => ({ getSeats: vi.fn(async () => seatsBody([SEAT()])), getCredit: undefined });

  it('OBS M2: an empty range with an unreadable build history still shows the source banner', async () => {
    const cur = usage({ empty: true });
    cur.incomplete = { marked: true, history_unreadable: 'EACCES: build history unreadable', usd_unknown_count: 0, dispatches_missing_usd: 0 };
    render(<UsageView client={fakeClient(cur)} now="2026-10-03T12:00:00" initialScope="compose" />);
    await waitFor(() => screen.getByText('No dispatches in this range'));
    expect(screen.getByTestId('usage-incomplete').textContent).toContain('Build history unreadable (EACCES: build history unreadable)');
  });

  it('L1: hidden for 60 s makes no seats call, and coming back visible refreshes once', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => FLEET_BODY })));
    resetFleetPoller();
    const client = seatsClient();
    render(<FleetUsage client={client} now={NOW} />);
    await waitFor(() => expect(client.getSeats).toHaveBeenCalledTimes(1));
    await act(async () => { setVisibility('hidden'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(FLEET_SEATS_POLL_MS * 2); });
    expect(client.getSeats).toHaveBeenCalledTimes(1);
    await act(async () => { setVisibility('visible'); await vi.advanceTimersByTimeAsync(0); });
    await waitFor(() => expect(client.getSeats).toHaveBeenCalledTimes(2));
    await act(async () => { await vi.advanceTimersByTimeAsync(FLEET_POLL_MS); }); // the next fleet tick is 15 s on: not 60 s since the read
    expect(client.getSeats).toHaveBeenCalledTimes(2);
  });

  it('L1: Home\'s glance pauses while hidden the same way', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => FLEET_BODY })));
    resetFleetPoller();
    const client = seatsClient();
    render(<HomeFleetGlance client={client} />);
    await waitFor(() => expect(client.getSeats).toHaveBeenCalledTimes(1));
    await act(async () => { setVisibility('hidden'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(FLEET_SEATS_POLL_MS * 2); });
    expect(client.getSeats).toHaveBeenCalledTimes(1);
    await act(async () => { setVisibility('visible'); await vi.advanceTimersByTimeAsync(0); });
    await waitFor(() => expect(client.getSeats).toHaveBeenCalledTimes(2));
  });

  for (const [name, el] of [['Usage > Seats and fleet', (c) => <FleetUsage client={c} now={NOW} />], ['Home glance', (c) => <HomeFleetGlance client={c} />]]) {
    it(`SOURCE-FAULTS M2: ${name} says the dollars are old after one good read and a failed refresh`, async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
      const good = { generated: NOW, sources: { sm_status: { value: { queue: { value: [], error: null }, ceiling: { value: { line: '$7 of $50', pct: 14, warn: false }, error: null }, spend: { value: { head: 'last 1h $7', rows: [] }, error: null } }, error: null, ts: 1, stale: false } } };
      let n = 0;
      vi.stubGlobal('fetch', vi.fn(async () => (++n === 1 ? { ok: true, status: 200, json: async () => good } : { ok: false, status: 503, json: async () => ({}) })));
      resetFleetPoller();
      render(el(seatsClient()));
      await waitFor(() => expect(n).toBeGreaterThanOrEqual(1));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.queryByTestId('source-note')).toBeNull(); // healthy: no note
      await act(async () => { await vi.advanceTimersByTimeAsync(FLEET_POLL_MS); });
      const note = await screen.findByTestId('source-note');
      expect(note.textContent).toMatch(/^Fleet unreadable since \d\d:\d\d: fleet route 503; showing the last good read from \d\d:\d\d$/);
      expect(note.getAttribute('data-stale')).toBe('true');
    });
  }
});

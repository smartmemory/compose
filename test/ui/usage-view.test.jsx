/** COMP-OBS-STATS-1: UsageView renders tiles, chart and table from a fake client, and an empty state. */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import UsageView from '../../src/components/usage/UsageView.jsx';
import { DEFAULT_MAIN_TABS } from '../../src/components/cockpit/viewTabsState.js';

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

  it('is a default tab', () => expect(DEFAULT_MAIN_TABS).toContain('usage'));

  it('renders tiles, chart and table from the client without fetching', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const client = fakeClient(usage(), usage({ usd: 2 }));
    const { container } = render(<UsageView client={client} now="2026-10-03T12:00:00" />);
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
    render(<UsageView client={fakeClient(usage({ empty: true }))} />);
    await waitFor(() => screen.getByText('No dispatches in this range'));
    expect(screen.queryAllByTestId('usage-tile')).toHaveLength(0);
    expect(screen.queryByTestId('usage-chart')).toBeNull();
    expect(screen.queryByTestId('usage-model-table')).toBeNull();
  });
});

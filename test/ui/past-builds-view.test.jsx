/**
 * COMP-COCKPIT-3: PastBuildsView renders archived build runs (prop-driven,
 * like SessionsView), with honest empty state, status filtering, and
 * feature-code → item resolution.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PastBuildsView from '../../src/components/vision/PastBuildsView.jsx';
import { setSensitiveToken } from '../../src/lib/compose-api.js';

const builds = [
  { featureCode: 'FEAT-B', status: 'failed', completedAt: '2026-06-08T01:00:00.000Z', durationMs: 90000, cost_usd: 0.5, stepCount: 3, failureReason: 'test step failed: timeout' },
  { featureCode: 'FEAT-A', status: 'complete', completedAt: '2026-06-08T00:00:00.000Z', durationMs: 45000, cost_usd: 0.12, stepCount: 4, failureReason: null },
];
const items = [{ id: 'i-a', featureCode: 'FEAT-A', title: 'Feature A' }];

describe('PastBuildsView (COCKPIT-3)', () => {
  it('shows an honest empty state when there are no builds', () => {
    render(<PastBuildsView builds={[]} items={[]} />);
    expect(screen.getByText('No past builds yet')).toBeTruthy();
  });

  it('renders each build with status, duration, and failure reason', () => {
    render(<PastBuildsView builds={builds} items={items} />);
    expect(screen.getByText('FEAT-A')).toBeTruthy();
    expect(screen.getByText('FEAT-B')).toBeTruthy();
    // failure reason only on the failed build
    expect(screen.getByText('test step failed: timeout')).toBeTruthy();
    // duration formatted
    expect(screen.getByText(/1m 30s/)).toBeTruthy();
  });

  it('filters by status', () => {
    render(<PastBuildsView builds={builds} items={items} />);
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'complete' } });
    expect(screen.getByText('FEAT-A')).toBeTruthy();
    expect(screen.queryByText('FEAT-B')).toBeNull();
  });

  it('resolves a known feature code to an item on click', () => {
    const onSelectItem = vi.fn();
    render(<PastBuildsView builds={builds} items={items} onSelectItem={onSelectItem} />);
    fireEvent.click(screen.getByText('FEAT-A'));
    expect(onSelectItem).toHaveBeenCalledWith('i-a');
  });
});

/**
 * COMP-COCKPIT-7: failed-build retry from Past Builds. A Retry button on
 * failed/aborted rows re-dispatches POST /api/build/start with the record's
 * featureCode + mode; feedback goes through notify() (compose:notify events).
 */
describe('PastBuildsView retry (COCKPIT-7)', () => {
  const retryBuilds = [
    { featureCode: 'FEAT-FAIL', mode: 'feature', status: 'failed', completedAt: '2026-06-08T01:00:00.000Z', durationMs: 1000, failureReason: 'boom' },
    { featureCode: 'FEAT-ABORT', mode: 'bug', status: 'aborted', completedAt: '2026-06-08T02:00:00.000Z', durationMs: 1000 },
    { featureCode: 'FEAT-OK', mode: 'feature', status: 'complete', completedAt: '2026-06-08T03:00:00.000Z', durationMs: 1000 },
    { featureCode: 'FEAT-KILL', mode: 'feature', status: 'killed', completedAt: '2026-06-08T04:00:00.000Z', durationMs: 1000 },
  ];

  let fetchCalls = [];
  let startResponse;
  let notifications = [];
  const onNotify = (e) => notifications.push(e.detail);

  beforeEach(() => {
    setSensitiveToken('test-token');
    startResponse = { status: 200, body: { started: true } };
    fetchCalls = [];
    notifications = [];
    window.addEventListener('compose:notify', onNotify);
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
      fetchCalls.push({ url: String(url), opts });
      return new Response(JSON.stringify(startResponse.body), { status: startResponse.status });
    });
  });

  afterEach(() => {
    window.removeEventListener('compose:notify', onNotify);
    vi.restoreAllMocks();
  });

  it('renders Retry only for failed and aborted builds', () => {
    render(<PastBuildsView builds={retryBuilds} items={[]} />);
    const rows = retryBuilds.map(b => screen.getByText(b.featureCode).closest('div[class*="flex-col"]'));
    const retryButtons = screen.getAllByRole('button', { name: /retry/i });
    expect(retryButtons).toHaveLength(2);
    // failed + aborted rows contain a Retry button; complete + killed do not
    expect(rows[0].textContent).toMatch(/retry/i);
    expect(rows[1].textContent).toMatch(/retry/i);
    expect(rows[2].textContent).not.toMatch(/retry/i);
    expect(rows[3].textContent).not.toMatch(/retry/i);
  });

  it('POSTs /api/build/start with the record featureCode and mode on click', async () => {
    render(<PastBuildsView builds={[retryBuilds[1]]} items={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(fetchCalls.some(c => c.url.includes('/api/build/start'))).toBe(true));
    const call = fetchCalls.find(c => c.url.includes('/api/build/start'));
    expect(call.opts.method).toBe('POST');
    expect(JSON.parse(call.opts.body)).toMatchObject({ featureCode: 'FEAT-ABORT', mode: 'bug' });
  });

  it('surfaces a warn notify mentioning the feature code on 409', async () => {
    startResponse = { status: 409, body: { error: 'A build is already active for FEAT-FAIL' } };
    render(<PastBuildsView builds={[retryBuilds[0]]} items={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(notifications.length).toBeGreaterThan(0));
    const n = notifications[0];
    expect(n.level).toBe('warn');
    expect(n.message).toContain('FEAT-FAIL');
    expect(n.message).toMatch(/already active/i);
  });

  it('surfaces an info notify on success', async () => {
    render(<PastBuildsView builds={[retryBuilds[0]]} items={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(notifications.length).toBeGreaterThan(0));
    const n = notifications[0];
    expect(n.level).toBe('info');
    expect(n.message).toContain('FEAT-FAIL');
    expect(n.message).toMatch(/restarted/i);
  });
});

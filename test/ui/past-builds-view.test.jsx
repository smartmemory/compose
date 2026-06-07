/**
 * COMP-COCKPIT-3: PastBuildsView renders archived build runs (prop-driven,
 * like SessionsView), with honest empty state, status filtering, and
 * feature-code → item resolution.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PastBuildsView from '../../src/components/vision/PastBuildsView.jsx';

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

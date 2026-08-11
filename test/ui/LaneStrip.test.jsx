/**
 * LaneStrip.test.jsx — vitest+jsdom tests for LaneStrip.jsx (COMP-AGENT-LANES S03b).
 *
 *   - One tab per lane with label + status dot
 *   - Attempt badge on retried lanes; (joined mid-build) marker
 *   - Selected lane's feed shows only that lane's messages
 *   - Collapsed state renders the counter line (legacy parity)
 *   - Renders nothing without lanes
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LaneStrip from '../../src/components/cockpit/LaneStrip.jsx';

function makeEntry(overrides = {}) {
  const lane = {
    flowId: 'f1', stepId: 'execute_tasks/0', itemIndex: 0,
    generation: 1, attempt: 1, label: 'worker A', agent: 'claude',
    ...(overrides.lane ?? {}),
  };
  return {
    key: `${lane.flowId}:${lane.stepId}:${lane.itemIndex}`,
    lane,
    status: 'working',
    version: [lane.generation, lane.attempt],
    messages: [],
    joinedMidBuild: false,
    ...overrides,
    lane,
  };
}

function textMessage(text) {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] }, _source: 'build' };
}

describe('<LaneStrip>', () => {
  it('renders nothing without lanes', () => {
    const { container } = render(<LaneStrip lanes={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders one tab per lane with its label', () => {
    const lanes = [
      makeEntry({ lane: { itemIndex: 0, label: 'worker A' } }),
      makeEntry({ lane: { itemIndex: 1, label: 'worker B' } }),
    ];
    render(<LaneStrip lanes={lanes} />);
    expect(screen.getByText('worker A')).toBeTruthy();
    expect(screen.getByText('worker B')).toBeTruthy();
  });

  it('shows a status dot per tab reflecting lane status', () => {
    const lanes = [
      makeEntry({ lane: { itemIndex: 0, label: 'ok' }, status: 'succeeded' }),
      makeEntry({ lane: { itemIndex: 1, label: 'bad' }, status: 'failed' }),
    ];
    render(<LaneStrip lanes={lanes} />);
    const dots = screen.getAllByTestId('lane-status-dot');
    expect(dots.length).toBe(2);
    expect(dots[0].dataset.status).toBe('succeeded');
    expect(dots[1].dataset.status).toBe('failed');
  });

  it('shows an attempt badge only for retried lanes', () => {
    const lanes = [
      makeEntry({ lane: { itemIndex: 0, label: 'first', attempt: 1 } }),
      makeEntry({ lane: { itemIndex: 1, label: 'retried', attempt: 3 }, version: [1, 3] }),
    ];
    render(<LaneStrip lanes={lanes} />);
    const badges = screen.getAllByTestId('lane-attempt-badge');
    expect(badges.length).toBe(1);
    expect(badges[0].textContent).toContain('3');
  });

  it('marks lanes joined mid-build', () => {
    const lanes = [makeEntry({ joinedMidBuild: true })];
    render(<LaneStrip lanes={lanes} />);
    expect(screen.getByText(/joined mid-build/)).toBeTruthy();
  });

  it("shows only the selected lane's messages in the feed", () => {
    const lanes = [
      makeEntry({ lane: { itemIndex: 0, label: 'worker A' }, messages: [textMessage('from A')] }),
      makeEntry({ lane: { itemIndex: 1, label: 'worker B' }, messages: [textMessage('from B')] }),
    ];
    render(<LaneStrip lanes={lanes} />);
    // First lane selected by default
    expect(screen.getByText('from A')).toBeTruthy();
    expect(screen.queryByText('from B')).toBeNull();
    fireEvent.click(screen.getByText('worker B'));
    expect(screen.getByText('from B')).toBeTruthy();
    expect(screen.queryByText('from A')).toBeNull();
  });

  it('renders in-lane error diagnostics', () => {
    const lanes = [
      makeEntry({ messages: [{ type: 'error', message: 'advisory oops', _source: 'build' }] }),
    ];
    render(<LaneStrip lanes={lanes} />);
    expect(screen.getByText(/advisory oops/)).toBeTruthy();
  });

  it('collapses to the legacy counter line and back', () => {
    const lanes = [
      makeEntry({ lane: { itemIndex: 0, label: 'a' }, status: 'succeeded' }),
      makeEntry({ lane: { itemIndex: 1, label: 'b' }, status: 'failed' }),
      makeEntry({ lane: { itemIndex: 2, label: 'c' }, status: 'working' }),
    ];
    render(<LaneStrip lanes={lanes} />);
    fireEvent.click(screen.getByTestId('lane-strip-toggle'));
    const counter = screen.getByTestId('lane-strip-counter');
    expect(counter.textContent).toContain('1/3');
    expect(counter.textContent).toContain('1 failed');
    expect(counter.textContent).toContain('1 active');
    // Tabs hidden while collapsed
    expect(screen.queryByText('a')).toBeNull();
    fireEvent.click(screen.getByTestId('lane-strip-toggle'));
    expect(screen.getByText('a')).toBeTruthy();
  });
});

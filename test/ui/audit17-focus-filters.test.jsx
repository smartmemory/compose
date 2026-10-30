/**
 * COMP-AUDIT-17 slice 2: what the focus chip filters. Props only; no fetch.
 * Filters apply to GateView and PastBuildsView; the StatusBand names where its feature came from.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import GateView from '../../src/components/vision/GateView.jsx';
import PastBuildsView from '../../src/components/vision/PastBuildsView.jsx';
import StatusBand from '../../src/components/vision/StatusBand.jsx';

vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: '<svg></svg>' }) },
}));

const items = [
  { id: 'iA', title: 'Feature A', featureCode: 'FEAT-A' },
  { id: 'iB', title: 'Feature B', featureCode: 'FEAT-B' },
];
const gate = (id, itemId) => ({
  id, itemId, status: 'pending', fromPhase: 'design', toPhase: 'blueprint', stepId: 'write_design', createdAt: new Date().toISOString(),
});
const gates = [gate('gA', 'iA'), gate('gB', 'iB')];

const shownGateTitles = () => ['Feature A', 'Feature B'].filter((t) => screen.queryAllByText(t).length > 0);

describe('GateView with the feature focus (one row table)', () => {
  const rows = [
    { name: 'no focus: every gate', focus: false, code: null, jumped: null, want: ['Feature A', 'Feature B'] },
    { name: 'session-sourced code does not filter (App passes no filter)', focus: false, code: null, jumped: null, want: ['Feature A', 'Feature B'] },
    { name: 'focus on A hides B', focus: true, code: 'FEAT-A', jumped: null, want: ['Feature A'] },
    { name: 'focus on A, jump to B: the jumped-to gate is always shown', focus: true, code: 'FEAT-A', jumped: 'gB', want: ['Feature A', 'Feature B'] },
    { name: 'focus on A, jump to A: no extra gate', focus: true, code: 'FEAT-A', jumped: 'gA', want: ['Feature A'] },
  ];
  it('rows', () => {
    for (const r of rows) {
      render(<GateView gates={gates} items={items} onResolve={vi.fn()} onSelect={vi.fn()} featureCode={r.code} focusActive={r.focus} focusedGateId={r.jumped} onFocusHandled={vi.fn()} />);
      expect(shownGateTitles(), r.name).toEqual(r.want);
      cleanup();
    }
  });

  it('has no per-view Focus toggle any more (the chip is the only control)', () => {
    render(<GateView gates={gates} items={items} onResolve={vi.fn()} onSelect={vi.fn()} featureCode="FEAT-A" focusActive />);
    expect(screen.queryByText(/^Focus:/)).toBeNull();
  });
});

describe('PastBuildsView search box follows the focus', () => {
  const builds = [
    { featureCode: 'FEAT-A', status: 'complete', completedAt: '2026-06-08T00:00:00.000Z', durationMs: 1000, cost_usd: 0, stepCount: 1 },
    { featureCode: 'FEAT-B', status: 'complete', completedAt: '2026-06-08T01:00:00.000Z', durationMs: 1000, cost_usd: 0, stepCount: 1 },
  ];
  it('pre-fills with the focused code and follows it; empty shows all', () => {
    const { rerender } = render(<PastBuildsView builds={builds} items={items} featureFilter={null} />);
    expect(screen.queryByText('FEAT-A')).toBeTruthy();
    expect(screen.queryByText('FEAT-B')).toBeTruthy();
    rerender(<PastBuildsView builds={builds} items={items} featureFilter="FEAT-A" />);
    expect(screen.queryByText('FEAT-A')).toBeTruthy();
    expect(screen.queryByText('FEAT-B')).toBeNull();
    rerender(<PastBuildsView builds={builds} items={items} featureFilter={null} />);
    expect(screen.queryByText('FEAT-B')).toBeTruthy();
  });
});

describe('StatusBand names its source', () => {
  it('rows', () => {
    const rows = [
      { source: 'focus', text: 'Focused:' },
      { source: 'session', text: 'Agent session:' },
    ];
    for (const r of rows) {
      render(<StatusBand featureCode="FEAT-A" snapshot={{ sentence: 'All good' }} source={r.source} />);
      expect(document.querySelector('[data-status-source]').textContent, r.source).toBe(r.text);
      cleanup();
    }
    render(<StatusBand featureCode="FEAT-A" snapshot={{ sentence: 'All good' }} />);
    expect(document.querySelector('[data-status-source]')).toBeNull();
    cleanup();
    render(<StatusBand featureCode={null} source={null} />);
    expect(document.querySelector('[data-status-band]')).toBeNull();
  });
});

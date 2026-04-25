/**
 * drift-ribbon.test.jsx — vitest+jsdom tests for DriftRibbon.jsx and driftRibbonLogic.js
 *
 * Covers:
 *   - Hidden when no axis breached
 *   - Single-line warning shown when at least one axis breached
 *   - Click expands axis table
 *   - Axis labels, ratio, threshold rendering
 *   - Correct axis count in warning text
 *   - formatRatio and axisLabel helpers
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DriftRibbon from '../../src/components/vision/DriftRibbon.jsx';
import { axisLabel, formatRatio, getBreachedAxes } from '../../src/components/vision/driftRibbonLogic.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const NOW = '2026-04-25T12:00:00Z';

function makeItem(driftAxes = []) {
  return {
    id: 'item-1',
    lifecycle: {
      featureCode: 'COMP-OBS-DRIFT-UI-TEST',
      lifecycle_ext: { drift_axes: driftAxes },
    },
  };
}

function makeAxis(axis_id, breached, ratio = 0.5, threshold = 0.3) {
  return {
    axis_id,
    name: axisLabel(axis_id),
    numerator: 5,
    denominator: 10,
    ratio,
    threshold,
    breached,
    computed_at: NOW,
    explanation: `Explanation for ${axis_id}`,
    breach_started_at: breached ? NOW : null,
    breach_event_id: breached ? 'some-uuid' : null,
  };
}

// ── Tests: hidden when no breach ──────────────────────────────────────────────

describe('DriftRibbon — hidden when no breach', () => {
  it('renders nothing when item has no lifecycle', () => {
    const item = { id: 'x' };
    const { container } = render(<DriftRibbon item={item} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when drift_axes is empty', () => {
    const item = makeItem([]);
    const { container } = render(<DriftRibbon item={item} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when all axes are unbreached', () => {
    const item = makeItem([
      makeAxis('path_drift', false, 0.1, 0.3),
      makeAxis('contract_drift', false, 0.05, 0.2),
    ]);
    const { container } = render(<DriftRibbon item={item} />);
    expect(container.firstChild).toBeNull();
  });
});

// ── Tests: single-line warning ────────────────────────────────────────────────

describe('DriftRibbon — single-line warning', () => {
  it('shows warning text when 1 axis breached', () => {
    const item = makeItem([makeAxis('path_drift', true)]);
    render(<DriftRibbon item={item} />);
    expect(screen.getByTestId('drift-ribbon-toggle')).toBeDefined();
    expect(screen.getByText(/1 drift alert/i)).toBeDefined();
  });

  it('shows plural "alerts" when 2 axes breached', () => {
    const item = makeItem([
      makeAxis('path_drift', true),
      makeAxis('review_debt_drift', true),
    ]);
    render(<DriftRibbon item={item} />);
    expect(screen.getByText(/2 drift alerts/i)).toBeDefined();
  });

  it('does not show the table by default (collapsed)', () => {
    const item = makeItem([makeAxis('path_drift', true)]);
    render(<DriftRibbon item={item} />);
    expect(screen.queryByTestId('drift-ribbon-table')).toBeNull();
  });
});

// ── Tests: click-to-expand ────────────────────────────────────────────────────

describe('DriftRibbon — click-to-expand', () => {
  it('clicking toggle reveals the axis table', () => {
    const item = makeItem([makeAxis('path_drift', true, 0.42, 0.3)]);
    render(<DriftRibbon item={item} />);

    const toggle = screen.getByTestId('drift-ribbon-toggle');
    fireEvent.click(toggle);

    expect(screen.getByTestId('drift-ribbon-table')).toBeDefined();
  });

  it('clicking toggle again collapses the table', () => {
    const item = makeItem([makeAxis('path_drift', true, 0.42, 0.3)]);
    render(<DriftRibbon item={item} />);

    const toggle = screen.getByTestId('drift-ribbon-toggle');
    fireEvent.click(toggle); // expand
    fireEvent.click(toggle); // collapse

    expect(screen.queryByTestId('drift-ribbon-table')).toBeNull();
  });

  it('expanded table shows axis label, ratio %, threshold %, explanation', () => {
    const item = makeItem([makeAxis('path_drift', true, 0.42, 0.3)]);
    render(<DriftRibbon item={item} />);

    fireEvent.click(screen.getByTestId('drift-ribbon-toggle'));

    // Axis row present
    expect(screen.getByTestId('drift-axis-row-path_drift')).toBeDefined();
    // Ratio formatted as percentage
    expect(screen.getByText('42%')).toBeDefined();
    // Threshold formatted as percentage
    expect(screen.getByText('30%')).toBeDefined();
    // Explanation present
    expect(screen.getByText(/Explanation for path_drift/)).toBeDefined();
  });

  it('only breached axes appear in the table', () => {
    const item = makeItem([
      makeAxis('path_drift', true, 0.5, 0.3),
      makeAxis('contract_drift', false, 0.1, 0.2), // not breached
    ]);
    render(<DriftRibbon item={item} />);

    fireEvent.click(screen.getByTestId('drift-ribbon-toggle'));

    expect(screen.getByTestId('drift-axis-row-path_drift')).toBeDefined();
    expect(screen.queryByTestId('drift-axis-row-contract_drift')).toBeNull();
  });
});

// ── Tests: axis labels ────────────────────────────────────────────────────────

describe('DriftRibbon — axis labels in table', () => {
  it('shows human-readable label for path_drift', () => {
    const item = makeItem([makeAxis('path_drift', true)]);
    render(<DriftRibbon item={item} />);
    fireEvent.click(screen.getByTestId('drift-ribbon-toggle'));
    expect(screen.getByText('Path drift')).toBeDefined();
  });

  it('shows human-readable label for review_debt_drift', () => {
    const item = makeItem([makeAxis('review_debt_drift', true)]);
    render(<DriftRibbon item={item} />);
    fireEvent.click(screen.getByTestId('drift-ribbon-toggle'));
    expect(screen.getByText('Review debt')).toBeDefined();
  });
});

// ── Tests: pure logic helpers ─────────────────────────────────────────────────

describe('axisLabel', () => {
  it('returns human-readable label for known ids', () => {
    expect(axisLabel('path_drift')).toBe('Path drift');
    expect(axisLabel('contract_drift')).toBe('Contract drift');
    expect(axisLabel('review_debt_drift')).toBe('Review debt');
  });

  it('returns the id itself for unknown axis_id', () => {
    expect(axisLabel('some_unknown_axis')).toBe('some_unknown_axis');
  });
});

describe('formatRatio', () => {
  it('formats 0.42 as 42%', () => {
    expect(formatRatio(0.42)).toBe('42%');
  });

  it('formats 0 as 0%', () => {
    expect(formatRatio(0)).toBe('0%');
  });

  it('formats 1.0 as 100%', () => {
    expect(formatRatio(1.0)).toBe('100%');
  });

  it('returns — for null', () => {
    expect(formatRatio(null)).toBe('—');
  });

  it('returns — for undefined', () => {
    expect(formatRatio(undefined)).toBe('—');
  });

  it('returns — for NaN', () => {
    expect(formatRatio(NaN)).toBe('—');
  });
});

describe('getBreachedAxes', () => {
  it('returns only breached axes', () => {
    const item = makeItem([
      makeAxis('path_drift', true),
      makeAxis('contract_drift', false),
      makeAxis('review_debt_drift', true),
    ]);
    const breached = getBreachedAxes(item);
    expect(breached.length).toBe(2);
    expect(breached.every(a => a.breached === true)).toBe(true);
  });

  it('returns empty array when no axes exist', () => {
    expect(getBreachedAxes({})).toEqual([]);
    expect(getBreachedAxes(makeItem([]))).toEqual([]);
  });
});

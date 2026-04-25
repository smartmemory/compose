/**
 * open-loops-panel.test.jsx — vitest+jsdom tests for OpenLoopsPanel.jsx.
 *
 * Covers:
 *   - Empty state renders "No open loops for this feature"
 *   - Loop list renders sorted oldest-first
 *   - Stale badge appears for loops past TTL
 *   - Resolve button present for open loops
 *   - Collapse toggle hides/shows panel
 *   - localStorage key: compose:<feature-code>:openLoopsCollapsed
 *   - Panel hidden when featureCode is null
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import OpenLoopsPanel from '../../src/components/vision/OpenLoopsPanel.jsx';

// ── Helpers ───────────────────────────────────────────────────────────────

const NOW = Date.now();

function makeItem(featureCode, loops = []) {
  return {
    id: 'item-1',
    lifecycle: {
      featureCode,
      lifecycle_ext: { open_loops: loops },
    },
  };
}

function makeLoop(overrides = {}) {
  const createdDaysAgo = overrides.daysAgo ?? 1;
  return {
    id: overrides.id ?? `loop-${Math.random().toString(36).slice(2)}`,
    kind: overrides.kind ?? 'deferred',
    summary: overrides.summary ?? 'test loop summary',
    created_at: new Date(NOW - createdDaysAgo * 86400000).toISOString(),
    parent_feature: overrides.parent_feature ?? 'FC-TEST',
    resolution: overrides.resolution ?? null,
    ttl_days: overrides.ttl_days ?? 90,
  };
}

// localStorage mock
const localStorageMock = (() => {
  let store = {};
  return {
    getItem: vi.fn((key) => store[key] ?? null),
    setItem: vi.fn((key, val) => { store[key] = val; }),
    clear: () => { store = {}; },
  };
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: false });

// ── Tests ─────────────────────────────────────────────────────────────────

describe('<OpenLoopsPanel> — not rendered when featureCode is null', () => {
  it('renders nothing when featureCode is null', () => {
    const { container } = render(<OpenLoopsPanel featureCode={null} items={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('<OpenLoopsPanel> — empty state', () => {
  beforeEach(() => { localStorageMock.clear(); });

  it('renders empty state message when no open loops', () => {
    const item = makeItem('FC-TEST', []);
    render(<OpenLoopsPanel featureCode="FC-TEST" items={[item]} />);
    expect(screen.getByTestId('open-loops-empty')).toBeTruthy();
    expect(screen.getByText(/No open loops for this feature/)).toBeTruthy();
  });

  it('renders add button in empty state', () => {
    const item = makeItem('FC-TEST', []);
    render(<OpenLoopsPanel featureCode="FC-TEST" items={[item]} />);
    expect(screen.getByTestId('add-loop-btn')).toBeTruthy();
  });
});

describe('<OpenLoopsPanel> — loop list', () => {
  beforeEach(() => { localStorageMock.clear(); });

  it('renders open loops sorted oldest-first', () => {
    const older = makeLoop({ id: 'loop-old', summary: 'older loop', daysAgo: 5 });
    const newer = makeLoop({ id: 'loop-new', summary: 'newer loop', daysAgo: 1 });
    const item = makeItem('FC-TEST', [newer, older]); // reversed order in data
    render(<OpenLoopsPanel featureCode="FC-TEST" items={[item]} />);

    const rows = document.querySelectorAll('[data-testid^="loop-row-"]');
    expect(rows.length).toBe(2);
    // Oldest should appear first
    expect(rows[0].getAttribute('data-testid')).toBe('loop-row-loop-old');
    expect(rows[1].getAttribute('data-testid')).toBe('loop-row-loop-new');
  });

  it('renders resolve button for open loops', () => {
    const loop = makeLoop({ id: 'loop-1' });
    const item = makeItem('FC-TEST', [loop]);
    render(<OpenLoopsPanel featureCode="FC-TEST" items={[item]} />);
    expect(screen.getByTestId('resolve-btn-loop-1')).toBeTruthy();
  });

  it('does not render resolve button for resolved loops', () => {
    const loop = makeLoop({
      id: 'loop-res',
      resolution: { resolved_at: new Date().toISOString(), resolved_by: 'ruze', note: '' },
    });
    const item = makeItem('FC-TEST', [loop]);
    render(<OpenLoopsPanel featureCode="FC-TEST" items={[item]} />);
    expect(screen.queryByTestId('resolve-btn-loop-res')).toBeNull();
  });

  it('does not show resolved loops in default view', () => {
    const resolved = makeLoop({
      id: 'loop-res',
      resolution: { resolved_at: new Date().toISOString(), resolved_by: 'ruze', note: '' },
    });
    const open = makeLoop({ id: 'loop-open' });
    const item = makeItem('FC-TEST', [resolved, open]);
    render(<OpenLoopsPanel featureCode="FC-TEST" items={[item]} />);

    // Only one row (the open one)
    const rows = document.querySelectorAll('[data-testid^="loop-row-"]');
    expect(rows.length).toBe(1);
    expect(rows[0].getAttribute('data-testid')).toBe('loop-row-loop-open');
  });
});

describe('<OpenLoopsPanel> — stale badge', () => {
  beforeEach(() => { localStorageMock.clear(); });

  it('shows >TTL badge for stale loops', () => {
    const staleLoop = makeLoop({ id: 'loop-stale', daysAgo: 100, ttl_days: 10 });
    const item = makeItem('FC-TEST', [staleLoop]);
    render(<OpenLoopsPanel featureCode="FC-TEST" items={[item]} />);
    expect(screen.getByTestId('stale-badge-loop-stale')).toBeTruthy();
  });

  it('does not show >TTL badge for fresh loops', () => {
    const freshLoop = makeLoop({ id: 'loop-fresh', daysAgo: 1, ttl_days: 90 });
    const item = makeItem('FC-TEST', [freshLoop]);
    render(<OpenLoopsPanel featureCode="FC-TEST" items={[item]} />);
    expect(screen.queryByTestId('stale-badge-loop-fresh')).toBeNull();
  });
});

describe('<OpenLoopsPanel> — collapse toggle', () => {
  beforeEach(() => { localStorageMock.clear(); localStorageMock.setItem.mockClear(); });

  it('panel is expanded by default', () => {
    const item = makeItem('FC-TEST', []);
    render(<OpenLoopsPanel featureCode="FC-TEST" items={[item]} />);
    expect(screen.getByTestId('open-loops-panel')).toBeTruthy();
    expect(screen.queryByTestId('open-loops-panel-collapsed')).toBeNull();
  });

  it('collapses when collapse button clicked', () => {
    const item = makeItem('FC-TEST', []);
    render(<OpenLoopsPanel featureCode="FC-TEST" items={[item]} />);
    fireEvent.click(screen.getByTestId('open-loops-collapse-btn'));
    expect(screen.getByTestId('open-loops-panel-collapsed')).toBeTruthy();
    expect(screen.queryByTestId('open-loops-panel')).toBeNull();
  });

  it('expands when expand button clicked from collapsed state', () => {
    // Start collapsed by pre-seeding localStorage
    localStorageMock.setItem('compose:FC-TEST:openLoopsCollapsed', 'true');
    const item = makeItem('FC-TEST', []);
    render(<OpenLoopsPanel featureCode="FC-TEST" items={[item]} />);
    expect(screen.getByTestId('open-loops-panel-collapsed')).toBeTruthy();
    fireEvent.click(screen.getByTestId('open-loops-expand-btn'));
    expect(screen.getByTestId('open-loops-panel')).toBeTruthy();
  });

  it('persists collapse state to localStorage with correct key', () => {
    const item = makeItem('FC-MYFEATURE', []);
    render(<OpenLoopsPanel featureCode="FC-MYFEATURE" items={[item]} />);
    fireEvent.click(screen.getByTestId('open-loops-collapse-btn'));
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'compose:FC-MYFEATURE:openLoopsCollapsed',
      'true',
    );
  });
});

describe('<OpenLoopsPanel> — add modal', () => {
  beforeEach(() => { localStorageMock.clear(); });

  it('shows add modal when + button clicked', () => {
    const item = makeItem('FC-TEST', []);
    render(<OpenLoopsPanel featureCode="FC-TEST" items={[item]} />);
    fireEvent.click(screen.getByTestId('add-loop-btn'));
    expect(screen.getByTestId('add-loop-modal')).toBeTruthy();
    expect(screen.getByTestId('add-loop-submit')).toBeTruthy();
  });
});

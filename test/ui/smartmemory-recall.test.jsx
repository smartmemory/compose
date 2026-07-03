/**
 * smartmemory-recall.test.jsx — vitest+jsdom tests for COMP-SMARTMEMORY-RECALL's
 * UI slice: the workspace-keyed enabled-probe hook (useRecallEnabled), the
 * RecallTab body states, and ContextItemDetail's tab-visibility / active-tab
 * reset / DetailTabs `tabs`-prop wiring.
 *
 * Mirrors env-health-panel.test.jsx (mock wsFetch), context-step-detail.test.jsx
 * (mock useVisionStore with selector support), and open-loops-panel.test.jsx
 * (testid conventions).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', () => ({ wsFetch: vi.fn() }));

let mockWs = { workspace: { id: 'ws-1' } };
vi.mock('../../src/contexts/WorkspaceContext.jsx', () => ({
  useWorkspace: () => mockWs,
}));

let _storeState;
vi.mock('../../src/components/vision/useVisionStore.js', () => ({
  useVisionStore: (selector) => {
    if (typeof selector === 'function') return selector(_storeState);
    return _storeState;
  },
}));

import { wsFetch } from '../../src/lib/wsFetch.js';
import useRecallEnabled, { __resetRecallEnabledCache } from '../../src/components/cockpit/useRecallEnabled.js';
import RecallTab from '../../src/components/cockpit/RecallTab.jsx';
import DetailTabs from '../../src/components/cockpit/DetailTabs.jsx';
import ContextItemDetail from '../../src/components/cockpit/ContextItemDetail.jsx';

const FEATURE_ITEM = { id: 'i1', lifecycle: { featureCode: 'COMP-X' } };
const NON_FEATURE_ITEM = { id: 'i2' };

function baseStoreState(overrides = {}) {
  return {
    items: [FEATURE_ITEM, NON_FEATURE_ITEM],
    connections: [],
    gates: [],
    updateItem: vi.fn(),
    deleteItem: vi.fn(),
    createConnection: vi.fn(),
    deleteConnection: vi.fn(),
    resolveGate: vi.fn(),
    activeBuild: null,
    sessions: [],
    agentErrors: [],
    ...overrides,
  };
}

function mockWsFetchRouting({ probe, perFeature } = {}) {
  wsFetch.mockImplementation((url) => {
    if (url === '/api/smartmemory/recall') {
      return Promise.resolve({ ok: true, json: async () => probe });
    }
    if (typeof url === 'string' && url.startsWith('/api/smartmemory/recall?featureCode=')) {
      return Promise.resolve({ ok: true, json: async () => perFeature });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
}

beforeEach(() => {
  __resetRecallEnabledCache();
  wsFetch.mockReset();
  mockWs = { workspace: { id: 'ws-1' } };
  _storeState = baseStoreState();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// useRecallEnabled — memoized workspace-keyed probe
// ---------------------------------------------------------------------------

describe('useRecallEnabled', () => {
  function Probe({ workspaceId }) {
    const enabled = useRecallEnabled(workspaceId);
    return <div data-testid="probe-result">{String(enabled)}</div>;
  }

  it('fires exactly one probe request per workspace id', async () => {
    mockWsFetchRouting({ probe: { enabled: true } });
    render(<Probe workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByTestId('probe-result').textContent).toBe('true'));
    expect(wsFetch.mock.calls.filter((c) => c[0] === '/api/smartmemory/recall').length).toBe(1);
  });

  it('caches the resolved value — a second mount with the same workspace id does not re-probe', async () => {
    mockWsFetchRouting({ probe: { enabled: false } });
    const { unmount } = render(<Probe workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByTestId('probe-result').textContent).toBe('false'));
    unmount();

    render(<Probe workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByTestId('probe-result').textContent).toBe('false'));
    expect(wsFetch.mock.calls.filter((c) => c[0] === '/api/smartmemory/recall').length).toBe(1);
  });

  it('re-probes on a workspace id change (different cache key)', async () => {
    mockWsFetchRouting({ probe: { enabled: true } });
    const { rerender } = render(<Probe workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByTestId('probe-result').textContent).toBe('true'));

    rerender(<Probe workspaceId="ws-2" />);
    await waitFor(() =>
      expect(wsFetch.mock.calls.filter((c) => c[0] === '/api/smartmemory/recall').length).toBe(2),
    );
  });

  it('resolves false when the probe request rejects', async () => {
    wsFetch.mockRejectedValue(new Error('boom'));
    render(<Probe workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByTestId('probe-result').textContent).toBe('false'));
  });
});

// ---------------------------------------------------------------------------
// RecallTab — fetch-on-open states
// ---------------------------------------------------------------------------

describe('<RecallTab>', () => {
  it('renders loading, then results with score/type/time/project badges', async () => {
    mockWsFetchRouting({
      perFeature: {
        enabled: true,
        available: true,
        featureCode: 'COMP-X',
        project: 'projB',
        results: [
          { id: 'm1', snippet: 'prior decision', score: 0.8, memoryType: 'decision', ts: '2026-05-02T16:11:11Z', project: 'projA' },
        ],
      },
    });
    render(<RecallTab featureCode="COMP-X" />);
    expect(screen.getByTestId('recall-loading')).toBeTruthy();

    await waitFor(() => expect(screen.getByTestId('recall-row-m1')).toBeTruthy());
    expect(screen.getByTestId('recall-row-m1').textContent).toMatch(/prior decision/);
    expect(screen.getByTestId('recall-score-m1')).toBeTruthy();
    expect(screen.getByTestId('recall-project-m1')).toBeTruthy();
  });

  it('hides the project badge when the result project matches the current project', async () => {
    mockWsFetchRouting({
      perFeature: {
        enabled: true,
        available: true,
        project: 'projB',
        results: [{ id: 'm1', snippet: 'x', score: 0.5, project: 'projB' }],
      },
    });
    render(<RecallTab featureCode="COMP-X" />);
    await waitFor(() => expect(screen.getByTestId('recall-row-m1')).toBeTruthy());
    expect(screen.queryByTestId('recall-project-m1')).toBeNull();
  });

  it('renders empty state for zero results', async () => {
    mockWsFetchRouting({ perFeature: { enabled: true, available: true, project: 'projB', results: [] } });
    render(<RecallTab featureCode="COMP-X" />);
    await waitFor(() => expect(screen.getByTestId('recall-empty')).toBeTruthy());
  });

  it('renders unreachable state when available:false', async () => {
    mockWsFetchRouting({ perFeature: { enabled: true, available: false, error: 'down' } });
    render(<RecallTab featureCode="COMP-X" />);
    await waitFor(() => expect(screen.getByTestId('recall-unreachable')).toBeTruthy());
    expect(screen.queryByTestId('recall-empty')).toBeNull();
  });

  it('renders unreachable state when the fetch rejects', async () => {
    wsFetch.mockRejectedValue(new Error('network down'));
    render(<RecallTab featureCode="COMP-X" />);
    await waitFor(() => expect(screen.getByTestId('recall-unreachable')).toBeTruthy());
  });

  it('refetches on a workspaceId change even when featureCode stays the same — no stale cross-workspace results', async () => {
    // Two workspaces both have recall enabled and the user has the same
    // featureCode selected in both. Switching workspace (same feature code)
    // must not leave the previous workspace's stale hits/project badge on
    // screen — it must refetch and show the new workspace's data.
    const perFeatureUrl = '/api/smartmemory/recall?featureCode=COMP-X';
    let calls = 0;
    wsFetch.mockImplementation((url) => {
      if (url === perFeatureUrl) {
        calls += 1;
        const body = calls === 1
          ? { enabled: true, available: true, project: 'projA', results: [{ id: 'm-a', snippet: 'workspace A hit', score: 0.5, project: 'projA' }] }
          : { enabled: true, available: true, project: 'projB', results: [{ id: 'm-b', snippet: 'workspace B hit', score: 0.5, project: 'projB' }] };
        return Promise.resolve({ ok: true, json: async () => body });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    const { rerender } = render(<RecallTab featureCode="COMP-X" workspaceId="ws-A" />);
    await waitFor(() => expect(screen.getByTestId('recall-row-m-a')).toBeTruthy());

    rerender(<RecallTab featureCode="COMP-X" workspaceId="ws-B" />);
    await waitFor(() => expect(screen.getByTestId('recall-row-m-b')).toBeTruthy());
    expect(screen.queryByTestId('recall-row-m-a')).toBeNull();
    expect(wsFetch.mock.calls.filter((c) => c[0] === perFeatureUrl).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// DetailTabs — `tabs` prop
// ---------------------------------------------------------------------------

describe('<DetailTabs> tabs prop', () => {
  it('honors a filtered tabs list — only rendered tabs appear', () => {
    render(<DetailTabs tabs={[{ id: 'overview', label: 'Overview' }]} activeTab="overview" />);
    expect(screen.getByRole('tab', { name: /overview/i })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /recall/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ContextItemDetail — Recall tab visibility, active-tab reset, probe memoization
// ---------------------------------------------------------------------------

describe('<ContextItemDetail> — Recall tab wiring', () => {
  it('Recall tab hidden when the probe resolves disabled', async () => {
    mockWsFetchRouting({ probe: { enabled: false } });
    render(<ContextItemDetail itemId="i1" onSelect={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalledWith('/api/smartmemory/recall'));
    expect(screen.queryByRole('tab', { name: /recall/i })).toBeNull();
  });

  it('Recall tab hidden for a non-feature item even when the probe resolves enabled, and no per-feature fetch fires', async () => {
    mockWsFetchRouting({ probe: { enabled: true } });
    render(<ContextItemDetail itemId="i2" onSelect={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalledWith('/api/smartmemory/recall'));
    expect(screen.queryByRole('tab', { name: /recall/i })).toBeNull();
    expect(wsFetch.mock.calls.some((c) => typeof c[0] === 'string' && c[0].startsWith('/api/smartmemory/recall?featureCode='))).toBe(false);
  });

  it('byte-identity when probe disabled: the five existing tabs render unchanged, same order', async () => {
    mockWsFetchRouting({ probe: { enabled: false } });
    render(<ContextItemDetail itemId="i1" onSelect={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalledWith('/api/smartmemory/recall'));
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent.trim().toLowerCase());
    expect(tabs).toEqual(['overview', 'pipeline', 'sessions', 'errors', 'files']);
  });

  it('shows Recall tab, activates it, and renders results', async () => {
    mockWsFetchRouting({
      probe: { enabled: true },
      perFeature: {
        enabled: true,
        available: true,
        project: 'projB',
        results: [{ id: 'm1', snippet: 'prior context', score: 0.7, project: 'projA' }],
      },
    });
    render(<ContextItemDetail itemId="i1" onSelect={() => {}} onClose={() => {}} />);
    const recallTab = await screen.findByRole('tab', { name: /recall/i });
    fireEvent.click(recallTab);
    await waitFor(() => expect(screen.getByTestId('recall-row-m1')).toBeTruthy());
  });

  it('active-tab reset: switching from a feature item (Recall active) to a non-feature item strands to overview, not a hidden tab', async () => {
    mockWsFetchRouting({
      probe: { enabled: true },
      perFeature: { enabled: true, available: true, project: 'projB', results: [] },
    });
    const { rerender } = render(<ContextItemDetail itemId="i1" onSelect={() => {}} onClose={() => {}} />);
    const recallTab = await screen.findByRole('tab', { name: /recall/i });
    fireEvent.click(recallTab);
    await waitFor(() => expect(screen.getByTestId('recall-empty')).toBeTruthy());

    rerender(<ContextItemDetail itemId="i2" onSelect={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.queryByRole('tab', { name: /recall/i })).toBeNull());
    expect(screen.queryByTestId('recall-empty')).toBeNull();
    // Overview content should be showing (effective tab reset), not a stranded hidden body.
    expect(screen.getByRole('tab', { name: /overview/i }).getAttribute('aria-selected')).toBe('true');
  });

  it('probe memoization across item switches within the same workspace: exactly one probe call', async () => {
    mockWsFetchRouting({ probe: { enabled: false } });
    const { rerender } = render(<ContextItemDetail itemId="i1" onSelect={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalledWith('/api/smartmemory/recall'));

    rerender(<ContextItemDetail itemId="i2" onSelect={() => {}} onClose={() => {}} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(wsFetch.mock.calls.filter((c) => c[0] === '/api/smartmemory/recall').length).toBe(1);
  });
});

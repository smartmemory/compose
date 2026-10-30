/**
 * COMP-AUDIT-17/18 slice 1: Home sections, quieter sidebar/context panel,
 * OpsStrip "All", honest Item labels, three-valued availability hook.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, renderHook } from '@testing-library/react';

let _store = { activeBuild: null, gates: new Map(), items: new Map(), recentErrors: [], resolveGate: null, iterationStates: new Map() };
vi.mock('../../src/components/vision/useVisionStore.js', () => ({
  useVisionStore: (sel) => (typeof sel === 'function' ? sel(_store) : _store),
}));

const { default: HomeSections } = await import('../../src/components/vision/HomeSections.jsx');
const { deriveHomeSections } = await import('../../src/components/vision/homeSectionsState.js');
const { default: AttentionQueueSidebar } = await import('../../src/components/vision/AttentionQueueSidebar.jsx');
const { default: ContextPanel } = await import('../../src/components/cockpit/ContextPanel.jsx');
const { default: OpsStrip } = await import('../../src/components/cockpit/OpsStrip.jsx');
const { default: ItemDetailPanel } = await import('../../src/components/vision/ItemDetailPanel.jsx');
const { useOpsStatusIndexState } = await import('../../src/components/cockpit/useOpsStatusIndex.js');

beforeEach(() => {
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }));
});
afterEach(() => vi.restoreAllMocks());

describe('Home sections', () => {
  it('renders nothing for an empty project (each section hidden when empty)', () => {
    render(<HomeSections sections={deriveHomeSections({})} />);
    for (const id of ['needs-you', 'running', 'in-progress', 'recent', 'builds']) {
      expect(screen.queryByTestId(`home-${id}`)).toBeNull();
    }
  });

  it('Needs you shows a pending gate; click jumps via onJumpToGate, Stop agent calls onStopAgent, no fetch', () => {
    const onJumpToGate = vi.fn();
    const onStopAgent = vi.fn();
    const sections = deriveHomeSections({
      items: [{ id: 'a', type: 'feature', title: 'Alpha', status: 'in_progress' }],
      gates: [{ id: 'g1', itemId: 'a', status: 'pending', stepId: 'design' }],
      spawnedAgents: [{ agentId: 'ag1', status: 'running', task: 'x' }],
    });
    render(<HomeSections sections={sections} onJumpToGate={onJumpToGate} onStopAgent={onStopAgent} />);
    fireEvent.click(screen.getByTestId('home-gate-row'));
    expect(onJumpToGate).toHaveBeenCalledWith('g1');
    fireEvent.click(screen.getByTestId('home-agent-stop'));
    expect(onStopAgent).toHaveBeenCalledWith('ag1');
    expect(screen.getAllByTestId('home-in-progress-card').length).toBe(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('Sidebar / ContextPanel', () => {
  const props = {
    items: [
      { id: '1', type: 'feature', title: 'A', status: 'in_progress', group: 'G' },
      { id: '2', type: 'feature', title: 'B', status: 'planned', group: 'G' },
      { id: '3', type: 'feature', title: 'C', status: 'planned', group: 'H' },
    ],
    gates: [], onViewChange: vi.fn(), connected: true, hiddenGroups: new Set(), onToggleGroup: vi.fn(),
    visibleTracks: [], spawnedAgents: [], agentRelays: [], agentActivity: [], agentErrors: [],
  };

  it('has no build widget, theme toggle or "+ New"; keeps the stats row and shows "1 active / 2"', () => {
    const { container } = render(<AttentionQueueSidebar {...props} />);
    expect(screen.queryByText('+ New')).toBeNull();
    expect(screen.queryByTitle(/theme/i)).toBeNull();
    expect(container.querySelector('[data-testid="build-status-widget"]')).toBeNull();
    expect(container.textContent).not.toMatch(/Toggle theme/i);
    expect(screen.getAllByTestId('group-count').map(n => n.textContent)).toContain('1 active / 2');
  });

  it('ContextPanel with no selection shows the hint, not a project summary', () => {
    render(<ContextPanel isOpen onToggle={() => {}} widthPx={300} onResizePx={() => {}}>{null}</ContextPanel>);
    expect(screen.getByTestId('context-empty-hint').textContent).toMatch(/Select an item/);
  });
});

describe('OpsStrip "All"', () => {
  it('"All" opens Home; an entry click still selects the feature', () => {
    _store = { ..._store, activeBuild: { featureCode: 'FC-1', status: 'running', currentStep: 's' } };
    const onOpenHome = vi.fn();
    const onSelectFeature = vi.fn();
    render(<OpsStrip activeView="graph" onOpenHome={onOpenHome} onSelectFeature={onSelectFeature} />);
    fireEvent.click(screen.getByTestId('ops-strip-all'));
    expect(onOpenHome).toHaveBeenCalledTimes(1);
    expect(onSelectFeature).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(/FC-1/));
    expect(onSelectFeature).toHaveBeenCalledWith('FC-1');
  });
});

describe('ItemDetailPanel labels (COMP-AUDIT-17)', () => {
  const noop = () => {};
  const base = { items: [], connections: [], gates: [], onUpdate: noop, onDelete: noop, onCreateConnection: noop, onDeleteConnection: noop, onSelect: noop, onClose: noop, onPressureTest: noop, onResolveGate: noop };
  beforeEach(() => { globalThis.WebSocket = class { close() {} send() {} addEventListener() {} }; });

  it('names the board status and confidence honestly; phase is read-only once compose owns it', () => {
    render(<ItemDetailPanel item={{ id: 'x', title: 'X', type: 'feature', status: 'in_progress', lifecycle: { featureCode: 'X-1', currentPhase: 'design' } }} {...base} />);
    expect(screen.getByTestId('status-label').textContent).toMatch(/Board status \(cockpit only\)/);
    expect(screen.getByTestId('confidence-label').textContent).toMatch(/Your confidence/);
    expect(screen.getByTestId('phase-readonly').textContent).toMatch(/set by compose build/);
  });

  it('keeps the legacy phase select when there is no lifecycle', () => {
    render(<ItemDetailPanel item={{ id: 'y', title: 'Y', type: 'feature', status: 'planned' }} {...base} />);
    expect(screen.queryByTestId('phase-readonly')).toBeNull();
  });
});

describe('useOpsStatusIndexState (three-valued)', () => {
  it('unknown -> yes when pages exist', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ pages: ['a'] }) }));
    const { result } = renderHook(() => useOpsStatusIndexState());
    expect(result.current.availability).toBe('unknown');
    await waitFor(() => expect(result.current.availability).toBe('yes'));
  });
  it('unknown -> no on an empty page list (a definitive answer)', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ pages: [] }) }));
    const { result } = renderHook(() => useOpsStatusIndexState());
    await waitFor(() => expect(result.current.availability).toBe('no'));
  });
  // COMP-AUDIT-17 slice 2 (FORGE-PL L1): a failed fetch is not "no"; the full row table is test/availability-check.test.js.
  it('a failed fetch stays unknown and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch = vi.fn(async () => { throw new Error('down'); });
    const { result } = renderHook(() => useOpsStatusIndexState());
    await waitFor(() => expect(warn).toHaveBeenCalledWith('[nav] ops availability check failed: down'));
    expect(result.current.availability).toBe('unknown');
    warn.mockRestore();
  });
});

/**
 * COMP-SUBAPP-CONTEXT-1: the real <ContextItemDetail> with a store item and fake clients. Four states per source, a feature
 * switch mid-flight, the three links. Any real fetch (global or wsFetch) fails the test: the clients are injected.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';

const fetchSpy = vi.fn(() => { throw new Error('real fetch called'); });
vi.mock('../../src/lib/wsFetch.js', () => ({ wsFetch: (...a) => fetchSpy(...a) }));
vi.mock('../../src/contexts/WorkspaceContext.jsx', () => ({ useWorkspace: () => ({ workspace: { id: 'w' } }) }));
let _state;
vi.mock('../../src/components/vision/useVisionStore.js', () => ({
  useVisionStore: (selector) => (typeof selector === 'function' ? selector(_state) : _state),
}));
// the Recall probe is another feature's own fetch; it is off here so the spy sees only this block's reads
vi.mock('../../src/components/cockpit/useRecallEnabled.js', () => ({ default: () => false }));
vi.mock('../../src/components/vision/ItemDetailPanel.jsx', () => ({ default: () => <div data-testid="detail-stub" /> }));

import ContextItemDetail from '../../src/components/cockpit/ContextItemDetail.jsx';
import { NavigationContext } from '../../src/lib/navigation.jsx';

const ITEMS = [
  { id: 'a', title: 'Alpha', status: 'in_progress', featureCode: 'FEAT-A' },
  { id: 'b', title: 'Beta', status: 'planned', featureCode: 'FEAT-B' },
];
const RUNS = [
  { id: 'run-old', featureCode: 'FEAT-A', flowName: 'old', status: 'complete', startedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T01:00:00Z' },
  { id: 'run-new', featureCode: 'FEAT-A', flowName: 'new', status: 'running', startedAt: '2026-10-01T00:00:00Z', updatedAt: '2026-11-02T01:00:00Z' },
  { id: 'run-b', featureCode: 'FEAT-B', flowName: 'bflow', status: 'complete', updatedAt: '2026-11-02T01:00:00Z' },
];
const BELT = { units: [{ id: 'UNIT-A', lane: 'forge', column: 'ready', features: ['FEAT-A'] }, { id: 'UNIT-X', lane: 'forge', column: 'ready' }] };
const HUB = { items: [{ doc_id: 'd1' }, { doc_id: 'd2' }], total: 2, feature: { title: 'Alpha wiki', roadmap_status: 'IN_PROGRESS' } };
const ok = { stratum: 'yes', cadence: 'yes', wiki: 'yes' };

const fakeClients = (over = {}) => ({
  stratum: { listRuns: vi.fn(async () => RUNS) },
  cadence: { getBelt: vi.fn(async () => BELT) },
  wiki: { featureHub: vi.fn(async () => HUB) },
  ...over,
});
const mount = (props = {}, nav = null) => {
  const ui = (p) => (
    <NavigationContext.Provider value={nav}>
      <ContextItemDetail itemId="a" onSelect={() => {}} onClose={() => {}} wikiWorkspace="wk" availability={ok} {...p} />
    </NavigationContext.Provider>
  );
  const r = render(ui(props));
  return { ...r, again: (p) => r.rerender(ui({ ...props, ...p })) };
};
const state = (src) => screen.getByTestId(`context-source-${src}`).getAttribute('data-state');

let warn;
beforeEach(() => {
  _state = { items: ITEMS, connections: [], gates: [], updateItem: vi.fn(), deleteItem: vi.fn(), createConnection: vi.fn(), deleteConnection: vi.fn(), resolveGate: vi.fn(), activeBuild: null, sessions: [], agentErrors: [] };
  fetchSpy.mockClear();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('real fetch called'); }));
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); warn.mockRestore(); expect(fetchSpy).not.toHaveBeenCalled(); });

describe('roadmap card (no fetch)', () => {
  it('shows code, title, status', () => {
    mount({ sourceClients: fakeClients() });
    expect(screen.getByTestId('context-source-roadmap').textContent).toMatch(/FEAT-A.*Alpha.*in_progress/);
  });
});

describe('four states per source', () => {
  it('loading, then data, for all three', async () => {
    let release;
    const clients = fakeClients({ stratum: { listRuns: vi.fn(() => new Promise((r) => { release = () => r(RUNS); })) } });
    mount({ sourceClients: clients });
    expect(screen.getByTestId('context-source-stratum-line').textContent).toBe('Loading Stratum…');
    await waitFor(() => expect(state('wiki')).toBe('data'));
    expect(state('cadence')).toBe('data');
    expect(screen.getByTestId('context-source-wiki').textContent).toMatch(/Alpha wiki.*2 docs/);
    expect(screen.getByTestId('context-source-cadence').textContent).toMatch(/UNIT-A/);
    expect(screen.getByTestId('context-source-cadence').textContent).not.toMatch(/UNIT-X/);
    await act(async () => { release(); });
    await waitFor(() => expect(state('stratum')).toBe('data'));
    expect(screen.getByTestId('context-source-stratum').textContent).toMatch(/new/); // latest updatedAt, not the old run
    expect(screen.getByTestId('context-source-stratum-basis').textContent).toMatch(/latest by updatedAt/);
  });

  const empties = [
    ['wiki', { wiki: { featureHub: async () => ({ items: [], total: 0, feature: null }) } }, 'No Wiki data for FEAT-A'],
    ['stratum', { stratum: { listRuns: async () => [] } }, 'No Stratum data for FEAT-A'],
    ['cadence', { cadence: { getBelt: async () => ({ units: [] }) } }, 'No Cadence data for FEAT-A'],
  ];
  for (const [src, over, line] of empties) {
    it(`${src}: read succeeded, nothing matched`, async () => {
      mount({ sourceClients: fakeClients(over) });
      await waitFor(() => expect(state(src)).toBe('empty'));
      expect(screen.getByTestId(`context-source-${src}-line`).textContent).toBe(line);
      expect(warn).not.toHaveBeenCalled();
    });
  }

  const failures = [
    ['wiki', { wiki: { featureHub: async () => { throw new Error('boom'); } } }, 'Wiki unavailable'],
    ['stratum', { stratum: { listRuns: async () => { throw new Error('boom'); } } }, 'Stratum unavailable'],
    ['cadence', { cadence: { getBelt: async () => { throw new Error('boom'); } } }, 'Cadence unavailable'],
  ];
  for (const [src, over, line] of failures) {
    it(`${src}: a failed read is unavailable (one WARNING naming it), never empty`, async () => {
      mount({ sourceClients: fakeClients(over) });
      await waitFor(() => expect(state(src)).toBe('unavailable'));
      expect(screen.getByTestId(`context-source-${src}-line`).textContent).toBe(line);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(new RegExp(`${src === 'wiki' ? 'Wiki' : src === 'stratum' ? 'Stratum' : 'Cadence'} unavailable`));
    });
  }

  const shapes = [
    ['wiki', { wiki: { featureHub: async () => ({ nope: true }) } }],
    ['stratum', { stratum: { listRuns: async () => ({ runs: [] }) } }],
    ['cadence', { cadence: { getBelt: async () => ({ lanes: [] }) } }],
  ];
  for (const [src, over] of shapes) {
    it(`${src}: a body that is not the contract's shape is unavailable`, async () => {
      mount({ sourceClients: fakeClients(over) });
      await waitFor(() => expect(state(src)).toBe('unavailable'));
      expect(warn).toHaveBeenCalledTimes(1);
    });
  }

  for (const src of ['wiki', 'stratum', 'cadence']) {
    it(`${src}: availability no is "not connected" and the client is not called`, async () => {
      const clients = fakeClients();
      mount({ sourceClients: clients, availability: { ...ok, [src]: 'no' } });
      expect(state(src)).toBe('notConnected');
      expect(screen.getByTestId(`context-source-${src}-line`).textContent).toBe(`${src === 'wiki' ? 'Wiki' : src === 'stratum' ? 'Stratum' : 'Cadence'} not connected`);
      await waitFor(() => expect(Object.values(clients).filter((c) => Object.values(c).some((f) => f.mock.calls.length)).length).toBe(2));
      expect(Object.values(clients[src])[0]).not.toHaveBeenCalled();
    });
  }

  it('all three fail: each card says so', async () => {
    const boom = async () => { throw new Error('down'); };
    mount({ sourceClients: { stratum: { listRuns: boom }, cadence: { getBelt: boom }, wiki: { featureHub: boom } } });
    await waitFor(() => expect(['wiki', 'stratum', 'cadence'].map(state)).toEqual(['unavailable', 'unavailable', 'unavailable']));
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe('reads follow the feature code', () => {
  it('reads once per code (no timer) and a stale answer for the previous feature never lands', async () => {
    const pending = {};
    const clients = fakeClients({
      stratum: { listRuns: vi.fn(() => new Promise((r) => { pending[`n${Object.keys(pending).length}`] = r; })) },
    });
    const { again } = mount({ sourceClients: clients });
    again({ itemId: 'b' }); // switch to FEAT-B while FEAT-A's read is in flight
    expect(screen.getByTestId('context-source-stratum-line').textContent).toBe('Loading Stratum…');
    await waitFor(() => expect(clients.stratum.listRuns).toHaveBeenCalledTimes(2));
    await act(async () => { pending.n1(RUNS); });
    await waitFor(() => expect(state('stratum')).toBe('data'));
    expect(screen.getByTestId('context-source-stratum').textContent).toMatch(/bflow/);
    await act(async () => { pending.n0([{ id: 'late', featureCode: 'FEAT-A', flowName: 'late-a', updatedAt: '2026-11-05T00:00:00Z' }]); });
    expect(screen.getByTestId('context-source-stratum').textContent).toMatch(/bflow/);
    expect(screen.getByTestId('context-source-stratum').textContent).not.toMatch(/late-a/);
    expect(clients.stratum.listRuns).toHaveBeenCalledTimes(2);
  });

  it('a re-render with the same code does not read again', async () => {
    const clients = fakeClients();
    const { again } = mount({ sourceClients: clients });
    await waitFor(() => expect(state('stratum')).toBe('data'));
    again({});
    expect(clients.stratum.listRuns).toHaveBeenCalledTimes(1);
  });
});

describe('links', () => {
  it('the run, the unit and the wiki card open their rooms', async () => {
    const nav = { openRoom: vi.fn() };
    mount({ sourceClients: fakeClients() }, nav);
    await waitFor(() => expect(state('stratum')).toBe('data'));
    await waitFor(() => expect(state('wiki')).toBe('data'));
    await waitFor(() => expect(state('cadence')).toBe('data'));
    fireEvent.click(screen.getByText('Open run'));
    expect(nav.openRoom).toHaveBeenLastCalledWith('stratum', { kind: 'run', id: 'run-new' });
    fireEvent.click(screen.getByText('Open unit UNIT-A'));
    expect(nav.openRoom).toHaveBeenLastCalledWith('cadence', { kind: 'unit', id: 'UNIT-A' });
    fireEvent.click(screen.getByText('Open in Wiki'));
    expect(nav.openRoom).toHaveBeenLastCalledWith('wiki');
  });
});

describe('an item with no feature code', () => {
  it('renders no sources block and reads nothing', () => {
    _state.items = [{ id: 'n', title: 'idea' }];
    const clients = fakeClients();
    mount({ itemId: 'n', sourceClients: clients });
    expect(screen.queryByTestId('context-sources')).toBeNull();
    expect(clients.stratum.listRuns).not.toHaveBeenCalled();
  });
});

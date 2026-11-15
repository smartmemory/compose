/**
 * COMP-PROJECT-GRAPH-DOC-PANEL-1 r2: a project graph item fills the app's right panel (ContextItemDetail + the real
 * ItemDetailPanel), the List view's way for a store item, read-only for an item from another workspace; the doc shows
 * formatted in the panel's Doc tab; descriptions render as markdown; the hover card strips markup.
 * Truth: smart-memory-ops units/COMP-PROJECT-GRAPH-DOC-PANEL-1/truth.md cases 5-9.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', () => ({ wsFetch: vi.fn(async () => ({ ok: true, json: async () => ({ enabled: false }) })) }));
vi.mock('../../src/contexts/WorkspaceContext.jsx', () => ({ useWorkspace: () => ({ workspace: { id: 'w' } }) }));
let _state;
vi.mock('../../src/components/vision/useVisionStore.js', () => {
  const useVisionStore = (selector) => (typeof selector === 'function' ? selector(_state) : _state);
  useVisionStore.getState = () => _state;
  return { useVisionStore };
});

const { default: ContextItemDetail } = await import('../../src/components/cockpit/ContextItemDetail.jsx');
const { projectItemSelection } = await import('../../src/lib/projectItemSelection.js');
const { markdownToPlain } = await import('../../src/lib/markdownPlain.js');

// The real ONTO-BATCHOBSERVER-WIRING-1 description from GET /api/projects/smartmemory/graph (2026-11-15).
const DESC = '## Related Documents - Roadmap entry: [`docs/ROADMAP.md`](../../ROADMAP.md) (line 524) - Migration design: [`ROADMAP-MIGRATE-1`](../ROADMAP-MIGRATE-1/design.md)';
const SM = { id: 'smartmemory:95fd1823', module: 'smartmemory', memberRoot: '/r/sm', type: 'feature', status: 'planned', title: 'ONTO-BATCHOBSERVER-WIRING-1', description: DESC, lifecycle: { featureCode: 'ONTO-BATCHOBSERVER-WIRING-1', currentPhase: 'explore_design' } };
const SM2 = { id: 'smartmemory:abc', module: 'smartmemory', memberRoot: '/r/sm', type: 'feature', status: 'planned', title: 'GOV-ROLES-1' };
const EXT = { items: [SM, SM2], connections: [{ id: 'k', fromId: SM.id, toId: SM2.id, type: 'informs' }] };
const STORE_ITEM = { id: 'c1', type: 'feature', status: 'planned', title: 'COMP-X', description: '# Head\n\n- a' };

beforeEach(() => {
  _state = { items: [STORE_ITEM], connections: [], gates: [], updateItem: vi.fn(), deleteItem: vi.fn(), createConnection: vi.fn(), deleteConnection: vi.fn(), resolveGate: vi.fn(), activeBuild: null, sessions: [], agentErrors: [] };
});
afterEach(() => cleanup());

const panel = (props) => render(<ContextItemDetail onSelect={() => {}} onClose={() => {}} onFocusFeature={() => {}} onViewInGraph={() => {}} onViewInTree={() => {}} {...props} />);

describe('project graph item in the right panel (COMP-PROJECT-GRAPH-DOC-PANEL-1 r2)', () => {
  it('selection: an item whose store id is in the bound store takes the List view path; another workspace\'s item is external', () => {
    const compose = { id: 'compose:c1', module: 'compose', memberRoot: '/r/forge/compose/' };
    expect(projectItemSelection({ item: compose, items: [compose], connections: [] }, [STORE_ITEM], '/r/forge/compose'))
      .toEqual({ type: 'item', id: 'c1', storeId: 'c1', doc: null });
    const other = projectItemSelection({ item: SM, ...EXT }, [STORE_ITEM], '/r/forge/compose');
    expect(other.id).toBe(SM.id);
    expect(other.external.item).toBe(SM);
    // same store id under another root is not the store item
    const clash = { id: 'x:c1', memberRoot: '/r/elsewhere' };
    expect(projectItemSelection({ item: clash, items: [clash], connections: [] }, [STORE_ITEM], '/r/forge/compose').external).toBeTruthy();
  });

  it('read-only item: List view content (type, title, status, description, related) with no edit, delete or connect controls', () => {
    panel({ itemId: SM.id, external: { item: SM, ...EXT } });
    expect(screen.getByTestId('item-detail-title').textContent).toBe('ONTO-BATCHOBSERVER-WIRING-1');
    expect(screen.getByTestId('item-detail-status').textContent).toBe('planned');
    expect(screen.queryByTestId('item-detail-actions')).toBeNull();
    for (const name of [/Rename/, /Connect/, /Kill/, /Delete/, /Start/, /Pressure Test/]) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(document.querySelector('select')).toBeNull();
    expect(screen.queryByTestId('item-detail-group-input')).toBeNull();
    expect(screen.queryByTestId('focus-feature')).toBeNull();
    expect(screen.queryByText(/View in Graph/)).toBeNull();
    expect(screen.getByText('GOV-ROLES-1')).toBeTruthy(); // related item from the project graph's own edges
    fireEvent.click(screen.getByTestId('item-detail-description'));
    expect(document.querySelector('textarea')).toBeNull();
    expect(_state.updateItem).not.toHaveBeenCalled();
  });

  it('description markdown is rendered in the panel: a heading, link text, no raw ## or ](', () => {
    panel({ itemId: SM.id, external: { item: SM, ...EXT } });
    const d = screen.getByTestId('item-detail-description');
    expect(d.querySelector('h2')).not.toBeNull();
    expect(d.textContent).toContain('docs/ROADMAP.md');
    expect(d.textContent).not.toContain('##');
    expect(d.textContent).not.toContain('](');
    expect(d.querySelector('a')).toBeNull(); // repo-relative links show as text with the target on hover
    expect(d.querySelector('[title="../../ROADMAP.md"]')).not.toBeNull();
  });

  it('store item: the editable List view panel, description rendered, click still edits', () => {
    panel({ itemId: 'c1' });
    const d = screen.getByTestId('item-detail-description');
    expect(d.querySelector('h1').textContent).toBe('Head');
    expect(screen.getByTestId('item-detail-actions')).toBeTruthy();
    fireEvent.click(d);
    expect(document.querySelector('textarea').value).toBe('# Head\n\n- a');
  });

  it('double-click doc: the Doc tab opens with formatted markdown (truth 1, 8)', () => {
    const md = '# Design\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n';
    const { rerender } = panel({ itemId: SM.id, external: { item: SM, ...EXT }, doc: { loading: true, requestedAt: 1 } });
    expect(screen.getByTestId('context-doc-loading')).toBeTruthy();
    rerender(<ContextItemDetail onSelect={() => {}} onClose={() => {}} itemId={SM.id} external={{ item: SM, ...EXT }} doc={{ text: md, path: '/r/d.md', requestedAt: 1 }} />);
    const body = screen.getByTestId('context-doc-text');
    expect(body.querySelector('h1').textContent).toBe('Design');
    expect(body.querySelectorAll('li').length).toBe(2);
    expect(body.querySelector('table')).not.toBeNull();
    expect(body.querySelector('pre code').textContent).toContain('const x = 1;');
    expect(body.textContent).not.toContain('# Design');
    // a store item's doc uses the same tab
    cleanup();
    panel({ itemId: 'c1', doc: { text: '## Store doc', requestedAt: 2 } });
    expect(screen.getByTestId('context-doc-text').querySelector('h2').textContent).toBe('Store doc');
  });

  it('no doc and a failed read say so in words in the Doc tab (truth 3, 4)', () => {
    panel({ itemId: SM.id, external: { item: SM, ...EXT }, doc: { error: 'smartmemory: no doc on disk for X', requestedAt: 1 } });
    expect(screen.getByTestId('context-doc-error').textContent).toBe('No design doc for this item: smartmemory: no doc on disk for X');
    cleanup();
    panel({ itemId: SM.id, external: { item: SM, ...EXT }, doc: { error: 'network down', requestedAt: 2 } });
    expect(screen.getByTestId('context-doc-error').textContent).toBe('Could not load the doc: network down');
  });

  it('hover card text: markup stripped, never raw ## or link syntax (truth 9)', () => {
    const t = markdownToPlain(DESC);
    expect(t).toBe('Related Documents - Roadmap entry: docs/ROADMAP.md (line 524) - Migration design: ROADMAP-MIGRATE-1');
    expect(markdownToPlain('## Problem\nCurrent **Python** core, see `x_y`.\n\n- one\n- two')).toBe('Problem Current Python core, see x_y. one two');
    expect(markdownToPlain(null)).toBe('');
  });
});

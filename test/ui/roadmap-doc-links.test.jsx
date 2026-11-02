/** COMP-ROADMAP-DOC-LINKS-1: roadmap items open their docs: files as links, double-click opens the design doc, a single click only selects. */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import TreeView from '../../src/components/vision/TreeView.jsx';
import { ItemFiles } from '../../src/components/vision/ItemDetailPanel.jsx';
import ContextFilesTab, { primaryDocPath } from '../../src/components/vision/ContextFilesTab.jsx';
import WikiView, { findDocTarget, featureOfDocPath } from '../../src/components/cockpit/WikiView.jsx';
import { resetPaneMemory } from '../../src/components/cockpit/PaneSwitcher.jsx';

const linked = typeof __WIKI_COMPONENTS__ !== 'undefined' && __WIKI_COMPONENTS__;
const FRAME = 'http://127.0.0.1:8791';
const doc = (id, path) => ({ doc_id: id, source_id: 's', path, title: id, kind: 'design', feature_ids: ['F-1'], areas: [], mtime: '2026-10-31T00:00:00Z', text_mode: 'full', missing_reason: null });
const hubClient = (docs) => ({
  graphAll: vi.fn(), graphPage: vi.fn(), note: vi.fn(), identity: vi.fn(), decisions: vi.fn(async () => ({ items: [], total: 0 })),
  decisionsPage: vi.fn(), sourcesPage: vi.fn(), docsByArea: vi.fn(), ledger: vi.fn(), upcomingCalls: vi.fn(), search: vi.fn(async () => ({ groups: [] })),
  featureHub: vi.fn(async () => ({ items: docs, total: docs.length, next_cursor: null, generated_at: 't', feature: null })),
});

beforeEach(() => resetPaneMemory());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('which doc an item opens', () => {
  const rows = [
    ['design.md wins over an earlier file', { files: ['docs/features/F-1/blueprint.md', 'docs/features/F-1/design.md'] }, 'docs/features/F-1/design.md'],
    ['no design.md: the first file', { files: ['docs/features/F-1/plan.md', 'docs/features/F-1/report.md'] }, 'docs/features/F-1/plan.md'],
    ['an empty list: null (the feature hub)', { files: [] }, null],
    ['no files field: null', {}, null],
    ['junk entries are skipped', { files: ['', null, 'docs/features/F-1/prd.md'] }, 'docs/features/F-1/prd.md'],
  ];
  it.each(rows)('%s', (_name, item, want) => expect(primaryDocPath(item)).toBe(want));
});

describe('repo path to wiki note', () => {
  const docs = [doc('d-design', 'docs/features/F-1/design.md'), doc('d-plan', 'docs/features/F-1/plan.md')];
  const rows = [
    ['an exact path match', 'docs/features/F-1/design.md', 'd-design'],
    ['a wiki path with a repo prefix still matches', 'docs/features/F-1/plan.md', 'd-plan'],
    ['a file the hub does not list', 'docs/features/F-1/missing.md', null],
  ];
  it.each(rows)('%s', async (_name, docPath, want) => {
    const client = hubClient(docs);
    const got = await findDocTarget(client, { workspace: 'wiki-eng', docPath, featureId: featureOfDocPath(docPath) });
    expect(client.featureHub).toHaveBeenCalledWith({ workspace: 'wiki-eng', featureId: 'F-1' });
    expect(got).toEqual(want ? { kind: 'note', workspace: 'wiki-eng', docId: want } : null);
  });
  it('a path outside docs/features has no feature, and a missing workspace asks nothing', async () => {
    expect(featureOfDocPath('README.md')).toBeNull();
    const client = hubClient(docs);
    expect(await findDocTarget(client, { workspace: undefined, docPath: 'docs/features/F-1/design.md', featureId: 'F-1' })).toBeNull();
    expect(client.featureHub).not.toHaveBeenCalled();
  });
});

describe('tree row: single click selects, double-click opens the doc', () => {
  const items = [
    { id: 'i1', type: 'feature', title: 'Has docs', status: 'planned', files: ['docs/features/F-1/design.md'] },
    { id: 'i2', type: 'feature', title: 'No docs', status: 'planned', files: [] },
  ];
  const mount = () => {
    const onSelect = vi.fn(); const onOpenDoc = vi.fn();
    const { container } = render(<TreeView items={items} connections={[]} selectedItemId={null} onSelect={onSelect} onOpenDoc={onOpenDoc} />);
    return { onSelect, onOpenDoc, row: (id) => container.querySelector(`[data-item-id="${id}"]`) };
  };
  const rows = [
    ['single click on an item with docs', 'i1', 'click', 1, 0],
    ['double-click on an item with docs', 'i1', 'dblclick', 0, 1],
    ['double-click on an item with no files still asks (the app opens the feature hub)', 'i2', 'dblclick', 0, 1],
  ];
  it.each(rows)('%s', (_name, id, gesture, selects, opens) => {
    const t = mount();
    fireEvent[gesture === 'click' ? 'click' : 'doubleClick'](t.row(id));
    expect(t.onSelect).toHaveBeenCalledTimes(selects);
    expect(t.onOpenDoc).toHaveBeenCalledTimes(opens);
    if (opens) expect(t.onOpenDoc).toHaveBeenCalledWith(id);
  });
  it('a tree with no handler does not throw on double-click', () => {
    const { container } = render(<TreeView items={items} connections={[]} selectedItemId={null} onSelect={vi.fn()} />);
    expect(() => fireEvent.doubleClick(container.querySelector('[data-item-id="i1"]'))).not.toThrow();
  });
});

describe('item detail files', () => {
  it('lists each file as a link that opens that path', () => {
    const onOpenFile = vi.fn();
    render(<ItemFiles files={['docs/features/F-1/design.md', 'docs/features/F-1/plan.md']} onOpenFile={onOpenFile} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['design.md', 'plan.md']);
    fireEvent.click(screen.getByText('plan.md'));
    expect(onOpenFile).toHaveBeenCalledWith('docs/features/F-1/plan.md');
  });
  it.each([[[]], [undefined], [null]])('renders nothing for %j', (files) => {
    const { container } = render(<ItemFiles files={files} onOpenFile={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('context Files tab', () => {
  it('opens the clicked file, not just the wiki home', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ files: [{ path: 'docs/features/F-1/design.md', size: 10 }, { path: 'docs/features/F-1/plan.md', size: 20 }, { path: 'docs/features/OTHER/x.md' }] }) })));
    const onOpenFile = vi.fn();
    render(<ContextFilesTab featureCode="F-1" onOpenFile={onOpenFile} />);
    fireEvent.click(await screen.findByText('plan.md'));
    expect(onOpenFile).toHaveBeenCalledWith('docs/features/F-1/plan.md');
  });
});

describe('wiki pane opens the requested doc', () => {
  it.skipIf(!linked)('a listed doc opens as its note in the frame', async () => {
    const client = hubClient([doc('d-design', 'docs/features/F-1/design.md')]);
    render(<WikiView client={client} featureCode="F-1" workspace="wiki-eng" frameBase={FRAME} docOpen={{ path: 'docs/features/F-1/design.md' }} />);
    await waitFor(() => expect(screen.getByTitle('wiki').getAttribute('src')).toBe(`${FRAME}/ui/embed/w/wiki-eng/note?id=d-design&theme=light`));
  });
  it.skipIf(!linked)('an unlisted doc leaves the feature hub open and throws nothing', async () => {
    const client = hubClient([doc('d-design', 'docs/features/F-1/design.md')]);
    render(<WikiView client={client} featureCode="F-1" workspace="wiki-eng" frameBase={FRAME} docOpen={{ path: 'docs/features/F-1/nope.md' }} />);
    await waitFor(() => expect(client.featureHub).toHaveBeenCalled());
    expect(screen.queryByTitle('wiki')).toBeNull();
    expect(await screen.findByText('d-design')).toBeTruthy();
  });
});

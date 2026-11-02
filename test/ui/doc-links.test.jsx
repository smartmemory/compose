/** COMP-WIKI-GRAPH-DOC-LINKS-1: every doc title Compose shows opens that doc. One row per render site: the title is a link
 *  (its href the doc in the full wiki), and a plain click opens the doc in the Wiki tab's frame (or, for a repo path, hands the
 *  path to the one open-doc function, App's navigateToWiki, through `onOpenFile`). */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import WikiView from '../../src/components/cockpit/WikiView.jsx';
import { resetPaneMemory } from '../../src/components/cockpit/PaneSwitcher.jsx';
import { GateArtifact } from '../../src/components/vision/ItemDetailPanel.jsx';
import GateView from '../../src/components/vision/GateView.jsx';

const linked = typeof __WIKI_COMPONENTS__ !== 'undefined' && __WIKI_COMPONENTS__;
const FRAME = 'http://127.0.0.1:8791';
const NOTE = (id) => `${FRAME}/ui/w/wiki-eng/note?id=${id}`;
const page = (items) => ({ items, total: items.length, next_cursor: null, generated_at: 't' });
const entry = (id, text, parent) => ({ entry_id: id, parent_doc_id: parent, kind: 'decision', ts: '2026-10-30T09:00:00Z', text, refs: [], status: 'accepted' });
const doc = (id, title, areas = []) => ({
  doc_id: id, source_id: 's', path: `docs/features/X-1/${id}.md`, title, kind: 'design', feature_ids: ['X-1'], areas, mtime: '2026-10-30T00:00:00Z', text_mode: 'full', missing_reason: null,
});
const feature = { feature_id: 'X-1', title: 'X one', roadmap_status: 'IN_PROGRESS', folder: 'docs/features/X-1', owner: null, current_decision_ref: null, latest_output_ref: null, doc_count: 1, areas: [] };
const source = { source_id: 'eng-mac-compose', plugin: 'src_local_fs', host: 'mac', status: 'ok', coverage: 'full_text', last_success: '2026-10-30T00:00:00Z', discovered: 9, indexing_age_s: 1, publication_delay_s: 0, overdue: false };

const client = () => ({
  graphAll: vi.fn(), graphPage: vi.fn(), note: vi.fn(), search: vi.fn(),
  identity: vi.fn(async () => { throw new Error('identity must not be needed'); }),
  featureHub: vi.fn(async () => ({ ...page([doc('f1', 'Feature design doc')]), feature })),
  decisions: vi.fn(async () => page([entry('fd', 'Feature decision', 'f2')])),
  decisionsPage: vi.fn(async () => page([entry('e1', 'Decision from a doc', 'd7')])),
  sourcesPage: vi.fn(async () => page([source])),
  docsByArea: vi.fn(async () => page([doc('a1', 'Area doc title', ['core'])])),
  ledger: vi.fn(async () => page([{ ...entry('l1', 'Ledger line', 'L9'), kind: 'ledger' }])),
  upcomingCalls: vi.fn(async () => null),
});

const openArea = () => {
  fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'core' } });
  fireEvent.submit(screen.getByLabelText('Area').closest('form'));
};
const SITES = [
  { site: 'Wiki > Decisions: decision text', pane: 'Decisions', text: 'Decision from a doc', href: NOTE('d7') },
  { site: 'Wiki > Ledger: entry text', pane: 'Ledger', text: 'Ledger line', href: NOTE('L9') },
  { site: 'Wiki > Feature: doc title', featureCode: 'X-1', text: 'Feature design doc', href: NOTE('f1') },
  { site: 'Wiki > Feature: decision', featureCode: 'X-1', text: 'Feature decision', href: NOTE('f2') },
  { site: 'Wiki > Area: doc title', pane: 'Area', before: openArea, text: 'Area doc title', href: NOTE('a1') },
  { site: 'Wiki > Sources: source name', pane: 'Sources', text: 'eng-mac-compose', href: `${FRAME}/ui/w/wiki-eng?source=eng-mac-compose` },
];

beforeEach(() => resetPaneMemory());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('doc links: every doc title in Compose opens its doc', () => {
  it.skipIf(!linked)('each wiki-tab site renders its title as a link to the doc, and a click opens that doc in the frame, without fetching', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('a component fetched'); });
    vi.stubGlobal('fetch', fetchSpy);
    const got = [];
    vi.spyOn(window, 'open').mockImplementation(() => null);
    for (const s of SITES) {
      render(<WikiView client={client()} workspace="wiki-eng" frameBase={FRAME} featureCode={s.featureCode} />);
      if (s.pane) fireEvent.click(screen.getByRole('tab', { name: s.pane }));
      s.before?.();
      const title = await screen.findByText(s.text);
      const href = title.closest('a')?.getAttribute('href') ?? null;
      fireEvent.click(title);
      got.push([s.site, href, screen.queryByTitle('wiki')?.getAttribute('src') ?? null]);
      cleanup();
      resetPaneMemory();
    }
    expect(got).toEqual(SITES.map((s) => [s.site, s.href, s.href.includes('?source=') ? null : `${s.href.replace('/ui/w/', '/ui/embed/w/')}&theme=light`])) // WIKI-UI-LINKS-1: the Document pane frames the embed route; a source opens the wiki app in a new tab;
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  const GATE_ROWS = [
    { name: 'with a feature code: a link to the feature doc', props: { name: 'design.md', featureCode: 'X-1' }, opened: ['docs/features/X-1/design.md'] },
    { name: 'no feature code: the name as text', props: { name: 'design.md' }, opened: null },
    { name: 'no open-doc function: the name as text', props: { name: 'plan.md', featureCode: 'X-1', onOpenFile: null }, opened: null },
  ];
  it.each(GATE_ROWS)('Item detail > pending gate artifact, $name', ({ props, opened }) => {
    const onOpenFile = vi.fn();
    render(<GateArtifact onOpenFile={onOpenFile} {...props} />);
    const link = screen.queryByTestId('gate-artifact-link');
    expect(screen.getByText(props.name)).toBeTruthy();
    if (opened === null) { expect(link).toBeNull(); return; }
    fireEvent.click(link);
    expect(onOpenFile.mock.calls.map(([p]) => p)).toEqual(opened);
  });

  // COMP-WIKI-GATEVIEW-DOC-LINK-1: the same name on the Gates view card.
  const gateCard = (code) => ({
    gates: [{ id: 'g1', itemId: 'i1', status: 'pending', fromPhase: 'explore_design', createdAt: '2026-11-02T00:00:00Z', artifactAssessment: { exists: true, completeness: 0.8, wordCount: 120, meetsMinWordCount: true } }],
    items: [{ id: 'i1', title: 'Item one', lifecycle: code ? { featureCode: code } : {} }],
  });
  const GATEVIEW_ROWS = [
    { name: 'with a feature code and handler: a link to the feature doc', code: 'X-1', handler: true, opened: ['docs/features/X-1/design.md'] },
    { name: 'no feature code: the name as text', code: null, handler: true, opened: null },
    { name: 'no handler: the name as text', code: 'X-1', handler: false, opened: null },
  ];
  it.each(GATEVIEW_ROWS)('Gates view > card artifact name, $name', ({ code, handler, opened }) => {
    const onOpenFile = vi.fn();
    render(<GateView {...gateCard(code)} onResolve={() => {}} onSelect={() => {}} onOpenFile={handler ? onOpenFile : undefined} />);
    expect(screen.getByText('design.md')).toBeTruthy();
    const link = screen.queryByTestId('gate-artifact-link');
    if (opened === null) { expect(link).toBeNull(); return; }
    fireEvent.click(link);
    expect(onOpenFile.mock.calls.map(([p]) => p)).toEqual(opened);
  });
});

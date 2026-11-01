/**
 * COMP-WIKI-DOC-PATH-LINKS-1: a doc known only by its repo path opens in the wiki. The sites: every ledger reference in Projects ›
 * Review › Decisions (source, commit, status, refs, echoes, maybe) and the owner-queue id open their file through `onOpenFile`; WikiView
 * resolves any path (the feature hub first, then the wiki's path lookup) and a miss keeps today's feature hub with a WARNING naming the path.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { configure as configureRtl } from '@testing-library/react';
import DecisionsPane from '../../src/components/cockpit/DecisionsPane.jsx';
import WikiView, { resolveDocTarget, docFileOf } from '../../src/components/cockpit/WikiView.jsx';
import { resetPaneMemory } from '../../src/components/cockpit/PaneSwitcher.jsx';
import { resetFleetProjects } from '../../src/lib/fleetProjects.js';

configureRtl({ asyncUtilTimeout: 5000 });
const linked = typeof __WIKI_COMPONENTS__ !== 'undefined' && __WIKI_COMPONENTS__;
const FRAME = 'http://127.0.0.1:8791';
const LEDGER = 'coordination/ledger.md';
const QUEUE = 'coordination/owner-queue.jsonl';

const row = (over) => ({
  id: 'L1', line: 1, at: '2026-11-01T11:40:00.000Z', day: '2026-11-01', decider: 'owner', by: 'owner', via: null, summary: 's', text: 't',
  units: [], refs: [], echoes: [], maybe: [], status: 'standing', statusBy: null, exact: false, inferred: true, dId: null, tags: [],
  commit: null, commitPending: false, source: 'ledger', projects: [], ...over,
});
const ROWS_IN = [
  row({ id: 'PEND', line: 22710, commitPending: true }),
  row({ id: 'COMMIT', line: 22712, commit: 'abcdef1234567890', status: 'superseded', statusBy: { line: 22715 } }),
  row({ id: 'LINE', line: 40, refs: [{ kind: 'line', value: '7' }, { kind: 'unit', value: 'X-1' }], echoes: [{ line: 12, by: 's2-coord' }], maybe: [30] }),
  row({ id: 'Q-9', source: 'owner-queue', queueId: 'Q-9', decider: 'queue', line: undefined }),
];
const answer = (over = {}) => ({
  asOf: 'x', filters: {}, total: ROWS_IN.length, nextCursor: null, rows: ROWS_IN,
  counts: { projects: { all: 4, fleet: 4 }, decider: { owner: 3, absent: 0, lane: 0, queue: 1 } },
  projects: [], blame: { state: 'warm' }, sourceErrors: {}, ledgerDoc: LEDGER, queueDoc: QUEUE, ...over,
});
function stubFetch(body) {
  vi.stubGlobal('fetch', vi.fn(async (url) => ({ ok: true, status: 200, json: async () => (String(url).startsWith('/api/projects') ? { configured: true, projects: [], laneIndex: {} } : body) })));
}
const rowEl = async (id) => within((await screen.findAllByTestId('decision-row')).find((r) => r.dataset.id === id));
const expand = (r) => fireEvent.click(r.getByTestId('decision-summary'));

beforeEach(() => resetPaneMemory());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetFleetProjects(); });

describe('Decisions: every ledger reference opens the ledger doc', () => {
  // [site, row id, expand first, how to find the element, the path onOpenFile gets]
  const SITES = [
    ['source: commit pending · ledger.md#L<n>', 'PEND', false, (r) => r.getByTestId('decision-source'), `${LEDGER}#L22710`],
    ['source: a commit', 'COMMIT', false, (r) => r.getByTestId('decision-source'), `${LEDGER}#L22712`],
    ['status: superseded by L<n>', 'COMMIT', false, (r) => r.getByTestId('decision-status'), `${LEDGER}#L22715`],
    ['source: ledger.md#L<n>', 'LINE', false, (r) => r.getByTestId('decision-source'), `${LEDGER}#L40`],
    ['premises: Refs ledger :<n>', 'LINE', true, (r) => r.getByText('ledger :7'), `${LEDGER}#L7`],
    ['premises: Echoes L<n>', 'LINE', true, (r) => r.getByText('L12 s2-coord'), `${LEDGER}#L12`],
    ['premises: Maybe changed by L<n>', 'LINE', true, (r) => r.getByText('L30'), `${LEDGER}#L30`],
    ['owner queue: the queue id', 'Q-9', false, (r) => r.getByTestId('decision-source'), QUEUE],
  ];
  it.each(SITES)('%s', async (_site, id, open, find, want) => {
    stubFetch(answer());
    const onOpenFile = vi.fn();
    render(<DecisionsPane projectRoot="/r/x" onOpenFile={onOpenFile} />);
    const r = await rowEl(id);
    if (open) expand(r);
    const el = find(r);
    expect(el.tagName).toBe('BUTTON');
    fireEvent.click(el);
    expect(onOpenFile.mock.calls).toEqual([[want]]);
  });

  it('a non-line ref stays text, and a click on a link does not toggle the row', async () => {
    stubFetch(answer());
    const onOpenFile = vi.fn();
    render(<DecisionsPane projectRoot="/r/x" onOpenFile={onOpenFile} />);
    const r = await rowEl('LINE');
    expand(r);
    expect(r.getByText('unit X-1').tagName).toBe('SPAN');
    fireEvent.click(r.getByText('L30'));
    expect(r.queryByTestId('decision-premises')).not.toBeNull();
  });

  it.each([
    ['no ledgerDoc or queueDoc from the route', answer({ ledgerDoc: null, queueDoc: null }), vi.fn()],
    ['no onOpenFile from the host', answer(), undefined],
  ])('%s: every reference stays text, same words', async (_name, body, onOpenFile) => {
    stubFetch(body);
    render(<DecisionsPane projectRoot="/r/x" onOpenFile={onOpenFile} />);
    const r = await rowEl('COMMIT');
    expect([r.getByTestId('decision-source').tagName, r.getByTestId('decision-status').tagName]).toEqual(['SPAN', 'SPAN']);
    expect([r.getByTestId('decision-source').textContent, r.getByTestId('decision-status').textContent]).toEqual(['abcdef123456', 'superseded by L22715']);
    expect((await rowEl('Q-9')).getByTestId('decision-source').tagName).toBe('SPAN');
    expect(screen.queryAllByTestId('decision-line-link')).toEqual([]);
  });
});

const err = (code) => Object.assign(new Error(code), { code });
const hubDoc = (id, path) => ({ doc_id: id, source_id: 's', path, title: id, kind: 'design', feature_ids: ['F-1'], areas: [], mtime: null, text_mode: 'full', missing_reason: null });
// Every DataClient call (WikiDataProvider refuses a client missing one), plus Compose's `docByPath` when `byPath` is given.
const client = ({ hub = [], byPath } = {}) => ({
  graphAll: vi.fn(), graphPage: vi.fn(), note: vi.fn(), identity: vi.fn(), decisions: vi.fn(async () => ({ items: [], total: 0 })),
  decisionsPage: vi.fn(), sourcesPage: vi.fn(), docsByArea: vi.fn(), ledger: vi.fn(), upcomingCalls: vi.fn(), search: vi.fn(async () => ({ groups: [] })),
  featureHub: vi.fn(async () => ({ items: hub, total: hub.length, next_cursor: null, generated_at: 't', feature: null })),
  ...(byPath === undefined ? {} : { docByPath: vi.fn(byPath) }),
});

describe('WikiView resolves a repo path to a wiki note', () => {
  // [row, client, docPath, featureId, the target, the docByPath call (null: not asked), a warning naming the path]
  const ROWS = [
    ['a feature doc the hub lists: the hub answers, the path lookup is not asked', client({ hub: [hubDoc('d1', 'docs/features/F-1/design.md')], byPath: async () => ({ id: 'x' }) }),
      'docs/features/F-1/design.md', 'F-1', 'd1', null, false],
    ['a non-feature path: the path lookup, the anchor dropped', client({ byPath: async () => ({ workspace: 'wiki-eng', id: 'eng-mac-ops:ledger' }) }),
      `${LEDGER}#L22710`, null, 'eng-mac-ops:ledger', LEDGER, false],
    ['a feature doc the hub does not list falls back to the path lookup', client({ hub: [], byPath: async () => ({ id: 'd-late' }) }),
      'docs/features/F-1/late.md', 'F-1', 'd-late', 'docs/features/F-1/late.md', false],
    ['the hub failing still tries the path lookup', { ...client({ byPath: async () => ({ id: 'd2' }) }), featureHub: vi.fn(async () => { throw err('wiki_unreachable'); }) },
      'docs/features/F-1/x.md', 'F-1', 'd2', 'docs/features/F-1/x.md', false],
    ['a miss (404): null, and a WARNING names the path', client({ byPath: async () => { throw err('not_found'); } }),
      'docs/nope.md', null, null, 'docs/nope.md', true],
    ['an ambiguous path (409): null, and a WARNING names the path', client({ byPath: async () => { throw err('ambiguous'); } }),
      'CHANGELOG.md', null, null, 'CHANGELOG.md', true],
    ['a refused path (400): null, and a WARNING names the path', client({ byPath: async () => { throw err('bad_request'); } }),
      '../x.md', null, null, '../x.md', true],
    ['an answer with no id: null, and a WARNING', client({ byPath: async () => ({}) }), 'docs/a.md', null, null, 'docs/a.md', true],
    ['a client with no path lookup: null, and a WARNING', client({}), 'docs/a.md', null, null, null, true],
  ];
  it.each(ROWS)('%s', async (_row, c, docPath, featureId, want, asked, warns) => {
    const warn = vi.fn();
    const got = await resolveDocTarget(c, { workspace: 'wiki-eng', docPath, featureId, warn });
    expect(got).toEqual(want ? { kind: 'note', workspace: 'wiki-eng', docId: want } : null);
    if (asked === null) expect(c.docByPath?.mock.calls ?? []).toEqual([]);
    else expect(c.docByPath.mock.calls).toEqual([[{ workspace: 'wiki-eng', path: asked }]]);
    expect(warn.mock.calls.length).toBe(warns ? 1 : 0);
    if (warns) expect(warn.mock.calls[0][0]).toContain(docFileOf(docPath));
  });

  it('no workspace or no path asks nothing', async () => {
    const c = client({ byPath: async () => ({ id: 'x' }) });
    expect(await resolveDocTarget(c, { workspace: undefined, docPath: LEDGER })).toBeNull();
    expect(await resolveDocTarget(c, { workspace: 'wiki-eng', docPath: '#L3' })).toBeNull();
    expect([c.featureHub.mock.calls.length, c.docByPath.mock.calls.length]).toEqual([0, 0]);
  });

  it.skipIf(!linked)('the ledger path opens as its note in the frame; the frame URL carries only the doc id', async () => {
    const c = client({ byPath: async () => ({ workspace: 'wiki-eng', id: 'eng-mac-ops:coordination/ledger.md' }) });
    render(<WikiView client={c} workspace="wiki-eng" frameBase={FRAME} docOpen={{ path: `${LEDGER}#L22710` }} />);
    await waitFor(() => expect(screen.getByTitle('wiki').getAttribute('src')).toBe(`${FRAME}/ui/w/wiki-eng/note?id=${encodeURIComponent('eng-mac-ops:coordination/ledger.md')}`));
  });

  it.skipIf(!linked)('a miss keeps today\'s feature hub and warns with the path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = client({ byPath: async () => { throw err('not_found'); } });
    render(<WikiView client={c} featureCode="F-1" workspace="wiki-eng" frameBase={FRAME} docOpen={{ path: 'docs/nope.md' }} />);
    await waitFor(() => expect(warn.mock.calls.some((a) => String(a[0]).includes('docs/nope.md'))).toBe(true));
    expect(screen.queryByTitle('wiki')).toBeNull();
  });
});

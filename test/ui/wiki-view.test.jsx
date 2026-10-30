/** COMPOSE-WIKI-TAB-1: the Wiki tab renders @wiki/components screens from a fake DataClient (no fetch). */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import WikiView from '../../src/components/cockpit/WikiView.jsx';
import { createWikiDataClient } from '../../src/lib/clients/wiki.js';
import { locateView } from '../../lib/view-keys.js';

const linked = typeof __WIKI_COMPONENTS__ !== 'undefined' && __WIKI_COMPONENTS__;
const FRAME = 'http://127.0.0.1:8791';
const feature = {
  feature_id: 'COMPOSE-WIKI-TAB-1', title: 'Wiki tab in Compose', roadmap_status: 'IN_PROGRESS', folder: 'docs/features/COMPOSE-WIKI-TAB-1',
  owner: null, current_decision_ref: null, latest_output_ref: null, doc_count: 1, areas: [],
};
const doc = {
  doc_id: 'd1', source_id: 's', path: 'docs/features/COMPOSE-WIKI-TAB-1/design.md', title: 'Wiki tab design', kind: 'design',
  feature_ids: ['COMPOSE-WIKI-TAB-1'], areas: [], mtime: '2026-10-30T00:00:00Z', text_mode: 'full', missing_reason: null,
};

afterEach(() => vi.unstubAllGlobals());

describe('Wiki tab', () => {
  it('is a sub-tab of the Library room', () => expect(locateView('wiki')).toEqual({ top: 'library', sub: 'wiki' }));

  it.skipIf(!linked)('renders the feature hub, search and the full-wiki frame from the injected client without fetching', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('a component fetched'); });
    vi.stubGlobal('fetch', fetchSpy);
    const client = {
      identity: vi.fn(async () => { throw new Error('identity must not be needed: the tab passes its workspace'); }),
      featureHub: vi.fn(async () => ({ items: [doc], total: 1, next_cursor: null, generated_at: 't', feature })),
      decisions: vi.fn(async () => ({ items: [], total: 0, next_cursor: null, generated_at: 't' })),
      decisionsPage: vi.fn(async () => ({ items: [], total: 0, next_cursor: null, generated_at: 't' })),
      sourcesPage: vi.fn(async () => ({ items: [], total: 0, next_cursor: null, generated_at: 't' })),
      docsByArea: vi.fn(async () => ({ items: [], total: 0, next_cursor: null, generated_at: 't' })),
      ledger: vi.fn(), upcomingCalls: vi.fn(),
      search: vi.fn(async () => ({ groups: [{ label: 'design', items: [{ doc_id: 'd1', title: 'Wiki tab design', path: doc.path, snippet: 'the tab', rank: 1 }], total: 1, next_cursor: null }], generated_at: 't' })),
    };
    render(<WikiView client={client} featureCode="COMPOSE-WIKI-TAB-1" workspace="wiki-eng" frameBase={FRAME} />);
    expect(await screen.findByText('Wiki tab design')).toBeTruthy();
    expect(client.featureHub).toHaveBeenCalledWith({ workspace: 'wiki-eng', featureId: 'COMPOSE-WIKI-TAB-1' });

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(client.search).toHaveBeenCalledWith({ workspace: 'wiki-eng', q: 'COMPOSE-WIKI-TAB-1' }));
    const hit = await screen.findByText('Wiki tab design');
    expect(hit.closest('a').getAttribute('href')).toBe(`${FRAME}/ui/w/wiki-eng/note?id=d1`);
    fireEvent.click(hit); // a plain click is onNavigate: the note opens in the full-wiki frame
    expect(screen.getByTitle('wiki').getAttribute('src')).toBe(`${FRAME}/ui/w/wiki-eng/note?id=d1`);

    fireEvent.click(screen.getByRole('button', { name: 'Open full wiki' }));
    expect(screen.getByTitle('wiki').getAttribute('src')).toBe(`${FRAME}/ui/feature/COMPOSE-WIKI-TAB-1`);
    expect(client.identity).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Wiki tab: Decisions', () => {
  const entry = (id, text) => ({ entry_id: id, parent_doc_id: 'd1', kind: 'decision', ts: '2026-10-02', text, refs: [], status: 'accepted' });

  it.skipIf(!linked)('pages the decisions list through the injected client without fetching', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('a component fetched'); });
    vi.stubGlobal('fetch', fetchSpy);
    const pages = {
      '': { items: [entry('e1', 'First call')], total: 60, next_cursor: 'c2', generated_at: 't' },
      c2: { items: [entry('e2', 'Second call')], total: 60, next_cursor: null, generated_at: 't' },
    };
    const client = {
      identity: vi.fn(async () => { throw new Error('identity must not be needed'); }),
      featureHub: vi.fn(), decisions: vi.fn(), search: vi.fn(), sourcesPage: vi.fn(), docsByArea: vi.fn(), ledger: vi.fn(), upcomingCalls: vi.fn(),
      decisionsPage: vi.fn(async ({ cursor }) => pages[cursor ?? '']),
    };
    render(<WikiView client={client} workspace="wiki-eng" frameBase={FRAME} />);
    fireEvent.click(screen.getByRole('button', { name: 'Decisions' }));
    expect(await screen.findByText('First call')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Next page'));
    expect(await screen.findByText('Second call')).toBeTruthy();
    expect(client.decisionsPage.mock.calls.map(([a]) => a)).toEqual([
      { workspace: 'wiki-eng', size: 50 },
      { workspace: 'wiki-eng', cursor: 'c2', size: 50 },
    ]);
    expect(client.identity).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Wiki tab: Sources', () => {
  const src = (id, o = {}) => ({ source_id: id, plugin: 'git', host: 'us1', status: 'ok', coverage: 'full_text', last_success: '2026-10-30T10:00:00Z', discovered: 12, indexing_age_s: 3600, publication_delay_s: null, overdue: true, ...o });

  it.skipIf(!linked)('pages the sources list through the injected client without fetching, badges shown', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('a component fetched'); });
    vi.stubGlobal('fetch', fetchSpy);
    const pages = {
      '': { items: [src('eng-docs')], total: 60, next_cursor: 's2', generated_at: 't' },
      s2: { items: [src('eng-ops', { overdue: false, indexing_age_s: 60 })], total: 60, next_cursor: null, generated_at: 't' },
    };
    const client = {
      identity: vi.fn(async () => { throw new Error('identity must not be needed'); }),
      featureHub: vi.fn(), decisions: vi.fn(), decisionsPage: vi.fn(), search: vi.fn(), docsByArea: vi.fn(), ledger: vi.fn(), upcomingCalls: vi.fn(),
      sourcesPage: vi.fn(async ({ cursor }) => pages[cursor ?? '']),
    };
    render(<WikiView client={client} workspace="wiki-eng" frameBase={FRAME} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sources' }));
    const row = (await screen.findByText('eng-docs')).closest('tr');
    expect(row.textContent).toContain('overdue');
    expect(row.textContent).toContain('1h');
    fireEvent.click(screen.getByLabelText('Next page'));
    expect((await screen.findByText('eng-ops')).closest('tr').textContent).toContain('on time');
    expect(client.sourcesPage.mock.calls.map(([a]) => a)).toEqual([
      { workspace: 'wiki-eng', size: 50 },
      { workspace: 'wiki-eng', cursor: 's2', size: 50 },
    ]);
    expect(client.identity).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Wiki tab: Area docs', () => {
  const adoc = (id, title, areas) => ({ ...doc, doc_id: id, title, areas });

  it.skipIf(!linked)('opens an area from a typed name, pages its docs, and follows a doc\'s area link, without fetching', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('a component fetched'); });
    vi.stubGlobal('fetch', fetchSpy);
    const pages = {
      search: {
        '': { items: [adoc('a1', 'Recall design', ['search', 'core'])], total: 60, next_cursor: 'a2', generated_at: 't' },
        a2: { items: [adoc('a2', 'Second page doc', ['search'])], total: 60, next_cursor: null, generated_at: 't' },
      },
      core: { '': { items: [adoc('a3', 'Core doc', ['core'])], total: 1, next_cursor: null, generated_at: 't' } },
    };
    const client = {
      identity: vi.fn(async () => { throw new Error('identity must not be needed'); }),
      featureHub: vi.fn(), decisions: vi.fn(), decisionsPage: vi.fn(), sourcesPage: vi.fn(), search: vi.fn(), ledger: vi.fn(), upcomingCalls: vi.fn(),
      docsByArea: vi.fn(async ({ area, cursor }) => pages[area][cursor ?? '']),
    };
    render(<WikiView client={client} workspace="wiki-eng" frameBase={FRAME} />);
    fireEvent.click(screen.getByRole('button', { name: 'Area' }));
    expect(screen.getByText(/Type an area name/)).toBeTruthy();
    expect(client.docsByArea).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Area'), { target: { value: ' search ' } });
    fireEvent.submit(screen.getByLabelText('Area').closest('form'));
    expect(await screen.findByText('Recall design')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Next page'));
    expect(await screen.findByText('Second page doc')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Previous page'));
    const link = (await screen.findByText('core', { selector: 'a' }));
    expect(link.getAttribute('href')).toBe(`${FRAME}/ui/area/core`);
    fireEvent.click(link); // a plain click is onNavigate: the area opens in this view, not the frame
    expect(await screen.findByText('Core doc')).toBeTruthy();
    expect(screen.getByLabelText('Area').value).toBe('core');
    expect(client.docsByArea.mock.calls.map(([a]) => a)).toEqual([
      { workspace: 'wiki-eng', area: 'search', size: 50 },
      { workspace: 'wiki-eng', area: 'search', cursor: 'a2', size: 50 },
      { workspace: 'wiki-eng', area: 'search', size: 50 },
      { workspace: 'wiki-eng', area: 'core', size: 50 },
    ]);
    expect(client.identity).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Wiki tab: Ledger', () => {
  const le = (id, text, ts) => ({ entry_id: id, parent_doc_id: 'd1', kind: 'ledger', ts, text, refs: [] });
  const baseClient = (over) => ({
    identity: vi.fn(async () => { throw new Error('identity must not be needed'); }),
    featureHub: vi.fn(), decisions: vi.fn(), decisionsPage: vi.fn(), sourcesPage: vi.fn(), docsByArea: vi.fn(), search: vi.fn(), ...over,
  });

  it.skipIf(!linked)('pages the 30-day timeline through the injected client and shows the upcoming calls, without fetching', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('a component fetched'); });
    vi.stubGlobal('fetch', fetchSpy);
    const pages = {
      '': { items: [le('l1', 'Shipped the tab', '2026-10-29T09:00:00Z')], total: 60, next_cursor: 'l2', generated_at: 't' },
      l2: { items: [le('l2', 'Older note', '2026-10-05T09:00:00Z')], total: 60, next_cursor: null, generated_at: 't' },
    };
    const client = baseClient({
      ledger: vi.fn(async ({ cursor }) => pages[cursor ?? '']),
      upcomingCalls: vi.fn(async () => ({ items: [le('c1', 'Call with Ana', '2026-11-02T15:00:00Z')], errors: [] })),
    });
    render(<WikiView client={client} workspace="wiki-eng" frameBase={FRAME} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ledger' }));
    expect(await screen.findByText('Shipped the tab')).toBeTruthy();
    expect(await screen.findByText('Call with Ana')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Next page'));
    expect(await screen.findByText('Older note')).toBeTruthy();
    const [first, second] = client.ledger.mock.calls.map(([a]) => a);
    expect([first.workspace, first.size, first.cursor, second.cursor]).toEqual(['wiki-eng', 50, undefined, 'l2']);
    expect(Date.parse(first.to) - Date.parse(first.from)).toBe(31 * 86_400_000); // 30 days back, one day forward
    expect(client.upcomingCalls.mock.calls.map(([a]) => a)).toEqual([{ workspace: 'wiki-eng' }]);
    expect(client.identity).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.skipIf(!linked)('an absent calls feed (null) leaves out the Upcoming calls section', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('a component fetched'); }));
    const client = baseClient({
      ledger: vi.fn(async () => ({ items: [le('l1', 'Shipped the tab', '2026-10-29T09:00:00Z')], total: 1, next_cursor: null, generated_at: 't' })),
      upcomingCalls: vi.fn(async () => null),
    });
    render(<WikiView client={client} workspace="wiki-eng" frameBase={FRAME} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ledger' }));
    expect(await screen.findByText('Shipped the tab')).toBeTruthy();
    await waitFor(() => expect(client.upcomingCalls).toHaveBeenCalled());
    expect(screen.queryByText('Upcoming calls')).toBeNull();
  });
});

describe('Compose wiki DataClient', () => {
  it('talks only to /api/wiki and rejects with the answer\'s code', async () => {
    const calls = [];
    let feedNull = false;
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      calls.push([String(url), opts.method || 'GET', opts.body && JSON.parse(opts.body)]);
      if (String(url).endsWith('/decisions')) return { ok: false, status: 403, json: async () => ({ code: 'workspace_refused', message: 'no' }) };
      if (String(url).includes('/feeds/')) return { ok: true, status: 200, json: async () => (feedNull ? null : { data: { items: [] }, errors: [], partial: false }) };
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    }));
    const client = createWikiDataClient();
    await client.identity();
    await client.featureHub({ workspace: 'wiki-eng', featureId: 'X-1' });
    await client.search({ workspace: 'wiki-eng', q: 'recall' });
    await client.decisionsPage({ workspace: 'wiki-eng' });
    await client.decisionsPage({ workspace: 'wiki-eng', cursor: 'c2', size: 20 });
    await client.sourcesPage({ workspace: 'wiki-eng' });
    await client.sourcesPage({ workspace: 'wiki-eng', cursor: 's2', size: 20 });
    await client.docsByArea({ workspace: 'wiki-eng', area: 'search' });
    await client.docsByArea({ workspace: 'wiki-eng', area: 'search', cursor: 'a2', size: 20 });
    await client.ledger({ workspace: 'wiki-eng', from: '2026-09-30T00:00:00Z', to: '2026-10-31T00:00:00Z' });
    await client.ledger({ workspace: 'wiki-eng', from: '2026-09-30T00:00:00Z', to: '2026-10-31T00:00:00Z', cursor: 'l2', size: 20 });
    expect(await client.upcomingCalls({ workspace: 'wiki-eng' })).toEqual({ items: [], errors: [] });
    feedNull = true;
    expect(await client.upcomingCalls({ workspace: 'wiki-eng' })).toBeNull();
    await expect(client.decisions({ workspace: 'wiki-private', featureId: 'X-1' })).rejects.toMatchObject({ code: 'workspace_refused', status: 403 });
    expect(calls.map(([u, m]) => `${m} ${u}`)).toEqual([
      'GET /api/wiki/identity', 'POST /api/wiki/query/feature_hub', 'POST /api/wiki/query/search',
      'POST /api/wiki/query/decisions_page', 'POST /api/wiki/query/decisions_page',
      'POST /api/wiki/query/sources_page', 'POST /api/wiki/query/sources_page',
      'POST /api/wiki/query/docs_by_area', 'POST /api/wiki/query/docs_by_area',
      'POST /api/wiki/query/ledger', 'POST /api/wiki/query/ledger',
      'GET /api/wiki/feeds/upcoming_calls?workspace=wiki-eng', 'GET /api/wiki/feeds/upcoming_calls?workspace=wiki-eng', 'POST /api/wiki/query/decisions',
    ]);
    expect(calls[1][2]).toEqual({ workspace: 'wiki-eng', featureId: 'X-1' });
    expect(calls[3][2]).toEqual({ workspace: 'wiki-eng' });
    expect(calls[4][2]).toEqual({ workspace: 'wiki-eng', cursor: 'c2', size: 20 });
    expect(calls[5][2]).toEqual({ workspace: 'wiki-eng' });
    expect(calls[6][2]).toEqual({ workspace: 'wiki-eng', cursor: 's2', size: 20 });
    expect(calls[7][2]).toEqual({ workspace: 'wiki-eng', area: 'search' });
    expect(calls[8][2]).toEqual({ workspace: 'wiki-eng', area: 'search', cursor: 'a2', size: 20 });
    expect(calls[9][2]).toEqual({ workspace: 'wiki-eng', from: '2026-09-30T00:00:00Z', to: '2026-10-31T00:00:00Z' });
    expect(calls[10][2]).toEqual({ workspace: 'wiki-eng', from: '2026-09-30T00:00:00Z', to: '2026-10-31T00:00:00Z', cursor: 'l2', size: 20 });
    expect(calls[11][1]).toBe('GET');
  });
});

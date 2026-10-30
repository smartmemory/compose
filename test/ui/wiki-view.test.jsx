/** COMPOSE-WIKI-TAB-1: the Wiki tab renders @wiki/components screens from a fake DataClient (no fetch). */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import WikiView from '../../src/components/cockpit/WikiView.jsx';
import { createWikiDataClient } from '../../src/lib/clients/wiki.js';
import { DEFAULT_MAIN_TABS } from '../../src/components/cockpit/viewTabsState.js';

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
  it('is a default tab', () => expect(DEFAULT_MAIN_TABS).toContain('wiki'));

  it.skipIf(!linked)('renders the feature hub, search and the full-wiki frame from the injected client without fetching', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('a component fetched'); });
    vi.stubGlobal('fetch', fetchSpy);
    const client = {
      identity: vi.fn(async () => { throw new Error('identity must not be needed: the tab passes its workspace'); }),
      featureHub: vi.fn(async () => ({ items: [doc], total: 1, next_cursor: null, generated_at: 't', feature })),
      decisions: vi.fn(async () => ({ items: [], total: 0, next_cursor: null, generated_at: 't' })),
      decisionsPage: vi.fn(async () => ({ items: [], total: 0, next_cursor: null, generated_at: 't' })),
      sourcesPage: vi.fn(async () => ({ items: [], total: 0, next_cursor: null, generated_at: 't' })),
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
      featureHub: vi.fn(), decisions: vi.fn(), search: vi.fn(), sourcesPage: vi.fn(),
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
      featureHub: vi.fn(), decisions: vi.fn(), decisionsPage: vi.fn(), search: vi.fn(),
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

describe('Compose wiki DataClient', () => {
  it('talks only to /api/wiki and rejects with the answer\'s code', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      calls.push([String(url), opts.method || 'GET', opts.body && JSON.parse(opts.body)]);
      if (String(url).endsWith('/decisions')) return { ok: false, status: 403, json: async () => ({ code: 'workspace_refused', message: 'no' }) };
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
    await expect(client.decisions({ workspace: 'wiki-private', featureId: 'X-1' })).rejects.toMatchObject({ code: 'workspace_refused', status: 403 });
    expect(calls.map(([u, m]) => `${m} ${u}`)).toEqual([
      'GET /api/wiki/identity', 'POST /api/wiki/query/feature_hub', 'POST /api/wiki/query/search',
      'POST /api/wiki/query/decisions_page', 'POST /api/wiki/query/decisions_page',
      'POST /api/wiki/query/sources_page', 'POST /api/wiki/query/sources_page', 'POST /api/wiki/query/decisions',
    ]);
    expect(calls[1][2]).toEqual({ workspace: 'wiki-eng', featureId: 'X-1' });
    expect(calls[3][2]).toEqual({ workspace: 'wiki-eng' });
    expect(calls[4][2]).toEqual({ workspace: 'wiki-eng', cursor: 'c2', size: 20 });
    expect(calls[5][2]).toEqual({ workspace: 'wiki-eng' });
    expect(calls[6][2]).toEqual({ workspace: 'wiki-eng', cursor: 's2', size: 20 });
  });
});

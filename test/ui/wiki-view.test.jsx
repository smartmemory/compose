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
    await expect(client.decisions({ workspace: 'wiki-private', featureId: 'X-1' })).rejects.toMatchObject({ code: 'workspace_refused', status: 403 });
    expect(calls.map(([u, m]) => `${m} ${u}`)).toEqual([
      'GET /api/wiki/identity', 'POST /api/wiki/query/feature_hub', 'POST /api/wiki/query/search', 'POST /api/wiki/query/decisions',
    ]);
    expect(calls[1][2]).toEqual({ workspace: 'wiki-eng', featureId: 'X-1' });
  });
});

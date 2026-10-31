/**
 * COMPOSE-DOCS-RETIRE-1: the Docs view is retired, the Library room is the wiki. Every way into
 * `docs` (deep link, stored view, settings default, visionUI command) lands on Library > Wiki.
 * The pure mapping rows run everywhere, the App-level rows need the linked wiki package.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import ViewTabs, { ViewSubTabs } from '../../src/components/cockpit/ViewTabs.jsx';
import {
  ROOMS, VIEW_KEYS, locateView, viewFromQuery, resolveStoredView, resolveDefaultView, migrateNavState,
} from '../../lib/view-keys.js';

const linked = typeof __WIKI_COMPONENTS__ !== 'undefined' && __WIKI_COMPONENTS__;
const ALL_YES = { ops: 'yes', stratum: 'yes', cadence: 'yes', wiki: 'yes' };
const WIKI = { view: 'wiki', fellBackFrom: null };

describe('retired docs key (pure mapping, one row table)', () => {
  it('rows', () => {
    const rows = [
      { entry: '?view=docs deep link', got: viewFromQuery('?view=docs'), want: 'wiki' },
      { entry: 'stored view=docs', got: resolveStoredView('docs', {}), want: WIKI },
      { entry: 'stored view=docs, wiki present', got: resolveStoredView('docs', { wiki: 'yes' }), want: WIKI },
      { entry: 'stored view=docs, wiki absent', got: resolveStoredView('docs', { wiki: 'no' }), want: { view: 'dashboard', fellBackFrom: 'wiki' } },
      { entry: 'settings defaultView=docs', got: resolveDefaultView('docs', VIEW_KEYS, {}), want: WIKI },
      { entry: 'compose:activeTab=docs', got: migrateNavState({ activeTabRaw: 'docs' }).view, want: 'wiki' },
      { entry: 'compose:activeView=docs', got: migrateNavState({ activeViewRaw: 'docs' }).view, want: 'wiki' },
      { entry: 'wiki sits in Library', got: locateView('wiki'), want: { top: 'library', sub: 'wiki' } },
      { entry: 'docs is not a view key', got: VIEW_KEYS.includes('docs'), want: false },
      { entry: 'docs is not a room view', got: ROOMS.some((r) => r.views.includes('docs')), want: false },
      { entry: 'docs has no highlight', got: locateView('docs'), want: null },
    ];
    for (const r of rows) expect(r.got, r.entry).toEqual(r.want);
  });
});

describe('Library sub-row has no Docs tab', () => {
  afterEach(cleanup);
  it('rows', () => {
    const rows = [
      { view: 'wiki', subs: ['wiki', 'journal'] },
      { view: 'journal', subs: ['wiki', 'journal'] },
    ];
    for (const r of rows) {
      cleanup();
      render(<ViewSubTabs activeView={r.view} availability={ALL_YES} onViewChange={() => {}} />);
      const ids = screen.getAllByRole('tab').map((t) => t.getAttribute('data-testid'));
      expect(ids, r.view).toEqual(r.subs.map((s) => `sub-tab-${s}`));
      expect(screen.queryByTestId('sub-tab-docs'), r.view).toBeNull();
    }
  });

  it('a retired activeView highlights no room and shows no sub-row', () => {
    render(<ViewTabs activeView="docs" availability={ALL_YES} onViewChange={() => {}} />);
    const selected = screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected).toEqual([]);
  });
});

function mockFetch() {
  global.fetch = vi.fn(async (url) => {
    if (String(url).includes('/api/wiki/available')) {
      return { ok: true, status: 200, json: async () => ({ available: true, workspace: 'wiki-eng', frameBase: 'http://127.0.0.1:1' }), text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  });
}

async function renderApp() {
  const { default: App } = await import('../../src/App.jsx');
  return render(<App />);
}

const selectedRooms = () => screen.getAllByRole('tab')
  .filter((t) => t.getAttribute('aria-selected') === 'true' && t.getAttribute('data-testid').startsWith('room-tab-'))
  .map((t) => t.getAttribute('data-testid'));

describe.skipIf(!linked)('App: every way into docs lands on Library > Wiki', () => {
  beforeEach(async () => {
    localStorage.clear();
    window.history.pushState({}, '', '/');
    const { useVisionStore } = await import('../../src/components/vision/useVisionStore.js');
    useVisionStore.setState({ items: [], uiCommand: null });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });

  async function expectLibraryWiki(label) {
    await waitFor(() => expect(selectedRooms(), label).toEqual(['room-tab-library']));
    const sub = await screen.findByTestId('sub-tab-wiki');
    expect(sub.getAttribute('aria-selected'), label).toBe('true');
    expect(screen.queryByTestId('sub-tab-docs'), label).toBeNull();
    expect(screen.queryByText(/View not found/i), label).toBeNull();
  }

  it('?view=docs, stored view=docs and a visionUI docs command (one row table)', async () => {
    const rows = [
      { entry: '?view=docs', setup: () => window.history.pushState({}, '', '/?view=docs') },
      { entry: 'stored compose:activeView=docs', setup: () => sessionStorage.setItem('compose:activeView', 'docs') },
    ];
    for (const r of rows) {
      cleanup(); localStorage.clear(); sessionStorage.clear(); window.history.pushState({}, '', '/');
      r.setup();
      mockFetch();
      await renderApp();
      await expectLibraryWiki(r.entry);
    }

    cleanup(); localStorage.clear(); sessionStorage.clear(); window.history.pushState({}, '', '/');
    mockFetch();
    await renderApp();
    await screen.findByTestId('home');
    const { useVisionStore } = await import('../../src/components/vision/useVisionStore.js');
    await act(async () => { useVisionStore.setState({ uiCommand: { view: 'docs' } }); });
    await expectLibraryWiki('visionUI docs command');
  }, 90000);
});

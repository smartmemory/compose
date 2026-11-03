/**
 * COMP-UI-LINKS-3: a doc request made before the Wiki workspace arrives opens when it does (and says so when the Wiki is unavailable);
 * roadmap file controls honor the same canNavigate('file') rule as EntityLink; every Wiki pane has a URL.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';
import { parseUrl, buildUrl, URL_PANES } from '../../lib/url-state.js';
import { ItemFiles, GateArtifact } from '../../src/components/vision/ItemDetailPanel.jsx';
import { NavigationContext } from '../../src/lib/navigation.jsx';
import WikiView, { PANE_KEYS } from '../../src/components/cockpit/WikiView.jsx';
import { resetPaneMemory } from '../../src/components/cockpit/PaneSwitcher.jsx';

const linked = typeof __WIKI_COMPONENTS__ !== 'undefined' && __WIKI_COMPONENTS__;
const FRAME = 'http://127.0.0.1:8791';
const DOC = 'docs/features/F-1/design.md';
const hubClient = () => ({
  graphAll: vi.fn(), graphPage: vi.fn(), note: vi.fn(), identity: vi.fn(), decisions: vi.fn(async () => ({ items: [], total: 0 })),
  decisionsPage: vi.fn(), sourcesPage: vi.fn(), docsByArea: vi.fn(), ledger: vi.fn(), upcomingCalls: vi.fn(), search: vi.fn(async () => ({ groups: [] })),
  featureHub: vi.fn(async () => ({
    items: [{ doc_id: 'd-design', source_id: 's', path: DOC, title: 'd-design', kind: 'design', feature_ids: ['F-1'], areas: [], mtime: '2026-10-31T00:00:00Z', text_mode: 'full' }],
    total: 1, next_cursor: null, generated_at: 't', feature: null,
  })),
});

beforeEach(() => resetPaneMemory());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('a doc requested before the workspace arrives', () => {
  it.skipIf(!linked)('is kept, and opens once the workspace is known', async () => {
    const client = hubClient();
    const req = { path: DOC };
    const { rerender } = render(<WikiView client={client} featureCode="F-1" workspace={null} frameBase={FRAME} availability="unknown" docOpen={req} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(client.featureHub).not.toHaveBeenCalled();
    expect(screen.queryByTitle('wiki')).toBeNull();
    expect(screen.queryByTestId('wiki-doc-unavailable')).toBeNull(); // still loading: not "unavailable"
    rerender(<WikiView client={client} featureCode="F-1" workspace="wiki-eng" frameBase={FRAME} availability="yes" docOpen={req} />);
    await waitFor(() => expect(screen.getByTitle('wiki').getAttribute('src')).toBe(`${FRAME}/ui/embed/w/wiki-eng/note?id=d-design&theme=light`));
  });
  it.skipIf(!linked)('is opened once: a later workspace change does not reopen it', async () => {
    const client = hubClient();
    const req = { path: DOC };
    const { rerender } = render(<WikiView client={client} featureCode="F-1" workspace="wiki-eng" frameBase={FRAME} availability="yes" docOpen={req} />);
    await waitFor(() => expect(screen.getByTitle('wiki')).toBeTruthy());
    const calls = client.featureHub.mock.calls.length;
    rerender(<WikiView client={client} featureCode="F-1" workspace="wiki-other" frameBase={FRAME} availability="yes" docOpen={req} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(client.featureHub.mock.calls.length).toBe(calls);
  });
  it.skipIf(!linked)('says so in the pane when the Wiki resolves to unavailable', async () => {
    const client = hubClient();
    render(<WikiView client={client} featureCode="F-1" workspace={null} frameBase={FRAME} availability="no" docOpen={{ path: DOC }} />);
    const note = await screen.findByTestId('wiki-doc-unavailable');
    expect(note.textContent).toContain(DOC);
    expect(note.textContent).toContain('not available');
    expect(client.featureHub).not.toHaveBeenCalled();
  });
});

describe('roadmap file controls follow canNavigate("file")', () => {
  const nav = (avail) => ({ openFile: vi.fn(), canNavigate: (kind) => (kind === 'file' ? avail !== 'no' : true) });
  it('availability no: the file is text with a reason, and no handler runs', () => {
    const n = nav('no');
    const onOpenFile = vi.fn();
    render(<NavigationContext.Provider value={n}><ItemFiles files={[DOC]} onOpenFile={onOpenFile} /></NavigationContext.Provider>);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    const text = screen.getByText('design.md');
    expect(text.getAttribute('title')).toContain('Wiki tab is not available');
    fireEvent.click(text);
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(n.openFile).not.toHaveBeenCalled();
  });
  it('availability yes, and no provider at all: a button that opens the path', () => {
    for (const wrap of [(c) => <NavigationContext.Provider value={nav('yes')}>{c}</NavigationContext.Provider>, (c) => c]) {
      const onOpenFile = vi.fn();
      const { unmount } = render(wrap(<ItemFiles files={[DOC]} onOpenFile={onOpenFile} />));
      fireEvent.click(screen.getByRole('button'));
      expect(onOpenFile).toHaveBeenCalledWith(DOC);
      unmount();
    }
  });
  it('a gate artifact degrades the same way', () => {
    render(<NavigationContext.Provider value={nav('no')}><GateArtifact name="design.md" featureCode="F-1" onOpenFile={vi.fn()} /></NavigationContext.Provider>);
    expect(screen.queryByTestId('gate-artifact-link')).toBeNull();
    expect(screen.getByText('design.md').getAttribute('title')).toContain('not available');
  });
});

describe('every Wiki pane has a URL', () => {
  it('the URL pane list is the pane switcher\'s list', () => expect(URL_PANES.wiki).toEqual(PANE_KEYS));
  it.each(PANE_KEYS)('buildUrl and parseUrl round-trip wiki pane %s', (pane) => {
    const url = buildUrl({ view: 'wiki', pane }, '');
    expect(url).toBe(`?view=wiki&pane=${pane}`);
    expect(parseUrl(url, '', null)).toEqual({ view: 'wiki', pane, ribbonHash: '' });
  });
  it('an unknown Wiki pane, and a pane of another view, are rejected', () => {
    expect(parseUrl('?view=wiki&pane=bogus', '', null).pane).toBeNull();
    expect(parseUrl('?view=wiki&pane=fleet', '', null).pane).toBeNull();
    expect(parseUrl('?view=sessions&pane=graph', '', null).pane).toBeNull();
    expect(buildUrl({ view: 'wiki', pane: 'bogus' }, '')).toBe('?view=wiki');
  });
  it.skipIf(!linked)('WikiView opens the URL pane, reports pane changes, and follows a changed URL pane (Back)', async () => {
    const onPaneChange = vi.fn();
    const { rerender } = render(<WikiView client={hubClient()} workspace="wiki-eng" frameBase={FRAME} availability="yes" urlPane="ledger" onPaneChange={onPaneChange} />);
    expect(screen.getByTestId('pane-ledger').getAttribute('aria-selected')).toBe('true');
    expect(onPaneChange).toHaveBeenLastCalledWith('ledger');
    fireEvent.click(screen.getByTestId('pane-decisions'));
    expect(onPaneChange).toHaveBeenLastCalledWith('decisions');
    rerender(<WikiView client={hubClient()} workspace="wiki-eng" frameBase={FRAME} availability="yes" urlPane="sources" onPaneChange={onPaneChange} />);
    await waitFor(() => expect(screen.getByTestId('pane-sources').getAttribute('aria-selected')).toBe('true'));
    expect(onPaneChange).toHaveBeenLastCalledWith('sources');
  });
});

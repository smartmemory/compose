/** WIKI-UI-LINKS-1: the Wiki tab's Document pane (the wiki's embed route, framed), feature routing, and the Feature pane's list and suggestions. */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, cleanup } from '@testing-library/react';
import WikiView, { documentSrc, targetOfPath, validTarget, WIKI_MESSAGE_SOURCE } from '../../src/components/cockpit/WikiView.jsx';
import { resetPaneMemory } from '../../src/components/cockpit/PaneSwitcher.jsx';
import { NavigationContext } from '../../src/lib/navigation.jsx';

const linked = typeof __WIKI_COMPONENTS__ !== 'undefined' && __WIKI_COMPONENTS__;
const FRAME = 'http://127.0.0.1:8791';
const doc = { doc_id: 'd1', source_id: 's', path: 'docs/a.md', title: 'Doc one', kind: 'design', feature_ids: ['F-1'], areas: [], mtime: '2026-10-30T00:00:00Z', text_mode: 'full', missing_reason: null };
const feat = (id, areas) => ({ feature_id: id, title: `${id} title`, roadmap_status: 'PLANNED', folder: 'f', owner: null, doc_count: 1, areas });
const page = (items) => ({ items, total: items.length, next_cursor: null, generated_at: 't' });
const client = (extra = {}) => ({
  identity: vi.fn(), graphAll: vi.fn(), graphPage: vi.fn(), note: vi.fn(),
  featureHub: vi.fn(async () => ({ ...page([doc]), feature: feat('F-2', []) })), decisions: vi.fn(async () => page([])),
  decisionsPage: vi.fn(async () => page([])), sourcesPage: vi.fn(async () => page([])), docsByArea: vi.fn(async () => page([])),
  ledger: vi.fn(), upcomingCalls: vi.fn(), search: vi.fn(async () => ({ groups: [], generated_at: 't' })),
  featuresPage: vi.fn(async () => page([feat('F-1', ['core', 'search']), feat('F-2', ['core'])])), ...extra,
});
const renderView = (c, props = {}, nav = null) => render(
  <NavigationContext.Provider value={nav}><WikiView client={c} workspace="wiki-eng" frameBase={FRAME} {...props} /></NavigationContext.Provider>,
);
const post = (frameWindow, data, origin = FRAME) => act(async () => { window.dispatchEvent(new MessageEvent('message', { data, origin, source: frameWindow })); });
const msg = (target) => ({ source: WIKI_MESSAGE_SOURCE, type: 'navigate', target });

beforeEach(() => resetPaneMemory());
afterEach(() => { cleanup(); document.documentElement.classList.remove('dark'); vi.unstubAllGlobals(); });

describe('Wiki tab helpers', () => {
  it('documentSrc: the embed route for the doc, theme from the parent', () => {
    expect(documentSrc(FRAME, { workspace: 'wiki-eng', docId: 'a b:c' }, 'dark')).toBe(`${FRAME}/ui/embed/w/wiki-eng/note?id=a+b%3Ac&theme=dark`);
  });
  it.each([
    ['/w/wiki-eng/note?id=d1', { kind: 'note', workspace: 'wiki-eng', docId: 'd1' }],
    ['/feature/F%201', { kind: 'feature', featureId: 'F 1' }],
    ['/area/core', { kind: 'area', area: 'core' }],
    ['/search?q=x', { kind: 'search', query: 'x' }],
    ['/graph?root=d1', null],
    ['/w/wiki-eng?source=s', null],
  ])('targetOfPath %s', (p, want) => expect(targetOfPath(p)).toEqual(want));
  it.each([
    [{ kind: 'note', workspace: 'w', docId: 'd' }, true], [{ kind: 'note', workspace: 'w' }, false], [{ kind: 'feature', featureId: 'F-1' }, true],
    [{ kind: 'features' }, true], [{ kind: 'source', workspace: 'w', source: 's' }, true], [{ kind: 'script', href: 'javascript:1' }, false],
    [null, false], [{ kind: 'area', area: 'x'.repeat(513) }, false],
  ])('validTarget %j -> %s', (t, ok) => expect(validTarget(t)).toBe(ok));
});

describe.skipIf(!linked)('Wiki tab: the Document pane', () => {
  it('with no doc picked shows a prompt and a link to the wiki app in a new tab', () => {
    renderView(client());
    fireEvent.click(screen.getByRole('tab', { name: 'Document' }));
    expect(screen.getByTestId('document-empty').textContent).toMatch(/Click a document/);
    const a = screen.getByRole('link', { name: 'Open the wiki app in a new tab' });
    expect(a.getAttribute('href')).toBe(`${FRAME}/ui/`);
    expect(a.getAttribute('target')).toBe('_blank');
    expect(screen.queryByTitle('wiki')).toBeNull();
  });

  it('frames the clicked doc with the theme from <html class="dark">', async () => {
    document.documentElement.classList.add('dark');
    renderView(client({ search: vi.fn(async () => ({ groups: [{ label: 'design', items: [{ doc_id: 'd1', title: 'Doc one', path: 'docs/a.md', snippet: 's', rank: 1 }], total: 1, next_cursor: null }], generated_at: 't' })) }), { featureCode: 'F-1' });
    fireEvent.click(screen.getByRole('tab', { name: 'Search' }));
    fireEvent.click(await screen.findByText('Doc one'));
    expect(screen.getByTitle('wiki').getAttribute('src')).toBe(`${FRAME}/ui/embed/w/wiki-eng/note?id=d1&theme=dark`);
  });

  it('routes a link posted by the frame, and refuses a wrong origin, a wrong window and a malformed target', async () => {
    const openFeature = vi.fn();
    renderView(client(), { featureCode: 'F-1', docOpen: undefined }, { canNavigate: (k, id) => k === 'feature' && id === 'F-9', openFeature });
    fireEvent.click(screen.getByRole('tab', { name: 'Document' }));
    expect(screen.queryByTitle('wiki')).toBeNull();
    // open a doc first so the frame exists: the Decisions-less path is a graph/search click; use a doc target through the frame's own message once framed
    fireEvent.click(screen.getByRole('tab', { name: 'Feature' }));
    const link = await screen.findByText('Doc one');
    fireEvent.click(link); // the hub's doc link: a note target -> Document pane
    const frame = screen.getByTitle('wiki');
    const w = frame.contentWindow;
    await post(w, msg({ kind: 'note', workspace: 'wiki-eng', docId: 'd2' }), 'http://evil.example');
    await post({}, msg({ kind: 'note', workspace: 'wiki-eng', docId: 'd2' }));
    await post(w, msg({ kind: 'note', workspace: 'wiki-eng' }));
    await post(w, { ...msg({ kind: 'note', workspace: 'wiki-eng', docId: 'd2' }), source: 'other' });
    expect(screen.getByTitle('wiki').getAttribute('src')).toContain('id=d1');
    await post(w, msg({ kind: 'note', workspace: 'wiki-eng', docId: 'd2' }));
    await waitFor(() => expect(screen.getByTitle('wiki').getAttribute('src')).toContain('id=d2'));
    await post(screen.getByTitle('wiki').contentWindow, msg({ kind: 'feature', featureId: 'F-9' }));
    expect(openFeature).toHaveBeenCalledWith('F-9');
  });
});

describe.skipIf(!linked)('Wiki tab: feature targets', () => {
  const hubWith = (ids) => client({ featureHub: vi.fn(async () => ({ ...page([{ ...doc, feature_ids: ids, areas: ['core'] }]), feature: feat('F-2', []) })) });

  it('open the Compose feature when the roadmap holds it, never the frame', async () => {
    const openFeature = vi.fn();
    renderView(hubWith(['F-9']), { featureCode: 'F-2' }, { canNavigate: (k, id) => k === 'feature' && id === 'F-9', openFeature });
    fireEvent.click(await screen.findByTestId('feature-chip'));
    expect(openFeature).toHaveBeenCalledWith('F-9');
    expect(screen.queryByTitle('wiki')).toBeNull();
  });

  it('a feature the roadmap lacks opens the wiki hub in the Feature pane, never the frame', async () => {
    const c = hubWith(['F-8']);
    renderView(c, { featureCode: 'F-2' }, { canNavigate: () => false, openFeature: vi.fn() });
    fireEvent.click(await screen.findByTestId('feature-chip'));
    await waitFor(() => expect(c.featureHub).toHaveBeenCalledWith({ workspace: 'wiki-eng', featureId: 'F-8' }));
    expect(screen.getByLabelText('Feature code').value).toBe('F-8');
    expect(screen.queryByTitle('wiki')).toBeNull();
  });

  it('the hub\'s "All features" crumb goes back to the list', async () => {
    renderView(client(), { featureCode: 'F-2' });
    fireEvent.click(await screen.findByTestId('all-features-link'));
    expect(await screen.findByRole('link', { name: 'F-1 title' })).toBeTruthy();
    expect(screen.getByLabelText('Feature code').value).toBe('');
  });
});

describe.skipIf(!linked)('Wiki tab: the Feature pane with no code', () => {
  it('lists the wiki features, and a row sets the code and opens its hub', async () => {
    const c = client();
    renderView(c);
    fireEvent.click(screen.getByRole('tab', { name: 'Feature' }));
    expect(await screen.findByRole('link', { name: 'F-2 title' })).toBeTruthy();
    expect(screen.queryByText(/Select a feature/)).toBeNull();
    expect(c.featuresPage).toHaveBeenCalledWith({ workspace: 'wiki-eng', size: 50 });
    fireEvent.click(screen.getByText('F-2'));
    await waitFor(() => expect(c.featureHub).toHaveBeenCalledWith({ workspace: 'wiki-eng', featureId: 'F-2' }));
    expect(screen.getByLabelText('Feature code').value).toBe('F-2');
  });

  it('says it cannot list, instead of looking empty, when the client has no featuresPage', async () => {
    const c = client(); delete c.featuresPage;
    renderView(c);
    fireEvent.click(screen.getByRole('tab', { name: 'Feature' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/cannot list features/);
  });

  it('offers feature codes and areas as suggestions from the same page', async () => {
    const { container } = renderView(client());
    await waitFor(() => expect([...container.querySelectorAll('#wiki-feature-codes option')].map((o) => o.value)).toEqual(['F-1', 'F-2']));
    expect(screen.getByLabelText('Feature code').getAttribute('list')).toBe('wiki-feature-codes');
    fireEvent.click(screen.getByRole('tab', { name: 'Area' }));
    expect([...container.querySelectorAll('#wiki-areas option')].map((o) => o.value)).toEqual(['core', 'search']);
    expect(screen.getByLabelText('Area').getAttribute('list')).toBe('wiki-areas');
  });

  it('warns once and offers none when the suggestions call fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = client({ featuresPage: vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'unavailable' }); }) });
    const { container } = renderView(c);
    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('no feature or area suggestions: unavailable')));
    expect(container.querySelectorAll('#wiki-feature-codes option')).toHaveLength(0);
    warn.mockRestore();
  });
});

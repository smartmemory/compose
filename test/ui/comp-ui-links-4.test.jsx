/**
 * COMP-UI-LINKS-4: a doc link that cannot open while the Wiki is unavailable says why from one place, the App's notify:
 * a refused row double-click, a request abandoned when the Wiki settles to `no`, and the Sessions pane not leaking in from a Wiki URL.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';
import { wikiUnavailableMessage } from '../../src/components/cockpit/WikiView.jsx';

const DOC = 'docs/features/F-1/design.md';
const ITEM = { id: 'i1', type: 'feature', title: 'Has docs', status: 'planned', files: [DOC] };
const MSG = wikiUnavailableMessage(DOC);

let settleWiki;
function mockFetch(wiki, { fleet = null } = {}) {
  global.fetch = vi.fn((url) => {
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
    if (String(url).includes('/api/wiki/available')) {
      if (wiki === 'pending') return new Promise((resolve) => { settleWiki = (body) => resolve(json(body)); });
      return Promise.resolve(json(wiki));
    }
    if (fleet && String(url).includes('/api/fleet')) return Promise.resolve(json(fleet));
    return Promise.resolve(json({}));
  });
}
async function renderApp(search) {
  window.history.pushState({}, '', `/${search}`);
  const { useVisionStore } = await import('../../src/components/vision/useVisionStore.js');
  useVisionStore.setState({ items: [ITEM], uiCommand: null });
  const { default: App } = await import('../../src/App.jsx');
  return render(<App />);
}
const FLEET = { generated: '2026-11-03T08:00:00Z', sources: { sm_status: { value: { sessions: { value: [{ name: 's1', busy: true }], error: null }, jobs: { value: [], error: null }, queue: { value: [], error: null } }, error: null, ts: 1, stale: false } } };
const row = (container) => container.querySelector('[data-item-id="i1"]');

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); localStorage.clear(); sessionStorage.clear(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });

describe('one message for the class', () => {
  it('names the document, or just the Wiki when there is none', () => {
    expect(wikiUnavailableMessage(DOC)).toBe(`The Wiki is not available here, so ${DOC} cannot be opened.`);
    expect(wikiUnavailableMessage(null)).toBe('The Wiki is not available here.');
  });
});

describe('App: a refused doc request says why', () => {
  it('M2: Wiki availability no, double-click a tree row with a doc shows the notice and does not navigate', async () => {
    mockFetch({ available: false });
    const { container } = await renderApp('?view=tree');
    await waitFor(() => expect(row(container)).toBeTruthy());
    await waitFor(() => expect(global.fetch.mock.calls.some((c) => String(c[0]).includes('/api/wiki/available'))).toBe(true));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    fireEvent.doubleClick(row(container));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(window.location.search).toContain('view=tree');
  }, 30000);

  it('M1: availability pending, double-click, then the check settles to no: ends on Day with the notice visible', async () => {
    mockFetch('pending');
    const { container } = await renderApp('?view=tree');
    await waitFor(() => expect(row(container)).toBeTruthy());
    await waitFor(() => expect(settleWiki).toBeTypeOf('function'));
    fireEvent.doubleClick(row(container));
    expect(screen.queryByText(MSG)).toBeNull(); // still being checked: not yet "unavailable"
    await act(async () => { settleWiki({ available: false }); });
    expect(await screen.findByTestId('day-view')).toBeTruthy();
    expect(await screen.findByText(MSG)).toBeTruthy();
  }, 30000);
});

describe('App: the Sessions pane follows its own view', () => {
  it('L1: ?view=wiki&pane=ledger, then Sessions: the Fleet body and pane=fleet in the URL', async () => {
    mockFetch({ available: true, workspace: 'wiki-eng', frameBase: 'http://127.0.0.1:1' }, { fleet: FLEET });
    await renderApp('?view=wiki&pane=ledger');
    await waitFor(() => expect(window.location.search).toContain('view=wiki'));
    const { useVisionStore } = await import('../../src/components/vision/useVisionStore.js');
    await act(async () => { useVisionStore.setState({ uiCommand: { view: 'sessions' } }); });
    await waitFor(() => expect(window.location.search).toContain('view=sessions'));
    expect(window.location.search).toContain('pane=fleet');
    expect(window.location.search).not.toContain('pane=ledger');
    expect((await screen.findByTestId('fleet-readers')).textContent).toMatch(/readers up: .*sm/i); // the Fleet body itself, not only the URL
  }, 30000);
});

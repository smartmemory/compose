/**
 * url-sync.test.jsx — COMP-COCKPIT-URL-SYNC-1: the URL follows the tab and pane.
 * Part 1 is one row table over the pure helpers. Part 2 mounts the shell and drives clicks, back and forward.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react';
import { parseUrl, buildUrl, sameUrlState } from '../../lib/url-state.js';
import { isRibbonHash, parseHash } from '../../src/components/ribbon/rangeLogic.js';

const H = '#ribbon.from=2026-10-30T18:00:00+08:00&to=2026-11-01T06:00:00+08:00';

describe('url-state helpers', () => {
  const rows = [
    { name: 'view only', search: '?view=process', hash: '', parsed: { view: 'process', pane: null, ribbonHash: '' } },
    { name: 'sessions pane', search: '?view=sessions&pane=sessions', hash: '', parsed: { view: 'sessions', pane: 'sessions', ribbonHash: '' } },
    { name: 'pane illegal for its view is dropped', search: '?view=process&pane=fleet', hash: '', parsed: { view: 'process', pane: null, ribbonHash: '' } },
    { name: 'retired key is canonicalised', search: '?view=docs', hash: '', parsed: { view: 'wiki', pane: null, ribbonHash: '' } },
    { name: 'unknown key names no view', search: '?view=bogus', hash: '', parsed: { view: null, pane: null, ribbonHash: '' } },
    { name: 'hash kept on Day', search: '?view=day', hash: H, parsed: { view: 'day', pane: null, ribbonHash: H } },
    { name: 'hash dropped off its owning view', search: '?view=process', hash: H, parsed: { view: 'process', pane: null, ribbonHash: '' } },
    { name: 'hash alone (no view) is kept for Day on load', search: '', hash: H, parsed: { view: null, pane: null, ribbonHash: H } },
  ];
  it.each(rows)('parse: $name', (r) => {
    expect(parseUrl(r.search, r.hash, isRibbonHash)).toEqual(r.parsed);
  });

  const builds = [
    { name: 'tab', state: { view: 'process' }, search: '', url: '?view=process' },
    { name: 'stale view replaced', state: { view: 'usage' }, search: '?view=process', url: '?view=usage' },
    { name: 'pane written on sessions', state: { view: 'sessions', pane: 'fleet' }, search: '', url: '?view=sessions&pane=fleet' },
    { name: 'pane removed when leaving sessions', state: { view: 'process', pane: 'fleet' }, search: '?view=sessions&pane=fleet', url: '?view=process' },
    { name: 'foreign params pass through', state: { view: 'usage' }, search: '?popout=1', url: '?popout=1&view=usage' },
    { name: 'hash written on Day', state: { view: 'day', ribbonHash: H }, search: '', url: `?view=day${H}` },
    { name: 'hash dropped off Day', state: { view: 'process', ribbonHash: H }, search: '?view=day', url: '?view=process' },
  ];
  it.each(builds)('build: $name', (r) => {
    expect(buildUrl(r.state, r.search)).toBe(r.url);
  });

  it('round trip: build then parse returns the state', () => {
    const s = { view: 'sessions', pane: 'sessions', ribbonHash: '' };
    expect(parseUrl(buildUrl(s, ''), '', isRibbonHash)).toEqual(s);
  });

  const noops = [
    { name: 'same view', search: '?view=process', state: { view: 'process' }, same: true },
    { name: 'different view', search: '?view=process', state: { view: 'usage' }, same: false },
    { name: 'pane ignored off sessions', search: '?view=process', state: { view: 'process', pane: 'fleet' }, same: true },
    { name: 'pane differs on sessions', search: '?view=sessions&pane=sessions', state: { view: 'sessions', pane: 'fleet' }, same: false },
    { name: 'no view in URL', search: '', state: { view: 'day' }, same: false },
  ];
  it.each(noops)('sameUrlState: $name', (r) => {
    expect(sameUrlState(r.search, r.state)).toBe(r.same);
  });
});

function mockFetch() {
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }));
}
async function renderApp() {
  const { default: App } = await import('../../src/App.jsx');
  return render(<App />);
}
const view = () => new URLSearchParams(window.location.search).get('view');
const goBack = async () => { await act(async () => { window.history.back(); await new Promise((r) => setTimeout(r, 50)); }); };
const goForward = async () => { await act(async () => { window.history.forward(); await new Promise((r) => setTimeout(r, 50)); }); };

describe('the shell writes and reads the URL', () => {
  beforeEach(() => {
    localStorage.clear(); sessionStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    window.history.replaceState(null, '', '/');
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('tab clicks push ?view=, back and forward restore it, and the ribbon hash lives on Day only', async () => {
    window.history.replaceState(null, '', `/?view=day${H}`);
    mockFetch();
    await renderApp();
    await screen.findByTestId('day-view');
    expect(view()).toBe('day');
    const start = window.history.length;

    fireEvent.click(screen.getByTestId('room-tab-fleet'));
    await waitFor(() => expect(view()).not.toBe('day'));
    const second = view();
    expect(window.location.hash).toBe('');
    expect(window.history.length).toBe(start + 1);

    fireEvent.click(screen.getByTestId('room-tab-library'));
    await waitFor(() => expect(view()).not.toBe(second));
    expect(window.history.length).toBe(start + 2);

    await goBack();
    await waitFor(() => expect(view()).toBe(second));
    await goBack();
    await waitFor(() => expect(view()).toBe('day'));
    expect(parseHash(window.location.hash)).toEqual(parseHash(H)); // the writer percent-encodes; the window is what must survive
    expect(await screen.findByTestId('day-view')).toBeTruthy();

    await goForward();
    await waitFor(() => expect(view()).toBe(second));
    expect(window.location.hash).toBe('');
  }, 30000);

  it('a pasted ?view=process URL opens Process with no ribbon hash', async () => {
    window.history.replaceState(null, '', `/?view=process${H}`);
    mockFetch();
    await renderApp();
    await waitFor(() => expect(screen.queryByTestId('day-view')).toBeNull());
    expect(view()).toBe('process');
    expect(window.location.hash).toBe('');
  }, 30000);

  it('a reload on the Sessions pane restores tab and pane', async () => {
    window.history.replaceState(null, '', '/?view=sessions&pane=sessions');
    mockFetch();
    await renderApp();
    await waitFor(() => expect(screen.queryByTestId('day-view')).toBeNull());
    expect(view()).toBe('sessions');
    expect(new URLSearchParams(window.location.search).get('pane')).toBe('sessions');
  }, 30000);
});

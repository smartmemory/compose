/**
 * COMP-AUDIT-17/18 slice 1: where the app lands (three-valued availability) and the labelled header.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react';

function mockFetch({ opsPages = null } = {}) {
  global.fetch = vi.fn(async (url) => {
    if (String(url).includes('/api/ops-status/index')) {
      if (opsPages === 'hang') return new Promise(() => {});
      return { ok: true, status: 200, json: async () => ({ pages: opsPages || [] }), text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  });
}

async function renderApp() {
  const { default: App } = await import('../../src/App.jsx');
  return render(<App />);
}

describe('App landing (COMP-AUDIT-17)', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());

  it('fresh storage lands on Home', async () => {
    mockFetch();
    await renderApp();
    expect(await screen.findByTestId('home')).toBeTruthy();
    expect(screen.queryByText(/View not found/i)).toBeNull();
  }, 30000);

  it('invalid stored key falls back to Home, never "View not found"', async () => {
    sessionStorage.setItem('compose:activeView', 'bogus');
    mockFetch();
    await renderApp();
    expect(await screen.findByTestId('home')).toBeTruthy();
    expect(screen.queryByText(/View not found/i)).toBeNull();
  }, 30000);

  it('stored ops while the check is unknown keeps Ops (its own state, not Home)', async () => {
    sessionStorage.setItem('compose:activeView', 'ops');
    mockFetch({ opsPages: 'hang' });
    await renderApp();
    await new Promise(r => setTimeout(r, 300));
    expect(screen.queryByTestId('home')).toBeNull();
    expect(screen.queryByText(/View not found/i)).toBeNull();
  }, 30000);

  it('stored ops once the check says no falls back to Home with one WARNING naming ops', async () => {
    sessionStorage.setItem('compose:activeView', 'ops');
    mockFetch({ opsPages: [] });
    await renderApp();
    expect(await screen.findByTestId('home')).toBeTruthy();
    const warns = console.warn.mock.calls.filter(c => String(c[0]).includes('ops'));
    expect(warns.length).toBe(1);
  }, 30000);

  it('stored ops with pages present stays on Ops', async () => {
    sessionStorage.setItem('compose:activeView', 'ops');
    mockFetch({ opsPages: ['status'] });
    await renderApp();
    await new Promise(r => setTimeout(r, 300));
    expect(screen.queryByTestId('home')).toBeNull();
  }, 30000);

  it('a hidden but valid key (gates) is kept', async () => {
    sessionStorage.setItem('compose:activeView', 'gates');
    mockFetch();
    await renderApp();
    await new Promise(r => setTimeout(r, 300));
    expect(screen.queryByTestId('home')).toBeNull();
    expect(screen.queryByText(/View not found/i)).toBeNull();
  }, 30000);

  it('landing by source: tab sessionStorage, shared localStorage, ?view=, settings defaultView (one row table)', async () => {
    const { useVisionStore } = await import('../../src/components/vision/useVisionStore.js');
    const rows = [
      { name: 'fresh tab, localStorage on ops (another tab): Home', local: 'ops', want: 'home' },
      { name: 'reload, sessionStorage on gates: stays on Gates', session: 'gates', want: 'gates' },
      { name: '?view=process wins over sessionStorage', session: 'gates', query: '?view=process', want: 'process' },
      { name: 'settings defaultView honored when nothing else', dv: 'graph', want: 'graph' },
      { name: 'invalid sessionStorage key: Home with the WARNING', session: 'bogus', want: 'home', warn: 'bogus' },
    ];
    for (const r of rows) {
      cleanup(); localStorage.clear(); sessionStorage.clear(); window.history.pushState({}, '', `/${r.query || ''}`);
      useVisionStore.setState({ settings: r.dv ? { ui: { defaultView: r.dv } } : {} });
      if (r.local) localStorage.setItem('compose:activeView', r.local);
      if (r.session) sessionStorage.setItem('compose:activeView', r.session);
      console.warn.mockClear();
      mockFetch();
      await renderApp();
      const landed = r.want === 'home' ? 'home' : `sub-tab-${r.want}`;
      const el = await screen.findByTestId(landed);
      if (r.want !== 'home') expect(el.getAttribute('aria-selected'), r.name).toBe('true');
      else expect(screen.queryByTestId('sub-tabs'), r.name).toBeNull();
      if (r.warn) expect(console.warn.mock.calls.filter(c => String(c[0]).includes(r.warn)).length, r.name).toBe(1);
    }
    useVisionStore.setState({ settings: {} });
    window.history.pushState({}, '', '/');
  }, 90000);

  it('Cmd+K first row is "Back to Fleet › Ops" when another tab left Ops open, and choosing it opens Ops', async () => {
    localStorage.setItem('compose:activeView', 'ops');
    mockFetch({ opsPages: ['status'] });
    await renderApp();
    await screen.findByTestId('home');
    expect(localStorage.getItem('compose:activeView')).toBe('ops'); // the fresh tab's mount did not overwrite it
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })); });
    const row = await screen.findByText('Back to Fleet › Ops');
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByTestId('sub-tab-ops').getAttribute('aria-selected')).toBe('true'));
  }, 30000);

  it('header is labelled: Run, New and Display menus', async () => {
    mockFetch();
    await renderApp();
    expect(await screen.findByTestId('new-menu-trigger')).toBeTruthy();
    expect(screen.getByTestId('display-menu-trigger')).toBeTruthy();
    expect(screen.getByText('Run')).toBeTruthy();
    expect(screen.getByText(/Launch/)).toBeTruthy();
  }, 30000);
});

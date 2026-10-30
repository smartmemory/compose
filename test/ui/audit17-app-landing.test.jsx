/**
 * COMP-AUDIT-17/18 slice 1: where the app lands (three-valued availability) and the labelled header.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

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
  beforeEach(() => { localStorage.clear(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());

  it('fresh storage lands on Home', async () => {
    mockFetch();
    await renderApp();
    expect(await screen.findByTestId('home')).toBeTruthy();
    expect(screen.queryByText(/View not found/i)).toBeNull();
  }, 30000);

  it('invalid stored key falls back to Home, never "View not found"', async () => {
    localStorage.setItem('compose:activeView', 'bogus');
    mockFetch();
    await renderApp();
    expect(await screen.findByTestId('home')).toBeTruthy();
    expect(screen.queryByText(/View not found/i)).toBeNull();
  }, 30000);

  it('stored ops while the check is unknown keeps Ops (its own state, not Home)', async () => {
    localStorage.setItem('compose:activeView', 'ops');
    mockFetch({ opsPages: 'hang' });
    await renderApp();
    await new Promise(r => setTimeout(r, 300));
    expect(screen.queryByTestId('home')).toBeNull();
    expect(screen.queryByText(/View not found/i)).toBeNull();
  }, 30000);

  it('stored ops once the check says no falls back to Home with one WARNING naming ops', async () => {
    localStorage.setItem('compose:activeView', 'ops');
    mockFetch({ opsPages: [] });
    await renderApp();
    expect(await screen.findByTestId('home')).toBeTruthy();
    const warns = console.warn.mock.calls.filter(c => String(c[0]).includes('ops'));
    expect(warns.length).toBe(1);
  }, 30000);

  it('stored ops with pages present stays on Ops', async () => {
    localStorage.setItem('compose:activeView', 'ops');
    mockFetch({ opsPages: ['status'] });
    await renderApp();
    await new Promise(r => setTimeout(r, 300));
    expect(screen.queryByTestId('home')).toBeNull();
  }, 30000);

  it('a hidden but valid key (gates) is kept', async () => {
    localStorage.setItem('compose:activeView', 'gates');
    mockFetch();
    await renderApp();
    await new Promise(r => setTimeout(r, 300));
    expect(screen.queryByTestId('home')).toBeNull();
    expect(screen.queryByText(/View not found/i)).toBeNull();
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

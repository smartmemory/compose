/**
 * tab-depth.test.jsx — COMP-COCKPIT-TAB-DEPTH-1: no room shows more than two tab rows above its content.
 * The walk renders the whole shell for every view `ROOMS` lists (reached through `locateView`), counts tab rows in the header,
 * the sub-rows and the main content, and skips the pane switcher (the allowed third level) and the item-detail panel (a side panel).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', async (orig) => ({ ...(await orig()), wsFetch: vi.fn() }));
import { wsFetch } from '../../src/lib/wsFetch.js';
import { ROOMS, locateView } from '../../lib/view-keys.js';
import { resetFleetProjects } from '../../src/lib/fleetProjects.js';
import { resetPaneMemory } from '../../src/components/cockpit/PaneSwitcher.jsx';

const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
function stubFetch() {
  wsFetch.mockImplementation(async (url) => {
    if (String(url).startsWith('/api/fleet/roots')) return ok({ roots: {} });
    if (String(url) === '/api/project') return ok({ name: 'compose', targetRoot: '/p/forge' });
    return ok({});
  });
  // The package-gated rooms (Ops, Stratum, Cadence, Wiki) show only once their availability probe says yes.
  global.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u === '/api/ops-status/index') return ok({ pages: ['lane-a', 'lane-b'] });
    if (u.endsWith('/available')) return ok({ available: true, workspace: 'wiki-eng', frameBase: 'http://127.0.0.1:4001' });
    return ok({});
  });
}

/** Tab rows: every tablist and every labelled nav, minus the breadcrumb, the pane switcher and anything inside a side panel. */
export function countTabRows(root) {
  return [...root.querySelectorAll('[role="tablist"], nav[aria-label]')].filter((el) => {
    if (el.getAttribute('aria-label') === 'Breadcrumb') return false;
    if (el.matches('[data-testid="pane-switcher"]')) return false;
    if (el.closest('[data-testid="pane-switcher-bar"], aside, [data-testid="context-panel"], [data-testid="item-detail"]')) return false;
    return true;
  }).length;
}

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); window.history.pushState({}, '', '/');
  wsFetch.mockReset(); resetFleetProjects(); resetPaneMemory();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });

describe('countTabRows (negative rows: the counter must fire on the old markup)', () => {
  it('counts the old Cadence nav as a third row and skips the pane switcher and breadcrumb', () => {
    const host = document.createElement('div');
    host.innerHTML = `
      <div role="tablist" aria-label="Rooms"></div>
      <div role="tablist" aria-label="Fleet views"></div>
      <nav aria-label="cadence"><button>Board</button></nav>
      <nav aria-label="Breadcrumb"></nav>
      <div data-testid="pane-switcher-bar"><div role="tablist" data-testid="pane-switcher"></div></div>`;
    expect(countTabRows(host)).toBe(3);
  });
  it('the old Ops tablist is a third row too', () => {
    const host = document.createElement('div');
    host.innerHTML = '<div role="tablist" aria-label="Rooms"></div><div role="tablist" aria-label="Fleet views"></div><div role="tablist" aria-label="Ops status pages"></div>';
    expect(countTabRows(host)).toBe(3);
  });
});

describe('every room, every view (the depth walk)', () => {
  it('shows at most two tab rows above the content', async () => {
    stubFetch(); // the vision store fetches on import
    const { default: App } = await import('../../src/App.jsx');
    const views = ROOMS.flatMap((r) => r.views).filter((v) => locateView(v));
    expect(views.length).toBeGreaterThanOrEqual(18);
    const seen = [];
    for (const view of views) {
      cleanup(); localStorage.clear(); sessionStorage.clear(); resetFleetProjects(); resetPaneMemory();
      window.history.pushState({}, '', `/?view=${view}`);
      stubFetch();
      const { container } = render(<App />);
      await waitFor(() => expect(screen.getAllByRole('tab').length).toBeGreaterThan(0));
      // Reached: a view that sits in a views row or switcher is the selected pane once its availability settles.
      const reached = locateView(view)?.sub ? view : null;
      if (reached) await waitFor(() => expect(document.querySelector(`[data-testid="sub-tab-${view}"][aria-selected="true"]`), view).not.toBeNull());
      seen.push([view, countTabRows(container)]);
    }
    expect(seen.filter(([, n]) => n > 2), JSON.stringify(seen)).toEqual([]);
  }, 240000);
});

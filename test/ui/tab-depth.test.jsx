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
const at = '2026-11-01T00:00:00Z';
const CADENCE_EMPTY = {
  belt: { generatedAt: at, units: [], lanes: [], errors: [] },
  seats: { generatedAt: at, seats: [], unassignedJobs: [], errors: [] },
  chains: { generatedAt: at, chains: [], errors: [] },
  attention: { generatedAt: at, asks: [], alerts: [], overdue: [], cadenceStatus: null, cadenceTs: null, errors: [] },
  live: { generatedAt: at, lanes: [], errors: [] },
  review: { generatedAt: at, reviewMaxH: 24, inReview: [], inReviewByLane: {}, ungrouped: { count: 0, oldestLanded: null }, errors: [] },
  outage: { state: 'ok' },
  diary: { generatedAt: at, entries: [], errors: [] },
  // COMP-UI-LINKS-1: the Fleet pane is built from Cadence parts, which read these too
  sessions: { generatedAt: at, scannedAt: null, counts: { busy: 0, idle: 0, unknown: 0 }, sessions: [], errors: [] },
  jobs: { generatedAt: at, capped: false, skipped: 0, counts: { alive: 0, stalled: 0, 'dead-open': 0, unknown: 0, done: 0 }, jobs: [], errors: [] },
  gates: { generatedAt: at, gates: [], engines: [], queue: { mode: null, waiting: [] }, lastLaunch: { label: null, ageS: null }, errors: [] },
  vitals: { generatedAt: at, scannedAt: null, disk: null, spend: null, today: null, ledger: null, errors: [] },
};
function stubFetch() {
  wsFetch.mockImplementation(async (url) => {
    if (String(url).startsWith('/api/fleet/roots')) return ok({ roots: {} });
    // One reader up, so Sessions shows its Fleet pane and therefore its switcher (review L1).
    if (String(url) === '/api/fleet') {
      const up = (value) => ({ value, error: null });
      return ok({ generated: at, sources: { sm_status: up({ queue: up([]), sessions: up([]), df: up({ free_gb: 500 }) }) } });
    }
    if (String(url) === '/api/project') return ok({ name: 'compose', targetRoot: '/p/forge' });
    // Valid empty bodies: `{}` crashes CadenceView and StratumView into their error boundary (review L1).
    if (/^\/api\/cadence-ui\/(belt|chains|seats|attention|live|review|outage|diary|sessions|jobs|gates|vitals)/.test(String(url))) return ok(CADENCE_EMPTY[String(url).split('/')[3].split('?')[0]]);
    if (String(url).startsWith('/api/stratum-ui/')) return ok([]);
    return ok({});
  });
  // The package-gated rooms (Ops, Stratum, Cadence, Wiki) show only once their availability probe says yes.
  global.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u === '/api/ops-status/index') return ok({ pages: ['lane-a', 'lane-b'] });
    if (u.startsWith('/api/decisions')) return ok({ rows: [], total: 0, next: null });
    if (u.endsWith('/available')) return ok({ available: true, workspace: 'wiki-eng', frameBase: 'http://127.0.0.1:4001' });
    return ok({});
  });
}

/** Tab rows: every tablist and every labelled nav, minus the breadcrumb, the pane switcher and anything inside a side panel. */
export function countTabRows(root) {
  return [...root.querySelectorAll('[role="tablist"], nav[aria-label]')].filter((el) => {
    if (el.getAttribute('aria-label') === 'Breadcrumb') return false;
    if (el.matches('[data-testid="pane-switcher"]')) return false;
    // @smartmemory/stratum-ui's Runs filter ("filter runs": All, Running, ...) is a package-owned segmented pill group, a filter and not navigation (found live 2026-10-31).
    if (el.matches('.sui-seg')) return false;
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
  it('a package segmented filter (.sui-seg) is not a row', () => {
    const host = document.createElement('div');
    host.innerHTML = '<div role="tablist" aria-label="Rooms"></div><div role="tablist" aria-label="Fleet views"></div><div class="sui-seg" role="tablist" aria-label="filter runs"></div>';
    expect(countTabRows(host)).toBe(2);
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
    // Views whose panes moved into the switcher: each must show one, so a crashed or hidden switcher cannot pass the count.
    const SWITCHED = ['cadence', 'stratum', 'sessions', 'ops', 'wiki', 'graph', 'tree', 'design', 'pipeline', 'pipeline-editor', 'build-history', 'gates', 'validate', 'qa-scope', 'decisions'];
    for (const view of views) {
      cleanup(); localStorage.clear(); sessionStorage.clear(); resetFleetProjects(); resetPaneMemory();
      window.history.pushState({}, '', `/?view=${view}`);
      stubFetch();
      const { container } = render(<App />);
      await waitFor(() => expect(screen.getAllByRole('tab').length).toBeGreaterThan(0));
      // Reached: a view that sits in a views row or switcher is the selected pane once its availability settles.
      const reached = locateView(view)?.sub ? view : null;
      if (reached) await waitFor(() => expect(document.querySelector(`[data-testid="sub-tab-${view}"][aria-selected="true"]`), view).not.toBeNull());
      if (SWITCHED.includes(view)) await waitFor(() => expect(container.querySelector('[data-testid="pane-switcher"]'), `${view} pane-switcher`).not.toBeNull(), { timeout: 5000 });
      expect(container.textContent, `${view} crashed`).not.toMatch(/panel crashed/);
      seen.push([view, countTabRows(container)]);
    }
    expect(seen.filter(([, n]) => n > 2), JSON.stringify(seen)).toEqual([]);
  }, 240000);
});

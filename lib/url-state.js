/**
 * url-state.js — the cockpit URL as a pure function of {view, pane, ribbonHash} (COMP-COCKPIT-URL-SYNC-1).
 *
 * The shell pushes `?view=<key>[&pane=<key>]` on every tab or pane change and reads the same two params back on load and
 * on `popstate`. The ribbon window lives in the hash and belongs to the Day view only: a URL for any other view carries no
 * hash. Other query params (anything the shell does not own) pass through untouched. Pure: no React, no `window`.
 */
import { canonicalView, isViewKey } from './view-keys.js';

/** The one view that owns the `#ribbon.` hash. */
export const RIBBON_VIEW = 'day';

/** Views whose pane is controlled by the shell and so named in the URL, with the legal pane keys. */
// COMP-UI-LINKS-3: the Wiki's eight panes are named too (WikiView.jsx PANES; test/url-state.test.js pins the two lists equal).
export const URL_PANES = {
  sessions: ['sessions', 'fleet'],
  wiki: ['search', 'graph', 'area', 'feature', 'decisions', 'sources', 'ledger', 'full'],
};

const hasPane = (view, pane) => Object.hasOwn(URL_PANES, view) && URL_PANES[view].includes(pane);

/**
 * Parse a location. `view` is null when the URL names no view; `pane` is null unless it is legal for that view;
 * `ribbonHash` is the hash kept verbatim only when `isRibbonHash(hash)` and the view is Day (or unnamed, Day on load).
 */
export function parseUrl(search, hash, isRibbonHash) {
  const params = new URLSearchParams(typeof search === 'string' ? search : '');
  const v = canonicalView(params.get('view'));
  const view = isViewKey(v) ? v : null;
  const pane = view && hasPane(view, params.get('pane')) ? params.get('pane') : null;
  const keep = typeof isRibbonHash === 'function' && isRibbonHash(hash) && (view === null || view === RIBBON_VIEW);
  return { view, pane, ribbonHash: keep ? hash : '' };
}

/** `?query#hash` for a state, starting from the current `search` so foreign params survive. */
export function buildUrl({ view, pane, ribbonHash }, search = '') {
  const params = new URLSearchParams(typeof search === 'string' ? search : '');
  params.set('view', view);
  if (hasPane(view, pane)) params.set('pane', pane); else params.delete('pane');
  const q = params.toString();
  return `${q ? `?${q}` : ''}${view === RIBBON_VIEW && ribbonHash ? ribbonHash : ''}`;
}

/** True when the location already names exactly this view and pane (the hash never counts: the ribbon writer owns it). */
export function sameUrlState(search, state) {
  const cur = parseUrl(search, '', null);
  return cur.view === state.view && cur.pane === (hasPane(state.view, state.pane) ? state.pane : null);
}

/**
 * view-keys.js — the one list of cockpit view keys (COMP-AUDIT-17).
 *
 * Shared by `server/settings-store.js` (which validates `ui.defaultView`), the
 * cockpit shell (`src/App.jsx`), the Settings picker and the tests. It lives in
 * `lib/` because the published package ships `lib/**` and not `src/**`.
 * Pure: no React, no Node-only APIs.
 *
 * Availability is three-valued: `unknown` (the check is still in flight),
 * `yes` or `no`. A decision made on load keeps every valid key and falls back
 * to Home only on `no`.
 */

/** The 20 leaf view keys; every `case` in the CockpitView switch is in this list. */
export const VIEW_KEYS = [
  'dashboard', 'graph', 'tree', 'docs', 'ideabox', 'ops', 'stratum', 'cadence', 'wiki', 'usage',
  'settings', 'gates', 'pipeline', 'pipeline-editor', 'sessions', 'build-history', 'validate',
  'qa-scope', 'journal', 'design',
];

/** The landing view: Home. */
export const DEFAULT_VIEW = 'dashboard';

/** Views that exist only when a package or served page set is present. */
export const PACKAGE_GATED_VIEWS = ['ops', 'stratum', 'cadence', 'wiki'];

export const VIEW_LABELS = {
  dashboard: 'Dashboard',
  graph: 'Graph',
  tree: 'Items',
  docs: 'Docs',
  ideabox: 'Ideabox',
  ops: 'Ops',
  stratum: 'Stratum',
  cadence: 'Cadence',
  wiki: 'Wiki',
  usage: 'Usage',
  settings: 'Settings',
  gates: 'Gates',
  pipeline: 'Pipeline',
  'pipeline-editor': 'Pipeline Editor',
  sessions: 'Sessions',
  'build-history': 'Builds',
  validate: 'Validate',
  'qa-scope': 'QA Scope',
  journal: 'Journal',
  design: 'Design',
};

export function isViewKey(key) {
  return typeof key === 'string' && VIEW_KEYS.includes(key);
}

function availabilityOf(availability, key) {
  if (!PACKAGE_GATED_VIEWS.includes(key)) return 'yes';
  const v = availability?.[key];
  return v === 'yes' || v === 'no' ? v : 'unknown';
}

/**
 * The view keys reachable by clicks in `tabs` (the visible tab list), minus
 * package-gated keys whose availability is `no`. `unknown` is kept: it may
 * still settle to `yes`.
 */
export function reachableViews(tabs, availability) {
  if (!Array.isArray(tabs)) return [];
  return tabs.filter((k) => isViewKey(k) && availabilityOf(availability, k) !== 'no');
}

/**
 * Decide the view for a stored key. Keeps any valid key; a package-gated key
 * falls back only when its availability is `no`. `fellBackFrom` names the
 * rejected key (the caller logs one WARNING) and is null when nothing was
 * rejected (fresh storage).
 * @returns {{view: string, fellBackFrom: string|null}}
 */
export function resolveStoredView(stored, availability) {
  if (stored == null || stored === '') return { view: DEFAULT_VIEW, fellBackFrom: null };
  if (!isViewKey(stored)) return { view: DEFAULT_VIEW, fellBackFrom: String(stored) };
  if (availabilityOf(availability, stored) === 'no') return { view: DEFAULT_VIEW, fellBackFrom: stored };
  return { view: stored, fellBackFrom: null };
}

/**
 * Decide the first-connect `defaultView`: it must be a valid key reachable by
 * clicks in `tabs`, and not a package-gated key that is `no`; else Home.
 * @returns {{view: string, fellBackFrom: string|null}}
 */
export function resolveDefaultView(defaultView, tabs, availability) {
  if (defaultView == null || defaultView === '') return { view: DEFAULT_VIEW, fellBackFrom: null };
  if (reachableViews(tabs, availability).includes(defaultView)) return { view: defaultView, fellBackFrom: null };
  return { view: DEFAULT_VIEW, fellBackFrom: String(defaultView) };
}

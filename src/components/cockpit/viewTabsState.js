/**
 * viewTabsState.js
 *
 * Pure logic for managing the cockpit's main-area view tabs.
 *
 * Tabs represent the major content surfaces (Dashboard, Graph, Docs, …).
 * These were previously the right-panel tabs; they now live in the
 * cockpit header via <ViewTabs> and drive what the main area renders.
 *
 * No React imports; fully testable in Node.js.
 */

// ---------------------------------------------------------------------------
// Default tab list (COMPOSE-UX-SIMPLIFY-2): five tabs, Dashboard first.
// The other views (tree, journal, design, gates, validate, qa-scope, pipeline,
// pipeline-editor, sessions, build-history) are hidden, not deleted: their
// renderView cases stay and in-app links (e.g. a gate card) still reach them.
// ---------------------------------------------------------------------------

export const DEFAULT_MAIN_TABS = ['dashboard', 'graph', 'docs', 'ideabox', 'ops', 'stratum', 'cadence', 'wiki', 'usage', 'settings'];

// Views that were tabs before COMPOSE-UX-SIMPLIFY-2. A persisted tab list from
// an older build is filtered against DEFAULT_MAIN_TABS so these drop out.
export const HIDDEN_VIEWS = [
  'tree', 'journal', 'design', 'gates', 'validate', 'qa-scope', 'pipeline',
  'pipeline-editor', 'sessions', 'build-history',
];

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * Returns true if `tab` is present in the given tabs array.
 */
export function isValidTab(tabs, tab) {
  if (!tab || !Array.isArray(tabs)) return false;
  return tabs.includes(tab);
}

/**
 * Returns the first tab in the array, or null if empty.
 */
export function getDefaultTab(tabs) {
  return tabs?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Mutations (all pure — return new arrays)
// ---------------------------------------------------------------------------

/**
 * Appends `tab` to the list.  No-op if the tab already exists.
 */
export function addTab(tabs, tab) {
  if (tabs.includes(tab)) return tabs;
  return [...tabs, tab];
}

/**
 * Removes `tab` from the list.
 * Refuses to remove the last remaining tab (minimum 1).
 * No-op if the tab is not found.
 */
export function removeTab(tabs, tab) {
  if (!tabs.includes(tab)) return tabs;
  if (tabs.length <= 1) return tabs;           // guard: keep at least one tab
  return tabs.filter(t => t !== tab);
}

/**
 * Moves the tab at `fromIndex` to `toIndex`.
 * Returns the original array if indices are invalid or equal.
 */
export function reorderTabs(tabs, fromIndex, toIndex) {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= tabs.length ||
    toIndex >= tabs.length
  ) {
    return tabs;
  }
  const result = [...tabs];
  const [moved] = result.splice(fromIndex, 1);
  result.splice(toIndex, 0, moved);
  return result;
}

// ---------------------------------------------------------------------------
// Persistence helpers (localStorage)
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'compose:mainTabs';
const ACTIVE_TAB_KEY = 'compose:activeTab';

/**
 * Loads persisted tab list, falling back to DEFAULT_MAIN_TABS.
 */
export function loadMainTabs() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return [...DEFAULT_MAIN_TABS];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length >= 1) {
      // Drop tabs hidden since COMPOSE-UX-SIMPLIFY-2 (and anything unknown),
      // then ensure new tabs added to DEFAULT_MAIN_TABS are present.
      let tabs = parsed.filter(t => DEFAULT_MAIN_TABS.includes(t));
      for (const tab of DEFAULT_MAIN_TABS) {
        if (!tabs.includes(tab)) {
          // Insert after 'docs' if possible, otherwise append
          const docsIdx = tabs.indexOf('docs');
          if (docsIdx >= 0) {
            tabs = [...tabs.slice(0, docsIdx + 1), tab, ...tabs.slice(docsIdx + 1)];
          } else {
            tabs = [...tabs, tab];
          }
        }
      }
      return tabs;
    }
  } catch {
    // ignore
  }
  return [...DEFAULT_MAIN_TABS];
}

/**
 * Persists the current tab list.
 */
export function saveMainTabs(tabs) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(tabs));
  } catch {
    // ignore
  }
}

/**
 * Loads the persisted active tab, falling back to the first tab in `tabs`.
 */
export function loadActiveTab(tabs) {
  try {
    const v = globalThis.localStorage?.getItem(ACTIVE_TAB_KEY);
    if (v && isValidTab(tabs, v)) return v;
  } catch {
    // ignore
  }
  return getDefaultTab(tabs);
}

/**
 * Persists the active tab.
 */
export function saveActiveTab(tab) {
  try {
    globalThis.localStorage?.setItem(ACTIVE_TAB_KEY, tab);
  } catch {
    // ignore
  }
}

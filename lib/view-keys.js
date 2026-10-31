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
  'dashboard', 'graph', 'tree', 'ideabox', 'ops', 'stratum', 'cadence', 'wiki', 'usage',
  'settings', 'gates', 'pipeline', 'pipeline-editor', 'sessions', 'build-history', 'validate',
  'qa-scope', 'journal', 'design',
  'process',
  'day',
];

/**
 * The landing view: Day (COMP-COCKPIT-RIBBON-TOP-1 supersedes RULE-DEFAULT-1's "else Home" fallback; Home is now
 * "Project home" behind the project chip and still opens through `?view=dashboard`).
 */
export const DEFAULT_VIEW = 'day';

/** Views that exist only when a package or served page set is present. */
export const PACKAGE_GATED_VIEWS = ['ops', 'stratum', 'cadence', 'wiki'];

export const VIEW_LABELS = {
  day: 'Day',
  dashboard: 'Dashboard',
  graph: 'Graph',
  tree: 'Items',
  ideabox: 'Ideabox',
  ops: 'Ops',
  stratum: 'Stratum',
  cadence: 'Cadence',
  wiki: 'Wiki',
  usage: 'Usage',
  process: 'Process',
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

/**
 * The view named by a location search string (`?view=<key>`), or null when absent or not a view key
 * (COMP-COCKPIT-13: the deep link the Process tab's pointer page carries). Pure; no storage read.
 */
export function viewFromQuery(search) {
  if (typeof search !== 'string' || search === '') return null;
  const v = canonicalView(new URLSearchParams(search).get('view'));
  return isViewKey(v) ? v : null;
}

/**
 * Retired view keys and the view that replaced them (COMPOSE-DOCS-RETIRE-1: the
 * Docs view is gone, the Library room is the wiki). A retired key is not a
 * view key; every entry point that accepts a key from outside the shell (a
 * `?view=` link, stored navigation, the settings default, a `visionUI` command)
 * maps it through `canonicalView` first.
 */
export const RETIRED_VIEW_ALIASES = { docs: 'wiki' };

/** The live key for `key`: a retired key's replacement, else `key` unchanged. */
export function canonicalView(key) {
  return typeof key === 'string' && Object.hasOwn(RETIRED_VIEW_ALIASES, key) ? RETIRED_VIEW_ALIASES[key] : key;
}

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
export function resolveStoredView(storedRaw, availability) {
  const stored = canonicalView(storedRaw);
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
export function resolveDefaultView(defaultViewRaw, tabs, availability) {
  const defaultView = canonicalView(defaultViewRaw);
  if (defaultView == null || defaultView === '') return { view: DEFAULT_VIEW, fellBackFrom: null };
  if (reachableViews(tabs, availability).includes(defaultView)) return { view: defaultView, fellBackFrom: null };
  return { view: DEFAULT_VIEW, fellBackFrom: String(defaultView) };
}

// ---------------------------------------------------------------------------
// Rooms (COMP-AUDIT-17 shape A, design §2.1). `activeView` stays the flat leaf
// key; rooms are derived from it by `locateView`, so every site that reads or
// sets a view key keeps working.
// ---------------------------------------------------------------------------

/**
 * The rooms, in order. COMP-COCKPIT-RIBBON-TOP-1 supersedes ROOM-ORDER-1's top-row order: Day is first, the five
 * `PROJECT_ROOMS` sit one step down behind the project chip, Fleet and Library stay top-level. A room with more than one
 * view shows a sub-row.
 */
export const ROOMS = [
  { key: 'day', label: 'Day', views: ['day'] },
  { key: 'home', label: 'Project home', views: ['dashboard'] },
  { key: 'ideas', label: 'Ideas', views: ['ideabox'] },
  { key: 'roadmap', label: 'Roadmap', views: ['graph', 'tree'] },
  { key: 'build', label: 'Build', views: ['design', 'pipeline', 'pipeline-editor', 'build-history'] },
  { key: 'review', label: 'Review', views: ['gates', 'validate', 'qa-scope'] },
  { key: 'fleet', label: 'Fleet', views: ['process', 'cadence', 'ops', 'stratum', 'sessions', 'usage'] },
  { key: 'library', label: 'Library', views: ['wiki', 'journal'] },
];

/** The Compose project rooms: reached through the Projects tab's sub-row, not the top row. One home; `src/lib/fleetProjects.js` re-exports it. */
export const PROJECT_ROOMS = ['home', 'ideas', 'roadmap', 'build', 'review'];

/** COMP-COCKPIT-PROJECTS-TAB-1: the top-row tab that holds the five project rooms (it is not a room itself). */
export const PROJECTS_KEY = 'projects';

/** The top row, in order: Day, Projects, Fleet, Library (then the gear). Day, Fleet and Library are `ROOMS` keys. */
export const TOP_TABS = ['day', PROJECTS_KEY, 'fleet', 'library'];

/**
 * True when `hash` is a `#ribbon.` window hash the ribbon would accept (it names Day on load; it never moves the view later).
 * The caller passes `parseHash` from `src/components/ribbon/rangeLogic.js`: this file ships in the package (`lib/**`) and the
 * server imports it, so it cannot import from `src/**`.
 */
export function hasRibbonHash(hash, parse) {
  return typeof parse === 'function' && parse(hash) != null;
}

/**
 * Esc from a project room's top level goes back to Day: the room's first view (or its only view). A sub-tab past the
 * first, a non-project room and Day itself return null (Esc keeps its other meanings there).
 */
export function escapeTarget(key) {
  const loc = locateView(key);
  if (!loc || loc.top !== PROJECTS_KEY) return null;
  const room = ROOMS.find((r) => r.key === loc.room);
  return room.views[0] === key ? 'day' : null;
}

/** The gear at the end of the top row opens Settings; it is not a room. */
export const GEAR_VIEW = 'settings';
export const GEAR_KEY = 'settings';

/** Sub-tab labels (a room's second row). */
export const SUB_LABELS = {
  graph: 'Graph',
  tree: 'List',
  gates: 'Gates',
  validate: 'Validate',
  'qa-scope': 'QA scope',
  design: 'Design',
  pipeline: 'Live build',
  'build-history': 'Builds',
  'pipeline-editor': 'Flow editor',
  cadence: 'Cadence',
  stratum: 'Stratum',
  ops: 'Ops',
  sessions: 'Sessions',
  usage: 'Usage',
  process: 'Process',
  wiki: 'Wiki',
  journal: 'Journal',
};

/** localStorage keys of the retired flat-tab navigation; removed on load. */
export const LEGACY_NAV_STORAGE_KEYS = ['compose:mainTabs', 'compose:activeTab'];

/**
 * The tabs to highlight for a view key: `{top, sub}`. `top` is a room key or
 * `settings` (the gear); `sub` is the key itself when the room shows a sub-row,
 * else null. Null for anything that is not a view key.
 * A project room's view sits under the Projects tab: `{top: 'projects', room, sub}` (COMP-COCKPIT-PROJECTS-TAB-1).
 */
export function locateView(key) {
  if (!isViewKey(key)) return null;
  if (key === GEAR_VIEW) return { top: GEAR_KEY, sub: null };
  const room = ROOMS.find((r) => r.views.includes(key));
  if (!room) return null;
  const sub = room.views.length > 1 ? key : null;
  return PROJECT_ROOMS.includes(room.key) ? { top: PROJECTS_KEY, room: room.key, sub } : { top: room.key, sub };
}

/**
 * The views a room shows. A package-gated view whose availability is `no` is
 * hidden; one still `unknown` is shown only while it is the active view (so a
 * stored view never vanishes under the user while its check is in flight).
 */
export function roomViews(roomKey, availability, activeView) {
  const room = ROOMS.find((r) => r.key === roomKey);
  if (!room) return [];
  return room.views.filter((k) => {
    const a = availabilityOf(availability, k);
    return a === 'yes' || (a === 'unknown' && k === activeView);
  });
}

/**
 * COMP-COCKPIT-RULE-DEFAULT-1: a room whose first view is not its useful one names the view it
 * opens on when nothing was used there yet (Fleet opens on Sessions, whose fleet pane is populated).
 */
export const ROOM_ENTRY = { fleet: 'sessions' };

/** The project rooms that show at least one view, in order: the Projects sub-row. */
export function projectRooms(availability, activeView) {
  return ROOMS.filter((r) => PROJECT_ROOMS.includes(r.key) && roomViews(r.key, availability, activeView).length > 0);
}

/**
 * The view a room opens on click: the last one used there if still shown, else its ROOM_ENTRY if shown, else the first shown.
 * `projects` re-opens the room `last` belongs to, else Project home.
 */
export function roomEntryView(roomKey, availability, last) {
  if (roomKey === PROJECTS_KEY) {
    const lastRoom = locateView(last);
    return lastRoom?.top === PROJECTS_KEY ? roomEntryView(lastRoom.room, availability, last) : roomEntryView('home', availability, null);
  }
  const shown = roomViews(roomKey, availability, last);
  if (last && shown.includes(last)) return last;
  const fresh = roomViews(roomKey, availability, null);
  const entry = ROOM_ENTRY[roomKey];
  if (entry && fresh.includes(entry)) return entry;
  return fresh[0] || DEFAULT_VIEW;
}

/** "Fleet › Ops": the room and sub-tab label of a view key, for the palette's "Back to" row. Null for a non-view. */
export function viewTrailLabel(key) {
  const loc = locateView(key);
  if (!loc) return null;
  const room = ROOMS.find((r) => r.key === (loc.room || loc.top));
  const top = room ? room.label : (VIEW_LABELS[key] || key);
  return loc.sub ? `${top} › ${SUB_LABELS[loc.sub] || loc.sub}` : top;
}

/**
 * Every stored navigation value, folded into one decision (design §2.7).
 * Precedence: `compose:activeView`, then the retired active-tab key, then the
 * settings `defaultView`, then Home. A key is rejected when it is not a view
 * key or its package/page availability is `no`; `unknown` is kept (the
 * cockpit re-checks once the answer settles). The retired tab list is ignored.
 * `items` null means "not loaded yet": a stored focus code is kept until it can be judged.
 * @returns {{view: string, focus: string|null, fellBackFrom: string|null, focusDropped: string|null}}
 */
export function migrateNavState({ activeViewRaw, activeTabRaw, tabsRaw, defaultView, focusRaw, items, available } = {}) {
  void tabsRaw; // the room order is fixed; nobody could reorder the old tabs
  let view = DEFAULT_VIEW;
  let fellBackFrom = null;
  for (const stored of [activeViewRaw, activeTabRaw, defaultView]) {
    const raw = canonicalView(stored);
    if (raw == null || raw === '') continue;
    if (isViewKey(raw) && availabilityOf(available, raw) !== 'no') { view = raw; break; }
    if (fellBackFrom == null) fellBackFrom = String(raw);
  }
  const storedFocus = typeof focusRaw === 'string' && focusRaw.trim() !== '' ? focusRaw.trim() : null;
  let focus = storedFocus;
  let focusDropped = null;
  if (storedFocus && Array.isArray(items) && items.length > 0
      && !items.some((i) => (i?.featureCode || i?.feature_code || i?.lifecycle?.featureCode) === storedFocus)) {
    focus = null;
    focusDropped = storedFocus;
  }
  return { view, focus, fellBackFrom: view === DEFAULT_VIEW ? fellBackFrom : null, focusDropped };
}

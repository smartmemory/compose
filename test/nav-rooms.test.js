/**
 * nav-rooms.test.js — COMP-AUDIT-17 slice 2: rooms, locateView, migrateNavState and the coverage test.
 * Keys are derived from VIEW_KEYS, never a literal count.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  VIEW_KEYS, PACKAGE_GATED_VIEWS, ROOMS, GEAR_VIEW, SUB_LABELS, DEFAULT_VIEW,
  locateView, roomViews, roomEntryView, migrateNavState, viewFromQuery, reachableViews,
} from '../lib/view-keys.js';

const ALL_YES = { ops: 'yes', stratum: 'yes', cadence: 'yes', wiki: 'yes' };

// Every key a user can see, given availability, by clicking: top rooms, the gear, then each shown sub-tab.
function clickable(availability) {
  const seen = new Set([GEAR_VIEW]);
  for (const room of ROOMS) for (const k of roomViews(room.key, availability, null)) seen.add(k);
  return seen;
}

describe('locateView (one row table)', () => {
  const rows = [
    ['dashboard', { top: 'home', sub: null }],
    ['graph', { top: 'roadmap', sub: 'graph' }],
    ['tree', { top: 'roadmap', sub: 'tree' }],
    ['ideabox', { top: 'ideas', sub: null }],
    ['gates', { top: 'review', sub: 'gates' }],
    ['validate', { top: 'review', sub: 'validate' }],
    ['qa-scope', { top: 'review', sub: 'qa-scope' }],
    ['design', { top: 'build', sub: 'design' }],
    ['pipeline', { top: 'build', sub: 'pipeline' }],
    ['build-history', { top: 'build', sub: 'build-history' }],
    ['pipeline-editor', { top: 'build', sub: 'pipeline-editor' }],
    ['cadence', { top: 'fleet', sub: 'cadence' }],
    ['stratum', { top: 'fleet', sub: 'stratum' }],
    ['ops', { top: 'fleet', sub: 'ops' }],
    ['sessions', { top: 'fleet', sub: 'sessions' }],
    ['usage', { top: 'fleet', sub: 'usage' }],
    ['process', { top: 'fleet', sub: 'process' }],
    ['docs', { top: 'library', sub: 'docs' }],
    ['wiki', { top: 'library', sub: 'wiki' }],
    ['journal', { top: 'library', sub: 'journal' }],
    ['settings', { top: 'settings', sub: null }],
    ['roadmap', null], ['', null], [undefined, null], ['<x>', null],
  ];
  test('rows', () => {
    for (const [k, want] of rows) assert.deepEqual(locateView(k), want, String(k));
  });
});

describe('roomViews + roomEntryView (one row table)', () => {
  test('availability hides a gated sub-tab on `no`, and on `unknown` unless active', () => {
    const rows = [
      { name: 'all yes', room: 'fleet', av: ALL_YES, active: null, want: ['process', 'cadence', 'ops', 'stratum', 'sessions', 'usage'] },
      { name: 'all unknown, none active', room: 'fleet', av: {}, active: null, want: ['process', 'sessions', 'usage'] },
      { name: 'unknown but active stays', room: 'fleet', av: {}, active: 'ops', want: ['process', 'ops', 'sessions', 'usage'] },
      { name: 'ops no', room: 'fleet', av: { ...ALL_YES, ops: 'no' }, active: null, want: ['process', 'cadence', 'stratum', 'sessions', 'usage'] },
      { name: 'wiki no', room: 'library', av: { ...ALL_YES, wiki: 'no' }, active: null, want: ['docs', 'journal'] },
      { name: 'review has no predicate', room: 'review', av: { ops: 'no' }, active: null, want: ['gates', 'validate', 'qa-scope'] },
      { name: 'unknown room', room: 'nope', av: {}, active: null, want: [] },
    ];
    for (const r of rows) assert.deepEqual(roomViews(r.room, r.av, r.active), r.want, r.name);
  });

  test('a room opens on the last view used there, else its first shown one', () => {
    const rows = [
      { room: 'fleet', av: ALL_YES, last: undefined, want: 'process' },
      { room: 'fleet', av: ALL_YES, last: 'usage', want: 'usage' },
      { room: 'fleet', av: { ...ALL_YES, stratum: 'no' }, last: 'stratum', want: 'process' },
      { room: 'fleet', av: {}, last: undefined, want: 'process' },
      { room: 'build', av: {}, last: undefined, want: 'design' },
      { room: 'home', av: {}, last: undefined, want: 'dashboard' },
      { room: 'roadmap', av: {}, last: 'tree', want: 'tree' },
      { room: 'review', av: {}, last: 'graph', want: 'gates' },
    ];
    for (const r of rows) assert.equal(roomEntryView(r.room, r.av, r.last), r.want, `${r.room}/${r.last}`);
  });
});

describe('migrateNavState (one row table, design §2.7)', () => {
  const rows = [
    { name: 'fresh storage', in: {}, view: 'dashboard', focus: null },
    { name: '1 tab list is ignored', in: { tabsRaw: '["tree","graph"]' }, view: 'dashboard', focus: null },
    { name: '2 active-tab key alone (hidden view gates)', in: { activeTabRaw: 'gates' }, view: 'gates', focus: null },
    { name: '2 active-tab key: garbage', in: { activeTabRaw: '<x>' }, view: 'dashboard', focus: null, from: '<x>' },
    { name: '3 activeView wins over the tab key', in: { activeViewRaw: 'docs', activeTabRaw: 'graph' }, view: 'docs', focus: null },
    { name: 'hidden key gates', in: { activeViewRaw: 'gates' }, view: 'gates', focus: null },
    { name: 'hidden key tree', in: { activeViewRaw: 'tree' }, view: 'tree', focus: null },
    { name: 'ops with no pages -> next source is Home', in: { activeViewRaw: 'ops', available: { ops: 'no' } }, view: 'dashboard', focus: null, from: 'ops' },
    { name: 'ops with no pages, tab key is usable', in: { activeViewRaw: 'ops', activeTabRaw: 'usage', available: { ops: 'no' } }, view: 'usage', focus: null },
    { name: 'stratum with the package absent', in: { activeViewRaw: 'stratum', available: { stratum: 'no' } }, view: 'dashboard', focus: null, from: 'stratum' },
    { name: 'Fleet sub-tab whose package is now absent', in: { activeViewRaw: 'cadence', available: { cadence: 'no' } }, view: 'dashboard', focus: null, from: 'cadence' },
    { name: 'unknown availability keeps a gated key', in: { activeViewRaw: 'wiki', available: {} }, view: 'wiki', focus: null },
    { name: 'usage', in: { activeViewRaw: 'usage' }, view: 'usage', focus: null },
    { name: 'process', in: { activeViewRaw: 'process' }, view: 'process', focus: null },
    { name: 'legacy roadmap value', in: { activeViewRaw: 'roadmap' }, view: 'dashboard', focus: null, from: 'roadmap' },
    { name: 'empty string', in: { activeViewRaw: '' }, view: 'dashboard', focus: null },
    { name: 'garbage', in: { activeViewRaw: '<script>' }, view: 'dashboard', focus: null, from: '<script>' },
    { name: '4 defaultView last', in: { defaultView: 'pipeline' }, view: 'pipeline', focus: null },
    { name: '4 defaultView unusable', in: { defaultView: 'roadmap' }, view: 'dashboard', focus: null, from: 'roadmap' },
    { name: '8 focus kept before items load', in: { focusRaw: 'FEAT-1', items: null }, view: 'dashboard', focus: 'FEAT-1' },
    { name: '8 focus resolves', in: { focusRaw: 'FEAT-1', items: [{ lifecycle: { featureCode: 'FEAT-1' } }] }, view: 'dashboard', focus: 'FEAT-1' },
    { name: '8 focus stale', in: { focusRaw: 'GONE-9', items: [{ featureCode: 'FEAT-1' }] }, view: 'dashboard', focus: null, dropped: 'GONE-9' },
    { name: '8 focus garbage', in: { focusRaw: '   ', items: null }, view: 'dashboard', focus: null },
    { name: '8 focus with an empty item list is not judged', in: { focusRaw: 'FEAT-1', items: [] }, view: 'dashboard', focus: 'FEAT-1' },
  ];
  test('rows, and the output view always renders a real view (never "View not found")', () => {
    for (const r of rows) {
      const got = migrateNavState(r.in);
      assert.equal(got.view, r.view, r.name);
      assert.equal(got.focus, r.focus, r.name);
      assert.equal(got.fellBackFrom, r.from ?? null, `${r.name} fellBackFrom`);
      assert.equal(got.focusDropped, r.dropped ?? null, `${r.name} focusDropped`);
      assert.ok(VIEW_KEYS.includes(got.view), `${r.name}: ${got.view} is a VIEW_KEYS entry`);
    }
  });
});

describe('coverage: every key has a click path (derived from VIEW_KEYS)', () => {
  test('(a) no feature focused, all packages available: every key is reachable', () => {
    const seen = clickable(ALL_YES);
    assert.deepEqual([...VIEW_KEYS].filter((k) => !seen.has(k)), []);
    assert.deepEqual([...seen].filter((k) => !VIEW_KEYS.includes(k)), []);
  });

  test('(b) each package absent drops its key and no other key', () => {
    for (const gated of PACKAGE_GATED_VIEWS) {
      const seen = clickable({ ...ALL_YES, [gated]: 'no' });
      assert.deepEqual([...VIEW_KEYS].filter((k) => !seen.has(k)), [gated], gated);
    }
    const none = clickable(Object.fromEntries(PACKAGE_GATED_VIEWS.map((k) => [k, 'no'])));
    assert.deepEqual([...VIEW_KEYS].filter((k) => !none.has(k)).sort(), [...PACKAGE_GATED_VIEWS].sort());
  });

  test('every key is in exactly one room or is the gear, and Fleet is never empty', () => {
    const owners = new Map();
    for (const room of ROOMS) for (const k of room.views) owners.set(k, (owners.get(k) || []).concat(room.key));
    for (const k of VIEW_KEYS) {
      if (k === GEAR_VIEW) assert.equal(owners.has(k), false);
      else assert.equal(owners.get(k)?.length, 1, k);
    }
    assert.ok(roomViews('fleet', {}, null).length >= 3);
  });

  test('(c) one row per navigation caller: the derived {top, sub} is the highlight', () => {
    const rows = [
      { caller: 'default view (settings)', key: 'pipeline', want: { top: 'build', sub: 'pipeline' } },
      { caller: 'visionUI view command', key: 'validate', want: { top: 'review', sub: 'validate' } },
      { caller: 'gate open (openGate)', key: 'gates', want: { top: 'review', sub: 'gates' } },
      { caller: 'EntityLink openView', key: 'build-history', want: { top: 'build', sub: 'build-history' } },
      { caller: 'View in graph', key: 'graph', want: { top: 'roadmap', sub: 'graph' } },
      { caller: 'View in tree', key: 'tree', want: { top: 'roadmap', sub: 'tree' } },
      { caller: 'open file (navigateToDocs)', key: 'docs', want: { top: 'library', sub: 'docs' } },
      { caller: 'docs back (previous view)', key: 'graph', want: { top: 'roadmap', sub: 'graph' } },
      { caller: 'sidebar Ideas row', key: 'ideabox', want: { top: 'ideas', sub: null } },
      { caller: 'GateToast', key: 'gates', want: { top: 'review', sub: 'gates' } },
      { caller: 'OpsStrip Fleet pill', key: 'sessions', want: { top: 'fleet', sub: 'sessions' } },
      { caller: 'OpsStrip "All"', key: 'dashboard', want: { top: 'home', sub: null } },
      { caller: 'room tab click (Fleet)', key: roomEntryView('fleet', ALL_YES), want: { top: 'fleet', sub: 'process' } },
      { caller: 'gear', key: 'settings', want: { top: 'settings', sub: null } },
      { caller: '?view=process deep link', key: viewFromQuery('?view=process'), want: { top: 'fleet', sub: 'process' } },
      { caller: '?view=design deep link', key: viewFromQuery('?view=design'), want: { top: 'build', sub: 'design' } },
    ];
    for (const r of rows) assert.deepEqual(locateView(r.key), r.want, r.caller);
  });

  test('every sub-tab key has a label and reachableViews over VIEW_KEYS keeps all but absent packages', () => {
    for (const room of ROOMS) if (room.views.length > 1) for (const k of room.views) assert.ok(SUB_LABELS[k], k);
    assert.deepEqual(reachableViews(VIEW_KEYS, {}), VIEW_KEYS);
    assert.equal(DEFAULT_VIEW, 'dashboard');
  });
});

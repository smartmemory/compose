/**
 * view-keys.test.js — COMP-AUDIT-17: the shared view list and the load-time
 * navigation decisions (three-valued availability: unknown | yes | no).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VIEW_KEYS, DEFAULT_VIEW, PACKAGE_GATED_VIEWS, VIEW_LABELS,
  reachableViews, resolveStoredView, resolveDefaultView,
} from '../lib/view-keys.js';
import { DEFAULT_MAIN_TABS } from '../src/components/cockpit/viewTabsState.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('VIEW_KEYS', () => {
  test('is the CockpitView switch, key for key, and every key has a label', () => {
    const src = fs.readFileSync(path.join(here, '../src/App.jsx'), 'utf-8');
    const switchBody = src.slice(src.indexOf('function CockpitView('), src.indexOf('function AppInner('));
    const cases = [...switchBody.matchAll(/case '([^']+)'/g)].map(m => m[1]);
    assert.deepEqual([...cases].sort(), [...VIEW_KEYS].sort());
    assert.deepEqual(Object.keys(VIEW_LABELS).sort(), [...VIEW_KEYS].sort());
    assert.equal(new Set(VIEW_KEYS).size, VIEW_KEYS.length);
    assert.equal(DEFAULT_VIEW, 'dashboard');
  });
});

describe('resolveStoredView (load: keep what is known on load)', () => {
  const rows = [
    { name: 'fresh storage', stored: null, avail: {}, view: 'dashboard', from: null },
    { name: 'empty string', stored: '', avail: {}, view: 'dashboard', from: null },
    { name: 'invalid key', stored: 'roadmap', avail: {}, view: 'dashboard', from: 'roadmap' },
    { name: 'garbage', stored: '<x>', avail: {}, view: 'dashboard', from: '<x>' },
    { name: 'plain key, no availability data', stored: 'graph', avail: {}, view: 'graph', from: null },
    { name: 'hidden key kept', stored: 'gates', avail: {}, view: 'gates', from: null },
    { name: 'unknown package key kept: ops', stored: 'ops', avail: {}, view: 'ops', from: null },
    { name: 'ops explicitly unknown', stored: 'ops', avail: { ops: 'unknown' }, view: 'ops', from: null },
    { name: 'stratum unknown', stored: 'stratum', avail: { stratum: 'unknown' }, view: 'stratum', from: null },
    { name: 'unknown then yes', stored: 'cadence', avail: { cadence: 'yes' }, view: 'cadence', from: null },
    { name: 'unknown then no: ops', stored: 'ops', avail: { ops: 'no' }, view: 'dashboard', from: 'ops' },
    { name: 'unknown then no: wiki', stored: 'wiki', avail: { wiki: 'no' }, view: 'dashboard', from: 'wiki' },
    { name: 'usage has no predicate', stored: 'usage', avail: { ops: 'no', wiki: 'no' }, view: 'usage', from: null },
    { name: 'other package absent does not matter', stored: 'graph', avail: { ops: 'no' }, view: 'graph', from: null },
  ];
  test('one row table', () => {
    for (const r of rows) {
      assert.deepEqual(resolveStoredView(r.stored, r.avail), { view: r.view, fellBackFrom: r.from }, r.name);
    }
  });
});

describe('reachableViews + resolveDefaultView', () => {
  test('reachable = visible tabs that are valid keys and not known-absent', () => {
    const rows = [
      { name: 'all unknown', tabs: DEFAULT_MAIN_TABS, avail: {}, expect: DEFAULT_MAIN_TABS },
      { name: 'ops and wiki absent', tabs: DEFAULT_MAIN_TABS, avail: { ops: 'no', wiki: 'no', stratum: 'yes' }, expect: DEFAULT_MAIN_TABS.filter(k => k !== 'ops' && k !== 'wiki') },
      { name: 'junk in the tab list is dropped', tabs: ['graph', 'bogus', null, 'docs'], avail: {}, expect: ['graph', 'docs'] },
      { name: 'not an array', tabs: null, avail: {}, expect: [] },
    ];
    for (const r of rows) assert.deepEqual(reachableViews(r.tabs, r.avail), r.expect, r.name);
  });

  test('defaultView lands only if reachable by clicks, else Home', () => {
    const tabs = DEFAULT_MAIN_TABS;
    const rows = [
      { name: 'none', dv: undefined, avail: {}, view: 'dashboard', from: null },
      { name: 'graph (a pick that stays)', dv: 'graph', avail: {}, view: 'graph', from: null },
      { name: 'visible tab', dv: 'docs', avail: {}, view: 'docs', from: null },
      { name: 'hidden view has no tab', dv: 'pipeline', avail: {}, view: 'dashboard', from: 'pipeline' },
      { name: 'invalid', dv: 'roadmap', avail: {}, view: 'dashboard', from: 'roadmap' },
      { name: 'package tab, still unknown', dv: 'stratum', avail: { stratum: 'unknown' }, view: 'stratum', from: null },
      { name: 'package tab, absent', dv: 'ops', avail: { ops: 'no' }, view: 'dashboard', from: 'ops' },
    ];
    for (const r of rows) assert.deepEqual(resolveDefaultView(r.dv, tabs, r.avail), { view: r.view, fellBackFrom: r.from }, r.name);
  });

  test('gated keys are all in VIEW_KEYS', () => {
    for (const k of PACKAGE_GATED_VIEWS) assert.ok(VIEW_KEYS.includes(k), k);
  });
});

describe('popoutView', () => {
  test('keys the popout renders stay; everything else is the Graph (one row table)', async () => {
    const { popoutView } = await import('../src/components/vision/popoutViews.js');
    const rows = [['graph', 'graph'], ['tree', 'tree'], ['gates', 'gates'], ['settings', 'settings'],
      ['dashboard', 'graph'], ['usage', 'graph'], ['roadmap', 'graph'], ['', 'graph'], [undefined, 'graph'], ['<x>', 'graph']];
    for (const [k, v] of rows) assert.equal(popoutView(k), v, String(k));
  });
});

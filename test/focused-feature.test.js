/**
 * focused-feature.test.js — COMP-AUDIT-17 §2.5: the focus reducer and resolveFeatureContext, one row table each.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  itemFeatureCode, featureCodeResolves, resolveFeatureContext, filterFeatureCode, focusReducer, parseStoredFocus,
} from '../src/components/cockpit/focusedFeature.js';

const A = { id: 'a', featureCode: 'FEAT-A' };
const B = { id: 'b', lifecycle: { featureCode: 'FEAT-B' } };
const C = { id: 'c', feature_code: 'FEAT-C' };
const NOCODE = { id: 'n', type: 'idea', title: 'FEAT-A in the title only' };

describe('itemFeatureCode', () => {
  test('order: featureCode, feature_code, lifecycle.featureCode; no title match', () => {
    const rows = [
      [{ featureCode: 'X', feature_code: 'Y', lifecycle: { featureCode: 'Z' } }, 'X'],
      [{ feature_code: 'Y', lifecycle: { featureCode: 'Z' } }, 'Y'],
      [{ lifecycle: { featureCode: 'Z' } }, 'Z'],
      [NOCODE, ''], [null, ''], [undefined, ''], [{ featureCode: 42 }, ''],
    ];
    for (const [item, want] of rows) assert.equal(itemFeatureCode(item), want);
  });
});

describe('focusReducer (one row table: action x prior state)', () => {
  const rows = [
    { name: 'Focus button sets', from: null, action: { type: 'focus', item: A }, to: 'FEAT-A' },
    { name: 'Focus on another feature replaces', from: 'FEAT-A', action: { type: 'focus', item: B }, to: 'FEAT-B' },
    { name: 'Focus on an item with no code: no change', from: 'FEAT-A', action: { type: 'focus', item: NOCODE }, to: 'FEAT-A' },
    { name: 're-click the same item (select): no change', from: 'FEAT-A', action: { type: 'select', id: 'a' }, to: 'FEAT-A' },
    { name: 'select a non-feature item: no change', from: 'FEAT-A', action: { type: 'select', id: 'n' }, to: 'FEAT-A' },
    { name: "select another feature's item: no change", from: 'FEAT-A', action: { type: 'select', id: 'b' }, to: 'FEAT-A' },
    { name: 'deselect: no change', from: 'FEAT-A', action: { type: 'deselect' }, to: 'FEAT-A' },
    { name: 'a session binds: no change', from: null, action: { type: 'sessionBind', code: 'FEAT-B' }, to: null },
    { name: 'x clears', from: 'FEAT-A', action: { type: 'clear' }, to: null },
    { name: 'project switch clears', from: 'FEAT-A', action: { type: 'projectSwitch' }, to: null },
    { name: 'reload with a resolving code: kept', from: 'FEAT-A', action: { type: 'reconcile', items: [A, B] }, to: 'FEAT-A' },
    { name: 'reload with a stale code: cleared', from: 'GONE-1', action: { type: 'reconcile', items: [A, B] }, to: null },
    { name: 'reconcile before items load: kept', from: 'FEAT-A', action: { type: 'reconcile', items: [] }, to: 'FEAT-A' },
    { name: 'unknown action: no change', from: 'FEAT-C', action: { type: 'whatever' }, to: 'FEAT-C' },
    { name: 'no action: no change', from: 'FEAT-C', action: undefined, to: 'FEAT-C' },
  ];
  test('rows', () => {
    for (const r of rows) assert.equal(focusReducer(r.from, r.action), r.to, r.name);
  });
});

describe('resolveFeatureContext + filterFeatureCode (one row table)', () => {
  const rows = [
    { name: 'nothing', in: {}, ctx: { code: null, source: null }, filter: null },
    { name: 'session binds with no focus: display only', in: { sessionState: { featureCode: 'FEAT-S' } }, ctx: { code: 'FEAT-S', source: 'session' }, filter: null },
    { name: 'focus alone filters', in: { focusedFeature: 'FEAT-A' }, ctx: { code: 'FEAT-A', source: 'focus' }, filter: 'FEAT-A' },
    { name: 'session binds with focus: focus wins', in: { focusedFeature: 'FEAT-A', sessionState: { featureCode: 'FEAT-S' } }, ctx: { code: 'FEAT-A', source: 'focus' }, filter: 'FEAT-A' },
    { name: 'empty session code', in: { sessionState: { featureCode: '' } }, ctx: { code: null, source: null }, filter: null },
    { name: 'no arguments', in: undefined, ctx: { code: null, source: null }, filter: null },
  ];
  test('rows', () => {
    for (const r of rows) {
      const ctx = resolveFeatureContext(r.in);
      assert.deepEqual(ctx, r.ctx, r.name);
      assert.equal(filterFeatureCode(ctx), r.filter, r.name);
    }
  });
});

describe('featureCodeResolves + parseStoredFocus', () => {
  test('rows', () => {
    assert.equal(featureCodeResolves([A, B, C], 'FEAT-C'), true);
    assert.equal(featureCodeResolves([A], 'FEAT-B'), false);
    assert.equal(featureCodeResolves([NOCODE], 'FEAT-A'), false);
    assert.equal(featureCodeResolves(null, 'FEAT-A'), false);
    assert.equal(featureCodeResolves([A], ''), false);
    for (const [raw, want] of [['FEAT-A', 'FEAT-A'], [' FEAT-A ', 'FEAT-A'], ['', null], ['  ', null], [null, null], [undefined, null], [7, null]]) {
      assert.equal(parseStoredFocus(raw), want, String(raw));
    }
  });
});

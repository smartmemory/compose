/**
 * subapp-host.test.js — COMP-SUBAPP-HOST-1: the host contract (contracts/subapp-host.schema.json) and the one place Compose
 * builds the host (src/components/cockpit/subappHost.js). Pure: no server, no network.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';

import { buildSubappHost, selectionOf, roomScope, scopeLabel, withoutSelection, roomSelection, opsLaneOf, createAttentionSink } from '../src/components/cockpit/subappHost.js';
import { attentionAdapter, reviewAdapter } from '../src/components/cockpit/notify/notifyLogic.js';

const schema = JSON.parse(readFileSync(new URL('../contracts/subapp-host.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
const validHost = ajv.compile(schema);
const validRow = ajv.getSchema(`${schema.$id}#/definitions/inboxRow`);

const item = { id: 'i1', lifecycle: { featureCode: 'COMP-TUI-4' } };

describe('subapp-host contract', () => {
  test('the host Compose builds validates, with and without a selection', () => {
    const sink = createAttentionSink();
    for (const args of [{ selectedItem: item, lane: 'forge' }, {}]) {
      const host = buildSubappHost({ ...args, attention: sink.publish });
      assert.equal(validHost(host), true, JSON.stringify(validHost.errors));
    }
  });

  test('refuses a workspace field (306b adds it), a token in auth, a data value as the sink, and an empty feature code', () => {
    const base = buildSubappHost({ selectedItem: item, attention: () => {} });
    const bad = [
      { ...base, workspace: 'w' },
      { ...base, auth: { ...base.auth, token: 't' } },
      { ...base, attention: 'publish' },
      { ...base, attention: { publish: true } },
      { ...base, selection: { featureCode: '' } },
      { selection: {}, auth: base.auth },
    ];
    for (const h of bad) assert.equal(validHost(h), false, JSON.stringify(h));
  });

  test('the inbox row definition matches what notifyLogic adapters really produce', () => {
    const rows = [
      ...attentionAdapter({ value: { alerts: [{ name: 'seat2 5h', state: 'tripped', value: 97, trip: 95 }] }, error: null }).rows,
      ...reviewAdapter({ value: { inRev: undefined, inReview: [{ id: 'g', lane: 'forge', overdue: true, rows: [1] }], reviewMaxH: 24 }, error: null }).rows,
    ];
    assert.equal(rows.length, 2);
    for (const r of rows) assert.equal(validRow(r), true, JSON.stringify(validRow.errors));
    assert.equal(validRow({ key: 'k', kind: 'x', severity: 'info', title: 't', sourceLabel: 's' }), false);
  });
});

describe('selection', () => {
  test('the selected item wins over the focused feature; a session code is never passed in', () => {
    assert.deepEqual(selectionOf({ selectedItem: item, focusedFeature: 'OTHER-1' }), { featureCode: 'COMP-TUI-4' });
    assert.deepEqual(selectionOf({ selectedItem: { id: 'x' }, focusedFeature: 'OTHER-1' }), { featureCode: 'OTHER-1' });
    assert.deepEqual(selectionOf({ lane: 'forge', unit: ' U-1 ' }), { lane: 'forge', unit: 'U-1' });
    assert.deepEqual(selectionOf({}), {});
  });

  test('auth carries the mode and says the credential is in the data client, never a token', () => {
    assert.deepEqual(buildSubappHost({ authMode: 'mobile-paired' }).auth, { mode: 'mobile-paired', credentials: 'data-client' });
    assert.deepEqual(buildSubappHost({ authMode: undefined }).auth, { mode: 'cockpit', credentials: 'data-client' });
  });

  test('each room scopes by its own fields, in order', () => {
    const sel = { featureCode: 'F-1', lane: 'ops', unit: 'U-1' };
    assert.deepEqual(roomScope(sel, 'stratum'), { key: 'featureCode', value: 'F-1' });
    assert.deepEqual(roomScope(sel, 'cadence'), { key: 'unit', value: 'U-1' });
    assert.deepEqual(roomScope({ lane: 'ops' }, 'cadence'), { key: 'lane', value: 'ops' });
    assert.deepEqual(roomScope({ featureCode: 'F-1', lane: 'ops' }, 'cadence'), { key: 'featureCode', value: 'F-1' });
    assert.equal(roomScope({ lane: 'ops' }, 'stratum'), null);
    assert.equal(scopeLabel(roomScope(sel, 'wiki')), 'filtered to F-1');
    assert.equal(scopeLabel({ key: 'lane', value: 'ops' }), 'filtered to lane ops');
    assert.deepEqual(withoutSelection({ selection: sel, auth: 1 }), { selection: {}, auth: 1 });
  });
});

describe('per-room selection (COMP-SUBAPP-HOST-1-FU-1)', () => {
  const sel = { featureCode: 'F-1', lane: 'ops', unit: 'U-1' };
  const model = { configured: true, projects: [{ id: 'forge' }], laneIndex: { forge: { project: 'forge', laneIds: ['compose', 'stratum'] }, choir: { project: 'choir', laneIds: ['choir'] }, main: { project: 'sm', laneIds: ['main'] } } };

  test('Cadence, Stratum and Wiki each get the featureCode (Cadence matches it against stamped features)', () => {
    assert.deepEqual(roomSelection(sel, 'cadence'), { unit: 'U-1', featureCode: 'F-1', lane: 'ops' });
    assert.deepEqual(roomSelection({ featureCode: 'F-1' }, 'cadence'), { featureCode: 'F-1' });
    assert.deepEqual(roomSelection(sel, 'stratum'), { featureCode: 'F-1' });
    assert.deepEqual(roomSelection(sel, 'wiki'), { featureCode: 'F-1' });
    assert.deepEqual(roomScope(roomSelection({ featureCode: 'F-1' }, 'cadence'), 'cadence'), { key: 'featureCode', value: 'F-1' });
  });

  test('a host lane maps to the ops lane through the project model; an unmapped lane gives none', () => {
    assert.equal(opsLaneOf(model, 'compose'), 'forge');
    assert.equal(opsLaneOf(model, 'ops:forge'), 'forge');
    assert.equal(opsLaneOf(model, 'choir'), 'choir');
    assert.equal(opsLaneOf(model, 'main'), 'main');
    assert.equal(opsLaneOf(model, 'nowhere'), null);
    assert.equal(opsLaneOf(model, undefined), null);
    assert.equal(opsLaneOf(null, 'main'), 'main');
    assert.equal(opsLaneOf({ configured: false }, 'main'), 'main');
  });

  test('two projects sharing a lane id: the focused project picks its own ops lane; no project keeps first-match and warns', () => {
    const shared = { configured: true, projects: [{ id: 'a' }, { id: 'b' }], laneIndex: { 'a-ops': { project: 'a', laneIds: ['main'] }, 'b-ops': { project: 'b', laneIds: ['main', 'extra'] } } };
    const warnings = [];
    const warn = (m) => warnings.push(m);
    assert.equal(opsLaneOf(shared, 'main', 'b', warn), 'b-ops');
    assert.equal(opsLaneOf(shared, 'main', 'a', warn), 'a-ops');
    assert.deepEqual(warnings, []);
    assert.equal(opsLaneOf(shared, 'main', null, warn), 'a-ops');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /"main" is owned by 2 projects \(a, b\)/);
    assert.equal(opsLaneOf(shared, 'main', 'c', warn), 'a-ops');
    assert.equal(warnings.length, 2);
    assert.equal(opsLaneOf(shared, 'extra', 'a', warn), 'b-ops');
    assert.equal(warnings.length, 2);
  });
});

describe('attention sink', () => {
  const row = (key) => ({ key, kind: 'gate', severity: 'warn', title: `gate ${key}`, detail: null, since: null, sourceLabel: 'stratum gates', action: 'stratum' });

  test('a publish replaces that source only; an empty list clears it; subscribers see every publish', () => {
    const sink = createAttentionSink({ warn: () => assert.fail('no warning expected') });
    const seen = [];
    const off = sink.subscribe((rows) => seen.push(rows.map((r) => r.key)));
    sink.publish('stratum', [row('a'), row('b')]);
    sink.publish('compose-gates', [row('c')]);
    sink.publish('stratum', [row('d')]);
    sink.publish('compose-gates', []);
    off();
    sink.publish('stratum', []);
    assert.deepEqual(seen, [['a', 'b'], ['a', 'b', 'c'], ['d', 'c'], ['d']]);
    assert.deepEqual(sink.read(), []);
  });

  test('a malformed row is dropped with one WARNING naming the source, never silently', () => {
    const warnings = [];
    const sink = createAttentionSink({ warn: (m) => warnings.push(m) });
    sink.publish('stratum', [row('a'), { key: 'b' }]);
    assert.deepEqual(sink.read().map((r) => r.key), ['a']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /stratum: 1 attention rows dropped/);
    sink.publish('', [row('x')]);
    assert.equal(warnings.length, 2);
  });
});

/**
 * notify-gate-sources.test.js — COMP-SUBAPP-ATTENTION-1 (row 307): Stratum's waiting gates and Compose's pending gates reach
 * the cockpit inbox through the host attention sink (subappHost.js), as typed rows ranked with Cadence's by `collect`.
 * Pure: fake clients and fake gates only, no server, no network; nothing here resolves, approves or dismisses a gate.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';

import { createAttentionSink } from '../src/components/cockpit/subappHost.js';
import {
  stratumGateRows, composeGateRows, mergeGateRows, publishComposeGates, pollStratumGates, startStratumGatePoller,
  STRATUM_LABEL, COMPOSE_LABEL,
} from '../src/components/cockpit/notify/gatePublishers.js';
import { collect, chipState, sinkAdapter, rowTarget, attentionList } from '../src/components/cockpit/notify/notifyLogic.js';

const schema = JSON.parse(readFileSync(new URL('../contracts/subapp-host.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.compile(schema);
const validRow = ajv.getSchema(`${schema.$id}#/definitions/inboxRow`);

const NOW = Date.parse('2026-11-03T20:00:00Z');
const ago = (s) => new Date(NOW - s * 1000).toISOString();
// A real PendingGate shape (stratum/ui/src/data-client.ts:150-175), token and all: the rows must never carry it.
const pg = (runId, stepId, extra = {}) => ({
  runId, flowName: 'build', stepId, gateToken: `tok-${runId}-${stepId}`, onApprove: 'next', onRevise: 'back', onKill: null,
  round: 0, maxRounds: 3, reviseEndsRun: false, waitingSince: ago(600), ...extra,
});
// A vision-store gate as created (server/vision-routes.js:986-1001).
const cg = (flowId, stepId, extra = {}) => ({
  id: `${flowId}:${stepId}:1`, flowId, stepId, round: 1, itemId: 'item-1', status: 'pending', createdAt: ago(120), ...extra,
});
const quiet = () => {};
const up = (value) => ({ value, error: null });
const CADENCE = up({ alerts: [{ name: 'seat2 5h', state: 'tripped', value: 97, trip: 95 }] });
// Every other source answered and empty, so `unknown` holds only what the sink says.
const FLEET = { sources: { sm_status: up({ queue: up([]), sessions: up([]), df: up({ free_gb: 500 }) }) } };
const ALL = { fleet: FLEET, outage: up({ state: 'ok' }), attention: up({ alerts: [] }), review: up({ reviewMaxH: 24, inReview: [] }) };

describe('mappers', () => {
  test('Stratum PendingGate -> typed rows that validate, keyed by run and step, aged from waitingSince, no token', () => {
    const { rows, dropped } = stratumGateRows([pg('run-a', 'review'), pg('run-b', 'ship', { waitingSince: null, round: 2 })], NOW);
    assert.equal(dropped, 0);
    for (const r of rows) assert.ok(validRow(r), JSON.stringify(validRow.errors));
    assert.deepEqual(rows.map((r) => [r.key, r.kind, r.severity, r.since, r.runId, r.stepId, r.action]), [
      ['stratum-gate:run-a:review', 'stratum-gate', 'warn', 600, 'run-a', 'review', 'stratum'],
      ['stratum-gate:run-b:ship', 'stratum-gate', 'warn', null, 'run-b', 'ship', 'stratum'],
    ]);
    assert.ok(rows.every((r) => !('gateToken' in r) && !JSON.stringify(r).includes('tok-')));
  });

  test('a PendingGate with no run or step id is counted as dropped, never keyed "undefined"', () => {
    const { rows, dropped } = stratumGateRows([pg('run-a', 'review'), { ...pg('x', 'y'), runId: '' }, { flowName: 'f' }], NOW);
    assert.deepEqual(rows.map((r) => r.key), ['stratum-gate:run-a:review']);
    assert.equal(dropped, 2);
  });

  test('Compose gates -> rows for the pending ones only (DashboardView rule), aged from createdAt else null, no token', () => {
    const gates = [
      cg('flow-1', 'design'),
      cg('flow-2', 'plan', { createdAt: undefined }),
      cg('flow-3', 'ship', { status: 'resolved', resolvedAt: ago(5) }),
    ];
    const rows = composeGateRows(gates, { items: [{ id: 'item-1', title: 'Gate sources' }], now: NOW });
    for (const r of rows) assert.ok(validRow(r), JSON.stringify(validRow.errors));
    assert.deepEqual(rows.map((r) => [r.key, r.kind, r.since, r.gateId, r.title]), [
      ['compose-gate:flow-1:design:1', 'compose-gate', 120, 'flow-1:design:1', 'Gate sources: design waiting'],
      ['compose-gate:flow-2:plan:1', 'compose-gate', null, 'flow-2:plan:1', 'Gate sources: plan waiting'],
    ]);
    assert.ok(rows.every((r) => !('gateToken' in r)));
  });
});

describe('one row per gate', () => {
  test('a Stratum gate matching a pending Compose gate (runId=flowId, stepId) leaves one row, the Compose one, marked as a Stratum flow gate', () => {
    const rows = [
      ...stratumGateRows([pg('flow-1', 'design'), pg('flow-9', 'qa')], NOW).rows,
      ...composeGateRows([cg('flow-1', 'design')], { now: NOW }),
    ];
    const merged = mergeGateRows(rows);
    assert.deepEqual(merged.map((r) => r.key), ['stratum-gate:flow-9:qa', 'compose-gate:flow-1:design:1']);
    const c = merged.find((r) => r.kind === 'compose-gate');
    assert.equal(c.stratumRunId, 'flow-1');
    assert.match(c.detail, /^Stratum flow gate/);
    // ...and through the sink and collect, the same: one row for the pair.
    const sink = createAttentionSink({ warn: quiet });
    sink.publish('stratum', stratumGateRows([pg('flow-1', 'design')], NOW).rows);
    publishComposeGates(sink, { gates: [cg('flow-1', 'design')], connected: true, now: NOW });
    assert.deepEqual(collect({ ...ALL, sink: sink.readState() }, NOW).rows.map((r) => r.key), ['compose-gate:flow-1:design:1']);
  });
});

describe('no silent degradation', () => {
  test('a rejecting listGates keeps the last good rows and names "stratum gates" unknown, never zero gates', async () => {
    const sink = createAttentionSink({ warn: quiet });
    const warnings = [];
    await pollStratumGates({ client: { listGates: async () => [pg('run-a', 'review')] }, sink, warn: (m) => warnings.push(m), now: () => NOW });
    assert.deepEqual(collect({ ...ALL, sink: sink.readState() }, NOW).unknown, []);
    await pollStratumGates({ client: { listGates: async () => { throw new Error('HTTP 502'); } }, sink, warn: (m) => warnings.push(m), now: () => NOW });
    const c = collect({ ...ALL, sink: sink.readState() }, NOW);
    assert.deepEqual(c.rows.map((r) => r.key), ['stratum-gate:run-a:review']);
    assert.deepEqual(c.unknown, [STRATUM_LABEL]);
    assert.notEqual(chipState(c).state, 'all-clear');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /HTTP 502/);
    // A non-list answer is the same lost source.
    await pollStratumGates({ client: { listGates: async () => ({ gates: [] }) }, sink, warn: (m) => warnings.push(m), now: () => NOW });
    assert.deepEqual(collect({ ...ALL, sink: sink.readState() }, NOW).unknown, [STRATUM_LABEL]);
    // The next good read clears the mark and replaces the rows.
    await pollStratumGates({ client: { listGates: async () => [] }, sink, warn: quiet, now: () => NOW });
    assert.deepEqual(collect({ ...ALL, sink: sink.readState() }, NOW), { rows: [], cleared: [], unknown: [], defaults: [] });
  });

  test('a rejecting first read (no rows yet) is "Alerts unknown", not "All clear"', async () => {
    const sink = createAttentionSink({ warn: quiet });
    await pollStratumGates({ client: { listGates: async () => { throw new Error('down'); } }, sink, warn: quiet, now: () => NOW });
    assert.equal(chipState(collect({ ...ALL, sink: sink.readState() }, NOW)).state, 'unknown');
  });

  test('a disconnected store keeps the last Compose rows and names "compose gates" unknown', () => {
    const sink = createAttentionSink({ warn: assert.fail });
    publishComposeGates(sink, { gates: [cg('flow-1', 'design')], connected: true, now: NOW });
    publishComposeGates(sink, { gates: [], connected: false, now: NOW });
    const c = collect({ ...ALL, sink: sink.readState() }, NOW);
    assert.deepEqual(c.rows.map((r) => r.key), ['compose-gate:flow-1:design:1']);
    assert.deepEqual(c.unknown, [COMPOSE_LABEL]);
    publishComposeGates(sink, { gates: [], connected: true, now: NOW });
    assert.deepEqual(collect({ ...ALL, sink: sink.readState() }, NOW).unknown, []);
  });

  test('Stratum absent: a never-started poller is no source at all, and stop() removes a started one (not unknown, not polled again)', async () => {
    const sink = createAttentionSink({ warn: quiet });
    publishComposeGates(sink, { gates: [], connected: true, now: NOW });
    assert.deepEqual(collect({ ...ALL, sink: sink.readState() }, NOW).unknown, []);
    let calls = 0;
    const doc = { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} };
    const client = { listGates: async () => { calls += 1; throw new Error('down'); } };
    const stop = startStratumGatePoller({ client, sink, intervalMs: 60_000, warn: quiet, doc });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls, 1);
    assert.deepEqual(sink.readState().unavailable, [STRATUM_LABEL]);
    stop();
    assert.deepEqual(sink.readState(), { rows: [], unavailable: [] });
    assert.deepEqual(collect({ ...ALL, sink: sink.readState() }, NOW).unknown, []);
  });

  test('a read in flight when the poller stops publishes nothing (the source stays gone)', async () => {
    const sink = createAttentionSink({ warn: quiet });
    let release;
    const client = { listGates: () => new Promise((r) => { release = r; }) };
    const doc = { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} };
    const stop = startStratumGatePoller({ client, sink, intervalMs: 60_000, warn: quiet, doc });
    stop();
    release([pg('run-a', 'review')]);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(sink.read(), []);
  });

  test('a hidden document polls nothing until it is shown (the cadence loop rule)', async () => {
    const sink = createAttentionSink({ warn: quiet });
    let calls = 0;
    const handlers = [];
    const doc = { visibilityState: 'hidden', addEventListener: (_e, fn) => handlers.push(fn), removeEventListener: () => {} };
    const stop = startStratumGatePoller({ client: { listGates: async () => { calls += 1; return []; } }, sink, intervalMs: 60_000, warn: quiet, doc });
    assert.equal(calls, 0);
    doc.visibilityState = 'visible';
    handlers.forEach((fn) => fn());
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls, 1);
    stop();
  });
});

describe('the sink keeps its old contract', () => {
  test('rows null with an unavailable label keeps the list; a list with the label replaces it; no label clears the mark', () => {
    const sink = createAttentionSink({ warn: assert.fail });
    const row = { key: 'k1', kind: 'stratum-gate', severity: 'warn', title: 't', sourceLabel: 'stratum gates' };
    sink.publish('stratum', [row]);
    const before = sink.readState();
    assert.equal(sink.readState(), before, 'stable object between publishes');
    sink.publish('stratum', null, { unavailable: 'stratum gates' });
    assert.deepEqual(sink.readState(), { rows: [row], unavailable: ['stratum gates'] });
    sink.publish('stratum', [], { unavailable: 'stratum gates' });
    assert.deepEqual(sink.readState(), { rows: [], unavailable: ['stratum gates'] });
    sink.publish('stratum', []);
    assert.deepEqual(sink.readState(), { rows: [], unavailable: [] });
  });

  test('a published row is re-aged from sinceAt at read time', () => {
    const sink = createAttentionSink({ warn: quiet });
    sink.publish('stratum', stratumGateRows([pg('run-a', 'review')], NOW).rows);
    assert.equal(sinkAdapter(sink.readState(), NOW + 3_600_000).rows[0].since, 600 + 3600);
    assert.deepEqual(sinkAdapter(undefined, NOW), { rows: [], unavailable: null });
  });
});

describe('into the inbox', () => {
  const mixed = () => {
    const sink = createAttentionSink({ warn: quiet });
    sink.publish('stratum', stratumGateRows([pg('run-a', 'review')], NOW).rows); // since 600
    publishComposeGates(sink, { gates: [cg('flow-1', 'design')], connected: true, now: NOW }); // since 120
    return sink;
  };

  test('Cadence attention, a Stratum gate and a Compose gate come out of collect in one ranked order', () => {
    const review = up({ reviewMaxH: 24, inReview: [{ id: 'g1', lane: 'forge', overdue: true, ageMs: 90_000_000, rows: [{}] }] });
    const c = collect({ ...ALL, attention: CADENCE, review, sink: mixed().readState() }, NOW);
    // critical first, then the older wait (larger since) first, then no age (Cadence attention, since null) last.
    assert.deepEqual(c.rows.map((r) => r.key), ['review:g1', 'stratum-gate:run-a:review', 'compose-gate:flow-1:design:1', 'attention:seat2 5h']);
    for (const r of c.rows) assert.ok(validRow(r), JSON.stringify(validRow.errors));
  });

  test('the owner count does not move with gate rows; the gate kinds are named, never counted', () => {
    const fleet = { sources: { sm_status: up({ queue: up([{ id: 'q1', by: 'ops-main', text: 'QUESTION: ship? (a) yes (b) no', age: 60 }]), sessions: up([]), df: up({ free_gb: 500 }) }) } };
    const without = chipState(collect({ ...ALL, fleet, attention: CADENCE }, NOW));
    const withGates = chipState(collect({ ...ALL, fleet, attention: CADENCE, sink: mixed().readState() }, NOW));
    assert.equal(without.count, 1);
    assert.equal(withGates.count, without.count);
    assert.deepEqual(withGates.others, ['gates', 'Cadence']); // rank order: the aged gate rows sort above the ageless Cadence row
    assert.deepEqual(without.others, ['Cadence']);
  });

  test('each row kind routes to its room: Stratum Gates pane at run+step, the Compose gate by id, Cadence', () => {
    const c = collect({ ...ALL, attention: CADENCE, sink: mixed().readState() }, NOW);
    const t = Object.fromEntries(c.rows.map((r) => [r.kind, rowTarget(r)]));
    assert.deepEqual(t['stratum-gate'], { to: 'room', room: 'stratum', focus: { kind: 'gates', runId: 'run-a', stepId: 'review' } });
    assert.deepEqual(t['compose-gate'], { to: 'gate', id: 'flow-1:design:1' });
    assert.deepEqual(t.attention, { to: 'view', view: 'cadence' });
  });

  test('the sidebar list is the tray\'s gate and Cadence rows in collect order, and names its unknown sources only', () => {
    const fleet = { sources: { sm_status: up({ queue: up([]), sessions: up([]), df: up({ free_gb: 1 }) }) } };
    const sink = mixed();
    sink.publish('stratum', null, { unavailable: STRATUM_LABEL });
    const c = collect({ ...ALL, fleet, fleetError: 'HTTP 500', attention: CADENCE, sink: sink.readState() }, NOW);
    const list = attentionList(c);
    assert.deepEqual(list.rows.map((r) => r.key), c.rows.filter((r) => r.kind !== 'disk').map((r) => r.key));
    assert.ok(c.rows.some((r) => r.kind === 'disk'), 'the disk row stays in the tray, out of the list');
    assert.deepEqual(list.unknown, [STRATUM_LABEL]);
  });
});

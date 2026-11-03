/**
 * notify-attention-fu2.test.js — COMP-SUBAPP-ATTENTION-FU-2: a dismissal names ONE gate instance (its source, its scope, its
 * round), and it is released only by an answer from that source for that scope, made after the dismissal. Pure: the real
 * sink, publishers and release rule over fake gates and a fake vision store; no server, no network.
 * The F1/F2 rows are the post-land review's repros (units/COMP-SUBAPP-ATTENTION-1/review-postland.md), written as real rows.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';

import { createAttentionSink } from '../src/components/cockpit/subappHost.js';
import {
  pollStratumGates, publishComposeGates, trackComposeGates, markStratumUnknown, gateKeyOf, composeGateKey, stratumGateRows,
  COMPOSE_SOURCE, COMPOSE_LABEL, STRATUM_SOURCE, STRATUM_LABEL,
} from '../src/components/cockpit/notify/gatePublishers.js';
import { checkUntilSettled } from '../src/components/cockpit/availabilityCheck.js';
import { collect, chipState } from '../src/components/cockpit/notify/notifyLogic.js';
import { releaseKeys } from '../src/components/cockpit/notify/notifyState.js';

const NOW = Date.parse('2026-11-03T20:00:00Z');
const ago = (s) => new Date(NOW - s * 1000).toISOString();
const pg = (runId, stepId, extra = {}) => ({
  runId, flowName: 'build', stepId, gateToken: `tok-${runId}-${stepId}`, onApprove: 'next', onRevise: 'back', onKill: null,
  round: 0, maxRounds: 3, reviseEndsRun: false, waitingSince: ago(600), ...extra,
});
const cg = (flowId, stepId, extra = {}) => ({
  id: `${flowId}:${stepId}:1`, flowId, stepId, round: 1, itemId: 'item-1', status: 'pending', createdAt: ago(120), ...extra,
});
const quiet = () => {};
const up = (value) => ({ value, error: null });
const FLEET = { sources: { sm_status: up({ queue: up([]), sessions: up([]), df: up({ free_gb: 500 }) }) } };
const ALL = { fleet: FLEET, outage: up({ state: 'ok' }), attention: up({ alerts: [] }), review: up({ reviewMaxH: 24, inReview: [] }) };
const dismissed = (...keys) => ({ v: 1, entries: Object.fromEntries(keys.map((k) => [k, { action: 'dismiss', at: ago(60) }])) });
const release = (sink, state) => releaseKeys(collect({ ...ALL, sink: sink.readState() }, NOW, state), state, null);
const sinkAt = () => createAttentionSink({ warn: quiet, now: () => NOW });

describe('the review repros', () => {
  test('F1: a revised Stratum gate whose next round no poll saw a gap before is an open row, and the old round is released', async () => {
    const sink = sinkAt();
    await pollStratumGates({ client: { listGates: async () => [pg('run-a', 'review', { round: 0 })] }, sink, warn: quiet, now: () => NOW });
    const k0 = sink.read()[0].key;
    const state = dismissed(k0);
    await pollStratumGates({ client: { listGates: async () => [pg('run-a', 'review', { round: 1 })] }, sink, warn: quiet, now: () => NOW });
    const c = collect({ ...ALL, sink: sink.readState() }, NOW, state);
    assert.equal(c.rows.length, 1, 'round 1 is a new gate instance: an open row');
    assert.deepEqual(release(sink, state), [k0], 'round 0 left the answer: its dismissal is released');
  });

  test('F2: a project switch never releases the dismissals of the project being left', () => {
    const sink = sinkAt();
    publishComposeGates(sink, { gates: [cg('flowA', 'design')], connected: true, scope: 'ws-a', now: NOW });
    const k = sink.read()[0].key;
    const state = dismissed(k);
    assert.deepEqual(release(sink, state), [], 'still pending and dismissed: kept');
    publishComposeGates(sink, { gates: [], connected: true, scope: 'ws-b', now: NOW }); // project B's store
    assert.deepEqual(release(sink, state), [], "project B's list is no answer for project A");
  });
});

// A zustand-shaped store over plain state: `set` notifies with (state, prev) like zustand's subscribe.
function fakeStore(initial = {}) {
  const init = { connected: false, gates: [], items: [], ...initial };
  let state = init;
  const subs = new Set();
  return {
    getState: () => state,
    getInitialState: () => init,
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
    set: (patch) => { const prev = state; state = { ...state, ...patch }; for (const fn of subs) fn(state, prev); },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('identity: a key names one gate instance', () => {
  test('Stratum keys carry the round; Compose keys carry the URI-encoded workspace; gateKeyOf reads both back, and old keys, without throwing', () => {
    const { rows } = stratumGateRows([pg('run-a', 'review'), pg('run-a', 'review', { round: 2 }), pg('run-b', 'x', { round: undefined })], NOW);
    assert.deepEqual(rows.map((r) => r.key), ['stratum-gate:run-a:review:0', 'stratum-gate:run-a:review:2', 'stratum-gate:run-b:x:0']);
    assert.equal(composeGateKey('ws:a b', 'f:s:1'), 'compose-gate:ws%3Aa%20b:f:s:1');
    assert.deepEqual(gateKeyOf('compose-gate:ws%3Aa%20b:f:s:1'), { source: COMPOSE_SOURCE, label: COMPOSE_LABEL, scope: 'ws:a b', legacy: false });
    assert.deepEqual(gateKeyOf('compose-gate:f:s:1'), { source: COMPOSE_SOURCE, label: COMPOSE_LABEL, scope: null, legacy: true });
    assert.deepEqual(gateKeyOf('compose-gate:%E0%A4%A:f:s:1'), { source: COMPOSE_SOURCE, label: COMPOSE_LABEL, scope: null, legacy: true }, 'a bad escape is legacy, not a throw');
    assert.deepEqual(gateKeyOf('stratum-gate:run-a:review'), { source: STRATUM_SOURCE, label: STRATUM_LABEL, scope: null, legacy: false });
    assert.equal(gateKeyOf('attention:seat2 5h'), null);
  });

  test('entries stored under the pre-FU-2 keys are released once, on the first answer of their source, and nothing throws', async () => {
    const sink = sinkAt();
    const state = dismissed('stratum-gate:run-a:review', 'compose-gate:flow-1:design:1', 'compose-gate:');
    await pollStratumGates({ client: { listGates: async () => [pg('run-a', 'review')] }, sink, warn: quiet, now: () => NOW });
    publishComposeGates(sink, { gates: [cg('flow-1', 'design')], connected: true, scope: 'ws-a', now: NOW });
    assert.deepEqual(release(sink, state).sort(), ['compose-gate:', 'compose-gate:flow-1:design:1', 'stratum-gate:run-a:review']);
  });
});

describe('answers are per (source, scope), after the dismissal', () => {
  test('an answer made before the dismissal releases nothing; the next answer without the key does', () => {
    let t = NOW - 120_000; // the answer predates the dismissal at NOW - 60 s
    const sink = createAttentionSink({ warn: quiet, now: () => t });
    publishComposeGates(sink, { gates: [], connected: true, scope: 'ws-a', now: NOW });
    const k = composeGateKey('ws-a', 'flow-9:qa:1'); // dismissed from another tab after this list was published
    assert.deepEqual(release(sink, dismissed(k)), []);
    t = NOW;
    publishComposeGates(sink, { gates: [], connected: true, scope: 'ws-a', now: NOW });
    assert.deepEqual(release(sink, dismissed(k)), [k]);
  });

  test('the same rule for both prefixes: unknown keeps, another scope keeps, the own scope releases', () => {
    const sink = sinkAt();
    const kc = composeGateKey('ws-a', 'flow-1:design:1');
    const ks = 'stratum-gate:run-a:review:0';
    publishComposeGates(sink, { gates: [], connected: true, scope: 'ws-a', now: NOW });
    sink.publish(STRATUM_SOURCE, []);
    assert.deepEqual(release(sink, dismissed(kc, ks)).sort(), [kc, ks].sort());
    sink.publish(STRATUM_SOURCE, null, { unavailable: STRATUM_LABEL });
    publishComposeGates(sink, { gates: [], connected: false, scope: 'ws-a', now: NOW });
    assert.deepEqual(release(sink, dismissed(kc, ks)), [], 'both unknown: kept');
    sink.publish(STRATUM_SOURCE, []);
    publishComposeGates(sink, { gates: [], connected: true, scope: 'ws-b', now: NOW });
    assert.deepEqual(release(sink, dismissed(kc, ks)), [ks], 'Compose answered for another project only');
  });

  test('a Compose publish with no workspace is unknown, never an answer', () => {
    const sink = sinkAt();
    publishComposeGates(sink, { gates: [], connected: true, now: NOW });
    assert.deepEqual(sink.readState().answered, []);
    assert.deepEqual(sink.readState().unavailable, [COMPOSE_LABEL]);
  });
});

describe('trackComposeGates: the store connection is the unit of scope', () => {
  const answeredScope = (sink) => sink.readState().answered.find((a) => a.source === COMPOSE_SOURCE)?.scope ?? null;

  test('a switch where the workspace read lands AFTER the new hydrate still scopes the hydrate to the new project', async () => {
    const store = fakeStore();
    const sink = sinkAt();
    let ws = 'ws-a';
    let pending = null;
    const readWorkspaceId = () => (pending ? new Promise((r) => { pending.resolve = r; }) : Promise.resolve(ws));
    const stop = trackComposeGates({ store, sink, readWorkspaceId, warn: assert.fail });
    assert.deepEqual(sink.readState().unavailable, [COMPOSE_LABEL], 'not connected: unknown from the start');
    store.set({ connected: true });
    store.set({ gates: [cg('flowA', 'design')] });
    await tick();
    assert.equal(answeredScope(sink), 'ws-a');
    const k = sink.read()[0].key;
    // Switch: the socket closes, reopens on project B and hydrates BEFORE the workspace read answers.
    store.set({ connected: false });
    pending = {};
    store.set({ connected: true });
    store.set({ gates: [] });
    await tick();
    assert.deepEqual(sink.readState().unavailable, [COMPOSE_LABEL], 'workspace not read yet: unknown');
    assert.deepEqual(release(sink, dismissed(k)), []);
    pending.resolve('ws-b');
    await tick();
    assert.equal(answeredScope(sink), 'ws-b');
    assert.deepEqual(release(sink, dismissed(k)), [], "B's empty list never releases A's dismissal");
    stop();
    assert.deepEqual(sink.readState(), { rows: [], unavailable: [], answered: [] }, 'stop() retires the source');
  });

  test('a store already open and hydrated when the tracker starts answers once the workspace is read; one still on its initial list does not', async () => {
    const hydratedStore = fakeStore({ connected: true });
    hydratedStore.set({ gates: [] }); // a new list: the hydrate
    const sink = sinkAt();
    trackComposeGates({ store: hydratedStore, sink, readWorkspaceId: async () => 'ws-a', warn: assert.fail });
    await tick();
    assert.equal(answeredScope(sink), 'ws-a');
    const fresh = fakeStore({ connected: true });
    const sink2 = sinkAt();
    trackComposeGates({ store: fresh, sink: sink2, readWorkspaceId: async () => 'ws-a', warn: assert.fail });
    await tick();
    assert.equal(answeredScope(sink2), null);
    assert.deepEqual(sink2.readState().unavailable, [COMPOSE_LABEL]);
  });

  test('a workspace read that fails keeps the source unknown with one WARNING; the next connection reads again', async () => {
    const store = fakeStore();
    const sink = sinkAt();
    const warnings = [];
    let fail = true;
    trackComposeGates({ store, sink, readWorkspaceId: async () => { if (fail) throw new Error('HTTP 502'); return 'ws-a'; }, warn: (m) => warnings.push(m) });
    store.set({ connected: true });
    store.set({ gates: [] });
    await tick();
    assert.deepEqual(sink.readState().unavailable, [COMPOSE_LABEL]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /compose gates: the workspace is unreadable \(HTTP 502\)/);
    fail = false;
    store.set({ connected: false });
    store.set({ connected: true });
    store.set({ gates: [] });
    await tick();
    assert.equal(answeredScope(sink), 'ws-a');
  });
});

describe('expected but silent is unknown', () => {
  test('F3 at the sink: a built Stratum marked unknown reads "Alerts unknown"; its cleanup retires the mark', () => {
    const sink = sinkAt();
    publishComposeGates(sink, { gates: [], connected: true, scope: 'ws-a', now: NOW });
    assert.equal(chipState(collect({ ...ALL, sink: sink.readState() }, NOW)).state, 'all-clear');
    const undo = markStratumUnknown(sink);
    assert.equal(chipState(collect({ ...ALL, sink: sink.readState() }, NOW)).state, 'unknown');
    undo();
    assert.deepEqual(sink.readState().unavailable, []);
    assert.equal(sink.readState().answered.some((a) => a.source === STRATUM_SOURCE), false);
  });

  test('checkUntilSettled rechecks every recheckMs while unknown, logs the failure once, and stops on cancel or a settled answer', async () => {
    const timers = [];
    const warnings = [];
    const answers = [new Error('ECONNREFUSED'), new Error('ECONNREFUSED'), new Error('ECONNREFUSED'), new Error('ECONNREFUSED'), { ok: true, json: async () => ({ available: true }) }];
    let calls = 0;
    const fetchFn = async () => { const a = answers[calls++]; if (a instanceof Error) throw a; return a; };
    const settled = [];
    checkUntilSettled({
      name: 'stratum', url: '/x', decide: (j) => (j?.available ? 'yes' : 'no'), fetchFn, wait: async () => {}, recheckMs: 30_000,
      warn: (m) => warnings.push(m), onSettled: (s) => settled.push(s), setTimer: (fn, ms) => { timers.push(ms); setTimeout(fn, 0); }, clearTimer: () => {},
    });
    for (let i = 0; i < 5; i += 1) await tick();
    assert.deepEqual(settled, ['yes']);
    assert.deepEqual(timers, [30_000, 30_000], 'each check is two attempts: two unknown rounds, two rechecks, then yes');
    assert.equal(calls, 5);
    assert.equal(warnings.length, 2, 'the first failure and the recheck notice, nothing per recheck');
    assert.match(warnings[1], /stratum availability unknown; rechecking every 30 s/);
    let n = 0;
    const cancel = checkUntilSettled({ name: 's', url: '/x', decide: () => 'yes', fetchFn: async () => { n += 1; throw new Error('down'); }, wait: async () => {}, recheckMs: 30_000, warn: quiet, onSettled: assert.fail, setTimer: (fn) => setTimeout(fn, 0), clearTimer: () => {} });
    await tick();
    cancel();
    for (let i = 0; i < 3; i += 1) await tick();
    assert.ok(n <= 2, `cancel stops the loop (${n} reads)`);
  });
});

describe('contract', () => {
  test('every sink answer validates against subapp-host 1.2.0 #/definitions/sinkAnswer, and a gate row key against inboxRow', async () => {
    const schema = JSON.parse(readFileSync(new URL('../contracts/subapp-host.schema.json', import.meta.url), 'utf8'));
    assert.equal(schema.version, '1.2.0');
    const ajv = new Ajv({ strict: false, allErrors: true });
    ajv.compile(schema);
    const validAnswer = ajv.getSchema(`${schema.$id}#/definitions/sinkAnswer`);
    const validRow = ajv.getSchema(`${schema.$id}#/definitions/inboxRow`);
    const sink = sinkAt();
    await pollStratumGates({ client: { listGates: async () => [pg('run-a', 'review')] }, sink, warn: quiet, now: () => NOW });
    publishComposeGates(sink, { gates: [cg('flow-1', 'design')], connected: true, scope: 'ws-a', now: NOW });
    assert.deepEqual(sink.readState().answered, [{ source: STRATUM_SOURCE, scope: null, at: NOW }, { source: COMPOSE_SOURCE, scope: 'ws-a', at: NOW }]);
    for (const a of sink.readState().answered) assert.ok(validAnswer(a), JSON.stringify(validAnswer.errors));
    for (const r of sink.read()) assert.ok(validRow(r), JSON.stringify(validRow.errors));
  });
});

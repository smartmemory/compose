/**
 * ribbon-owner-identity-fu1.test.js — COMP-DAYVIEW-OWNER-IDENTITY-FU-1: a lane blocked on the owner never reads "working",
 * and the lane drawer's EXPECTED LANDING answers "now" by the ribbon's own rule (`laneState`).
 *
 * F1 (review of 0877beff): a stamp whose ask is drawn on another lane left its own lane reading "working". The lane rule: a
 * `laneGuess` ask is drawn on its stamp's unit lane (`laneRule: 'stamp-lane'`); a named ask stays on its lane and the stamp's
 * lane mirrors it (`laneRule: 'asked-elsewhere'`), with no second marker and no second count.
 * F2: `expectedLanding` reads `laneState`, so the drawer says "on answer" whenever the ribbon says the cause is the owner.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRibbon } from '../lib/ribbon-feed.js';
import { attachRibbonRoutes } from '../server/ribbon-routes.js';
import { laneState, ownerWaitsAtNow, withOwnerOpen } from '../src/components/ribbon/ribbonLayout.js';
import { expectedLanding } from '../src/components/ribbon/lane/laneLogic.js';
import { ownerAsks } from '../src/components/cockpit/notify/notifyLogic.js';

const D = (s) => Date.parse(`2026-10-31T${s}:00Z`);
const T = (s) => `2026-10-31T${s}:00.000Z`;
const NOW = D('12:00');
const owner = (s) => s.kind === 'wait' && s.cause === 'owner';
const events = (o = {}) => ({ owner_waits: [], reviews: [], fix_runs: [], gates: [], deploys: [], fixes: [], ready_at: null, dispatched_at: null, author_done_at: null, landed_at: null, account: null, ...o });
const unit = (id, lane, ev) => ({ id, lane, title: `Title ${id}`, titleSource: 'stamp', state: ev.landed_at ? 'landed' : 'authoring', landedAt: ev.landed_at, deployedAt: null, events: events(ev) });

async function route(over) {
  let handler = null;
  attachRibbonRoutes({ get: (_p, h) => { handler = h; }, locals: {} }, { deps: {
    now: () => NOW, warn: () => {}, info: () => {}, dataDir: () => '/nonexistent/ribbon-owner-identity-fu1-test',
    loadSnapshots: async () => [], loadGateLog: async () => [], loadSeats: async () => ({ seats: [] }),
    ledger: { get: async () => ({ value: [] }), rows: () => [] }, loadOutage: async () => ({ state: 'ok', since: null }),
    eta: async () => ({ p50: '2h', p80: '3h', asOf: 'a', raw: 'r' }), ...over,
  } });
  return new Promise((resolve, reject) => {
    const res = { set() {}, status() { return this; }, json: resolve };
    handler({ query: { from: T('00:00'), to: T('23:00') }, socket: { localPort: 1 } }, res).catch(reject);
  });
}
const units = async () => ({ units: [
  unit('U8', 'main', { ready_at: T('07:50'), dispatched_at: T('08:00'), author_done_at: T('08:50'), owner_waits: [{ start: T('09:00'), end: null, qid: 'A' }] }),
  unit('U9', 'ops', { ready_at: T('07:50'), dispatched_at: T('08:00') }),
  unit('U7', 'web', { ready_at: T('07:50'), dispatched_at: T('08:00') }),
], coverage: {}, asOf: new Date(NOW).toISOString() });
const lane = (b, n) => b.lanes.find((l) => l.lane === n);
const st = (b, n) => laneState(lane(b, n), b.now, b.now);
const markers = (b) => b.lanes.filter((l) => { const x = laneState(l, b.now, b.now); return x?.cause === 'owner' && !x.askedOn; }).map((l) => l.lane);
const ask = (extra) => ({ id: 'A', status: 'open', by: 'main-main', ts: D('09:00') / 1000, text: 'ASK: ship it?', ...extra });

describe('F1 at the route: a stamp whose ask sits on another lane never reads "working"', () => {
  it('review repro, queue lane is a laneGuess (no lane, no unit, asker names no lane): the ask is drawn on main, the stamp\'s lane', async () => {
    const body = await route({ loadUnits: units, loadOwnerQueue: async () => [ask({ by: 'someone-else' })] });
    assert.equal(st(body, 'main').phrase, 'waiting on you 3h');
    assert.equal(st(body, 'ops')?.kind, 'working', 'ops is not blocked: it holds no ask');
    assert.deepEqual(lane(body, 'main').spans.filter(owner).map((s) => [s.queueId, s.laneRule, s.laneGuess]), [['A', 'stamp-lane', false]]);
    assert.deepEqual(lane(body, 'ops').spans.filter(owner), []);
    assert.deepEqual(markers(body), ['main'], 'exactly one Needs-you marker');
    assert.deepEqual(ownerWaitsAtNow(body.lanes, body.now, body.now), [{ lane: 'main', queueId: 'A' }]);
    assert.deepEqual(body.owner.open.map((o) => [o.id, o.lane]), [['A', 'main']]);
    assert.equal(ownerAsks(body.owner.open, null, NOW).rows.length, 1, 'headline count is 1');
  });
  it('queue lane is named (web): the marker and the count stay on web, main reads "waiting on you 3h (asked on web)", no second marker', async () => {
    const body = await route({ loadUnits: units, loadOwnerQueue: async () => [ask({ lane: 'web' })] });
    assert.equal(st(body, 'main').phrase, 'waiting on you 3h (asked on web)');
    assert.equal(st(body, 'main').kind, 'wait');
    assert.deepEqual(lane(body, 'web').spans.filter(owner).map((s) => [s.queueId, s.laneRule ?? null]), [['A', null]]);
    assert.deepEqual(lane(body, 'main').spans.filter(owner).map((s) => [s.queueId ?? null, s.laneRule, s.askedOn, s.askQid]), [[null, 'asked-elsewhere', 'web', 'A']]);
    assert.deepEqual(markers(body), ['web'], 'exactly one Needs-you marker');
    assert.deepEqual(ownerWaitsAtNow(body.lanes, body.now, body.now), [{ lane: 'web', queueId: 'A' }], 'one count');
    assert.equal(ownerAsks(body.owner.open, null, NOW).rows.length, 1);
  });
  it('the ask answered from the cockpit: the mirror leaves with its ask (withOwnerOpen), main falls back to its own state', async () => {
    const body = await route({ loadUnits: units, loadOwnerQueue: async () => [ask({ lane: 'web' })] });
    const f = withOwnerOpen(body, [], body.now);
    assert.deepEqual(f.lanes.flatMap((l) => l.spans.filter(owner)), []);
    assert.equal(laneState(lane(f, 'main'), f.now, f.now)?.kind, 'working');
    const kept = withOwnerOpen(body, ['A'], body.now);
    assert.equal(laneState(lane(kept, 'main'), kept.now, kept.now).phrase, 'waiting on you 3h (asked on web)');
  });
  it('the ask is closed (answered 11:00): the mirror is history, so main does not claim a wait at now', async () => {
    const body = await route({ loadUnits: units, loadOwnerQueue: async () => [ask({ lane: 'web' }), { id: 'A', status: 'closed', closed_ts: D('11:00') / 1000 }] });
    assert.deepEqual(markers(body), []);
    assert.equal(st(body, 'main')?.kind, 'working');
  });
});

describe('F2: the drawer answers "now" by laneState, so it agrees with the ribbon', () => {
  const NOWISO = T('12:00');
  const span = (o) => ({ kind: 'wait', cause: 'owner', unit: 'U1', ...o });
  const L = (spans) => ({ lane: 'main', current: { id: 'U1', title: 'U1', since: T('08:00') }, eta: null, spans, marks: [] });
  const job = { kind: 'wait', cause: 'review', start: T('09:30'), end: NOWISO, unit: 'U1' };
  const cases = [
    ['A: an open ask at now plus a review job that ends later', L([span({ queueId: 'Q2', start: T('10:00'), end: T('11:59') }), { ...job, end: NOWISO }])],
    ['B: a history stamp that ties for the latest end plus an open ask', L([span({ start: T('09:00'), end: NOWISO, open: false }), span({ queueId: 'Q2', start: T('10:00'), end: NOWISO })])],
    ['C: the ask alone', L([span({ queueId: 'Q2', start: T('10:00'), end: NOWISO })])],
    ['D: a mirror of an ask drawn on another lane', L([span({ start: T('10:00'), end: NOWISO, askedOn: 'ops', askQid: 'Q2', open: false })])],
  ];
  for (const [name, l] of cases) {
    it(`${name}: laneState says owner and the drawer says "on answer"`, () => {
      assert.equal(laneState(l, NOWISO, NOWISO)?.cause, 'owner');
      assert.equal(expectedLanding(l, NOWISO).text, 'on answer');
    });
  }
  it('no owner cause at now (a history stamp only, a review job): the drawer falls to the estimate, as before', () => {
    const l = { ...L([span({ start: T('09:00'), end: NOWISO, open: false }), job]), eta: { p50: '2h', p80: '3h', asOf: NOWISO } };
    assert.notEqual(laneState(l, NOWISO, NOWISO)?.cause, 'owner');
    assert.notEqual(expectedLanding(l, NOWISO).text, 'on answer');
  });
});

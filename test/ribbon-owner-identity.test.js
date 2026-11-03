/**
 * ribbon-owner-identity.test.js — COMP-DAYVIEW-OWNER-IDENTITY-1: an owner wait keeps its ask's id from the stamp to the
 * screen, so one ask is one wait and "waiting on you" means an open ask.
 *
 * The mechanism at each layer: the producer cuts the owner time by stamp with its `qid` (`timeIntervals`), the feed puts
 * `qid` and the stamp's own start on the span (`buildRibbon`), the route matches a stamp to the queue ask with that id on any
 * lane (`reconcileOwnerSpans`), and the client asks one predicate whether an owner span counts at now (`ownerAtNow`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { timeIntervals, timeSplit } from '../lib/process-metrics.js';
import { buildRibbon } from '../lib/ribbon-feed.js';
import { reconcileOwnerSpans } from '../lib/owner-spans.js';
import { attachRibbonRoutes } from '../server/ribbon-routes.js';
import { laneState, ownerAtNow, ownerWaitsAtNow, withOwnerOpen } from '../src/components/ribbon/ribbonLayout.js';
import { ownerAsks } from '../src/components/cockpit/notify/notifyLogic.js';

const D = (s) => Date.parse(`2026-10-31T${s}:00Z`);
const T = (s) => `2026-10-31T${s}:00.000Z`;
const NOW = D('12:00');
const owner = (s) => s.kind === 'wait' && s.cause === 'owner';
const len = (ivs) => ivs.reduce((n, [a, b]) => n + (b - a), 0);
const events = (o = {}) => ({ owner_waits: [], reviews: [], fix_runs: [], gates: [], deploys: [], fixes: [], ready_at: null, dispatched_at: null, author_done_at: null, landed_at: null, account: null, ...o });
const unit = (id, lane, ev) => ({ id, lane, title: `Title ${id}`, titleSource: 'stamp', state: ev.landed_at ? 'landed' : 'authoring', landedAt: ev.landed_at, deployedAt: null, events: events(ev) });

describe('producer: timeIntervals.waitingOwnerAsks', () => {
  const row = {
    ready_at: T('01:00'), dispatched_at: T('01:00'), author_done_at: T('02:00'), landed_at: T('10:00'),
    reviews: [{ dispatched_at: T('04:30'), at: T('05:00') }],
    owner_waits: [{ start: T('03:00'), end: T('06:00'), qid: 'A' }, { start: T('05:30'), end: T('07:00'), qid: 'B' }, { start: T('08:00'), end: T('09:00') }],
  };
  const t = timeIntervals(row);
  it('each piece carries its stamp\'s qid (null when it has none) and the stamp\'s own start, after the job time is cut out', () => {
    assert.deepEqual(t.waitingOwnerAsks.map((w) => [w.qid, w.since, w.start, w.end]), [
      ['A', D('03:00'), D('03:00'), D('04:30')], ['A', D('03:00'), D('05:00'), D('06:00')],
      ['B', D('05:30'), D('06:00'), D('07:00')], [null, D('08:00'), D('08:00'), D('09:00')],
    ]);
  });
  it('overlapping stamps never share time, so the pieces add up to waitingOwner exactly', () => {
    assert.equal(t.waitingOwnerAsks.reduce((n, w) => n + (w.end - w.start), 0), len(t.waitingOwner));
  });
  it('waitingOwner and minutes.waiting_owner keep their shape and values', () => {
    assert.deepEqual(t.waitingOwner, [[D('03:00'), D('04:30')], [D('05:00'), D('07:00')], [D('08:00'), D('09:00')]]);
    assert.equal(timeSplit(row).minutes.waiting_owner, 270);
  });
});

describe('feed: the stamp span carries qid and its own start', () => {
  it('a stamp cut by a review keeps qid on both pieces, and since is the stamp\'s start, not the piece\'s', () => {
    const u = unit('U1', 'forge', { ready_at: T('01:00'), dispatched_at: T('01:00'), author_done_at: T('02:00'), landed_at: T('10:00'),
      reviews: [{ dispatched_at: T('02:30'), at: T('04:00') }], owner_waits: [{ start: T('03:00'), end: T('06:00'), qid: 'A' }] });
    const r = buildRibbon({ from: D('00:00'), to: D('23:00'), now: NOW, units: [u], warn: () => {} });
    const spans = r.lanes.find((l) => l.lane === 'forge').spans.filter(owner);
    assert.deepEqual(spans.map((s) => [s.qid, s.since, s.start, s.end]), [['A', T('03:00'), T('04:00'), T('06:00')]]);
  });
  it('a stamp with no qid has no qid field', () => {
    const u = unit('U2', 'forge', { ready_at: T('01:00'), dispatched_at: T('01:00'), author_done_at: T('02:00'), landed_at: T('10:00'), owner_waits: [{ start: T('03:00'), end: T('04:00') }] });
    const s = buildRibbon({ from: D('00:00'), to: D('23:00'), now: NOW, units: [u], warn: () => {} }).lanes[0].spans.find(owner);
    assert.equal('qid' in s, false);
  });
});

describe('reconcile: a stamp matches its ask by qid, on any lane, and nothing else', () => {
  const S = (o) => ({ kind: 'wait', cause: 'owner', unit: 'X', start: T('09:00'), since: T('09:00'), end: T('12:00'), open: false, ...o });
  const Q = (o) => ({ kind: 'wait', cause: 'owner', unit: null, queueId: 'Q', start: T('09:00'), since: T('09:00'), end: T('12:00'), ...o });
  const pick = (spans) => spans.map((s) => [s.unit, s.queueId ?? null, s.start.slice(11, 16), s.end.slice(11, 16), s.open ?? null]);
  const asOf = D('13:00');
  // [name, spans, opts, expected]
  const ROWS = [
    ['review F2: the stamp carrying qid Q and the unit-less ask Q are one wait, the queue\'s', [S({ qid: 'Q' }), Q()], { asOf }, [[null, 'Q', '09:00', '12:00', null]]],
    ['no qid: the old unit-plus-start rule still applies (an ask with no unit never matches)', [S(), Q()], { asOf }, [['X', null, '09:00', '12:00', false], [null, 'Q', '09:00', '12:00', null]]],
    ['no qid: the same unit within 10 min matches, the stamp keeps its time outside the ask', [S({ end: T('13:00') }), Q({ unit: 'X', start: T('09:05'), since: T('09:05') })], { asOf }, [['X', null, '09:00', '09:05', false], ['X', null, '12:00', '13:00', false], ['X', 'Q', '09:05', '12:00', null]]],
    ['a qid never falls back to the unit rule: same unit, same start, another id is another ask', [S({ qid: 'R' }), Q({ unit: 'X' })], { asOf }, [['X', null, '09:00', '12:00', false], ['X', 'Q', '09:00', '12:00', null]]],
    ['the ask sits on another lane: the stamp keeps only its time outside it, here none', [S({ qid: 'Q', end: T('13:00'), open: true })], { asOf, asks: [Q({ end: T('13:00') })] }, []],
    ['the ask on another lane was answered at 11:00: the stamp keeps 11:00 to the read on its lane, as history', [S({ qid: 'Q', end: T('13:00'), open: true })], { asOf, asks: [Q({ end: T('11:00') })] }, [['X', null, '11:00', '13:00', false]]],
    ['the ask is not in the queue (pruned or closed outside the window): an open stamp is history, clipped at the read', [S({ qid: 'Z', end: T('14:00'), open: true })], { asOf }, [['X', null, '09:00', '13:00', false]]],
    ['the queue unreadable: the stamp stays as it is, open stays open', [S({ qid: 'Q', open: true })], { asOf: NaN }, [['X', null, '09:00', '12:00', true]]],
  ];
  for (const [name, spans, opts, want] of ROWS) it(name, () => assert.deepEqual(pick(reconcileOwnerSpans(spans, opts)), want));
});

describe('client: ownerAtNow is the one at-now owner rule', () => {
  const now = T('12:00');
  it('review F1: the remainder after an answered ask reads "working", and nothing counts at now', () => {
    const spans = reconcileOwnerSpans([
      { kind: 'wait', cause: 'owner', unit: 'U1', start: T('09:00'), since: T('09:00'), end: now, open: true },
      { kind: 'wait', cause: 'owner', unit: 'U1', queueId: 'Q1', start: T('09:00'), since: T('09:00'), end: T('11:00') },
    ], { asOf: NOW });
    const l = { lane: 'forge', current: { id: 'U1', since: T('08:00') }, spans };
    assert.equal(laneState(l, now, now)?.phrase, 'working 4h');
    assert.equal(ownerWaitsAtNow([l], now, now).length, 0);
  });
  it('the predicate: a queue span or an open stamp counts, a closed stamp and any other span do not', () => {
    const w = { kind: 'wait', cause: 'owner' };
    assert.deepEqual([{ ...w, queueId: 'A' }, { ...w, open: true }, { ...w, open: false }, w, { kind: 'wait', cause: 'review', open: true }, null].map(ownerAtNow), [true, true, false, false, false, false]);
  });
  it('withOwnerOpen: with the ids known, a live open stamp no id backs is dropped; with them unknown it stays', () => {
    const feed = { now, lanes: [{ lane: 'a', spans: [{ kind: 'wait', cause: 'owner', start: T('10:00'), end: now, open: true }] }] };
    assert.equal(withOwnerOpen(feed, [], now).lanes[0].spans.length, 0);
    assert.equal(withOwnerOpen(feed, null, now).lanes[0].spans.length, 1);
  });
});

/** The route handler, in-process (no listen): returns the JSON body of one GET. */
async function route(over) {
  let handler = null;
  attachRibbonRoutes({ get: (_p, h) => { handler = h; }, locals: {} }, { deps: {
    now: () => NOW, warn: () => {}, info: () => {}, dataDir: () => '/nonexistent/ribbon-owner-identity-test',
    loadSnapshots: async () => [], loadGateLog: async () => [], loadSeats: async () => ({ seats: [] }),
    ledger: { get: async () => ({ value: [] }), rows: () => [] }, loadOutage: async () => ({ state: 'ok', since: null }),
    eta: async () => ({ p50: '2h', p80: '3h', asOf: 'a', raw: 'r' }), ...over,
  } });
  let status = 200;
  const body = await new Promise((resolve, reject) => {
    const res = { set() {}, status(c) { status = c; return this; }, json: resolve };
    handler({ query: { from: T('00:00'), to: T('23:00') }, socket: { localPort: 1 } }, res).catch(reject);
  });
  return { status, body };
}

describe('the route: one ask is one wait at now, by its id', () => {
  const units = (waits) => async () => ({ units: [
    unit('U8', 'forge', { ready_at: T('07:50'), dispatched_at: T('08:00'), author_done_at: T('08:50'), owner_waits: waits }),
    unit('U9', 'web', { ready_at: T('07:50'), dispatched_at: T('08:00') }),
  ], coverage: {}, asOf: new Date(NOW).toISOString() });
  const lane = (b, n) => b.lanes.find((l) => l.lane === n);
  it('a stamp whose qid sits on another lane: one wait, drawn on the queue\'s lane at now, never two', async () => {
    const { status, body } = await route({
      loadUnits: units([{ start: T('09:00'), end: null, qid: 'A' }]),
      loadOwnerQueue: async () => [{ id: 'A', status: 'open', lane: 'web', by: 'web-main', ts: D('09:00') / 1000, text: 'ASK: ship it?' }],
    });
    assert.equal(status, 200);
    // FU-1: the ask's time is still the queue's (no queue span, no open stamp on forge), but forge keeps ONE mirror of it, so it
    // reads "waiting on you (asked on web)" instead of "working"; the mirror is no ask and no marker.
    assert.deepEqual(lane(body, 'forge').spans.filter(owner).map((s) => [s.queueId ?? null, s.askedOn, s.askQid, s.laneRule]), [[null, 'web', 'A', 'asked-elsewhere']], 'the stamp\'s time is all the ask\'s');
    assert.deepEqual(lane(body, 'web').spans.filter(owner).map((s) => s.queueId), ['A']);
    const drawn = ownerWaitsAtNow(body.lanes, body.now, body.now);
    assert.deepEqual(drawn, [{ lane: 'web', queueId: 'A' }]);
    assert.deepEqual(drawn.map((d) => d.queueId), ownerAsks(body.owner.open, null, NOW).rows.map((q) => q.id));
    assert.equal(body.lanes.filter((l) => laneState(l, body.now, body.now)?.cause === 'owner' && !laneState(l, body.now, body.now).askedOn).map((l) => l.lane).join(), 'web', 'one marker lane');
  });
  it('review F1 at the route: the ask answered at 11:00, the stamp still open: forge reads "working", nothing at now', async () => {
    const { body } = await route({
      loadUnits: units([{ start: T('09:00'), end: null, qid: 'A' }]),
      loadOwnerQueue: async () => [{ id: 'A', status: 'open', unit: 'U8', by: 'forge-main', ts: D('09:00') / 1000, text: 'ASK: ship it?' }, { id: 'A', status: 'closed', closed_ts: D('11:00') / 1000 }],
    });
    assert.deepEqual(lane(body, 'forge').spans.filter(owner).map((s) => [s.queueId ?? null, s.start, s.end, s.open ?? null]),
      [['A', T('09:00'), T('11:00'), null], [null, T('11:00'), T('12:00'), false]]);
    assert.equal(laneState(lane(body, 'forge'), body.now, body.now)?.kind, 'working');
    assert.deepEqual(ownerWaitsAtNow(body.lanes, body.now, body.now), []);
  });
  it('review F5: the queue unreadable: the stamp span stays open, owner.open is null, and the lane reads "waiting on you"', async () => {
    const { body } = await route({
      loadUnits: units([{ start: T('09:00'), end: null, qid: 'A' }]),
      loadOwnerQueue: async () => { throw new Error('ENOENT owner-queue.jsonl'); },
    });
    assert.deepEqual(body.owner, { open: null });
    assert.ok(body.sourceErrors.ownerQueue);
    assert.deepEqual(lane(body, 'forge').spans.filter(owner).map((s) => [s.qid, s.open]), [['A', true]]);
    assert.match(laneState(lane(body, 'forge'), body.now, body.now)?.phrase ?? '', /^waiting on you 3h/);
    assert.deepEqual(ownerWaitsAtNow(body.lanes, body.now, body.now), [{ lane: 'forge', queueId: null }]);
  });
});

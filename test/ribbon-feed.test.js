/**
 * COMP-COCKPIT-RIBBON-FEED-1: `buildRibbon` over fixture stamp rows. One row table; every row builds a ribbon and checks one claim.
 * All fixture times are Z so the expectations do not depend on the machine's zone.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachRibbonRoutes } from '../server/ribbon-routes.js';
import { buildRibbon, computeHistory, etaWithPrev, holdBands, parseGateLog } from '../lib/ribbon-feed.js';
import { buildDecisions, parseLedger, queueDecisions } from '../lib/decisions-ledger.js';
import { ownerWaitsAtNow } from '../src/components/ribbon/ribbonLayout.js';
import { ownerAsks } from '../src/components/cockpit/notify/notifyLogic.js';

const D = (s) => Date.parse(`2026-10-31T${s}:00Z`);
const T = (s) => `2026-10-31T${s}:00.000Z`; // the feed prints toISOString()
const NOW = D('12:00');
const LIVE = { from: D('00:00'), to: D('23:00'), now: NOW };

const events = (o = {}) => ({ owner_waits: [], reviews: [], fix_runs: [], gates: [], deploys: [], fixes: [], ready_at: null, dispatched_at: null, author_done_at: null, landed_at: null, account: null, ...o });
const unit = (id, lane, ev, o = {}) => ({ id, lane, title: `Title ${id}`, titleSource: 'stamp', state: ev.landed_at ? 'landed' : 'authoring', landedAt: ev.landed_at, deployedAt: null, events: events(ev), ...o });
const FULL = {
  ready_at: T('02:00'), dispatched_at: T('02:10'), author_done_at: T('02:40'), landed_at: T('04:00'),
  reviews: [{ round: 1, dispatched_at: T('02:50'), at: T('03:00') }],
  fix_runs: [{ round: 1, dispatched_at: T('03:05'), done_at: T('03:15') }],
  gates: [{ n: 1, started_at: T('03:30'), done_at: T('03:40') }],
};
const HIST = (earliest) => Object.fromEntries(['stamps.landed_at', 'stamps.dispatched_at'].map((k) => [k, { earliest, count: 1 }]));
const lane = (r, name = 'forge') => r.lanes.find((l) => l.lane === name);
const gate = (lines) => parseGateLog(lines.join('\n'));
const holdLines = (from, n, stepMin) => Array.from({ length: n }, (_, i) => {
  const m = from + i * stepMin;
  return `2026-10-30T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00 wait L${i} engine=claude (fleet cap 16/16)`;
});

describe('buildRibbon', () => {
  // [name, input overrides, check(ribbon)]
  const ROWS = [
    ['full stamps: four work spans, a review wait and a gate wait, one land mark, nothing not recorded', { units: [unit('U1', 'forge', FULL)], history: HIST(T('00:00')) }, (r) => {
      const l = lane(r);
      assert.equal(l.spans.filter((s) => s.kind === 'work').length, 4);
      assert.deepEqual(new Set(l.spans.filter((s) => s.kind === 'wait').map((s) => s.cause)), new Set(['unknown', 'review', 'gate']));
      assert.equal(l.spans.some((s) => s.kind === 'notRecorded'), false);
      assert.deepEqual(l.marks.map((m) => [m.kind, m.unit, m.source]), [['land', 'U1', 'stamps']]);
      assert.deepEqual(r.coverage, { n: 1, dispatched: 1, pct: 100, label: 'start stamps on 100% of landings' });
    }],
    ['no dispatch stamp: one notRecorded span from the ready stamp to the landing, rule in words', { units: [unit('U2', 'forge', { ready_at: T('02:00'), landed_at: T('04:00') })], history: HIST(T('00:00')) }, (r) => {
      const s = lane(r).spans;
      assert.equal(s.length, 1);
      assert.deepEqual([s[0].kind, s[0].start, s[0].end], ['notRecorded', T('02:00'), T('04:00')]);
      assert.match(s[0].why, /no dispatch stamp.*rule U-d/);
      assert.equal(r.coverage.pct, 0);
    }],
    ['a closed owner wait no job covers is a wait with cause owner', { units: [unit('U3', 'forge', { ...FULL, owner_waits: [{ qid: 'q', start: T('02:42'), end: T('02:48') }] })], history: HIST(T('00:00')) }, (r) => {
      const w = lane(r).spans.find((s) => s.cause === 'owner');
      assert.deepEqual([w.start, w.end], [T('02:42'), T('02:48')]);
    }],
    ['the live unit with an open owner wait: wait cause owner up to now, unit is current', { units: [unit('U4', 'forge', { ready_at: T('09:00'), dispatched_at: T('09:10'), author_done_at: T('09:40'), owner_waits: [{ qid: 'q', start: T('11:00') }] })], history: HIST(T('00:00')) }, (r) => {
      const l = lane(r);
      assert.equal(l.current.id, 'U4');
      const w = l.spans.find((s) => s.cause === 'owner');
      assert.deepEqual([w.start, w.end], [T('11:00'), T('12:00')]);
    }],
    ['unlanded in a live window: current, authoring drawn to now; ready unit is next; idle false', { units: [unit('U5', 'forge', { ready_at: T('10:00'), dispatched_at: T('11:00') }), unit('U6', 'forge', { ready_at: T('10:30') }, { state: 'ready' })], history: HIST(T('00:00')) }, (r) => {
      const l = lane(r);
      assert.deepEqual([l.current.id, l.current.since], ['U5', T('11:00')]);
      assert.deepEqual(l.next.map((n) => n.id), ['U6']);
      assert.deepEqual(l.spans.map((s) => [s.kind, s.job, s.end]), [['work', 'authoring', T('12:00')]]);
      assert.equal(l.idle, false);
    }],
    ['a retired unit is never current or next', { units: [unit('U7', 'forge', { ready_at: T('10:00'), dispatched_at: T('11:00') }, { state: 'retired' })], history: HIST(T('00:00')) }, (r) => {
      assert.deepEqual([lane(r).current, lane(r).next, lane(r).spans], [null, [], []]);
      assert.equal(lane(r).idle, true);
    }],
    ['past window: no current, no next, no eta, no outage band, the landing still marks', {
      from: D('00:00') - 11 * 86_400_000, to: D('00:00') - 10 * 86_400_000, now: NOW,
      units: [unit('U8', 'forge', { ready_at: '2026-10-20T02:00:00Z', dispatched_at: '2026-10-20T02:10:00Z', author_done_at: '2026-10-20T02:40:00Z', landed_at: '2026-10-20T04:00:00Z' }), unit('U9', 'forge', { ready_at: T('10:00'), dispatched_at: T('11:00') })],
      outage: { state: 'outage', since: T('10:00') }, etas: { forge: { p50: '1h', p80: '2h', asOf: 'x', raw: 'r', prev: null } }, history: HIST('2026-10-09T00:00:00Z'),
    }, (r) => {
      const l = lane(r);
      assert.deepEqual([r.live, l.current, l.next, l.eta, r.bands.some((b) => b.kind === 'outage')], [false, null, [], null, false]);
      assert.equal(l.marks.filter((m) => m.kind === 'land').length, 1);
    }],
    ['live: the outage state becomes an open band, and the eta is passed through', { units: [unit('U1', 'forge', FULL)], outage: { state: 'outage', since: T('10:00') }, etas: { forge: { noData: true, raw: 'NO DATA' } }, history: HIST(T('00:00')) }, (r) => {
      assert.deepEqual(r.bands.filter((b) => b.kind === 'outage').map((b) => [b.start, b.end]), [[T('10:00'), null]]);
      assert.deepEqual(lane(r).eta, { noData: true, raw: 'NO DATA' });
    }],
    ['a window before the stamps: every lane has a notRecorded span and the source says so', {
      from: Date.parse('2026-10-01T00:00:00Z'), to: Date.parse('2026-10-02T00:00:00Z'), now: NOW,
      units: [unit('U1', 'forge', FULL), unit('U2', 'ops', { ...FULL, landed_at: T('05:00') })], history: HIST('2026-10-09T00:00:00Z'),
    }, (r) => {
      for (const l of r.lanes) assert.deepEqual([l.spans.length, l.spans[0].kind, l.idle], [1, 'notRecorded', false], l.lane);
      const n = r.notRecorded.find((x) => x.source === 'stamps.landed_at');
      assert.deepEqual([n.start, n.end], ['2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z']);
    }],
    ['a 40 min hold is one band', { gateEntries: gate(holdLines(23 * 60, 11, 4)), units: [unit('U1', 'forge', FULL)], history: HIST(T('00:00')), from: D('00:00') - 86_400_000, to: D('23:00') }, (r) => {
      const h = r.bands.filter((b) => b.kind === 'hold');
      assert.equal(h.length, 1);
      assert.equal(h[0].source, 'launch-gate gate.log');
    }],
    ['a 20 min hold is no band', { gateEntries: gate(holdLines(23 * 60, 6, 4)), units: [unit('U1', 'forge', FULL)], history: HIST(T('00:00')), from: D('00:00') - 86_400_000, to: D('23:00') }, (r) => {
      assert.equal(r.bands.filter((b) => b.kind === 'hold').length, 0);
    }],
    ['an APPLIED owner-queue row is a decide mark on its lane with the reverse text; a laneless one goes to ops', {
      units: [unit('U1', 'forge', FULL), unit('U2', 'ops', FULL)], history: HIST(T('00:00')),
      decisions: queueDecisions([
        { id: 'X-1', by: 'forge-main', ts: D('05:00') / 1000, text: 'APPLIED (night mode): ship it. Reverse = revert abc.' },
        { id: 'Y-1', by: 's2-coord', ts: D('06:00') / 1000, text: 'APPLIED: other. Reverse = undo.' },
        { id: 'Z-1', by: 'forge-main', ts: D('07:00') / 1000, text: 'Is this ok?' },
      ]),
    }, (r) => {
      const dec = (n) => lane(r, n).marks.filter((m) => m.kind === 'decide');
      assert.deepEqual(dec('forge').map((m) => [m.source, m.reverse]), [['owner-queue', 'revert abc.']]);
      assert.deepEqual(dec('ops').map((m) => m.reverse), ['undo.']);
    }],
    ['a failed source is a notRecorded entry with its message, and the ledger-less decide marks still come back', {
      units: [unit('U1', 'forge', FULL)], history: HIST(T('00:00')), sourceErrors: { ledger: 'wiki is stopped' },
      decisions: queueDecisions([{ id: 'X', by: 'forge-main', ts: D('05:00') / 1000, text: 'APPLIED: yes' }]),
    }, (r) => {
      assert.match(r.notRecorded.find((n) => n.source === 'ledger').why, /wiki is stopped/);
      assert.equal(lane(r).marks.filter((m) => m.kind === 'decide').length, 1);
    }],
    ['DECISIONS-1: ledger OWNER-ABSENT lines are decide marks from the ledger, with or without the colon (ledger.md:6764 shape)', {
      units: [unit('U1', 'forge', FULL)], history: HIST(T('00:00')),
      decisions: buildDecisions(parseLedger([
        '- 2026-10-31T05:00Z s2-coord: OWNER-ABSENT decision: pick a. Reverse = pick b.',
        '- 2026-10-31T05:30Z s2-coord: OWNER-ABSENT decision BYOC F3: REFUSE (option 1). Reverse = allow.',
        '- 2026-10-31T06:00Z s2-coord: plain line',
      ].join('\n'))),
    }, (r) => {
      const m = r.lanes.flatMap((l) => l.marks).filter((x) => x.kind === 'decide');
      assert.deepEqual(m.map((x) => [x.source, x.reverse]), [['ledger', 'pick b.'], ['ledger', 'allow.']]);
    }],
    ['quota: a wait while the lane\'s seat sat at the limit is cause quota', {
      units: [unit('U1', 'forge', { ...FULL, account: 'seat2' })], history: HIST(T('00:00')),
      snapshots: [{ account: 'seat2', window: '5h', ts: D('02:41') / 1000, used_pct: 100, resets_at: D('07:00') / 1000 }, { account: 'seat2', window: '5h', ts: D('02:49') / 1000, used_pct: 40, resets_at: D('07:00') / 1000 }],
    }, (r) => {
      assert.equal(lane(r).seat, 'seat2');
      assert.equal(lane(r).spans.some((s) => s.cause === 'quota'), true);
    }],
    ['DAYVIEW-FIX-1 U2-DATA (FEED-1 M1): a landing with no start stamp is a notRecorded span from the window start, not nothing', { units: [unit('M1', 'forge', { landed_at: T('04:00') })], history: HIST(T('00:00')) }, (r) => {
      assert.deepEqual(lane(r).spans.map((s) => [s.kind, s.unit, s.start, s.end]), [['notRecorded', 'M1', T('00:00'), T('04:00')]]);
    }],
    ['DAYVIEW-FIX-1 U2-DATA (FEED-1 M1): ... and from the previous landing of the lane when there is one', { units: [unit('P1', 'forge', FULL), unit('M1', 'forge', { landed_at: T('06:00') })], history: HIST(T('00:00')) }, (r) => {
      assert.deepEqual(lane(r).spans.filter((s) => s.unit === 'M1').map((s) => [s.kind, s.start, s.end]), [['notRecorded', T('04:00'), T('06:00')]]);
    }],
    ['DAYVIEW-FIX-1 U2-DATA (FEED-1 M2): recorded work on an unlanded unit stays drawn in a past window, with no current unit', {
      to: D('06:00'), now: NOW, units: [unit('M2', 'forge', { ready_at: T('02:00'), dispatched_at: T('02:10'), author_done_at: T('02:40') })], history: HIST(T('00:00')),
    }, (r) => {
      const l = lane(r);
      assert.deepEqual([r.live, l.current, l.idle], [false, null, false]);
      assert.deepEqual(l.spans.filter((s) => s.kind === 'work').map((s) => [s.job, s.start, s.end]), [['authoring', T('02:10'), T('02:40')]]);
    }],
    ['DAYVIEW-FIX-1 U2-DATA (FEED-1 M3): no dispatch or landing history anywhere is a notRecorded span, not a thrown RangeError', { units: [unit('M3', 'forge', { ready_at: T('02:00') }, { state: 'ready' })] }, (r) => {
      const n = lane(r).spans.filter((s) => s.kind === 'notRecorded');
      assert.deepEqual(n.map((s) => [s.start, s.end]), [[T('00:00'), T('23:00')]]);
      assert.match(n[0].why, /no dispatch or landing stamp exists yet/);
    }],
    ['DAYVIEW-FIX-1 U2-DATA (FEED-1 M5): a source error carrying a home path keeps its meaning and loses the path, in sourceErrors and notRecorded', {
      units: [unit('U1', 'forge', FULL)], history: HIST(T('00:00')),
      sourceErrors: { quota: "ENOENT: no such file or directory, open '/Users/review-probe/.claude/usage/snapshots.jsonl'", holds: 'EACCES /home/ops/status/launch-gate/gate.log and ~/.claude/x.json (about ~5 min)' },
    }, (r) => {
      const all = JSON.stringify([r.sourceErrors, r.notRecorded]);
      assert.equal(/\/Users\/|\/home\/|~\//.test(all), false, all);
      assert.match(r.sourceErrors.quota, /ENOENT: no such file or directory, open 'snapshots\.jsonl'/);
      assert.match(r.notRecorded.find((n) => n.source === 'quota').why, /^could not be read: ENOENT.*snapshots\.jsonl/);
      assert.match(r.sourceErrors.holds, /about ~5 min/);
    }],
    ['DAYVIEW-FIX-1 U2-DATA (RIBBON-MARKS-1 M1): a decide mark carries the unit its text names (what Reverse acts on) and its queue id; one naming none carries null', {
      units: [unit('U1', 'forge', FULL)], history: HIST(T('00:00')),
      decisions: queueDecisions([
        { id: 'Q-1', by: 'forge-main', ts: D('05:00') / 1000, text: 'APPLIED (COMP-FOO-1): ship it. Reverse = revert abc.' },
        { id: 'Q-2', by: 'forge-main', ts: D('06:00') / 1000, text: 'APPLIED: no unit named. Reverse = undo.' },
      ]),
    }, (r) => {
      assert.deepEqual(lane(r).marks.filter((m) => m.kind === 'decide').map((m) => [m.queueId, m.unit]), [['Q-1', 'COMP-FOO-1'], ['Q-2', null]]);
    }],
    ['an unlisted lane is drawn in the ops group', { units: [unit('U1', 'newlane', FULL)], history: HIST(T('00:00')), warn: () => {} }, (r) => assert.equal(lane(r, 'newlane').group, 'ops')],
  ];
  for (const [name, input, check] of ROWS) it(name, () => check(buildRibbon({ ...LIVE, ...input })));
});

describe('etaWithPrev and holdBands', () => {
  const eta = { p50: '3h', p80: '5h', asOf: 'a', raw: 'r' };
  // [name, run, expected]
  const ROWS = [
    ['first reading: prev null, one row to append', () => etaWithPrev('x', eta, []), { eta: { ...eta, prev: null }, append: { lane: 'x', p50: '3h', asOf: 'a' } }],
    ['same p50: nothing appended, prev stays', () => etaWithPrev('x', eta, [{ lane: 'x', p50: '3h', asOf: 'a' }]), { eta: { ...eta, prev: null }, append: null }],
    ['changed p50: prev is the last different one, one row appended', () => etaWithPrev('x', eta, [{ lane: 'x', p50: '4h', asOf: 'z' }]), { eta: { ...eta, prev: { p50: '4h', asOf: 'z' } }, append: { lane: 'x', p50: '3h', asOf: 'a' } }],
    ['noData is passed through', () => etaWithPrev('x', { noData: true, raw: 'n' }, []), { eta: { noData: true, raw: 'n' }, append: null }],
    ['an admit ends a hold run', () => holdBands(parseGateLog([...holdLines(0, 5, 4), '2026-10-30T00:20:00 admit A', ...holdLines(21, 5, 4)].join('\n')), { from: 0, to: Date.now() + 1e9, now: Date.now(), live: false }).length, 0],
  ];
  for (const [name, run, want] of ROWS) it(name, () => assert.deepEqual(run(), want));
});

// The route over fake sources: validation, the ledger-unreadable case, remote mode. One row table.
describe('GET /api/ribbon', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ribbon-route-'));
  const FROM = '2026-10-31T00:00:00Z';
  const TO = '2026-10-31T23:00:00Z';
  const deps = (over = {}) => ({
    now: () => NOW, warn: () => {}, dataDir: () => dataDir,
    loadUnits: async () => ({ units: [unit('U1', 'forge', FULL)], coverage: {}, asOf: new Date(NOW).toISOString() }),
    loadSnapshots: async () => [], loadGateLog: async () => [], loadSeats: async () => ({ seats: [] }),
    loadOwnerQueue: async () => [{ id: 'X', by: 'forge-main', ts: D('05:00') / 1000, text: 'APPLIED: yes. Reverse = no.' }],
    ledger: { get: async () => ({ value: [] }), rows: (e) => buildDecisions(e) }, loadOutage: async () => ({ state: 'ok', since: null }),
    eta: async () => ({ p50: '2h', p80: '3h', asOf: 'a', raw: 'r' }),
    ...over,
  });
  async function get(query, over) {
    const app = express();
    attachRibbonRoutes(app, { deps: deps(over) });
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try { const res = await fetch(`http://127.0.0.1:${server.address().port}/api/ribbon?${query}`); return { status: res.status, body: await res.json() }; } finally { server.close(); }
  }
  // [name, query, deps override, status, check(body)]
  const ROWS = [
    ['a good window answers with the contract keys', `from=${FROM}&to=${TO}`, {}, 200, (b) => assert.deepEqual(Object.keys(b), ['from', 'to', 'now', 'live', 'asOf', 'ageS', 'lanes', 'bands', 'pins', 'coverage', 'history', 'notRecorded', 'sourceErrors', 'owner'])],
    ['the eta carries prev null on the first reading and is written to the history file', `from=${FROM}&to=${TO}`, { loadUnits: async () => ({ units: [unit('U5', 'forge', { ready_at: T('10:00'), dispatched_at: T('11:00') })], coverage: {}, asOf: new Date(NOW).toISOString() }) }, 200, (b) => assert.deepEqual(lane(b).eta, { p50: '2h', p80: '3h', asOf: 'a', raw: 'r', prev: null })],
    ['DAYVIEW-FIX-1 U2-DATA (FEED-1 M5): a loader that throws with a home path answers 200 with the path cut from sourceErrors and notRecorded', `from=${FROM}&to=${TO}`, { loadSnapshots: async () => { throw new Error("ENOENT: open '/Users/review-probe/.claude/usage/snapshots.jsonl'"); } }, 200, (b) => {
      assert.equal(/\/Users\//.test(JSON.stringify([b.sourceErrors, b.notRecorded, b.owner])), false);
      assert.match(b.sourceErrors.quota, /ENOENT: open 'snapshots\.jsonl'/);
    }],
    ['the ledger unreadable: sourceErrors.ledger is set and the owner-queue decide mark still comes back', `from=${FROM}&to=${TO}`, { ledger: { get: async () => ({ value: null, error: 'ENOENT ledger.md' }), rows: () => [] } }, 200, (b) => {
      assert.match(b.sourceErrors.ledger, /ENOENT/);
      assert.equal(lane(b).marks.filter((m) => m.kind === 'decide' && m.source === 'owner-queue').length, 1);
    }],
    ['every source down: still 200, the stamps are not recorded, no lanes', `from=${FROM}&to=${TO}`, { loadUnits: async () => { throw new Error('no stamps'); } }, 200, (b) => {
      assert.deepEqual([b.lanes.length, Boolean(b.sourceErrors.stamps), b.notRecorded.some((n) => n.source === 'stamps')], [0, true, true]);
    }],
    ['the owner queue down: owner.open is null (unknown, never []), the reason only in sourceErrors', `from=${FROM}&to=${TO}`, { loadOwnerQueue: async () => { throw new Error('ENOENT owner-queue.jsonl'); } }, 200, (b) => {
      assert.deepEqual([b.owner, Boolean(b.sourceErrors.ownerQueue)], [{ open: null }, true]);
    }],
    ['from after to is 400', `from=${TO}&to=${FROM}`, {}, 400, (b) => assert.match(b.error, /before/)],
    ['from equal to is 400', `from=${FROM}&to=${FROM}`, {}, 400, () => {}],
    ['32 days is 400', 'from=2026-10-01T00:00:00Z&to=2026-11-02T00:00:00Z', {}, 400, (b) => assert.match(b.error, /31 days/)],
    ['from=x is 400', `from=x&to=${TO}`, {}, 400, () => {}],
    ['a time without an offset is 400', `from=2026-10-31T00:00:00&to=${TO}`, {}, 400, () => {}],
    ['missing to is 400', `from=${FROM}`, {}, 400, () => {}],
  ];
  for (const [name, query, over, status, check] of ROWS) it(name, async () => { const r = await get(query, over); assert.equal(r.status, status); check(r.body); });
  it('LIVE-DATA-1: the boot warm fills the sources and every lane estimate once, so the first read reads nothing, and a failing source never throws', async () => {
    const hits = { units: 0, snap: 0, eta: 0 };
    const over = { loadUnits: async () => { hits.units += 1; return { units: [unit('U7', 'forge', { ready_at: T('10:00'), dispatched_at: T('11:00') })], coverage: {}, asOf: new Date(NOW).toISOString() }; }, loadSnapshots: async () => { hits.snap += 1; throw new Error('snapshots gone'); }, eta: async () => { hits.eta += 1; return { p50: '2h', p80: '3h', asOf: 'a', raw: 'r' }; } };
    const app = express();
    attachRibbonRoutes(app, { deps: deps(over) });
    await app.locals.warmRibbon();
    assert.deepEqual(hits, { units: 1, snap: 1, eta: 1 });
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/ribbon?from=${FROM}&to=${TO}`);
      assert.equal(res.status, 200);
      assert.equal(hits.units, 1, 'the source cache was warm');
    } finally { server.close(); }
  });
  it('U2 F2: one ask with a stamp and a queue row draws once at now, an open stamp with no queue ask is history clipped at the read (not open), and the drawn count is the headline count', async () => {
    const r = await get(`from=${FROM}&to=${TO}`, {
      loadUnits: async () => ({ units: [
        unit('U8', 'forge', { ready_at: T('07:50'), dispatched_at: T('08:00'), author_done_at: T('08:50'), owner_waits: [{ start: T('09:00'), end: null }] }),
        unit('U9', 'web', { ready_at: T('05:50'), dispatched_at: T('06:00'), author_done_at: T('06:50'), owner_waits: [{ start: T('07:00'), end: null }] }),
      ], coverage: {}, asOf: new Date(NOW).toISOString() }),
      loadOwnerQueue: async () => [{ id: 'A', status: 'open', by: 'forge-main', ts: D('09:00') / 1000, text: 'ASK: ship it?', unit: 'U8' }],
    });
    assert.equal(r.status, 200);
    const owners = (name) => r.body.lanes.find((l) => l.lane === name).spans.filter((s) => s.kind === 'wait' && s.cause === 'owner');
    assert.deepEqual(owners('forge').map((s) => s.queueId ?? null), ['A'], 'one ask, one span: the queue\'s');
    assert.deepEqual(owners('web').map((s) => [s.start, s.end, s.open]), [[D('07:00') && new Date(D('07:00')).toISOString(), new Date(NOW).toISOString(), false]], 'no ask in the queue: the stamp is clipped at the read, not open');
    const drawn = ownerWaitsAtNow(r.body.lanes, NOW, r.body.now);
    // The stamp clipped at the read ends at the read, so `ownerWaitsAtNow` (client, U3's file) still lists it with queueId null:
    // the headline is compared on the queue's own spans until U3 counts only queue asks there (report-u3-data.md ## Questions).
    const queued = drawn.filter((d) => d.queueId !== null);
    assert.deepEqual(queued.map((d) => d.queueId), ownerAsks(r.body.owner.open, null, NOW).rows.map((q) => q.id));
    assert.equal(queued.length, 1);
  });
  it('remote mode mounts nothing', () => assert.equal(attachRibbonRoutes(express(), { remote: true }), false));
});

describe('COMP-RIBBON-FEED-OVERFLOW-1: history scan over a very large snapshot log', () => {
  it('200k snapshot timestamps give the right earliest and count without a stack overflow', () => {
    const base = 1_700_000_000;
    const snapshots = Array.from({ length: 200_000 }, (_, i) => ({ ts: base + ((i * 7919) % 200_000) }));
    snapshots.push({ ts: 'bad' }, null); // not numeric: skipped, not counted
    const h = computeHistory({ snapshots });
    assert.equal(h.quota.count, 200_000);
    assert.equal(h.quota.earliest, new Date(base * 1000).toISOString());
  });
});

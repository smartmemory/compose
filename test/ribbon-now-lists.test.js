/**
 * ribbon-now-lists.test.js — COMP-COCKPIT-RIBBON-NOW-1: the rows behind the Day page's "now" lists. One row table over the
 * four list functions, including every unknown source (null, never an empty list).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { workingNow, waitingNow, landedSince, phoneLines, sinceWords, agoWords } from '../src/components/ribbon/now/nowLists.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const iso = (hAgo) => new Date(NOW - hAgo * 3_600_000).toISOString();
const fleet = ({ sessions = [], jobs = [] } = {}) => ({ sources: { sm_status: { value: { sessions: { value: sessions, error: null }, jobs: { value: jobs, error: null } }, error: null } } });
const FLEET_DOWN = { sources: { sm_status: { value: null, error: 'timed out' } } };
const feed = (lanes, from = iso(30)) => ({ from, lanes });
const lane = (name, over = {}) => ({ lane: name, current: null, next: [], eta: null, marks: [], ...over });
const unit = (id, over = {}) => ({ id, lane: 'a', title: `T-${id}`, waiting: null, authorDoneAt: null, landedAt: null, deployedAt: null, ...over });
const index = (units) => ({ units, asOf: iso(0) });
const key = (rows) => rows.map((r) => `${r.lane}|${r.unit}|${r.title}|${r.since === null ? 'null' : Math.round((NOW - r.since) / 60_000)}`);

describe('workingNow', () => {
  const ROWS = [
    ['a busy session takes its unit and start from the lane of the same name',
      () => workingNow(fleet({ sessions: [{ name: 'a-main', busy: true }, { name: 'b-main', busy: false }] }), feed([lane('a', { current: { id: 'U1', title: 'One', since: iso(2) } })]), null, NOW),
      ['a|U1|One|120']],
    ['a live job is its own row, oldest first; a dead job is left out',
      () => workingNow(fleet({ jobs: [{ session: 'a-main', id: 'j1', kind: 'review', age: 600, alive: true }, { session: 'b-main', id: 'j2', kind: 'author', age: 7200, alive: true }, { session: 'c-main', id: 'j3', kind: 'bash', age: 5, alive: false }] }), null, null, NOW),
      ['b|j2|author|120', 'a|j1|review|10']],
    ['Compose\'s own agent counts as one row', () => workingNow(fleet(), null, { status: 'working' }, NOW), ['Compose|null|Compose\'s own agent|null']],
    ['nothing busy is an empty list, not null', () => workingNow(fleet({ sessions: [{ name: 'a-main', busy: false }] }), feed([]), null, NOW), []],
    ['sm_status down: lanes with a current unit stand in', () => workingNow(FLEET_DOWN, feed([lane('a', { current: { id: 'U1', title: 'One', since: iso(1) } }), lane('b')]), null, NOW), ['a|U1|One|60']],
    ['sm_status down and no feed is null', () => workingNow(FLEET_DOWN, null, null, NOW), null],
    ['no fleet at all and no feed is null', () => workingNow(null, undefined, null, NOW), null],
  ];
  it('rows', () => {
    for (const [name, run, want] of ROWS) {
      const got = run();
      assert.deepEqual(got === null ? null : key(got), want, name);
    }
  });
});

describe('waitingNow', () => {
  const ROWS = [
    ['review waits are oldest first and carry their start', index([unit('N', { waiting: 'review', authorDoneAt: iso(1) }), unit('O', { waiting: 'review', authorDoneAt: iso(5) })]), { review: ['O', 'N'], you: [] }],
    ['an owner wait has no start in the index: you group, since null', index([unit('Y', { waiting: 'owner' })]), { review: [], you: ['Y'] }],
    ['landed and unwaiting units are not listed', index([unit('L', { landedAt: iso(1) }), unit('Q')]), { review: [], you: [] }],
    ['index down is null', null, null],
    ['index without units is null', { asOf: iso(0) }, null],
  ];
  it('rows', () => {
    for (const [name, idx, want] of ROWS) {
      const got = waitingNow(idx);
      assert.deepEqual(got === null ? null : { review: got.review.map((r) => r.unit), you: got.you.map((r) => r.unit) }, want, name);
    }
    assert.equal(waitingNow(index([unit('Y', { waiting: 'owner' })])).you[0].since, null);
    assert.equal(waitingNow(index([unit('N', { waiting: 'review', authorDoneAt: iso(1) })])).review[0].since, NOW - 3_600_000);
  });
});

describe('landedSince', () => {
  const since = NOW - 10 * 3_600_000;
  const units = index([unit('A', { landedAt: iso(2), deployedAt: iso(1) }), unit('B', { landedAt: iso(5) }), unit('C', { landedAt: iso(20) }), unit('D')]);
  const marks = feed([lane('a', { marks: [
    { kind: 'land', at: iso(2), unit: 'A' }, { kind: 'deploy', at: iso(1), unit: 'A', title: 'T-A', text: 'on prod' },
    { kind: 'decide', at: iso(3), text: 'APPLIED x' }, { kind: 'deploy', at: iso(15), unit: 'C' },
  ] })], iso(30));
  const ROWS = [
    ['newest first, with live state words', () => landedSince(units, since, null), (g) => g.rows.map((r) => `${r.unit}:${r.state}`), ['A:deployed', 'B:not deployed yet']],
    ['also is null when the feed is down', () => landedSince(units, since, null), (g) => g.also, null],
    ['also: deploys and decisions after the mark, newest first, landings left to the list', () => landedSince(units, since, marks), (g) => g.also.map((m) => m.kind), ['deploy', 'decide']],
    ['a feed window that starts after the mark is partial', () => landedSince(units, since, feed([], iso(4))), (g) => g.alsoPartial, true],
    ['a feed window that covers the mark is not', () => landedSince(units, since, marks), (g) => g.alsoPartial, false],
    ['no earlier visit recorded is null', () => landedSince(units, null, marks), (g) => g, null],
    ['index down is null', () => landedSince(null, since, marks), (g) => g, null],
  ];
  it('rows', () => { for (const [name, run, pick, want] of ROWS) assert.deepEqual(pick(run()), want, name); });
});

describe('phoneLines', () => {
  const idx = index([unit('W', { lane: 'b', waiting: 'review', title: 'Waiting one' }), unit('X', { lane: 'c', waiting: 'owner' })]);
  const lanes = feed([
    lane('a', { current: { id: 'U1', title: 'Search', since: iso(1) }, eta: { p50: '9h', p80: '32h', raw: 'ESTIMATE a P50 9h P80 32h chain 1 units 76 width 51 basis a n=500 as_of 2026-10-31T20:14' } }),
    lane('f', { current: { id: 'U9', title: `${'Long title '.repeat(12)}` }, eta: { p50: '2026-11-01T02:00:00-07:00' } }),
    lane('g', { current: { id: 'U8', title: 'Soon' }, eta: { p50: '2026-11-03T12:00:00-07:00' } }),
    lane('b', { eta: { noData: true } }), lane('c'), lane('d', { next: [{ id: 'Q1', title: 'Queued one' }] }), lane('e'),
  ]);
  it('rows', () => {
    const got = phoneLines({ ...lanes, now: '2026-10-31T12:00:00-07:00' }, idx);
    const long = got.find((l) => l.lane === 'f');
    assert.ok(long.text.startsWith('Long title Long title') && long.text.includes('…') && long.text.endsWith('working · ETA 02:00 Sun'), 'a long title is clipped, a time ETA reads like the ribbon\'s');
    assert.match(got.find((l) => l.lane === 'g').text, /· ETA Tue$/, 'a later day reads as a weekday');
    assert.deepEqual(got.filter((l) => !['f', 'g'].includes(l.lane)).map((l) => `${l.lane}: ${l.text}`), [
      'a: Search · working · ETA in 9h',
      'b: Waiting one · waiting on review · ETA no data',
      'c: T-X · waiting on you · ETA unknown',
      'd: Queued one · next up · ETA unknown',
    ]);
    assert.equal(phoneLines(null, idx), null, 'feed down');
    assert.deepEqual(phoneLines(feed([lane('a', { current: { id: 'U1' } })]), null).map((l) => l.text), ['U1 · working · ETA unknown'], 'index down still lists working');
  });
});

describe('words', () => {
  it('rows', () => {
    const at = (d, h) => new Date(2026, 9, d, h, 0).getTime();
    assert.match(sinceWords(at(31, 9), at(31, 12)), /^today \d\d:\d\d$/);
    assert.match(sinceWords(at(30, 18), at(31, 12)), /^yesterday \d\d:\d\d$/);
    assert.doesNotMatch(sinceWords(at(28, 18), at(31, 12)), /today|yesterday/);
    assert.equal(agoWords(NOW - 130 * 60_000, NOW), '2 h 10 m');
    assert.equal(agoWords(NOW - 5 * 60_000, NOW), '5 min');
    assert.equal(agoWords(null, NOW), 'time not recorded');
  });
});

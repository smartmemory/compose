/**
 * notify-cleared.test.js — COMP-COCKPIT-NOTIFY-ACTIONS-1: the pure rules over Compose's notify list. `isCleared`,
 * `ownerAsks(rows, state, now)`, `collect(..., state)`, `bannerText(collected, state, now)`, the snooze presets, the release
 * keys and the ribbon marks. One row table; each row builds its sources and state and checks what the owner would see.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ownerAsks, collect, chipState, bannerText } from '../src/components/cockpit/notify/notifyLogic.js';
import { isCleared, fnv1a, snoozePresets, releaseKeys, ribbonAlerts, tomorrowNine, actionClassOf } from '../src/components/cockpit/notify/notifyState.js';
import { fleetPills } from '../src/components/cockpit/fleetLogic.js';
import { whatCounts } from '../src/components/cockpit/what/whatRules.js';

const NOW = Date.parse('2026-10-31T21:00:00.000Z');
const iso = (dh) => new Date(NOW + dh * 3_600_000).toISOString();
const q = (id, text, over = {}) => ({ id, text, by: 'x', age: 600, red: false, error: null, ...over });
const SEC_TEXT = 'SECURITY: token in history';
const QUEUE = [q('S1', SEC_TEXT, { age: 9000 }), q('A1', 'QUESTION: ship it? (a) yes (b) no'), q('F1', 'FYI: moved')];
const fleetOf = ({ queue = QUEUE, sessions = [], free = 500 } = {}) => ({
  generated: new Date(NOW).toISOString(),
  sources: { sm_status: { value: { queue: { value: queue, error: null }, sessions: { value: sessions, error: null }, df: { value: { free_gb: free }, error: null } }, error: null } },
});
const OK = { value: { state: 'ok' }, error: null };
const att = (alerts) => ({ value: { alerts }, error: null });
const WALL = { name: 'seat1 5h', state: 'tripped', value: 99, trip: 95 };
const sources = (over = {}) => ({ fleet: fleetOf(over), outage: over.outage ?? OK, attention: over.attention ?? att([WALL]) });
const st = (entries) => ({ v: 1, entries });
const at = iso(-0.5);
const keys = (rows) => rows.map((r) => r.key);

describe('notify cleared state', () => {
  // [name, () => void]
  const ROWS = [
    ['no state: identical to COUNT-ONE (every row open, nothing cleared)', () => {
      const c = collect(sources(), NOW);
      assert.deepEqual(keys(c.rows), ['security:S1', 'ask:A1', 'attention:seat1 5h']);
      assert.deepEqual(c.cleared, []);
      assert.equal(ownerAsks(QUEUE).n, 2);
      assert.equal(chipState(c).count, 3);
    }],
    ['an acked alert leaves the count and moves into cleared', () => {
      const c = collect(sources(), NOW, st({ 'attention:seat1 5h': { action: 'ack', at } }));
      assert.deepEqual(keys(c.rows), ['security:S1', 'ask:A1']);
      assert.deepEqual(c.cleared.map((r) => [r.key, r.cleared.action]), [['attention:seat1 5h', 'ack']]);
      assert.equal(chipState(c).count, 2);
    }],
    ['a snoozed alert is cleared before until and back once until passes (fake clock)', () => {
      const s = st({ 'attention:seat1 5h': { action: 'snooze', at, until: iso(1) } });
      assert.equal(collect(sources(), NOW, s).cleared.length, 1);
      assert.equal(collect(sources(), NOW + 3_600_000, s).cleared.length, 0);
      assert.equal(collect(sources(), NOW + 3_600_000, s).rows.length, 3);
    }],
    ['a dismissed alert is cleared; a released one is a new alert', () => {
      assert.equal(isCleared('disk', null, st({ disk: { action: 'dismiss', at } }), NOW), true);
      assert.equal(isCleared('disk', null, st({ disk: { action: 'released', was: 'dismiss', at } }), NOW), false);
      const c = collect(sources({ free: 50 }), NOW, st({ disk: { action: 'released', was: 'ack', at } }));
      assert.ok(keys(c.rows).includes('disk'));
    }],
    ['an acked security row still counts, still critical, banner hidden', () => {
      const sec = st({ 'security:S1': { action: 'ack', at, textHash: fnv1a(SEC_TEXT) } });
      assert.equal(isCleared('security:S1', null, sec, NOW), false);
      const c = collect(sources(), NOW, sec);
      assert.equal(chipState(c).count, 3);
      assert.equal(chipState(c).critical, 1);
      assert.equal(bannerText(c, sec), null);
      assert.equal(ownerAsks(QUEUE, sec, NOW).n, 2);
    }],
    ['a security row whose text changed brings the banner back', () => {
      const sec = st({ 'security:S1': { action: 'ack', at, textHash: fnv1a(SEC_TEXT) } });
      const c = collect(sources({ queue: [q('S1', 'SECURITY: token in history, now also in a fork', { age: 9000 })] }), NOW, sec);
      assert.match(bannerText(c, sec).text, /also in a fork/);
    }],
    ['a security row with only an age change keeps the banner hidden', () => {
      const sec = st({ 'security:S1': { action: 'ack', at, textHash: fnv1a(SEC_TEXT) } });
      const c = collect(sources({ queue: [q('S1', SEC_TEXT, { age: 99_999, red: true })] }), NOW, sec);
      assert.equal(bannerText(c, sec), null);
    }],
    ['a new security id brings the banner back and +N counts only unacknowledged rows', () => {
      const sec = st({ 'security:S1': { action: 'ack', at, textHash: fnv1a(SEC_TEXT) } });
      const queue = [q('S1', SEC_TEXT, { age: 9000 }), q('S2', 'CREDENTIAL, rotate', { age: 100 }), q('S3', 'SECURITY: other', { age: 50 })];
      const b = bannerText(collect(sources({ queue }), NOW, sec), sec);
      assert.match(b.text, /rotate/);
      assert.equal(b.more, 1);
    }],
    ['an answered ask leaves ownerAsks, the chip, the WHAT line and the ops pill alike', () => {
      const ans = st({ 'ask:A1': { action: 'answered', at: iso(-0.05), answer: 'OWNER (via cockpit): (b) no' } }); // answered after the row (age 600 s) opened
      assert.deepEqual(ownerAsks(QUEUE, ans, NOW).rows.map((r) => r.id), ['S1']);
      assert.equal(collect(sources(), NOW, ans).rows.filter((r) => r.key.startsWith('ask:')).length, 0);
      assert.equal(whatCounts({ fleet: fleetOf(), now: NOW, notifyState: ans }).waitingYou, 1);
      assert.equal(fleetPills(fleetOf(), ans, NOW).find((p) => p.key === 'fleet:owner').label, '1 owner question');
      assert.equal(fleetPills(fleetOf()).find((p) => p.key === 'fleet:owner').label, '2 owner questions');
    }],
    ['a re-asked id is not hidden by an old answer: answered a day ago, open ask age 60 counts', () => {
      const old = st({ 'ask:A1': { action: 'answered', at: iso(-24), answer: 'OWNER (via cockpit): (b) no' } });
      const queue = [q('A1', 'QUESTION: ship it again?', { age: 60 })];
      assert.equal(ownerAsks(queue, old, NOW).n, 1);
      assert.equal(collect(sources({ queue }), NOW, old).rows.filter((r) => r.key === 'ask:A1').length, 1);
      assert.equal(whatCounts({ fleet: fleetOf({ queue }), now: NOW, notifyState: old }).waitingYou, 1);
    }],
    ['the same record still open (stored ts matches its opened time) stays hidden', () => {
      const ts = NOW / 1000 - 600;
      const ans = st({ 'ask:A1': { action: 'answered', at, ts, answer: 'x' } });
      assert.equal(ownerAsks([q('A1', 'QUESTION: ship it?', { age: 600 })], ans, NOW).n, 0);
      assert.equal(ownerAsks([q('A1', 'QUESTION: ship it?', { age: 630 })], ans, NOW).n, 0, 'age within the cache slack');
    }],
    ['a stored ts that is not this record shows the row, even when answered later than it opened', () => {
      const ans = st({ 'ask:A1': { action: 'answered', at, ts: NOW / 1000 - 90_000, answer: 'x' } });
      assert.equal(ownerAsks([q('A1', 'QUESTION: again?', { age: 600 })], ans, NOW).n, 1);
    }],
    ['a legacy entry (no ts) answered after the row opened hides it; answered before it opened shows it', () => {
      const after = st({ 'ask:A1': { action: 'answered', at: iso(-0.05), answer: 'x' } });
      assert.equal(ownerAsks([q('A1', 'QUESTION: q?', { age: 600 })], after, NOW).n, 0);
      const before = st({ 'ask:A1': { action: 'answered', at: iso(-2), answer: 'x' } });
      assert.equal(ownerAsks([q('A1', 'QUESTION: q?', { age: 600 })], before, NOW).n, 1);
    }],
    ['an old security answer does not silence a re-opened security row banner', () => {
      const old = st({ 'security:S1': { action: 'answered', at: iso(-24), answer: 'x' } });
      const queue = [q('S1', SEC_TEXT, { age: 60 })];
      assert.match(bannerText(collect(sources({ queue }), NOW, old), old, NOW).text, /Security/);
    }],
    ['an answered security row still counts (only the queue drops it)', () => {
      const ans = st({ 'security:S1': { action: 'answered', at, answer: 'OWNER (via cockpit): resolved: rotated' } });
      assert.equal(ownerAsks(QUEUE, ans, NOW).n, 2);
      assert.equal(bannerText(collect(sources(), NOW, ans), ans, NOW), null);
    }],
    ['state unavailable (null) hides nothing', () => {
      const c = collect(sources(), NOW, null);
      assert.equal(chipState(c).count, 3);
      assert.notEqual(bannerText(c, null), null);
    }],
    ['until reset: 5h wall reads five_h, 7d wall reads seven_d, hidden without a seat or with a past reset', () => {
      const seats = [{ id: 'seat1', five_h: { resets_at: iso(2) }, seven_d: { resets_at: iso(50) } }, { id: 'seat2', five_h: { resets_at: iso(-1) } }];
      const wall = (name) => collect(sources({ attention: att([{ name, state: 'tripped' }]) }), NOW).rows.find((r) => r.key === `attention:${name}`);
      const reset = (row) => snoozePresets(row, seats, NOW).find((p) => p.id === 'reset')?.until ?? null;
      assert.equal(reset(wall('seat1 5h')), iso(2));
      assert.equal(reset(wall('seat1 7d')), iso(50));
      assert.equal(reset(wall('cadence lag')), null);
      assert.equal(reset(wall('seat2 5h')), null);
      assert.equal(reset({ key: 'disk', kind: 'disk' }), null);
      assert.deepEqual(snoozePresets({ key: 'disk' }, seats, NOW).map((p) => p.id), ['1h', 'tomorrow']);
      assert.equal(snoozePresets({ key: 'disk' }, seats, NOW).at(-1).until, new Date(tomorrowNine(NOW)).toISOString());
    }],
    ['release: an ack whose source answered without the row; never while that source is down, never for snooze', () => {
      const s = st({ disk: { action: 'ack', at }, 'queue:GONE': { action: 'dismiss', at }, 'queue:F1': { action: 'ack', at }, 'ctx:x': { action: 'snooze', at, until: iso(1) }, outage: { action: 'ack', at } });
      const c = collect(sources(), NOW, s);
      assert.deepEqual(releaseKeys(c, s, QUEUE).sort(), ['disk', 'outage', 'queue:GONE']);
      const down = collect({ fleet: null, outage: { value: null, error: 'x' }, attention: att([]) }, NOW, s);
      assert.deepEqual(releaseKeys(down, s, null), []);
    }],
    ['ribbon: a row age in seconds becomes a time; a cleared row and a gone stored entry draw as cleared', () => {
      const s = st({ 'attention:seat1 5h': { action: 'ack', at, sinceAt: iso(-3) }, outage: { action: 'released', was: 'dismiss', at, title: 'Claude API outage', sinceAt: iso(-2) }, 'queue:F1': { action: 'ack', at } });
      const marks = ribbonAlerts(collect(sources(), NOW, s), s, NOW);
      const by = Object.fromEntries(marks.map((m) => [m.key, m]));
      assert.equal(by['security:S1'].since, new Date(NOW - 9000 * 1000).toISOString());
      assert.equal(by['attention:seat1 5h'].since, iso(-3));
      assert.equal(by['attention:seat1 5h'].cleared.action, 'ack');
      assert.equal(by.outage.since, iso(-2));
      assert.equal(by.outage.cleared.action, 'dismiss');
      assert.equal(by['queue:F1'], undefined);
    }],
    ['actionClassOf: chip keys and inbox groups', () => {
      assert.deepEqual(
        [{ key: 'security:1' }, { key: 'ask:1' }, { key: 'disk' }, { key: 'attention:x' }, { group: 'decided' }, { group: 'fyi' }, { group: 'asks' }, { group: 'security' }].map(actionClassOf),
        ['security', 'ask', 'alert', 'alert', 'info', 'info', 'ask', 'security'],
      );
    }],
  ];
  it('rows', () => {
    for (const [name, run] of ROWS) {
      try { run(); } catch (err) { err.message = `${name}: ${err.message}`; throw err; }
    }
  });
});

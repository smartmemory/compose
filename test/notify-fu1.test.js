/**
 * COMP-COCKPIT-12-FU-1 (NOTIFY-CHIP-1 M1/M2, COUNT-ONE-1 M1): the chip's number is the owner-ask count WHAT and the NOW drawer
 * show, a failed fleet refresh over retained data and a Cadence attention body with `errors` are unavailable sources, never clear.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collect, chipState, chipLabel, ownerAsks, unknownLine, FLEET_UNREADABLE } from '../src/components/cockpit/notify/notifyLogic.js';
import { whatInputs } from '../src/components/cockpit/what/whatRules.js';

const NOW = Date.parse('2026-11-03T06:00:00Z');
const q = (id, text, over = {}) => ({ id, text, by: 'x', age: 600, red: false, error: null, ...over });
// the reviewer's probe: security, overdue ask, ordinary ask, APPLIED, FYI
const QUEUE = [
  q('S1', 'SECURITY: token in history', { age: 9000 }),
  q('A1', 'QUESTION: ship it? (a) yes (b) no', { red: true, age: 7000 }),
  q('A2', 'QUESTION: and this? (a) yes (b) no'),
  q('P1', 'APPLIED: decided for you'),
  q('F1', 'FYI: moved'),
];
const fleetOf = ({ queue = QUEUE, free = 150 } = {}) => ({
  generated: new Date(NOW).toISOString(),
  sources: { sm_status: { value: { queue: { value: queue, error: null }, sessions: { value: [], error: null }, df: { value: { free_gb: free }, error: null } }, error: null } },
});
const OK = { value: { state: 'ok' }, error: null };
const att = (alerts, errors) => ({ value: { alerts, ...(errors ? { errors } : {}) }, error: null });
const rev = { value: { inReview: [], reviewMaxH: 24 }, error: null };
const src = (over = {}) => ({ fleet: fleetOf(over), outage: OK, attention: over.attention ?? att([]), review: rev, ...(over.fleetError !== undefined ? { fleetError: over.fleetError } : {}) });

describe('COUNT-ONE-1 M1: one owner count', () => {
  it('the chip number equals WHAT and the drawer at 150 GB and at 80 GB free, the disk alert shown as its own marker', () => {
    for (const [free, label, others] of [[150, '3 alerts', []], [80, '3 alerts · disk', ['disk']]]) {
      const c = collect(src({ free }), NOW);
      const chip = chipState(c);
      const drawer = ownerAsks(QUEUE, null, NOW).n;
      const what = whatInputs({ fleet: fleetOf({ free }), now: NOW }).ownerCount;
      assert.deepEqual([chip.count, what, drawer], [3, 3, 3], `${free} GB`);
      assert.deepEqual(chip.others, others);
      assert.equal(chipLabel(chip), label);
    }
  });
  it('critical tone still follows any critical row, and with no owner ask the label names the others', () => {
    const c = collect(src({ queue: [], free: 80 }), NOW);
    const chip = chipState(c);
    assert.equal(chip.state, 'alerts');
    assert.equal(chip.count, 0);
    assert.equal(chip.critical, 1);
    assert.equal(chipLabel(chip), 'Alerts: disk');
  });
});

describe('NOTIFY-CHIP-1 M1: a failed fleet refresh over retained data', () => {
  it('is unknown, named, not All clear; a healthy fleet without an error is still All clear', () => {
    const clean = { queue: [], free: 500 };
    assert.equal(chipState(collect(src(clean), NOW)).state, 'all-clear');
    const c = collect(src({ ...clean, fleetError: 'fleet route 502' }), NOW);
    assert.deepEqual(c.unknown, [FLEET_UNREADABLE]);
    assert.equal(chipState(c).state, 'unknown');
    assert.equal(unknownLine(c), 'No alerts from the sources that answered; 1 unavailable');
  });
  it('a first read that failed (no data yet) is not double counted', () => {
    const c = collect({ ...src({ queue: [] }), fleet: null, fleetError: 'fleet route 502' }, NOW);
    assert.equal(c.unknown.includes(FLEET_UNREADABLE), false);
    assert.equal(chipState(c).state, 'unknown');
  });
});

describe('NOTIFY-CHIP-1 M2: Cadence attention with errors', () => {
  it('a 200 body with errors and no alerts is unavailable, not clear', () => {
    const c = collect(src({ queue: [], free: 500, attention: att([], ['cadence page: fixture unavailable']) }), NOW);
    assert.deepEqual(c.unknown, ['cadence attention']);
    assert.equal(chipState(c).state, 'unknown');
  });
  it('partial rows that did come back stay, with the source still named unavailable', () => {
    const c = collect(src({ queue: [], free: 500, attention: att([{ name: 'seat1 5h', state: 'tripped', value: 99, trip: 95 }], ['cadence page: x']) }), NOW);
    assert.equal(c.rows.length, 1);
    assert.deepEqual(c.unknown, ['cadence attention']);
  });
  it('an empty errors list is clean', () => {
    assert.equal(chipState(collect(src({ queue: [], free: 500, attention: att([], []) }), NOW)).state, 'all-clear');
  });
});

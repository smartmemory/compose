/**
 * COMP-COCKPIT-13 U1: pure helpers of the Process view (lib/process-metrics.js). One explicit row table per helper.
 * Naive stamps are LOCAL wall time (the builder's to_local), so their expectations are built with local Date fields.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { freshness, laneRows, laneTimeSplit, timeSplit, toLocal } from '../lib/process-metrics.js';

const Z = (h, m = 0, s = 0, ms = 0) => Date.UTC(2026, 9, 30, h, m, s, ms);
const t = (h, m) => `2026-10-30T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;

describe('toLocal', () => {
  // [stamp, expected epoch ms or null]
  const ROWS = [
    ['Z', '2026-10-30T10:00:00Z', Z(10)],
    ['+08:00 offset', '2026-10-30T10:00:00+08:00', Z(2)],
    ['naive is local wall time', '2026-10-30T10:00:00', new Date(2026, 9, 30, 10, 0, 0).getTime()],
    ['date-only is local midnight, not UTC', '2026-10-30', new Date(2026, 9, 30).getTime()],
    ['no seconds, Z', '2026-10-30T10:00Z', Z(10)],
    ['microseconds with offset', '2026-10-30T10:00:00.250000+02:00', Z(8, 0, 0, 250)],
    ['no seconds, offset', '2026-10-30T10:00+02:00', Z(8)],
    ['garbage', 'yesterday', null],
    ['impossible date', '2026-13-40T10:00:00Z', null],
    ['not a string', 12345, null],
  ];
  for (const [name, stamp, want] of ROWS) it(name, () => assert.equal(toLocal(stamp), want));
});

describe('laneRows', () => {
  const row = { ready_at: t(10, 0) };
  // [name, doc, expected ids, skipped, error?]
  const ROWS = [
    ['units map', { units: { A: row, B: row } }, ['A', 'B'], 0, undefined],
    ['units list with ids', { units: [{ id: 'A', ...row }, { id: 'B', ...row }] }, ['A', 'B'], 0, undefined],
    ['bare list', [{ id: 'A', ...row }], ['A'], 0, undefined],
    ['non-object rows are skipped and counted', { units: { A: row, B: 'oops', C: null } }, ['A'], 2, undefined],
    ['not a stamp document', { hello: 1 }, [], 0, 'no units list or map'],
  ];
  for (const [name, doc, ids, skipped, error] of ROWS) {
    it(name, () => {
      const r = laneRows(doc);
      assert.deepEqual(r.rows.map((x) => x.id), ids);
      assert.equal(r.skipped, skipped);
      assert.equal(r.error, error);
    });
  }
});

describe('timeSplit', () => {
  const base = { ready_at: t(10, 0), landed_at: t(12, 0) };
  const full = {
    ...base,
    dispatched_at: t(10, 10), author_done_at: t(10, 40),
    reviews: [{ round: 1, dispatched_at: t(10, 50), at: t(11, 0) }],
    fix_runs: [{ round: 1, dispatched_at: t(11, 5), done_at: t(11, 15) }],
    gates: [{ n: 1, started_at: t(11, 30), done_at: t(11, 40) }],
  };
  const known = (m) => ({ status: 'known', minutes: { authoring: 30, review: 10, fix_rounds: 10, gate: 10, waiting_owner: 0, waiting: 60, ...m } });
  const unknown = (rule) => ({ status: 'unknown', rule });
  const owner = (start, end) => ({ ...full, owner_waits: [{ qid: 'q', start, end }] });
  const { author_done_at: _a, ...noAuthorDone } = full;
  const { ready_at: _r, ...noReady } = full;

  // [name, row, expected]
  const ROWS = [
    ['full row: exact minutes per bucket, gate time is not waiting', full, known({})],
    ['owner wait inside a gap moves to waiting on owner', owner(t(10, 42), t(10, 48)), known({ waiting_owner: 6, waiting: 54 })],
    ['owner wait overlapping a review: the job wins', owner(t(10, 55), t(11, 10)), known({ waiting_owner: 5, waiting: 55 })],
    ['L1 owner wait straddling landed_at is clipped', owner(t(11, 50), t(12, 30)), known({ waiting_owner: 10, waiting: 50 })],
    ['L1 post-land review with dispatched_at is ignored', { ...full, reviews: [...full.reviews, { kind: 'postland', dispatched_at: t(12, 10), at: t(12, 20) }] }, known({})],
    ['L1 post-land review with `at` only is ignored, unit stays known', { ...full, reviews: [...full.reviews, { kind: 'postland', at: t(12, 20) }] }, known({})],
    ['U-a review `at` without `dispatched_at`', { ...full, reviews: [{ round: 1, at: t(11, 0) }] }, unknown('U-a')],
    ['U-a fix run `done_at` only', { ...full, fix_runs: [{ done_at: t(11, 15) }] }, unknown('U-a')],
    ['U-a gate `done_at` only', { ...full, gates: [{ done_at: t(11, 40) }] }, unknown('U-a')],
    ['U-b open review', { ...full, reviews: [{ round: 1, dispatched_at: t(10, 50) }] }, unknown('U-b')],
    ['U-b open owner wait', owner(t(10, 42), undefined), unknown('U-b')],
    ['U-c legacy fixes[] without fix_runs[]', { ...full, fix_runs: [], fixes: [t(11, 5)] }, unknown('U-c')],
    ['U-d no author_done_at', noAuthorDone, unknown('U-d')],
    ['U-e a stamp toLocal rejects', { ...full, author_done_at: 'not a time' }, unknown('U-e')],
    ['not landed is outside', { ...full, landed_at: undefined }, { status: 'outside' }],
    ['no ready_at is outside', noReady, { status: 'outside' }],
  ];
  for (const [name, row, want] of ROWS) it(name, () => assert.deepEqual(timeSplit(row), want));

  it('laneTimeSplit sums known units only and counts the rest', () => {
    const lane = laneTimeSplit([full, full, noAuthorDone, { ...full, landed_at: undefined }, { ...full, author_done_at: 'x' }]);
    assert.equal(lane.known, 2);
    assert.equal(lane.unknown, 2);
    assert.equal(lane.outside, 1);
    assert.deepEqual(lane.byRule, { 'U-a': 0, 'U-b': 0, 'U-c': 0, 'U-d': 1, 'U-e': 1 });
    assert.deepEqual(lane.minutes, { authoring: 60, review: 20, fix_rounds: 20, gate: 20, waiting_owner: 0, waiting: 120 });
  });
});

describe('freshness', () => {
  const now = 10_000_000;
  // [name, input, expected]
  const ROWS = [
    ['0 s is fresh', { mtimeMs: now }, { ageS: 0, stale: false, failed: null }],
    ['1800 s is fresh', { mtimeMs: now - 1_800_000 }, { ageS: 1800, stale: false, failed: null }],
    ['1801 s is stale', { mtimeMs: now - 1_801_000 }, { ageS: 1801, stale: true, failed: null }],
    ['BUILD-FAILED.txt gives the time and reason', { mtimeMs: now, failedText: '2026-10-30 20:50 local\nbuild raised\n' }, { ageS: 0, stale: false, failed: { time: '2026-10-30 20:50 local', reason: 'build raised' } }],
  ];
  for (const [name, input, want] of ROWS) it(name, () => assert.deepEqual(freshness({ now, ...input }), want));
});

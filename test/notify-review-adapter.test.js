/**
 * notify-review-adapter.test.js — COMP-COCKPIT-TAB-DEPTH-1 F2 (review M1): the post-land review backlog is an inbox row.
 * One red row per group over `reviewMaxH`; a group under it makes none; a failed read is `unavailable`, never an empty list.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reviewAdapter, collect, chipState } from '../src/components/cockpit/notify/notifyLogic.js';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const H = 3_600_000;
const group = (id, lane, ageH, over = {}) => ({ id, lane, rows: ['U1@2026-10-31', 'U2@2026-10-31'], dispatchedAt: new Date(NOW - ageH * H).toISOString(), ageMs: ageH * H, overdue: ageH * H > 24 * H, ...over });
const ok = (inReview) => ({ value: { generatedAt: '', reviewMaxH: 24, inReview, inReviewByLane: {}, ungrouped: { count: 0, oldestLanded: null }, errors: [] }, error: null });

describe('reviewAdapter', () => {
  it('a group over 24 h is one red row with its lane and age', () => {
    const { rows, unavailable } = reviewAdapter(ok([group('g1', 'forge-main', 30)]), NOW);
    assert.equal(unavailable, null);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'review');
    assert.equal(rows[0].severity, 'critical');
    assert.equal(rows[0].lane, 'forge-main');
    assert.equal(rows[0].since, 30 * 3600);
    assert.match(rows[0].title, /over 24 h: forge-main/);
  });
  it('one row per group over the limit, none for a group under it', () => {
    const { rows } = reviewAdapter(ok([group('g1', 'a', 30), group('g2', 'b', 5), group('g3', 'b', 49)]), NOW);
    assert.deepEqual(rows.map((r) => r.key), ['review:g1', 'review:g3']);
  });
  it('groups under 24 h make no row and the source answered', () => {
    assert.deepEqual(reviewAdapter(ok([group('g1', 'a', 23)]), NOW), { rows: [], unavailable: null });
  });
  it('an empty backlog is clear, not unavailable', () => {
    assert.deepEqual(reviewAdapter(ok([]), NOW), { rows: [], unavailable: null });
  });
  it('a failed read, a missing body and a body with no inReview list are unavailable', () => {
    for (const bad of [{ value: null, error: 'HTTP 500' }, null, { value: {}, error: null }, { value: { inReview: 'x' }, error: null }]) {
      assert.deepEqual(reviewAdapter(bad, NOW), { rows: [], unavailable: 'post-land review' });
    }
  });
  it('a group with no age but overdue true still rows (age from dispatchedAt is optional)', () => {
    const { rows } = reviewAdapter(ok([group('g1', 'a', 30, { ageMs: null, dispatchedAt: null })]), NOW);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].since, null);
  });
});

describe('collect with the review source', () => {
  const base = { fleet: { generated: '', sources: { sm_status: { value: { queue: { value: [], error: null }, sessions: { value: [], error: null }, df: { value: { free_gb: 500 }, error: null } }, error: null } } }, outage: { value: { state: 'ok' }, error: null }, attention: { value: { alerts: [] }, error: null } };
  it('an overdue group is a critical chip row', () => {
    const c = collect({ ...base, review: ok([group('g1', 'forge-main', 30)]) }, NOW);
    assert.equal(c.rows.length, 1);
    assert.deepEqual(chipState(c), { state: 'alerts', count: 0, critical: 1, unavailable: 0, others: ['review'] }); // a review is not an owner ask
  });
  it('a failed review read makes the chip unknown, not all clear', () => {
    const c = collect({ ...base, review: { value: null, error: 'HTTP 500' } }, NOW);
    assert.deepEqual(c.unknown, ['post-land review']);
    assert.equal(chipState(c).state, 'unknown');
  });
});

/**
 * COMP-DAYVIEW-DESIGN-FIX-1 U3-DATA: one rule for stamp vs queue owner time (U2 review F1 + U2 author F2), and `safeReason`
 * on a quoted home path (U2-DATA post-land M2). The spans are asserted, not a count.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileOwnerSpans, OWNER_MATCH_TOLERANCE_MS } from '../lib/owner-spans.js';
import { safeReason } from '../lib/ribbon-feed.js';

const AS_OF = Date.parse('2026-11-03T14:00:00Z');
const stamp = (unit, start, end, over = {}) => ({ kind: 'wait', cause: 'owner', unit, start, end, open: false, ...over });
const ask = (unit, start, end, over = {}) => ({ kind: 'wait', cause: 'owner', unit, queueId: `q-${unit}`, start, end, since: start, ...over });
const win = (s) => s.map((x) => [x.unit, x.start.slice(11, 16), x.end.slice(11, 16), x.open ?? null, x.queueId ?? null]);

describe('reconcileOwnerSpans: a stamp is matched to its ask by identity, never by time overlap', () => {
  it('the review repro: a 4 h stamp for X and a 5 min ask for Y on one lane keep both', () => {
    const x = stamp('X', '2026-11-03T10:00:00Z', '2026-11-03T14:00:00Z');
    const y = ask('Y', '2026-11-03T13:50:00Z', '2026-11-03T13:55:00Z');
    assert.deepEqual(win(reconcileOwnerSpans([x, y], { asOf: AS_OF })), [['X', '10:00', '14:00', false, null], ['Y', '13:50', '13:55', null, 'q-Y']]);
  });
  it('a stamp partly covered by its own ask keeps the part after its ask closed, the queue draws the covered part', () => {
    const s = stamp('X', '2026-11-03T09:00:00Z', '2026-11-03T12:00:00Z', { since: '2026-11-03T09:00:00Z' });
    const q = ask('X', '2026-11-03T09:00:00Z', '2026-11-03T11:00:00Z');
    assert.deepEqual(win(reconcileOwnerSpans([s, q], { asOf: AS_OF })), [['X', '11:00', '12:00', false, null], ['X', '09:00', '11:00', null, 'q-X']]);
  });
  it('a stamp fully under its own ask (start inside the tolerance) is drawn once, by the queue', () => {
    const s = stamp('X', '2026-11-03T09:00:00Z', '2026-11-03T11:00:00Z');
    const q = ask('X', new Date(Date.parse('2026-11-03T09:00:00Z') + OWNER_MATCH_TOLERANCE_MS - 1000).toISOString().replace('.000Z', 'Z'), '2026-11-03T11:00:00Z');
    const got = reconcileOwnerSpans([s, q], { asOf: AS_OF });
    assert.deepEqual(got.map((x) => [x.start, x.end, x.queueId ?? null]), [['2026-11-03T09:00:00.000Z', q.start.replace('Z', '.000Z'), null], [q.start, '2026-11-03T11:00:00Z', 'q-X']]);
  });
  it('the same unit with a start far from the ask is a different ask: no match, the stamp stays whole', () => {
    const s = stamp('X', '2026-11-03T08:00:00Z', '2026-11-03T12:00:00Z');
    const q = ask('X', '2026-11-03T10:00:00Z', '2026-11-03T11:00:00Z');
    assert.deepEqual(win(reconcileOwnerSpans([s, q], { asOf: AS_OF })), [['X', '08:00', '12:00', false, null], ['X', '10:00', '11:00', null, 'q-X']]);
  });
});

describe('reconcileOwnerSpans: an open stamp with no queue record', () => {
  it('is clipped at the queue read (asOf) and no longer open', () => {
    const s = stamp('X', '2026-11-03T08:00:00Z', '2026-11-03T14:30:00Z', { open: true });
    assert.deepEqual(win(reconcileOwnerSpans([s], { asOf: AS_OF })), [['X', '08:00', '14:00', false, null]]);
  });
  it('an open stamp whose own ask is in the queue leaves only the time the queue does not cover', () => {
    const s = stamp('X', '2026-11-03T08:00:00Z', '2026-11-03T14:00:00Z', { open: true });
    const q = ask('X', '2026-11-03T08:00:00Z', '2026-11-03T14:00:00Z');
    assert.deepEqual(win(reconcileOwnerSpans([s, q], { asOf: AS_OF })), [['X', '08:00', '14:00', null, 'q-X']]);
  });
});

describe('reconcileOwnerSpans: an unreadable queue', () => {
  it('keeps every stamp span exactly as it is (open stays open), the reason lives in sourceErrors.ownerQueue', () => {
    const s = stamp('X', '2026-11-03T08:00:00Z', '2026-11-03T14:30:00Z', { open: true });
    assert.deepEqual(reconcileOwnerSpans([s], { asOf: null }), [s]);
  });
});

describe('safeReason: a quoted home path goes whole, an unquoted one up to the first space', () => {
  it('quoted path with spaces', () => assert.equal(safeReason("ENOENT: open '/Users/A B/x y/z'"), "ENOENT: open 'z'"));
  it('quoted ~/ path with spaces', () => assert.equal(safeReason('ENOENT: open "~/My Dir/a b.json"'), 'ENOENT: open "a b.json"'));
  it('unquoted path stops at the space', () => assert.equal(safeReason('cannot read /Users/a/f.json now'), 'cannot read f.json now'));
  it('unquoted ~/ path', () => assert.equal(safeReason('cannot read ~/x/y.json now'), 'cannot read y.json now'));
});

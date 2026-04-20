import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  branchDecisionEventId,
  shouldEmit,
} from '../../server/decision-event-id.js';

describe('branchDecisionEventId', () => {
  it('is deterministic across calls', () => {
    const a = branchDecisionEventId('COMP-OBS-BRANCH', 'branch-xyz');
    const b = branchDecisionEventId('COMP-OBS-BRANCH', 'branch-xyz');
    assert.equal(a, b);
  });

  it('differs by branch_id', () => {
    const a = branchDecisionEventId('COMP-OBS-BRANCH', 'b1');
    const b = branchDecisionEventId('COMP-OBS-BRANCH', 'b2');
    assert.notEqual(a, b);
  });

  it('differs by feature_code', () => {
    const a = branchDecisionEventId('FEAT-A', 'branch-xyz');
    const b = branchDecisionEventId('FEAT-B', 'branch-xyz');
    assert.notEqual(a, b);
  });

  it('returns a uuid string', () => {
    const id = branchDecisionEventId('F', 'b1');
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('shouldEmit', () => {
  it('returns true when id is not in the set', () => {
    assert.equal(shouldEmit('id-1', new Set(['id-2'])), true);
  });

  it('returns false when id is in the set', () => {
    assert.equal(shouldEmit('id-1', new Set(['id-1', 'id-2'])), false);
  });

  it('accepts an array as the second arg', () => {
    assert.equal(shouldEmit('id-1', ['id-1']), false);
    assert.equal(shouldEmit('id-3', ['id-1', 'id-2']), true);
  });

  it('handles null/undefined emittedSet as empty', () => {
    assert.equal(shouldEmit('id-1', null), true);
    assert.equal(shouldEmit('id-1', undefined), true);
  });
});

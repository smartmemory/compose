import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { shouldUseServerDispatch } from '../lib/build.js';

describe('shouldUseServerDispatch routing', () => {
  beforeEach(() => { delete process.env.COMPOSE_SERVER_DISPATCH; });
  afterEach(()  => { delete process.env.COMPOSE_SERVER_DISPATCH; });

  it('returns false when flag unset', () => {
    assert.equal(shouldUseServerDispatch({ isolation: 'none' }), false);
    assert.equal(shouldUseServerDispatch({ isolation: 'worktree' }), false);
    assert.equal(shouldUseServerDispatch({}), false);
  });

  it('returns true for flag=1 + isolation=none', () => {
    process.env.COMPOSE_SERVER_DISPATCH = '1';
    assert.equal(shouldUseServerDispatch({ isolation: 'none' }), true);
  });

  it('returns false for flag=1 + isolation=worktree (fall-through)', () => {
    process.env.COMPOSE_SERVER_DISPATCH = '1';
    assert.equal(shouldUseServerDispatch({ isolation: 'worktree' }), false);
  });

  it('returns false for flag=1 + isolation omitted (default worktree)', () => {
    process.env.COMPOSE_SERVER_DISPATCH = '1';
    assert.equal(shouldUseServerDispatch({}), false);
  });

  it('returns false for flag=1 + isolation=branch (Stratum rejects it anyway)', () => {
    process.env.COMPOSE_SERVER_DISPATCH = '1';
    assert.equal(shouldUseServerDispatch({ isolation: 'branch' }), false);
  });

  it('returns false for flag values other than "1"', () => {
    process.env.COMPOSE_SERVER_DISPATCH = 'true';
    assert.equal(shouldUseServerDispatch({ isolation: 'none' }), false);
    process.env.COMPOSE_SERVER_DISPATCH = '0';
    assert.equal(shouldUseServerDispatch({ isolation: 'none' }), false);
  });
});

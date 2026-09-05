// COMP-LIFECYCLE-BACKFILL S1 — one REAL stratum CLI round trip for a new guard
// verb, so the wire-shape tests (which mock execFile) cannot hide a dead seam.
// `guard policy` on an unregistered resource is read-only and needs no key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { guardPolicy } from '../server/stratum-client.js';
import { isGuardError, guardErrorType } from '../server/lifecycle-guard.js';

test('guardPolicy over the real stratum CLI returns the canonical guard_not_found envelope', async () => {
  const res = await guardPolicy('compose:0000000000000000:NO-SUCH-FEATURE-S1-REAL');
  assert.equal(res.status, 'error', JSON.stringify(res));
  assert.equal(res.error_type, 'guard_not_found');
  assert.equal(typeof res.message, 'string');
  assert.equal(isGuardError(res), true);
  assert.equal(guardErrorType(res), 'guard_not_found');
});

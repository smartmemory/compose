/**
 * build-ship-gate.test.js — COMP-ROADMAP-PLAN T3 (S8).
 *
 * The `stepId === 'ship'` interception in runBuild runs executeShipStep (the
 * git stage/commit/audit path). That is build/fix-specific. It must be gated so
 * it runs ONLY when mode !== 'plan':
 *   - build & bug (fix) STILL hit executeShipStep (bug-fix DEPENDS on it, even
 *     though fix is tracksFeatureJson:false — so the gate must NOT key off
 *     tracksFeatureJson).
 *   - plan's `ship` step must fall through to normal agent-step execution.
 *
 * Tested via the exported pure predicate `shouldInterceptShip(stepId, mode)`,
 * which is the gate condition used at the call site.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIB_DIR = `${REPO_ROOT}/lib`;

const { shouldInterceptShip } = await import(`${LIB_DIR}/build.js`);

test('T3a: build & bug ship steps DO hit executeShipStep (interception on)', () => {
  // runBuild uses runtime tokens feature|bug|plan for `mode`.
  assert.equal(shouldInterceptShip('ship', 'feature'), true, 'build/feature ship is intercepted');
  assert.equal(shouldInterceptShip('ship', 'bug'), true, 'bug/fix ship is intercepted (depends on it)');
});

test('T3b: plan ship step does NOT hit executeShipStep (falls through to agent step)', () => {
  assert.equal(shouldInterceptShip('ship', 'plan'), false, 'plan ship is NOT intercepted');
});

test('T3c: non-ship steps are never intercepted, regardless of mode', () => {
  for (const mode of ['feature', 'bug', 'plan']) {
    assert.equal(shouldInterceptShip('explore_design', mode), false);
    assert.equal(shouldInterceptShip('design', mode), false);
    assert.equal(shouldInterceptShip('blueprint', mode), false);
  }
});

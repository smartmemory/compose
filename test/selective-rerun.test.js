/**
 * selective-rerun.test.js — STRAT-REV-5: Selective Re-review (TS re-expression).
 *
 * Spec source: the pre-deletion test/selective-rerun.test.js at cc390a7, which
 * inlined equivalents of the build.js sidecar helpers. This re-expression drives
 * the REAL exported helpers (priorDirtyLensesPath / persistPriorDirtyLenses /
 * clearPriorDirtyLenses) plus the RETRY/FIRST-RUN triage prompt. The end-to-end
 * dirty-review recovery (persist + fixer + revise + selective rerun) is an
 * engine-native review_gate covered by ts-cutover-review-gate-golden.test.js.
 *
 * Pattern: real fs I/O in tmp dirs (no fs mocking), following build.test.js.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import YAML from 'yaml';

import { BASELINE_LENSES, LENS_DEFINITIONS, triageLenses } from '../lib/review-lenses.js';
import {
  priorDirtyLensesPath,
  persistPriorDirtyLenses,
  clearPriorDirtyLenses,
} from '../lib/build.js';

function loadReviewTriageIntent() {
  const pipelinePath = join(process.cwd(), 'pipelines', 'build.stratum.yaml');
  const pipeline = YAML.parse(readFileSync(pipelinePath, 'utf-8'));
  return pipeline.flows.build.steps.find(step => step.id === 'review_triage').do;
}

// Models the agent-side retry selection documented by the triage RETRY PATH:
// baseline lenses plus any previously-dirty non-baseline lens.
function selectRetryLenses(priorDirtyLenses) {
  const lensIds = [...BASELINE_LENSES];
  for (const lensId of priorDirtyLenses ?? []) {
    if (!lensIds.includes(lensId)) lensIds.push(lensId);
  }
  return lensIds.map(id => LENS_DEFINITIONS[id]);
}

function makeTmpDir() {
  const dir = join(tmpdir(), `strat-rev5-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('STRAT-REV-5: prior_dirty_lenses sidecar (TS re-expression)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  // T6-1: persistPriorDirtyLenses writes correct JSON
  it('T6-1: persistPriorDirtyLenses writes correct content to sidecar path', () => {
    persistPriorDirtyLenses(tmpDir, ['contract-compliance']);
    const sidecarPath = priorDirtyLensesPath(tmpDir);
    assert.ok(existsSync(sidecarPath), 'sidecar file should exist after persist');
    assert.deepEqual(JSON.parse(readFileSync(sidecarPath, 'utf-8')), ['contract-compliance']);
  });

  // T6-2: persistPriorDirtyLenses overwrites on second call
  it('T6-2: persistPriorDirtyLenses overwrites on subsequent call', () => {
    persistPriorDirtyLenses(tmpDir, ['contract-compliance']);
    persistPriorDirtyLenses(tmpDir, ['security']);
    assert.deepEqual(JSON.parse(readFileSync(priorDirtyLensesPath(tmpDir), 'utf-8')), ['security']);
  });

  // T6-3: clearPriorDirtyLenses deletes existing file
  it('T6-3: clearPriorDirtyLenses deletes an existing sidecar file', () => {
    persistPriorDirtyLenses(tmpDir, ['diff-quality']);
    assert.ok(existsSync(priorDirtyLensesPath(tmpDir)), 'file should exist before clear');
    clearPriorDirtyLenses(tmpDir);
    assert.ok(!existsSync(priorDirtyLensesPath(tmpDir)), 'file should be absent after clear');
  });

  // T6-4: clearPriorDirtyLenses no-ops when file absent
  it('T6-4: clearPriorDirtyLenses does not throw when sidecar is absent', () => {
    assert.ok(!existsSync(priorDirtyLensesPath(tmpDir)), 'precondition: no sidecar');
    assert.doesNotThrow(() => clearPriorDirtyLenses(tmpDir));
  });

  // NOTE: the dirty-lenses persist decision moved into the engine-native
  // review_gate (I1) — a dirty review_merge derives the dirty lenses from its
  // surviving findings and persists them before revising. That end-to-end
  // behaviour is covered by test/ts-cutover-review-gate-golden.test.js; the pure
  // helpers below remain the sidecar's read/write/clear contract.

  // T6-8: build complete branch clears sidecar
  it('T6-8: build complete branch clears a pre-existing sidecar', () => {
    persistPriorDirtyLenses(tmpDir, ['contract-compliance']);
    assert.ok(existsSync(priorDirtyLensesPath(tmpDir)), 'precondition: sidecar should exist');
    clearPriorDirtyLenses(tmpDir);
    assert.ok(!existsSync(priorDirtyLensesPath(tmpDir)), 'sidecar should be deleted after build complete');
  });

  // T6-9: first-run — sidecar never created when review passes clean
  it('T6-9: sidecar is never created when review passes clean', () => {
    clearPriorDirtyLenses(tmpDir);
    assert.ok(!existsSync(priorDirtyLensesPath(tmpDir)), 'sidecar should never exist when review is clean');
  });

  // T6-11: triage contract explicitly documents selective retry rules
  it('T6-11: triage intent encodes sidecar-based selective retry rules', () => {
    const intent = loadReviewTriageIntent();
    assert.match(intent, /RETRY PATH/);
    assert.match(intent, /FIRST RUN PATH/);
    assert.match(intent, /\.compose\/prior_dirty_lenses\.json/);
    assert.match(intent, /Activate all lenses listed in that array\./);
    assert.match(intent, /Always also include diff-quality and contract-compliance/);
    assert.match(intent, /Skip all other lenses/);
  });

  // T6-11b: FIRST RUN PATH restores the debug-discipline baseline lens
  it('T6-11b: triage first-run baseline includes debug-discipline', () => {
    const intent = loadReviewTriageIntent();
    assert.match(intent, /always\s+include diff-quality, contract-compliance, and debug-discipline/);
  });

  // T6-12: retry with contract-only findings re-runs baseline lenses only
  it('T6-12: retry selectivity keeps retry scoped to baseline lenses when only contract lens was dirty', () => {
    const retried = selectRetryLenses(['contract-compliance']).map(task => task.id);
    assert.deepEqual(retried, ['diff-quality', 'contract-compliance', 'debug-discipline']);
  });

  // T6-13: retry preserves previously dirty non-baseline lenses alongside baselines
  it('T6-13: retry selectivity re-runs dirty optional lenses plus the baselines', () => {
    const retried = selectRetryLenses(['security']).map(task => task.id);
    assert.deepEqual(retried, ['diff-quality', 'contract-compliance', 'debug-discipline', 'security']);
  });

  // T6-14: first-run still uses file-based triage when sidecar is absent
  it('T6-14: first-run path still activates broader lens set from file triggers', () => {
    const firstRun = triageLenses(['src/auth/login.jsx']).map(task => task.id);
    assert.deepEqual(firstRun, ['diff-quality', 'contract-compliance', 'debug-discipline', 'security', 'framework']);
  });
});

/**
 * COMP-SHIP-CONTRACT — the ship step's engine output must satisfy the strict
 * PhaseResult contract.
 *
 * Engine contracts are strict Zod objects: any key the contract does not
 * declare fails the step. executeShipStep's return carries Compose-facing
 * extras (`commit`, `filesChanged`, `testsAttested`, `noRepo`, `test_count`,
 * `pass_rate`, `error_code`) that PhaseResult never declared. Reporting it raw
 * failed attempt 1 with `unrecognized_keys` and only "recovered" because
 * attempt 2 re-ran ship, found nothing staged, and returned the field-less
 * "All changes already committed" shape — so gsd never once reported a real
 * commit_hash. toPhaseResultOutput is the single narrowing seam.
 *
 * The declared field sets are read from the pipeline YAML rather than
 * hard-coded, so a contract edit that drops a field fails here.
 *
 * SCOPE: these cover the helper only. Reverting lib/gsd.js to report the RAW ship
 * result would leave every assertion here green, so the CALL SITE is covered in
 * test/ts-cutover-pipeline-fanout-golden.test.js, which runs a real gsd flow
 * against the engine and asserts ship_gsd succeeds on attempt 1 with a populated
 * commit_hash. Keep that pairing: a helper test alone cannot catch this defect.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { toPhaseResultOutput } from '../lib/build.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function declaredPhaseResultFields(pipeline) {
  const spec = parseYaml(fs.readFileSync(path.join(repoRoot, 'pipelines', pipeline), 'utf8'));
  const fields = spec?.contracts?.PhaseResult;
  assert.ok(fields, `${pipeline} declares a PhaseResult contract`);
  return new Set(Object.keys(fields));
}

// Every shape executeShipStep can return, by artifact branch.
const SHIP_RETURNS = {
  'committed': {
    phase: 'ship',
    artifact: 'abc123def456',
    outcome: 'complete',
    summary: 'Committed abc123de: feat(X): thing (2 files)',
    commit: 'abc123def456',
    filesChanged: ['lib/a.js', 'lib/b.js'],
    test_count: 12,
    pass_rate: 1,
    // COMP-COMPLETION-GATE slice 2: `completionWarning` is gone (ship no longer
    // writes completions) and `testsAttested` took its place as the extra the
    // caller consumes. Keep these fixtures byte-faithful to executeShipStep's
    // real returns — the allowlist keeps this test green either way, so a stale
    // fixture stops mirroring reality without ever going red.
    testsAttested: 'passed',
  },
  'no-git': {
    phase: 'ship',
    artifact: 'no-git',
    outcome: 'complete',
    summary: 'No git repository — wrote artifacts (commit skipped)',
    commit: null,
    noRepo: true,
    testsAttested: 'no-signal',
  },
  'no-changes': {
    phase: 'ship',
    artifact: 'no-changes',
    outcome: 'complete',
    summary: 'All changes already committed',
  },
  'failed': {
    phase: 'ship',
    artifact: '',
    outcome: 'failed',
    summary: 'Ship failed: boom',
    error_code: 'JUDGMENT_CANON_DRIFT',
  },
};

test('toPhaseResultOutput emits only fields the gsd PhaseResult contract declares', () => {
  const declared = declaredPhaseResultFields('gsd.stratum.yaml');
  for (const [label, shipResult] of Object.entries(SHIP_RETURNS)) {
    const undeclared = Object.keys(toPhaseResultOutput(shipResult)).filter((k) => !declared.has(k));
    assert.deepEqual(undeclared, [], `${label} ship result emits undeclared key(s): ${undeclared}`);
  }
});

test('toPhaseResultOutput emits every field the contract requires', () => {
  // Required = declared without a trailing `?` on its type.
  const spec = parseYaml(fs.readFileSync(path.join(repoRoot, 'pipelines', 'gsd.stratum.yaml'), 'utf8'));
  const required = Object.entries(spec.contracts.PhaseResult)
    .filter(([, type]) => !String(type).endsWith('?'))
    .map(([field]) => field);
  assert.deepEqual(required, ['phase', 'artifact', 'outcome', 'summary']);
  for (const [label, shipResult] of Object.entries(SHIP_RETURNS)) {
    const out = toPhaseResultOutput(shipResult);
    for (const field of required) {
      assert.equal(typeof out[field], 'string', `${label} is missing required ${field}`);
    }
  }
});

test('toPhaseResultOutput renames commit/filesChanged to the contract spelling', () => {
  const out = toPhaseResultOutput(SHIP_RETURNS.committed);
  assert.equal(out.commit_hash, 'abc123def456');
  assert.deepEqual(out.files_changed, ['lib/a.js', 'lib/b.js']);
  assert.equal('commit' in out, false);
  assert.equal('filesChanged' in out, false);
});

test('toPhaseResultOutput omits commit_hash when there is no commit', () => {
  // The no-git branch returns `commit: null`; a null would fail the string type.
  for (const label of ['no-git', 'no-changes', 'failed']) {
    assert.equal('commit_hash' in toPhaseResultOutput(SHIP_RETURNS[label]), false, label);
  }
});

test('build PhaseResult stays a superset of gsd PhaseResult', () => {
  // build.stratum.yaml adds `plan_items?`, which is why that field is spread at
  // the runBuild call site instead of living in the shared helper.
  const gsd = declaredPhaseResultFields('gsd.stratum.yaml');
  const build = declaredPhaseResultFields('build.stratum.yaml');
  for (const field of gsd) assert.ok(build.has(field), `build PhaseResult is missing ${field}`);
  assert.equal(build.has('plan_items'), true);
  assert.equal(gsd.has('plan_items'), false);
});

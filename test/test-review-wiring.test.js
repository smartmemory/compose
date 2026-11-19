/**
 * Structural tests for the COMP-TEST-BOOTSTRAP-4-1 test_review wiring (re-ordered by
 * COMP-SETUP-PREFLIGHT-1: coverage, reviews, retest, then test_review)
 * in pipelines/build.stratum.yaml. A full proof-run is heavy; these assert the
 * pipeline topology directly. Run with: node --test test/test-review-wiring.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import YAML from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const spec = YAML.parse(
  readFileSync(join(__dirname, '..', 'pipelines', 'build.stratum.yaml'), 'utf-8')
);

describe('build flow wiring', () => {
  const steps = spec.flows.build.steps;
  const ids = steps.map(s => s.id);
  const byId = Object.fromEntries(steps.map(s => [s.id, s]));

  // COMP-SETUP-PREFLIGHT-1 (fe73e0a5, 89c6a000): tests run before any paid review, and code a
  // review fixer changed is re-tested (retest) before test_review. The old pin was coverage ->
  // test_review; the intended order is now coverage -> reviews -> codex_review -> retest -> test_review.
  it('runs coverage before every review step, and retest between codex_review and test_review', () => {
    const at = (id) => { const i = ids.indexOf(id); assert.ok(i >= 0, `${id} step exists`); return i; };
    for (const r of ['review_triage', 'review_lenses', 'review_merge', 'review_gate', 'codex_review']) {
      assert.ok(at('coverage') < at(r), `coverage runs before ${r}`);
    }
    assert.deepEqual(byId.review_triage.after, ['coverage'], 'the first review step waits on coverage');
    assert.equal(ids[at('codex_review') + 1], 'retest', 'retest immediately follows codex_review');
    assert.deepEqual(byId.retest.after, ['codex_review']);
    assert.equal(ids[at('retest') + 1], 'test_review', 'test_review immediately follows retest');
  });

  it('test_review is a flattened advisory step after retest', () => {
    assert.deepEqual(byId.test_review.after, ['retest']);
    assert.ok(!('run' in byId.test_review), 'test_review must not invoke a blocking subflow');
    assert.ok(!('out' in byId.test_review), 'test_review must not declare a blocking output contract');
    assert.ok(!('ensure' in byId.test_review), 'test_review must not declare a blocking ensure');
  });

  it('report now depends on test_review (re-pointed from coverage)', () => {
    assert.deepEqual(byId.report.after, ['test_review']);
  });
});

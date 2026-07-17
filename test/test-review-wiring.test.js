/**
 * Structural tests for the COMP-TEST-BOOTSTRAP-4-1 post-coverage test_review wiring
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

  it('runs test_review between coverage and report', () => {
    const i = ids.indexOf('coverage');
    assert.ok(i >= 0, 'coverage step exists');
    assert.equal(ids[i + 1], 'test_review', 'test_review immediately follows coverage');
  });

  it('test_review is a flattened advisory step after coverage', () => {
    assert.deepEqual(byId.test_review.after, ['coverage']);
    assert.ok(!('run' in byId.test_review), 'test_review must not invoke a blocking subflow');
    assert.ok(!('out' in byId.test_review), 'test_review must not declare a blocking output contract');
    assert.ok(!('ensure' in byId.test_review), 'test_review must not declare a blocking ensure');
  });

  it('report now depends on test_review (re-pointed from coverage)', () => {
    assert.deepEqual(byId.report.after, ['test_review']);
  });
});

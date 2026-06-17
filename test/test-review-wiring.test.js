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

describe('test_review flow (COMP-TEST-BOOTSTRAP-4-1)', () => {
  it('defines a test_review sub-flow returning ReviewResult', () => {
    const f = spec.flows.test_review;
    assert.ok(f, 'flows.test_review must exist');
    assert.equal(f.output, 'ReviewResult');
    assert.equal(f.steps.length, 1, 'single review step');
  });

  it('is ADVISORY — its review step has neither ensure nor output_contract', () => {
    // Both would route a bad/clean-but-flagged result through executeChildFlow's
    // blocking fix-retry path, which (via report→docs→ship) could block ship.
    const step = spec.flows.test_review.steps[0];
    assert.ok(!('ensure' in step), 'test_review step must not declare a blocking ensure');
    assert.ok(!('output_contract' in step), 'test_review step must not declare an output_contract (schema_failed is a blocking path)');
  });
});

describe('build flow wiring', () => {
  const steps = spec.flows.build.steps;
  const ids = steps.map(s => s.id);
  const byId = Object.fromEntries(steps.map(s => [s.id, s]));

  it('runs test_review between coverage and report', () => {
    const i = ids.indexOf('coverage');
    assert.ok(i >= 0, 'coverage step exists');
    assert.equal(ids[i + 1], 'test_review', 'test_review immediately follows coverage');
  });

  it('test_review invokes the test_review flow and depends on coverage', () => {
    assert.equal(byId.test_review.flow, 'test_review');
    assert.deepEqual(byId.test_review.depends_on, ['coverage']);
  });

  it('report now depends on test_review (re-pointed from coverage)', () => {
    assert.deepEqual(byId.report.depends_on, ['test_review']);
  });
});

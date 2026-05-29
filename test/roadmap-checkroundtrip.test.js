import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateRoadmapFromBase } from '../lib/roadmap-gen.js';

const FEATURES = [
  { code: 'FEAT-1', phase: 'Phase 1', status: 'PLANNED', description: 'first', position: 1 },
];

describe('generator determinism', () => {
  test('injected now appears in a fresh-file preamble', () => {
    const out = generateRoadmapFromBase('', FEATURES, { now: '2020-01-02', projectName: 'X' });
    assert.ok(out.includes('2020-01-02'), 'injected now should drive the Last updated line');
  });

  test('two fresh generations with the same now are byte-equal', () => {
    const a = generateRoadmapFromBase('', FEATURES, { now: '2020-01-02', projectName: 'X' });
    const b = generateRoadmapFromBase('', FEATURES, { now: '2020-01-02', projectName: 'X' });
    assert.equal(a, b);
  });

  test('suppressDrift prevents drift emission even with cwd + divergent override', () => {
    let wrote = '';
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (c) => { wrote += String(c); return true; };
    try {
      const base = '## Phase 1 — PARKED (manual hold)\n\n| # | Feature | Description | Status |\n|---|---------|-------------|--------|\n| 1 | FEAT-1 | first | PLANNED |\n';
      generateRoadmapFromBase(base, FEATURES, { now: '2020-01-02', cwd: '/tmp/nonexistent-xyz', suppressDrift: true });
    } finally {
      process.stderr.write = orig;
    }
    assert.ok(!wrote.includes('diverges'), `expected no drift warning, got: ${wrote}`);
  });
});

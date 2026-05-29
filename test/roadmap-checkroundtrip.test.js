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

import { checkRoundtrip } from '../lib/roadmap-roundtrip.js';

const OPTS = { now: '2020-01-02', projectName: 'X' };

describe('checkRoundtrip — fixed point + lossless', () => {
  test('a simple feature set is a fixed point and lossless', () => {
    const features = [
      { code: 'FEAT-1', phase: 'Phase 1', status: 'PLANNED', description: 'first', position: 1 },
      { code: 'FEAT-2', phase: 'Phase 1', status: 'COMPLETE', description: 'second', position: 2 },
    ];
    const r = checkRoundtrip('', features, OPTS);
    assert.equal(r.fixedPoint, true, JSON.stringify(r.diffs));
    assert.equal(r.lossless, true, JSON.stringify(r.diffs));
    assert.ok(r.passes <= 2);
  });

  test('reports LOSSLESS_EXTRA for a valid code present in ROADMAP but not in features', () => {
    const base = [
      '# X Roadmap', '',
      '## Phase 9 — PLANNED', '',
      '| # | Feature | Description | Status |',
      '|---|---------|-------------|--------|',
      '| 1 | ORPHAN-1 | not in features | PLANNED |', '',
    ].join('\n');
    const features = [
      { code: 'FEAT-1', phase: 'Phase 1', status: 'PLANNED', description: 'first', position: 1 },
    ];
    const r = checkRoundtrip(base, features, OPTS);
    assert.ok(r.diffs.some(d => d.kind === 'LOSSLESS_EXTRA' && d.code === 'ORPHAN-1'),
      `expected LOSSLESS_EXTRA for ORPHAN-1, got ${JSON.stringify(r.diffs)}`);
  });

  test('anonymous rows are NOT reported as extra', () => {
    const base = [
      '# X Roadmap', '',
      '## Phase 1 — PLANNED', '',
      '| # | Feature | Description | Status |',
      '|---|---------|-------------|--------|',
      '| 1 | FEAT-1 | first | PLANNED |',
      '| — | — | curated anon note | PLANNED |', '',
    ].join('\n');
    const features = [
      { code: 'FEAT-1', phase: 'Phase 1', status: 'PLANNED', description: 'first', position: 1 },
    ];
    const r = checkRoundtrip(base, features, OPTS);
    assert.ok(!r.diffs.some(d => d.kind === 'LOSSLESS_EXTRA'),
      `anon row must not be extra, got ${JSON.stringify(r.diffs)}`);
  });

  test('a feature with items[] recovers each item status without false LOSSLESS', () => {
    const features = [
      { code: 'FEAT-1', phase: 'Phase 1', status: 'PARTIAL', description: 'parent', position: 1,
        items: [
          { position: 1, description: 'sub a', status: 'COMPLETE' },
          { position: 2, description: 'sub b', status: 'PLANNED' },
        ] },
    ];
    const r = checkRoundtrip('', features, OPTS);
    assert.equal(r.lossless, true, JSON.stringify(r.diffs));
  });

  test('reports LOSSLESS_CHANGED when a phase-heading override rewrites a row status away from feature.json', () => {
    // The base phase heading carries a curated COMPLETE override. The generator
    // preserves that override in the heading; on re-parse the parser's
    // SKIP_STATUSES rule rewrites the FEAT-1 row status to COMPLETE, while
    // feature.json says IN_PROGRESS — so the projection is genuinely lossy.
    const base = [
      '# X Roadmap', '',
      '## Phase 1 — COMPLETE', '',
      '| # | Feature | Description | Status |',
      '|---|---------|-------------|--------|',
      '| 1 | FEAT-1 | x | IN_PROGRESS |', '',
    ].join('\n');
    const features = [
      { code: 'FEAT-1', phase: 'Phase 1', status: 'IN_PROGRESS', description: 'x', position: 1 },
    ];
    const r = checkRoundtrip(base, features, OPTS);
    assert.equal(r.lossless, false, JSON.stringify(r.diffs));
    assert.ok(r.diffs.some(d => d.kind === 'LOSSLESS_CHANGED' && d.code === 'FEAT-1'),
      `expected LOSSLESS_CHANGED for FEAT-1, got ${JSON.stringify(r.diffs)}`);
  });

  test('a feature with an empty items[] emits exactly one recoverable row (no LOSSLESS_MISSING)', () => {
    // The generator always emits every well-formed feature as a typed row, so
    // LOSSLESS_MISSING cannot be triggered through gen with valid input. Pin the
    // inverse: an empty items[] takes the featureless single-row path and is
    // recovered cleanly — guarding against a future regression that drops it.
    const features = [
      { code: 'FEAT-1', phase: 'Phase 1', status: 'IN_PROGRESS', description: 'x', position: 1, items: [] },
    ];
    const r = checkRoundtrip('', features, OPTS);
    assert.ok(!r.diffs.some(d => d.kind === 'LOSSLESS_MISSING'),
      `no row must be missing, got ${JSON.stringify(r.diffs)}`);
    assert.equal(r.lossless, true, JSON.stringify(r.diffs));
  });
});

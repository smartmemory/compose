/**
 * migrate-roadmap.test.js — coverage for lib/migrate-roadmap.js,
 * focused on externalPrefixes skipping cross-project rows.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { migrateRoadmap } from '../lib/migrate-roadmap.js';

function freshCwd() {
  return mkdtempSync(join(tmpdir(), 'migrate-roadmap-'));
}

const ROADMAP = [
  '# X Roadmap', '',
  '## Phase 1 — PLANNED', '',
  '| # | Feature | Description | Status |',
  '|---|---------|-------------|--------|',
  '| 1 | STRAT-X-1 | owned by stratum | PLANNED |',
  '| 2 | COMP-Y-1 | owned here | PLANNED |', '',
].join('\n');

describe('migrateRoadmap externalPrefixes', () => {
  test('skips external-prefixed rows, migrates local ones', () => {
    const cwd = freshCwd();
    writeFileSync(join(cwd, 'ROADMAP.md'), ROADMAP, 'utf-8');

    const result = migrateRoadmap(cwd, { dryRun: true, externalPrefixes: ['STRAT-'] });

    assert.ok(!result.created.includes('STRAT-X-1'),
      `STRAT-X-1 must NOT be created, got ${JSON.stringify(result)}`);
    assert.ok(result.skippedExternal.includes('STRAT-X-1'),
      `STRAT-X-1 must be in skippedExternal, got ${JSON.stringify(result)}`);
    assert.ok(result.created.includes('COMP-Y-1'),
      `COMP-Y-1 must be created, got ${JSON.stringify(result)}`);
  });

  test('without externalPrefixes both rows are migrated', () => {
    const cwd = freshCwd();
    writeFileSync(join(cwd, 'ROADMAP.md'), ROADMAP, 'utf-8');

    const result = migrateRoadmap(cwd, { dryRun: true });

    assert.deepEqual(result.skippedExternal, []);
    assert.ok(result.created.includes('STRAT-X-1'));
    assert.ok(result.created.includes('COMP-Y-1'));
  });
});

// ---------------------------------------------------------------------------
// COMP-COMPLETION-GATE AC-17 — the migration exemption is named and logged on
// BOTH branches, including a NEW COMPLETE row created without --overwrite
// (§2.7 round 2 finding 7: keying the exemption on --overwrite alone would
// leave the create path as a silent bypass).
// ---------------------------------------------------------------------------

const ROADMAP_COMPLETE = [
  '# X Roadmap', '',
  '## Phase 1 — COMPLETE', '',
  '| # | Feature | Description | Status |',
  '|---|---------|-------------|--------|',
  '| 1 | COMP-DONE-1 | shipped long ago | COMPLETE |', '',
].join('\n');

function captureWarn(fn) {
  const seen = [];
  const orig = console.warn;
  console.warn = (...a) => seen.push(a.map(String).join(' '));
  try { return { result: fn(), seen }; } finally { console.warn = orig; }
}

describe('migrateRoadmap COMPLETE exemption (AC-17)', () => {
  test('NEGATIVE: a new COMPLETE row created WITHOUT --overwrite is covered and logged, not silently written', () => {
    const cwd = freshCwd();
    writeFileSync(join(cwd, 'ROADMAP.md'), ROADMAP_COMPLETE, 'utf-8');
    const { result, seen } = captureWarn(() => migrateRoadmap(cwd, {}));
    assert.deepEqual(result.created, ['COMP-DONE-1']);
    const fj = JSON.parse(readFileSync(join(cwd, 'docs', 'features', 'COMP-DONE-1', 'feature.json'), 'utf8'));
    assert.equal(fj.status, 'COMPLETE');
    assert.equal(seen.filter((l) => /migration exemption \(create\).*COMP-DONE-1.*COMPLETE/.test(l)).length, 1, seen.join('\n'));
  });

  test('the overwrite branch is logged under its own name', () => {
    const cwd = freshCwd();
    writeFileSync(join(cwd, 'ROADMAP.md'), ROADMAP_COMPLETE, 'utf-8');
    migrateRoadmap(cwd, {});
    const { result, seen } = captureWarn(() => migrateRoadmap(cwd, { overwrite: true }));
    assert.deepEqual(result.updated, ['COMP-DONE-1']);
    assert.equal(seen.filter((l) => /migration exemption \(overwrite\).*COMP-DONE-1/.test(l)).length, 1, seen.join('\n'));
  });

  test('a non-COMPLETE row is not logged as an exemption', () => {
    const cwd = freshCwd();
    writeFileSync(join(cwd, 'ROADMAP.md'), ROADMAP, 'utf-8');
    const { seen } = captureWarn(() => migrateRoadmap(cwd, {}));
    assert.equal(seen.filter((l) => /migration exemption/.test(l)).length, 0);
  });
});

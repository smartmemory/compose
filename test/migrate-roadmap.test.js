/**
 * migrate-roadmap.test.js — coverage for lib/migrate-roadmap.js,
 * focused on externalPrefixes skipping cross-project rows.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

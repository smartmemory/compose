/**
 * feature-json-external.test.js — feature-json.js with an absolute/external
 * featuresDir (COMP-PATHS-EXTERNAL S2, Decision 7).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFeature, readFeature, listFeatures } from '../lib/feature-json.js';

describe('feature-json with absolute featuresDir (D7)', () => {
  test('writes/reads into an ABSOLUTE external dir, not <cwd>/abs', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'fj-cwd-'));
    const ext = mkdtempSync(join(tmpdir(), 'fj-ext-'));      // a different root
    const featuresAbs = join(ext, 'features');
    const feat = { code: 'X-1', description: 'd', status: 'PLANNED' };

    writeFeature(cwd, feat, featuresAbs);
    assert.ok(existsSync(join(featuresAbs, 'X-1', 'feature.json')), 'feature.json lands in the external dir');
    assert.ok(!existsSync(join(cwd, ext, 'features', 'X-1')), 'must NOT be re-rooted under cwd');

    assert.equal(readFeature(cwd, 'X-1', featuresAbs)?.code, 'X-1');
    assert.deepEqual(listFeatures(cwd, featuresAbs).map(f => f.code), ['X-1']);
  });

  test('relative featuresDir still works under cwd (back-compat)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'fj-rel-'));
    writeFeature(cwd, { code: 'Y-1', description: 'd', status: 'PLANNED' }, 'docs/features');
    assert.ok(existsSync(join(cwd, 'docs/features/Y-1/feature.json')));
  });

  test('default featuresDir (omitted) still resolves under cwd', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'fj-def-'));
    writeFeature(cwd, { code: 'Z-1', description: 'd', status: 'PLANNED' });
    assert.ok(existsSync(join(cwd, 'docs/features/Z-1/feature.json')));
  });
});

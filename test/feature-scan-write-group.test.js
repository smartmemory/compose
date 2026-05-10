/**
 * feature-scan-write-group.test.js — coverage for writeFeatureGroupToDisk.
 *
 * Verifies the disk write-back path used when a vision item's `group` is
 * edited (graph context menu or item detail panel).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { writeFeatureGroupToDisk } from '../server/feature-scan.js';

function makeFeaturesDir() {
  const dir = mkdtempSync(join(tmpdir(), 'feature-scan-write-group-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function seedFeature(featuresDir, code, spec = {}) {
  const featureDir = join(featuresDir, code);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(
    join(featureDir, 'feature.json'),
    JSON.stringify({
      code,
      description: 'A test feature',
      status: 'PLANNED',
      created: '2026-05-09',
      updated: '2026-05-09',
      ...spec,
    }, null, 2) + '\n',
    'utf-8',
  );
  return featureDir;
}

describe('writeFeatureGroupToDisk', () => {
  test('writes the new group into feature.json (resolved by lifecycle.featureCode)', () => {
    const featuresDir = makeFeaturesDir();
    const code = 'COMP-FOO';
    seedFeature(featuresDir, code, { group: 'OLD-GROUP' });
    const item = { id: 'i1', title: 'Foo', lifecycle: { featureCode: code } };

    const wrote = writeFeatureGroupToDisk(item, 'NEW-GROUP', featuresDir);
    assert.equal(wrote, true);

    const spec = JSON.parse(readFileSync(join(featuresDir, code, 'feature.json'), 'utf-8'));
    assert.equal(spec.group, 'NEW-GROUP');
  });

  test('resolves feature dir from item.title when no featureCode (matches scanFeatures convention)', () => {
    const featuresDir = makeFeaturesDir();
    const code = 'COMP-BAR';
    seedFeature(featuresDir, code);
    // Items seeded by scanFeatures use feature.name (= dir name = code) as title.
    const item = { id: 'i2', title: code };

    const wrote = writeFeatureGroupToDisk(item, 'BAR-GROUP', featuresDir);
    assert.equal(wrote, true);

    const spec = JSON.parse(readFileSync(join(featuresDir, code, 'feature.json'), 'utf-8'));
    assert.equal(spec.group, 'BAR-GROUP');
  });

  test('clears group when newGroup is empty/null', () => {
    const featuresDir = makeFeaturesDir();
    const code = 'COMP-BAZ';
    seedFeature(featuresDir, code, { group: 'EXISTING' });
    const item = { id: 'i3', title: code };

    assert.equal(writeFeatureGroupToDisk(item, '', featuresDir), true);
    let spec = JSON.parse(readFileSync(join(featuresDir, code, 'feature.json'), 'utf-8'));
    assert.equal('group' in spec, false);

    // Now seed again and clear with explicit null
    seedFeature(featuresDir, code, { group: 'EXISTING' });
    assert.equal(writeFeatureGroupToDisk(item, null, featuresDir), true);
    spec = JSON.parse(readFileSync(join(featuresDir, code, 'feature.json'), 'utf-8'));
    assert.equal('group' in spec, false);
  });

  test('idempotent: writing the same group is a no-op', () => {
    const featuresDir = makeFeaturesDir();
    const code = 'COMP-IDEMP';
    seedFeature(featuresDir, code, { group: 'SAME' });
    const item = { id: 'i4', title: code };

    const wrote = writeFeatureGroupToDisk(item, 'SAME', featuresDir);
    assert.equal(wrote, false, 'should report no write when value unchanged');

    // Whitespace-only differences are also normalized away.
    const wrote2 = writeFeatureGroupToDisk(item, '  SAME  ', featuresDir);
    assert.equal(wrote2, false);
  });

  test('returns false (silent) when no feature.json exists', () => {
    const featuresDir = makeFeaturesDir();
    const item = { id: 'i5', title: 'NOT-A-FEATURE' };

    const wrote = writeFeatureGroupToDisk(item, 'X', featuresDir);
    assert.equal(wrote, false);
  });

  test('returns false when item has no resolvable code/title', () => {
    const featuresDir = makeFeaturesDir();
    const wrote = writeFeatureGroupToDisk({}, 'X', featuresDir);
    assert.equal(wrote, false);
    const wrote2 = writeFeatureGroupToDisk(null, 'X', featuresDir);
    assert.equal(wrote2, false);
  });

  test('does not leave temp files behind on success', () => {
    const featuresDir = makeFeaturesDir();
    const code = 'COMP-TMP';
    seedFeature(featuresDir, code);
    const item = { id: 'i6', title: code };

    writeFeatureGroupToDisk(item, 'WHATEVER', featuresDir);

    const files = readdirSync(join(featuresDir, code));
    const stragglers = files.filter(f => f.includes('.tmp.'));
    assert.deepEqual(stragglers, [], `unexpected temp files: ${stragglers.join(',')}`);
    assert.equal(existsSync(join(featuresDir, code, 'feature.json')), true);
  });

  test('preserves other feature.json fields and bumps updated date', () => {
    const featuresDir = makeFeaturesDir();
    const code = 'COMP-PRESERVE';
    seedFeature(featuresDir, code, {
      profile: { language: 'node', test_framework: 'vitest' },
      description: 'Keep me',
      status: 'IN_PROGRESS',
    });
    const item = { id: 'i7', title: code };

    writeFeatureGroupToDisk(item, 'NEW', featuresDir);
    const spec = JSON.parse(readFileSync(join(featuresDir, code, 'feature.json'), 'utf-8'));
    assert.equal(spec.description, 'Keep me');
    assert.equal(spec.status, 'IN_PROGRESS');
    assert.deepEqual(spec.profile, { language: 'node', test_framework: 'vitest' });
    assert.equal(spec.group, 'NEW');
    // updated should be a YYYY-MM-DD string
    assert.match(spec.updated, /^\d{4}-\d{2}-\d{2}$/);
  });
});

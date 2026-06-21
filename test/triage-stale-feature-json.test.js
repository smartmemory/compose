/**
 * triage-stale-feature-json.test.js — COMP-ROADMAP-PLAN T8 (S4b).
 *
 * isTriageStale must NOT count feature.json's own mtime against the
 * triageTimestamp it reads FROM feature.json — that is circular (writing the
 * cache stamp would self-invalidate the cache). A plan-produced feature whose
 * design.md predates the stamp must be considered fresh. A design.md newer than
 * the stamp must still mark the feature stale. The normal-triage skip path is
 * unaffected.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { isTriageStale } from '../lib/triage.js';

// Absolute features dir → resolvePathValue normalizes it as-is, so
// featureDir = <featuresDir>/<code>.
function freshFeaturesDir() {
  const cwd = mkdtempSync(join(tmpdir(), 'triage-stale-'));
  const featuresDir = join(cwd, 'docs', 'features');
  mkdirSync(featuresDir, { recursive: true });
  return { cwd, featuresDir };
}

// Set an mtime (and atime) on a file to a deterministic epoch-seconds value so
// the staleness comparison is not at the mercy of filesystem mtime resolution.
function setMtime(filePath, epochSeconds) {
  utimesSync(filePath, epochSeconds, epochSeconds);
}

function writeFeatureDir(featuresDir, code, { triageStamp, designContent = '# design' }) {
  const dir = join(featuresDir, code);
  mkdirSync(dir, { recursive: true });
  const designPath = join(dir, 'design.md');
  const jsonPath = join(dir, 'feature.json');
  writeFileSync(designPath, designContent);
  writeFileSync(jsonPath, JSON.stringify({
    code,
    status: 'PLANNED',
    profile: { needs_prd: false, needs_architecture: false, needs_verification: true, needs_report: false },
    triageTimestamp: triageStamp,
  }, null, 2));
  return { dir, designPath, jsonPath };
}

describe('isTriageStale — feature.json excluded from the folder scan (T8)', () => {
  test('(a) NOT stale: profile+triageTimestamp present, design.md untouched', () => {
    const { cwd, featuresDir } = freshFeaturesDir();
    const stamp = '2026-06-21T12:00:00.000Z';
    const stampSec = new Date(stamp).getTime() / 1000;
    const { designPath, jsonPath } = writeFeatureDir(featuresDir, 'PLAN-FRESH-1', { triageStamp: stamp });

    // design.md older than the stamp; feature.json itself NEWER than the stamp
    // (it was just written, carrying the stamp). Pre-fix, that newer
    // feature.json mtime would self-stale the feature.
    setMtime(designPath, stampSec - 60);
    setMtime(jsonPath, stampSec + 120);

    assert.equal(isTriageStale(cwd, 'PLAN-FRESH-1', featuresDir), false,
      'a freshly-stamped feature with an untouched design.md must be fresh');
  });

  test('(b) STALE: a design.md newer than triageTimestamp', () => {
    const { cwd, featuresDir } = freshFeaturesDir();
    const stamp = '2026-06-21T12:00:00.000Z';
    const stampSec = new Date(stamp).getTime() / 1000;
    const { designPath, jsonPath } = writeFeatureDir(featuresDir, 'PLAN-EDITED-1', { triageStamp: stamp });

    setMtime(jsonPath, stampSec); // feature.json itself not the trigger
    setMtime(designPath, stampSec + 300); // design edited after the stamp

    assert.equal(isTriageStale(cwd, 'PLAN-EDITED-1', featuresDir), true,
      'a design.md newer than the stamp must still mark the feature stale');
  });

  test('(c) normal-triage golden path still skips: every non-json file older than stamp', () => {
    const { cwd, featuresDir } = freshFeaturesDir();
    const stamp = '2026-06-21T12:00:00.000Z';
    const stampSec = new Date(stamp).getTime() / 1000;
    const code = 'NORMAL-1';
    const dir = join(featuresDir, code);
    mkdirSync(dir, { recursive: true });
    const designPath = join(dir, 'design.md');
    const prdPath = join(dir, 'prd.md');
    const jsonPath = join(dir, 'feature.json');
    writeFileSync(designPath, '# d');
    writeFileSync(prdPath, '# prd');
    writeFileSync(jsonPath, JSON.stringify({ code, triageTimestamp: stamp }, null, 2));

    setMtime(designPath, stampSec - 100);
    setMtime(prdPath, stampSec - 50);
    setMtime(jsonPath, stampSec + 200); // newer json must not flip the result

    assert.equal(isTriageStale(cwd, code, featuresDir), false,
      'all content files older than the stamp ⇒ not stale (json excluded)');
  });

  test('still stale when triageTimestamp is missing entirely', () => {
    const { cwd, featuresDir } = freshFeaturesDir();
    const code = 'NOSTAMP-1';
    const dir = join(featuresDir, code);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'design.md'), '# d');
    writeFileSync(join(dir, 'feature.json'), JSON.stringify({ code }, null, 2));
    assert.equal(isTriageStale(cwd, code, featuresDir), true);
  });
});

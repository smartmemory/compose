/**
 * feature-fields.test.js — COMP-TRIAGE-5 S02.
 *
 * Contract tests for the shared field validator introduced to close the
 * complexity bypass (lib/build.js used to write `complexity: String(tier)`,
 * e.g. "0".."4", straight past the old inline COMPLEXITIES.has check because
 * that check only lived inside addRoadmapEntry). validateFeatureFields is the
 * single guard both addRoadmapEntry and the future build write path call.
 *
 * Run with: node --test test/feature-fields.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { addRoadmapEntry, validateFeatureFields } from '../lib/feature-writer.js';
import { readFeature } from '../lib/feature-json.js';

function freshCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'feature-fields-'));
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  return cwd;
}

// ---------------------------------------------------------------------------
// validateFeatureFields — unit tests (pure, no I/O)
// ---------------------------------------------------------------------------

describe('validateFeatureFields', () => {
  test('accepts a fully valid field set (no throw)', () => {
    assert.doesNotThrow(() => validateFeatureFields({
      complexity: 'M',
      triageTier: 2,
      lane: 'standard',
      estimateSource: 'front',
      triageConfidence: 'medium',
    }));
  });

  test('accepts an empty/absent field set (all optional)', () => {
    assert.doesNotThrow(() => validateFeatureFields({}));
  });

  test('rejects complexity outside {S,M,L,XL}', () => {
    assert.throws(() => validateFeatureFields({ complexity: 'Z' }), /invalid complexity/);
  });

  test('rejects triageTier as a string ("0")', () => {
    assert.throws(() => validateFeatureFields({ triageTier: '0' }), /invalid triageTier/);
  });

  test('rejects triageTier out of range (5)', () => {
    assert.throws(() => validateFeatureFields({ triageTier: 5 }), /invalid triageTier/);
  });

  test('rejects triageTier out of range (-1)', () => {
    assert.throws(() => validateFeatureFields({ triageTier: -1 }), /invalid triageTier/);
  });

  test('accepts triageTier at each valid integer 0-4', () => {
    for (let tier = 0; tier <= 4; tier++) {
      assert.doesNotThrow(() => validateFeatureFields({ triageTier: tier }), `tier ${tier} should be valid`);
    }
  });

  test('accepts triageTier: 2', () => {
    assert.doesNotThrow(() => validateFeatureFields({ triageTier: 2 }));
  });

  test('rejects an invalid lane', () => {
    assert.throws(() => validateFeatureFields({ lane: 'medium' }), /invalid lane/);
  });

  test('accepts each valid lane', () => {
    for (const lane of ['trivial', 'standard', 'complex']) {
      assert.doesNotThrow(() => validateFeatureFields({ lane }), `lane ${lane} should be valid`);
    }
  });

  test('rejects an invalid estimateSource', () => {
    assert.throws(() => validateFeatureFields({ estimateSource: 'guessed' }), /invalid estimateSource/);
  });

  test('accepts each valid estimateSource', () => {
    for (const estimateSource of ['front', 'refined', 'escalated']) {
      assert.doesNotThrow(() => validateFeatureFields({ estimateSource }), `estimateSource ${estimateSource} should be valid`);
    }
  });

  test('accepts each valid triageConfidence', () => {
    for (const triageConfidence of ['high', 'medium', 'low']) {
      assert.doesNotThrow(() => validateFeatureFields({ triageConfidence }));
    }
  });

  test('rejects an invalid triageConfidence', () => {
    assert.throws(() => validateFeatureFields({ triageConfidence: 'certain' }), /invalid triageConfidence/);
  });

  // Regression: today lib/build.js writes `complexity: String(triageResult.tier)`
  // (e.g. "0", "1", ..., "4") via a raw provider write that bypasses the old
  // inline COMPLEXITIES.has check inside addRoadmapEntry. The shared validator
  // must reject a tier-as-string masquerading as `complexity` regardless of
  // which write path calls it.
  test('regression: rejects a tier-as-string in complexity (the build.js String(tier) bypass)', () => {
    for (const tierAsString of ['0', '1', '2', '3', '4']) {
      assert.throws(
        () => validateFeatureFields({ complexity: tierAsString }),
        /invalid complexity/,
        `complexity "${tierAsString}" must be rejected`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// addRoadmapEntry — end-to-end wiring through the new fields
// ---------------------------------------------------------------------------

describe('addRoadmapEntry — lane/triageTier/estimateSource/triageConfidence', () => {
  test('persists lane, triageTier, estimateSource, triageConfidence + regenerates ROADMAP', async () => {
    const cwd = freshCwd();
    const r = await addRoadmapEntry(cwd, {
      code: 'TRI-FIELD-1',
      description: 'a feature with triage fields',
      phase: 'Phase 1',
      complexity: 'M',
      lane: 'standard',
      triageTier: 2,
      estimateSource: 'front',
      triageConfidence: 'medium',
    });
    assert.equal(r.code, 'TRI-FIELD-1');

    const feature = readFeature(cwd, 'TRI-FIELD-1');
    assert.equal(feature.lane, 'standard');
    assert.equal(feature.triageTier, 2);
    assert.equal(feature.estimateSource, 'front');
    assert.equal(feature.triageConfidence, 'medium');
  });

  test('omits the new fields when not supplied (no undefined keys)', async () => {
    const cwd = freshCwd();
    await addRoadmapEntry(cwd, {
      code: 'TRI-FIELD-2',
      description: 'no triage fields',
      phase: 'Phase 0',
    });
    const feature = readFeature(cwd, 'TRI-FIELD-2');
    assert.ok(!('lane' in feature), 'lane not added when absent');
    assert.ok(!('triageTier' in feature), 'triageTier not added when absent');
    assert.ok(!('estimateSource' in feature), 'estimateSource not added when absent');
    assert.ok(!('triageConfidence' in feature), 'triageConfidence not added when absent');
  });

  test('rejects bad complexity (existing behavior preserved through validateFeatureFields)', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => addRoadmapEntry(cwd, { code: 'TRI-BADC-1', description: 'd', phase: 'P', complexity: 'huge' }),
      /invalid complexity/,
    );
  });

  test('rejects a string triageTier via addRoadmapEntry', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => addRoadmapEntry(cwd, { code: 'TRI-BADT-1', description: 'd', phase: 'P', triageTier: '0' }),
      /invalid triageTier/,
    );
  });

  test('rejects an out-of-range triageTier via addRoadmapEntry', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => addRoadmapEntry(cwd, { code: 'TRI-BADT-2', description: 'd', phase: 'P', triageTier: 5 }),
      /invalid triageTier/,
    );
  });

  test('rejects a bad lane via addRoadmapEntry', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => addRoadmapEntry(cwd, { code: 'TRI-BADL-1', description: 'd', phase: 'P', lane: 'medium' }),
      /invalid lane/,
    );
  });

  test('rejects a bad estimateSource via addRoadmapEntry', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => addRoadmapEntry(cwd, { code: 'TRI-BADE-1', description: 'd', phase: 'P', estimateSource: 'guessed' }),
      /invalid estimateSource/,
    );
  });

  test('rejects a bad triageConfidence via addRoadmapEntry', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => addRoadmapEntry(cwd, { code: 'TRI-BADCONF-1', description: 'd', phase: 'P', triageConfidence: 'certain' }),
      /invalid triageConfidence/,
    );
  });
});

/**
 * feature-writer-plan-fields.test.js — COMP-ROADMAP-PLAN T7 (S4a).
 *
 * addRoadmapEntry must accept and persist the plan-handshake fields
 * (profile, triageTimestamp, plannedBy, impact) via the provider-backed
 * createFeature path (NOT raw writeFeature), and still regenerate ROADMAP.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { addRoadmapEntry } from '../lib/feature-writer.js';
import { readFeature } from '../lib/feature-json.js';

function freshCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'feature-writer-plan-'));
  // ROADMAP regen needs the docs/features dir to exist.
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  return cwd;
}

describe('addRoadmapEntry — plan handshake fields (T7)', () => {
  test('persists profile, triageTimestamp, plannedBy, impact + regenerates ROADMAP', async () => {
    const cwd = freshCwd();
    const profile = {
      needs_prd: false,
      needs_architecture: true,
      needs_verification: true,
      needs_report: false,
    };
    const triageTimestamp = '2026-06-21T12:00:00.000Z';

    const r = await addRoadmapEntry(cwd, {
      code: 'PLAN-WIDGET-1',
      description: 'a widget the plan produced',
      phase: 'Phase 1',
      status: 'PLANNED',
      complexity: 'M',
      profile,
      triageTimestamp,
      plannedBy: 'PLAN-build-a-widget',
      impact: 'high',
    });
    assert.equal(r.code, 'PLAN-WIDGET-1');

    // feature.json carries all four new fields, provider-backed.
    const feature = readFeature(cwd, 'PLAN-WIDGET-1');
    assert.equal(feature.status, 'PLANNED');
    assert.equal(feature.complexity, 'M');
    assert.deepEqual(feature.profile, profile);
    assert.equal(feature.triageTimestamp, triageTimestamp);
    assert.equal(feature.plannedBy, 'PLAN-build-a-widget');
    assert.equal(feature.impact, 'high');

    // ROADMAP row regenerated.
    assert.ok(existsSync(join(cwd, 'ROADMAP.md')), 'ROADMAP.md regenerated');
    const roadmap = readFileSync(join(cwd, 'ROADMAP.md'), 'utf-8');
    assert.match(roadmap, /PLAN-WIDGET-1/);
  });

  test('omits the new fields when not supplied (no undefined keys)', async () => {
    const cwd = freshCwd();
    await addRoadmapEntry(cwd, {
      code: 'PLAIN-1',
      description: 'no plan fields',
      phase: 'Phase 0',
    });
    const feature = readFeature(cwd, 'PLAIN-1');
    assert.ok(!('profile' in feature), 'profile not added when absent');
    assert.ok(!('triageTimestamp' in feature), 'triageTimestamp not added when absent');
    assert.ok(!('plannedBy' in feature), 'plannedBy not added when absent');
    assert.ok(!('impact' in feature), 'impact not added when absent');
  });

  test('rejects a non-object profile', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => addRoadmapEntry(cwd, {
        code: 'BADPROF-1', description: 'x', phase: 'P', profile: 'not-an-object',
      }),
      /invalid profile/,
    );
  });

  test('rejects an invalid impact value', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => addRoadmapEntry(cwd, {
        code: 'BADIMP-1', description: 'x', phase: 'P', impact: 'gigantic',
      }),
      /invalid impact/,
    );
  });
});

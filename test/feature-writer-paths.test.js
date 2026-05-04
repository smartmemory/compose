/**
 * feature-writer-paths.test.js — Verifies lib writers honor
 * .compose/compose.json `paths.features` override.
 * COMP-MCP-MIGRATION-2.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { addRoadmapEntry, setFeatureStatus, linkFeatures } from '../lib/feature-writer.js';
import { proposeFollowup } from '../lib/followup-writer.js';
import { recordCompletion, getCompletions } from '../lib/completion-writer.js';
import { readFeature } from '../lib/feature-json.js';

const FAKE_SHA = 'b'.repeat(40);

function freshCwdWithOverride(featuresDir = 'specs/features') {
  const cwd = mkdtempSync(join(tmpdir(), 'fw-paths-'));
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  writeFileSync(join(cwd, '.compose', 'compose.json'),
    JSON.stringify({ paths: { features: featuresDir } }), 'utf-8');
  mkdirSync(join(cwd, featuresDir), { recursive: true });
  return cwd;
}

describe('feature-writer respects paths.features override', () => {
  test('addRoadmapEntry writes under override', async () => {
    const cwd = freshCwdWithOverride();
    await addRoadmapEntry(cwd, {
      code: 'OVR-1', description: 'override test', phase: 'Phase 0',
    });

    // Feature.json lives at specs/features/OVR-1/feature.json
    assert.ok(existsSync(join(cwd, 'specs', 'features', 'OVR-1', 'feature.json')));
    // NOT at default docs/features
    assert.ok(!existsSync(join(cwd, 'docs', 'features', 'OVR-1', 'feature.json')));

    // ROADMAP.md regenerated with the override-rooted listing
    const roadmap = readFileSync(join(cwd, 'ROADMAP.md'), 'utf-8');
    assert.match(roadmap, /OVR-1/);
  });

  test('readFeature with override (via setFeatureStatus)', async () => {
    const cwd = freshCwdWithOverride();
    await addRoadmapEntry(cwd, {
      code: 'OVR-2', description: 'd', phase: 'Phase 0',
    });
    const r = await setFeatureStatus(cwd, {
      code: 'OVR-2', status: 'IN_PROGRESS',
    });
    assert.equal(r.from, 'PLANNED');
    assert.equal(r.to, 'IN_PROGRESS');

    // Verify feature.json under override
    const f = readFeature(cwd, 'OVR-2', 'specs/features');
    assert.equal(f.status, 'IN_PROGRESS');
  });

  test('linkFeatures with override', async () => {
    const cwd = freshCwdWithOverride();
    await addRoadmapEntry(cwd, { code: 'OVR-3', description: 'a', phase: 'Phase 0' });
    await addRoadmapEntry(cwd, { code: 'OVR-4', description: 'b', phase: 'Phase 0' });
    const r = await linkFeatures(cwd, {
      from_code: 'OVR-3', to_code: 'OVR-4', kind: 'related',
    });
    assert.equal(r.kind, 'related');
    const f = readFeature(cwd, 'OVR-3', 'specs/features');
    assert.deepEqual(f.links, [{ kind: 'related', to_code: 'OVR-4' }]);
  });

  test('proposeFollowup writes new feature under override', async () => {
    const cwd = freshCwdWithOverride();
    await addRoadmapEntry(cwd, { code: 'OVR-5', description: 'parent', phase: 'Phase 0' });
    const r = await proposeFollowup(cwd, {
      parent_code: 'OVR-5',
      description: 'sub-ticket',
      rationale: 'because',
    });
    assert.equal(r.code, 'OVR-5-1');
    assert.ok(existsSync(join(cwd, 'specs', 'features', 'OVR-5-1', 'feature.json')));
    assert.ok(existsSync(join(cwd, 'specs', 'features', 'OVR-5-1', 'design.md')));
    // Rationale is in the new design.md
    const design = readFileSync(join(cwd, 'specs', 'features', 'OVR-5-1', 'design.md'), 'utf-8');
    assert.match(design, /## Why/);
    assert.match(design, /because/);
  });

  test('recordCompletion writes onto override-rooted feature.json', async () => {
    const cwd = freshCwdWithOverride();
    await addRoadmapEntry(cwd, { code: 'OVR-6', description: 'd', phase: 'Phase 0' });

    await recordCompletion(cwd, {
      feature_code: 'OVR-6',
      commit_sha: FAKE_SHA,
      tests_pass: true,
      files_changed: ['file.js'],
      notes: 'shipped',
    });

    const f = readFeature(cwd, 'OVR-6', 'specs/features');
    assert.ok(Array.isArray(f.completions));
    assert.equal(f.completions.length, 1);
    assert.equal(f.completions[0].commit_sha, FAKE_SHA);
    assert.equal(f.status, 'COMPLETE');

    const got = getCompletions(cwd, { feature_code: 'OVR-6' });
    assert.equal(got.completions.length, 1);
  });

  test('default behavior unchanged when no override', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'fw-default-'));
    mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
    await addRoadmapEntry(cwd, {
      code: 'DEF-1', description: 'd', phase: 'Phase 0',
    });
    assert.ok(existsSync(join(cwd, 'docs', 'features', 'DEF-1', 'feature.json')));
  });
});

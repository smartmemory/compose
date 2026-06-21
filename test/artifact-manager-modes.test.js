/**
 * artifact-manager-modes.test.js — COMP-ROADMAP-MODES S03.
 *
 * The ArtifactManager becomes mode-scoped: assess()/scaffold() iterate the
 * mode's declared artifact subset. No-regression invariant: build (and a
 * no-mode ctor) assess ALL 6 artifacts exactly as today; bug items (fix mode,
 * empty phaseArtifacts) fall back to the global set, so bug assessment is
 * unchanged. The global ARTIFACT_SCHEMAS map + startup invariant are untouched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ArtifactManager, ARTIFACT_SCHEMAS } from '../server/artifact-manager.js';

const ALL = Object.keys(ARTIFACT_SCHEMAS).sort();
const root = mkdtempSync(join(tmpdir(), 'am-modes-'));

test('no-mode ctor assesses ALL artifacts (byte-identical to today)', () => {
  const keys = Object.keys(new ArtifactManager(root).assess('FEAT-1').artifacts).sort();
  assert.deepEqual(keys, ALL);
});

test('build mode assesses ALL artifacts', () => {
  const keys = Object.keys(new ArtifactManager(root, 'build').assess('FEAT-1').artifacts).sort();
  assert.deepEqual(keys, ALL);
});

test('fix/bug mode falls back to the global set (bug assessment unchanged)', () => {
  const fixKeys = Object.keys(new ArtifactManager(root, 'fix').assess('BUG-1').artifacts).sort();
  const bugKeys = Object.keys(new ArtifactManager(root, 'bug').assess('BUG-1').artifacts).sort();
  assert.deepEqual(fixKeys, ALL, 'fix (empty phaseArtifacts) → global default');
  assert.deepEqual(bugKeys, ALL, 'bug normalizes to fix → global default');
});

test('plan mode scopes assessment to its declared subset', () => {
  const keys = Object.keys(new ArtifactManager(root, 'plan').assess('PLAN-1').artifacts).sort();
  assert.deepEqual(keys, ['design.md', 'plan.md']);
});

test('global ARTIFACT_SCHEMAS still has all 6 (maps untouched)', () => {
  assert.equal(ALL.length, 6);
  assert.ok(ALL.includes('design.md') && ALL.includes('report.md'));
});

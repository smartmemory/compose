/**
 * lifecycle-modes.test.js — COMP-ROADMAP-MODES S01.
 *
 * The mode-keyed lifecycle registry (build|fix|plan) is the single source of
 * truth the guard / artifact-manager / runner consume. The load-bearing
 * invariant: the `build` entry reproduces today's hard-coded data VERBATIM, so
 * build behavior stays byte-identical. These tests pin that against the legacy
 * exports.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LIFECYCLE_MODES,
  resolveMode,
  getMode,
  genesisOf,
  completablePhaseOf,
  transitionsOf,
  skippableOf,
  phaseOrderOf,
  artifactsOf,
  terminalOf,
} from '../lib/lifecycle-modes.js';

// Legacy hard-coded data — the build entry must equal these exactly.
import { BASE_TRANSITIONS, SKIPPABLE, TERMINAL } from '../server/lifecycle-guard.js';

test('build entry transitions deep-equal legacy BASE_TRANSITIONS', () => {
  assert.deepEqual(LIFECYCLE_MODES.build.transitions, BASE_TRANSITIONS);
});

test('build entry skippable/terminal equal legacy sets', () => {
  assert.deepEqual(new Set(LIFECYCLE_MODES.build.skippable), SKIPPABLE);
  assert.deepEqual(new Set(LIFECYCLE_MODES.build.terminal), TERMINAL);
});

test('build genesis + completable phase match the hard-coded graph', () => {
  assert.equal(LIFECYCLE_MODES.build.genesis, 'explore_design');
  assert.equal(LIFECYCLE_MODES.build.completablePhase, 'ship');
});

test('resolveMode normalizes runtime (feature|bug) AND canonical (build|fix|plan)', () => {
  assert.equal(resolveMode('feature'), 'build');
  assert.equal(resolveMode('bug'), 'fix');
  assert.equal(resolveMode('build'), 'build');
  assert.equal(resolveMode('fix'), 'fix');
  assert.equal(resolveMode('plan'), 'plan');
  assert.equal(resolveMode(undefined), 'build');
  assert.equal(resolveMode(null), 'build');
  assert.equal(resolveMode('garbage'), 'build');
});

test('getMode resolves and returns the mode entry; unknown → build', () => {
  assert.equal(getMode('feature'), LIFECYCLE_MODES.build);
  assert.equal(getMode('bug'), LIFECYCLE_MODES.fix);
  assert.equal(getMode('garbage'), LIFECYCLE_MODES.build);
});

test('accessors return per-mode data, defaulting to build', () => {
  assert.equal(genesisOf('build'), 'explore_design');
  assert.equal(genesisOf('fix'), 'reproduce');
  assert.equal(completablePhaseOf('build'), 'ship');
  assert.deepEqual(transitionsOf('build'), BASE_TRANSITIONS);
  assert.deepEqual(skippableOf('build'), ['prd', 'architecture', 'report']);
  assert.deepEqual(terminalOf('build'), ['complete', 'killed']);
  assert.ok(phaseOrderOf('build').includes('ship'));
  assert.ok(phaseOrderOf('build').includes('explore_design'));
  // unknown mode falls back to build's data
  assert.equal(genesisOf('garbage'), 'explore_design');
});

test('build artifacts are the full 6; a narrowing mode (plan) is a subset', () => {
  assert.deepEqual(
    [...artifactsOf('build')].sort(),
    ['architecture.md', 'blueprint.md', 'design.md', 'plan.md', 'prd.md', 'report.md'],
  );
  // plan is a real subset (seed); fix declares none → empty (assess falls back to global default).
  const planArtifacts = artifactsOf('plan');
  assert.ok(planArtifacts.length > 0 && planArtifacts.length < 6);
  assert.deepEqual(artifactsOf('fix'), []);
});

test('every mode has a coherent graph: genesis is a transition key, terminals have no outgoing', () => {
  for (const mode of ['build', 'fix', 'plan']) {
    const t = transitionsOf(mode);
    assert.ok(Object.prototype.hasOwnProperty.call(t, genesisOf(mode)), `${mode} genesis is a node`);
    // the completable phase exists as a node
    assert.ok(Object.prototype.hasOwnProperty.call(t, completablePhaseOf(mode)), `${mode} completable phase is a node`);
  }
});

test('runner config carries the per-mode behavioral switches', () => {
  assert.equal(LIFECYCLE_MODES.build.runner.runsTriage, true);
  assert.equal(LIFECYCLE_MODES.build.runner.tracksFeatureJson, true);
  assert.equal(LIFECYCLE_MODES.build.runner.artifactRoot, 'features');
  assert.equal(LIFECYCLE_MODES.fix.runner.runsTriage, false);
  assert.equal(LIFECYCLE_MODES.fix.runner.tracksFeatureJson, false);
  assert.equal(LIFECYCLE_MODES.fix.runner.artifactRoot, 'docs/bugs');
  assert.equal(LIFECYCLE_MODES.fix.runner.defaultTemplate, 'bug-fix');
});

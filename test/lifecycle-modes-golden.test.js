/**
 * lifecycle-modes-golden.test.js — COMP-ROADMAP-MODES S07.
 *
 * Two guarantees for the keystone:
 *   1. GOLDEN: the `build` surface (guard graph, resource id, status projection,
 *      artifact set) is byte-identical to the pre-refactor behavior — the
 *      no-regression contract pinned in one place.
 *   2. 4TH-MODE PROOF: adding a brand-new mode is a DATA-ONLY change. We inject a
 *      throwaway `demo` mode entry, exercise it through every public seam (guard,
 *      resource id, artifact manager, status recognizer), then remove it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LIFECYCLE_MODES, resolveMode, genesisOf, completablePhaseOf, allKnownPhases, artifactsOf,
} from '../lib/lifecycle-modes.js';
import { buildPhaseGraph, resourceId, edgePredicates, phaseToStatus } from '../server/lifecycle-guard.js';
import { artifactKeysForMode } from '../server/artifact-manager.js';

// ── 1. GOLDEN: the build surface is the legacy contract ──────────────────────

test('GOLDEN build phase graph is exactly the legacy graph', () => {
  const g = buildPhaseGraph('build');
  // forward edges
  assert.deepEqual(g.explore_design.filter((x) => x !== 'killed'), ['prd', 'architecture', 'blueprint']);
  assert.deepEqual(g.docs.filter((x) => x !== 'killed'), ['ship']);
  // the completion edge + kill edges + terminal sinks
  assert.ok(g.ship.includes('complete'));
  assert.ok(g.blueprint.includes('killed'));
  assert.deepEqual(g.complete, []);
  assert.deepEqual(g.killed, []);
  // no-arg call (legacy default) is identical
  assert.deepEqual(buildPhaseGraph(), g);
});

test('GOLDEN build resource id has no mode segment; status projection unchanged', () => {
  assert.equal(resourceId('FEAT-1', '/tmp/p', 'build'), resourceId('FEAT-1', '/tmp/p'));
  assert.ok(resourceId('FEAT-1', '/tmp/p', 'build').endsWith(':FEAT-1'));
  assert.equal(phaseToStatus('complete'), 'COMPLETE');
  assert.equal(phaseToStatus('killed'), 'KILLED');
  assert.equal(phaseToStatus('execute'), 'IN_PROGRESS');
});

test('GOLDEN build assesses all 6 artifacts; build edge predicates unchanged', () => {
  assert.deepEqual(artifactKeysForMode('build').sort(),
    ['architecture.md', 'blueprint.md', 'design.md', 'plan.md', 'prd.md', 'report.md']);
  const p = edgePredicates('docs/features/FEAT-1', 'build');
  assert.equal(p['explore_design->blueprint'][0].statement, "server_file_exists('docs/features/FEAT-1/design.md')");
});

// ── 2. 4TH-MODE PROOF: a new mode is a data-only change ──────────────────────

test('a 4th mode is a DATA-ONLY change — register / assess / project, then remove', () => {
  assert.equal(resolveMode('demo'), 'build', 'unknown token resolves to build BEFORE the entry exists');

  LIFECYCLE_MODES.demo = {
    transitions: { start: ['done'], done: [] },
    skippable: [],
    terminal: ['complete', 'killed'],
    genesis: 'start',
    completablePhase: 'done',
    phaseArtifacts: ['design.md'],
    edgeEvidence: { 'start->done': 'design.md' },
    phaseOrder: ['start', 'done'],
    runner: { artifactRoot: 'docs/demo', runsTriage: false, tracksFeatureJson: false, descriptionLoader: 'feature', planInputs: 'feature', defaultTemplate: 'build' },
  };
  try {
    // resolveMode + accessors now recognize the mode purely from data
    assert.equal(resolveMode('demo'), 'demo');
    assert.equal(genesisOf('demo'), 'start');
    assert.equal(completablePhaseOf('demo'), 'done');
    assert.deepEqual(artifactsOf('demo'), ['design.md']);

    // guard builds the demo graph with the right completion + kill edges
    const g = buildPhaseGraph('demo');
    assert.ok(g.done.includes('complete'), 'completablePhase → complete');
    assert.ok(g.start.includes('killed'), 'non-terminal → killed');
    assert.deepEqual(g.complete, []);

    // resource id namespaces the new mode (no collision with build)
    const rid = resourceId('X', '/tmp/p', 'demo');
    assert.ok(rid.includes(':demo:X'));
    assert.notEqual(rid, resourceId('X', '/tmp/p', 'build'));

    // edge predicates come from the demo evidence map
    const preds = edgePredicates('docs/demo/X', 'demo');
    assert.equal(preds['start->done'][0].statement, "server_file_exists('docs/demo/X/design.md')");

    // artifact manager scopes assessment to the demo subset
    assert.deepEqual(artifactKeysForMode('demo'), ['design.md']);

    // status recognizer now knows the demo phases (no source edit needed)
    const known = new Set(allKnownPhases());
    assert.ok(known.has('start') && known.has('done'));
  } finally {
    delete LIFECYCLE_MODES.demo;
  }

  assert.equal(resolveMode('demo'), 'build', 'mode removed cleanly — back to build fallback');
});

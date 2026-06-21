/**
 * roadmap-plan-golden.test.js — COMP-ROADMAP-PLAN T13 (golden flow).
 *
 * Stitches the produce → consume handshake with REAL backends (fs, provider,
 * registry, guard, the real pipeline YAML). The LLM agent layer is the only
 * thing not exercised — every wired seam is. This is the integration the per-task
 * unit tests do not cover together:
 *
 *   compose plan  → build-ready docs/features/<code>/{feature.json, design.md}
 *                 → triage would SKIP it (profile + fresh triageTimestamp)
 *   compose build → explore_design RATIFIES the plan design (no clobber)
 *
 * plus the spine (plan.stratum.yaml phase-named steps) and the guard/projection
 * golden (plan resolves docs/plans; the build surface is unregressed).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import YAML from 'yaml';

import { addRoadmapEntry } from '../lib/feature-writer.js';
import { readFeature } from '../lib/feature-json.js';
import { isTriageStale } from '../lib/triage.js';
import { applyPlannedByRatify } from '../lib/build.js';
import { getMode } from '../lib/lifecycle-modes.js';
import { edgePredicates, _testOnly_featureRelDir } from '../server/lifecycle-guard.js';

const REPO = process.cwd();

// ── 1. Spine: the real plan pipeline maps onto the plan phaseOrder ───────────

describe('golden: the plan spine', () => {
  test('plan.stratum.yaml has phase-named steps and projectName/intent inputs', () => {
    const spec = YAML.parse(readFileSync(join(REPO, 'pipelines', 'plan.stratum.yaml'), 'utf-8'));
    assert.equal(spec.workflow.name, 'plan');
    assert.deepEqual(Object.keys(spec.flows.plan.input).sort(), ['intent', 'projectName']);
    const stepIds = spec.flows.plan.steps.filter((s) => s.id).map((s) => s.id);
    // top-level step IDs must equal the plan phaseOrder for phase tracking
    for (const phase of getMode('plan').phaseOrder) {
      assert.ok(stepIds.includes(phase), `plan pipeline is missing phase step "${phase}"`);
    }
  });
});

// ── 2 + 3. Produce → consume handshake ───────────────────────────────────────

describe('golden: produce → consume handshake', () => {
  test('plan writes a build-ready feature that build would skip-triage and ratify', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'roadmap-plan-golden-'));
    const code = 'PLAN-WIDGET-1';
    const featureDir = join(cwd, 'docs', 'features', code);
    mkdirSync(featureDir, { recursive: true });

    // PLAN spec step: write the per-feature design.md FIRST...
    writeFileSync(join(featureDir, 'design.md'), `# ${code}: a widget\n\n**Status:** PLANNED\n\nThe plan-authored design.\n`);
    // ...THEN stamp triageTimestamp at/after the design write (C8 ordering).
    const designMtime = statSync(join(featureDir, 'design.md')).mtime.getTime();
    const triageTimestamp = new Date(designMtime + 1000).toISOString();
    const profile = { needs_prd: false, needs_architecture: false, needs_verification: true, needs_report: false };

    await addRoadmapEntry(cwd, {
      code, description: 'a widget the plan produced', phase: 'Phase 1',
      status: 'PLANNED', complexity: 'M', profile, triageTimestamp,
      plannedBy: 'PLAN-BUILD-A-WIDGET', impact: 'high',
    });

    // PRODUCE: the feature.json is build-ready.
    const feature = readFeature(cwd, code);
    assert.equal(feature.status, 'PLANNED');
    assert.equal(feature.plannedBy, 'PLAN-BUILD-A-WIDGET');
    assert.deepEqual(feature.profile, profile);
    assert.equal(feature.triageTimestamp, triageTimestamp);
    assert.ok(existsSync(join(featureDir, 'design.md')));

    // STITCH (T7→T8): build would SKIP fresh triage — profile present AND not stale.
    assert.equal(feature.profile != null, true);
    assert.equal(isTriageStale(cwd, code), false, 'a fresh plan-authored feature must not be triage-stale');

    // CONSUME (T12): build's explore_design RATIFIES this design (real build pipeline).
    const buildSpec = YAML.parse(readFileSync(join(REPO, 'pipelines', 'build.stratum.yaml'), 'utf-8'));
    const mutated = applyPlannedByRatify(buildSpec, 'build', feature.plannedBy);
    assert.equal(mutated, true);
    const exploreStep = buildSpec.flows.build.steps.find((s) => s.id === 'explore_design');
    assert.match(exploreStep.intent, /RATIFY/);
    assert.match(exploreStep.intent, /PLAN-BUILD-A-WIDGET/);
    assert.match(exploreStep.intent, /\{featureCode\}/); // interpolation preserved
  });
});

// ── 4. Guard + projection golden (plan resolves docs/plans; build unregressed) ─

describe('golden: guard + projection', () => {
  test('plan evidence resolves docs/plans; build stays docs/features', () => {
    const root = mkdtempSync(join(tmpdir(), 'roadmap-plan-guard-'));
    assert.equal(_testOnly_featureRelDir('PLAN-X', root, 'plan'), 'docs/plans/PLAN-X');
    assert.equal(_testOnly_featureRelDir('FEAT-1', root, 'build'), 'docs/features/FEAT-1');
    // plan's explore_design->plan edge predicate looks in docs/plans
    const p = edgePredicates(_testOnly_featureRelDir('PLAN-X', root, 'plan'), 'plan');
    assert.equal(p['explore_design->plan'][0].statement, "server_file_exists('docs/plans/PLAN-X/design.md')");
  });

  test('plan session never writes a feature row; build does', () => {
    assert.equal(getMode('plan').runner.tracksFeatureJson, false);
    assert.equal(getMode('build').runner.tracksFeatureJson, true);
  });
});

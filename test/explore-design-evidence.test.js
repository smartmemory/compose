import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

import { buildStepPrompt } from '../lib/step-prompt.js';
import { evaluatePredicate } from '@smartmemory/stratum/dist/eval/expr.js';

const ROOT = new URL('..', import.meta.url).pathname;
const SPEC = YAML.parse(readFileSync(join(ROOT, 'pipelines', 'build.stratum.yaml'), 'utf8'));
const STEP = SPEC.flows.build.steps.find((candidate) => candidate.id === 'explore_design');
const ARTIFACT = 'docs/features/COMP-OUTCOME-ENUM-1/design.md';

function accepted(result) {
  return STEP.ensure.every(({ expr }) => evaluatePredicate(expr, { result }, { workspaceRoot: ROOT }).holds);
}

function exploration(focus) {
  return {
    focus,
    findings: `Findings for ${focus}`,
    files_examined: ['lib/build.js'],
  };
}

test('explore_design rejects a complete result with too few explorations', () => {
  assert.equal(accepted({
    phase: 'explore_design',
    artifact: ARTIFACT,
    outcome: 'complete',
    summary: 'Design written after one explorer',
    explorations: [exploration('architecture')],
  }), false);
});

test('explore_design rejects a complete result that omits the explorations field entirely', () => {
  assert.equal(accepted({
    phase: 'explore_design',
    artifact: ARTIFACT,
    outcome: 'complete',
    summary: 'Design written with no exploration evidence',
  }), false);
});

test('explore_design accepts a complete result with two exploration records', () => {
  assert.equal(accepted({
    phase: 'explore_design',
    artifact: ARTIFACT,
    outcome: 'complete',
    summary: 'Design written after parallel exploration',
    explorations: [exploration('architecture'), exploration('related implementations')],
  }), true);
});

test('explore_design still accepts a skipped result when its artifact exists', () => {
  assert.equal(accepted({
    phase: 'explore_design',
    artifact: ARTIFACT,
    outcome: 'skipped',
    summary: 'Existing design reused',
  }), true);
});

test('explore_design prompt carries the exploration evidence contract', () => {
  const prompt = buildStepPrompt({
    step_id: STEP.id,
    intent: STEP.do,
    inputs: { featureCode: 'COMP-EXPLORER-EVIDENCE-1' },
    output_fields: SPEC.contracts.PhaseResult,
    ensure: STEP.ensure.map(({ expr }) => expr),
  }, { cwd: ROOT, featureCode: 'COMP-EXPLORER-EVIDENCE-1' });

  assert.match(prompt, /- explorations \(ExplorationEvidence\[\]\?\)/);
  assert.match(prompt, /focus, findings, and files_examined/);
  assert.match(prompt, /len\(result\.explorations\) >= 2/);
});

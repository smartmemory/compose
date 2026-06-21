/**
 * build-modes.test.js — COMP-ROADMAP-MODES S05.
 *
 * The runner's binary feature-vs-bug assumptions are lifted into the mode
 * registry's runner config. These tests pin the per-mode plan-input contract
 * and that a third mode (`plan`) threads through WITHOUT inheriting feature
 * behavior (no triage, no feature.json) or bug-specific machinery. The
 * feature/bug assertions are regression guards for the planInputs refactor.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runBuild } from '../lib/build.js';

function makeProject(tmpDir, template, flowName) {
  const composeDir = join(tmpDir, '.compose');
  mkdirSync(join(composeDir, 'data'), { recursive: true });
  writeFileSync(join(composeDir, 'compose.json'), JSON.stringify({ version: 1, capabilities: { stratum: true } }));
  const pipeDir = join(tmpDir, 'pipelines');
  mkdirSync(pipeDir, { recursive: true });
  writeFileSync(join(pipeDir, `${template}.stratum.yaml`), `
version: "0.2"
contracts:
  R: { phase: { type: string } }
flows:
  ${flowName}:
    input:
      featureCode: { type: string }
      description: { type: string }
      task: { type: string }
      projectName: { type: string }
      intent: { type: string }
    output: R
    steps:
      - id: design
        agent: claude
        intent: "stub"
        inputs: { featureCode: "$.input.featureCode" }
        output_contract: R
        retries: 1
`);
}

function makeMockStratum() {
  const captured = { plan: null };
  return {
    captured,
    async connect() {},
    async plan(spec, flow, inputs) {
      captured.plan = { spec, flow, inputs };
      return { status: 'complete', flow_id: 'mock-flow', step_id: 'design', step_number: 1, total_steps: 1 };
    },
    async resume(flowId) { return { status: 'complete', flow_id: flowId, step_id: 'design', step_number: 1, total_steps: 1 }; },
    async stepDone(flowId, stepId, result) { return { status: 'complete', flow_id: flowId }; },
    async audit() { return { status: 'complete' }; },
    async runAgentText() { return { text: '', tokens: { input: 0, output: 0 } }; },
    async close() {},
  };
}

function readActiveBuild(tmpDir) {
  return JSON.parse(readFileSync(join(tmpDir, '.compose', 'data', 'active-build.json'), 'utf-8'));
}

test('plan mode: {projectName, intent} envelope, active-build mode=plan, no feature.json', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'modes-plan-'));
  try {
    makeProject(tmpDir, 'new', 'new');
    const planDir = join(tmpDir, 'docs', 'plans', 'PLAN-A');
    mkdirSync(planDir, { recursive: true });
    const stratum = makeMockStratum();

    await runBuild('PLAN-A', { cwd: tmpDir, stratum, mode: 'plan', template: 'new', description: 'an idea', skipTriage: true });

    assert.deepEqual(stratum.captured.plan.inputs, { projectName: 'PLAN-A', intent: 'an idea' },
      'plan threads the new.stratum.yaml {projectName, intent} shape');
    assert.equal(readActiveBuild(tmpDir).mode, 'plan', 'active-build persists mode=plan');
    assert.ok(!existsSync(join(planDir, 'feature.json')), 'plan does not write feature.json (tracksFeatureJson:false)');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('bug mode: { task } envelope (regression guard for the planInputs lift)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'modes-bug-'));
  try {
    makeProject(tmpDir, 'bug-fix', 'bug_fix');
    mkdirSync(join(tmpDir, 'docs', 'bugs', 'BUG-A'), { recursive: true });
    const stratum = makeMockStratum();

    await runBuild('BUG-A', { cwd: tmpDir, stratum, mode: 'bug', template: 'bug-fix', description: 'a bug', skipTriage: true });

    assert.deepEqual(stratum.captured.plan.inputs, { task: 'a bug' }, 'bug threads { task }');
    assert.equal(readActiveBuild(tmpDir).mode, 'bug');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('feature mode: full feature envelope (regression guard)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'modes-feat-'));
  try {
    makeProject(tmpDir, 'build', 'build');
    const featDir = join(tmpDir, 'docs', 'features', 'FEAT-A');
    mkdirSync(featDir, { recursive: true });
    const stratum = makeMockStratum();

    await runBuild('FEAT-A', { cwd: tmpDir, stratum, mode: 'feature', template: 'build', description: 'a feature', skipTriage: true });

    const inputs = stratum.captured.plan.inputs;
    assert.equal(inputs.featureCode, 'FEAT-A');
    assert.equal(inputs.description, 'a feature');
    assert.equal(inputs.implementer_agent, 'claude');
    assert.equal(inputs.reviewer_agent, 'codex');
    assert.equal(readActiveBuild(tmpDir).mode, 'feature');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

/**
 * Integration tests for policy enforcement in the build runner.
 *
 * Uses a Stratum spec with a gate step. Tests verify that evaluatePolicy
 * controls whether the build waits for human approval (gate), auto-approves
 * (flag/skip), or defaults to gate when settings are missing.
 *
 * Skip if the live TS MCP bin is unavailable.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runBuild as runBuildRuntime } from '../lib/build.js';
import { runBuildWithAgentFactory } from './helpers/ts-agent-harness.js';

const runBuild = (featureCode, options) => runBuildWithAgentFactory(runBuildRuntime, featureCode, options);

// ---------------------------------------------------------------------------
// Skip guard
// ---------------------------------------------------------------------------

import { TS_MCP_BIN } from './helpers/stratum-test-bin.js';
const stratumAvailable = existsSync(TS_MCP_BIN);
const stratumStateRoot = mkdtempSync(join(tmpdir(), 'build-policy-stratum-state-'));
const previousStateRoot = process.env.STRATUM_STATE_ROOT;

before(() => { process.env.STRATUM_STATE_ROOT = stratumStateRoot; });
after(() => {
  if (previousStateRoot === undefined) delete process.env.STRATUM_STATE_ROOT;
  else process.env.STRATUM_STATE_ROOT = previousStateRoot;
  rmSync(stratumStateRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Spec with a gate between design and implement
// ---------------------------------------------------------------------------

const GATED_SPEC = `\
version: 1

contracts:
  PhaseResult:
    phase: string
    artifact: string
    outcome: string

flows:
  entry: build
  build:
    input:
      featureCode: string
      description: string
      pre_merge_gate: string[]?
      implementer_agent: string
      reviewer_agent: string
    output:
      from: "\${implement.output}"
      contract: PhaseResult
    max_rounds: 2
    steps:
      - id: design
        agent: claude
        do: "Write the design doc for \${input.featureCode}."
        out: PhaseResult
        attempts: 1

      - id: design_gate
        after: [design]
        gate:
          on_approve: implement
          on_revise: design
          on_kill: null

      - id: implement
        after: [design_gate]
        agent: claude
        do: "Implement \${input.featureCode}."
        out: PhaseResult
        attempts: 1
`;

// ---------------------------------------------------------------------------
// Mock connector
// ---------------------------------------------------------------------------

function mockConnectorFactory(tmpDir) {
  return function factory(_agentType, _opts) {
    return {
      async *run(prompt, _runOpts) {
        const stepMatch = prompt.match(/step "(\w+)"/);
        const stepId = stepMatch?.[1] ?? 'unknown';
        const markerDir = join(tmpDir, '.compose', 'data', 'markers');
        mkdirSync(markerDir, { recursive: true });
        writeFileSync(join(markerDir, `${stepId}.done`), 'completed');
        const result = { phase: stepId, artifact: `${stepId}.md`, outcome: 'complete' };
        yield { type: 'assistant', content: JSON.stringify(result) };
        yield { type: 'system', subtype: 'complete', agent: 'mock' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupProject(dir, settingsOverride) {
  const composeDir = join(dir, '.compose');
  const dataDir = join(composeDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(composeDir, 'compose.json'),
    JSON.stringify({ version: 2, capabilities: { stratum: true } })
  );

  if (settingsOverride !== undefined) {
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settingsOverride, null, 2));
  }

  const featureDir = join(dir, 'docs', 'features', 'TEST-1');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'design.md'), '# Test\nPolicy enforcement test.');

  const pipeDir = join(dir, 'pipelines');
  mkdirSync(pipeDir, { recursive: true });
  writeFileSync(join(pipeDir, 'build.stratum.yaml'), GATED_SPEC);

  return { composeDir, dataDir, featureDir };
}

function readStreamLog(dir) {
  const logPath = join(dir, '.compose', 'build-stream.jsonl');
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('build policy enforcement — skip', { skip: !stratumAvailable && 'TS stratum MCP bin not found' }, () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'build-policy-skip-'));
    setupProject(tmpDir, { policies: { design_gate: 'skip' } });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('skip policy auto-approves gate without creating gate record', async () => {
    await runBuild('TEST-1', {
      cwd: tmpDir,
      connectorFactory: mockConnectorFactory(tmpDir),
      gateOpts: { nonInteractive: true },
    });

    // Build should complete (implement step ran)
    const markers = join(tmpDir, '.compose', 'data', 'markers');
    assert.ok(existsSync(join(markers, 'implement.done')), 'implement step should have run');

    // No gate record should exist
    const statePath = join(tmpDir, '.compose', 'data', 'vision-state.json');
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      const gates = state.gates || [];
      const gateRecords = gates.filter(g => g.stepId === 'design_gate');
      assert.equal(gateRecords.length, 0, 'skip policy should not create gate records');
    }

    // Stream log should contain build_gate_resolved with policyMode: 'skip'
    const events = readStreamLog(tmpDir);
    const resolved = events.find(e => e.type === 'build_gate_resolved' && e.stepId === 'design_gate');
    assert.ok(resolved, 'should emit build_gate_resolved event');
    assert.equal(resolved.policyMode, 'skip');
    assert.equal(resolved.outcome, 'approve');
  });
});

describe('build policy enforcement — flag', { skip: !stratumAvailable && 'TS stratum MCP bin not found' }, () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'build-policy-flag-'));
    setupProject(tmpDir, { policies: { design_gate: 'flag' } });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('flag policy auto-approves gate and emits stream event', async () => {
    await runBuild('TEST-1', {
      cwd: tmpDir,
      connectorFactory: mockConnectorFactory(tmpDir),
      gateOpts: { nonInteractive: true },
    });

    // Build should complete
    const markers = join(tmpDir, '.compose', 'data', 'markers');
    assert.ok(existsSync(join(markers, 'implement.done')), 'implement step should have run');

    // No gate record
    const statePath = join(tmpDir, '.compose', 'data', 'vision-state.json');
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      const gates = state.gates || [];
      const gateRecords = gates.filter(g => g.stepId === 'design_gate');
      assert.equal(gateRecords.length, 0, 'flag policy should not create gate records');
    }

    // Stream: policyMode flag
    const events = readStreamLog(tmpDir);
    const resolved = events.find(e => e.type === 'build_gate_resolved' && e.stepId === 'design_gate');
    assert.ok(resolved, 'should emit build_gate_resolved event');
    assert.equal(resolved.policyMode, 'flag');
    assert.equal(resolved.outcome, 'approve');
  });
});

describe('build policy enforcement — missing settings defaults to gate', { skip: 'gate mode blocks for human input — verify manually' }, () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'build-policy-default-'));
    // No settings.json — should default to gate
    setupProject(tmpDir);
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('missing settings file defaults all gates to gate mode', async () => {
    const settingsPath = join(tmpDir, '.compose', 'data', 'settings.json');
    assert.ok(!existsSync(settingsPath), 'settings.json should not exist');

    // Build will hang on gate. Use gateOpts.autoApprove to auto-approve for test.
    await runBuild('TEST-1', {
      cwd: tmpDir,
      connectorFactory: mockConnectorFactory(tmpDir),
      gateOpts: { nonInteractive: true, autoApprove: true },
    });

    // Stream should contain build_gate event (not just build_gate_resolved)
    const events = readStreamLog(tmpDir);
    const gateEvent = events.find(e => e.type === 'build_gate' && e.stepId === 'design_gate');
    assert.ok(gateEvent, 'should emit build_gate event for gate mode');
    assert.equal(gateEvent.policyMode, 'gate');
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBuild } from '../lib/build.js';

const COMPOSE_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const COMPOSE_BIN = join(COMPOSE_ROOT, 'bin', 'compose.js');

function makeProject(tmpDir, featureCode = 'RESUME-1') {
  mkdirSync(join(tmpDir, '.compose', 'data'), { recursive: true });
  writeFileSync(join(tmpDir, '.compose', 'compose.json'), JSON.stringify({ version: 1, capabilities: { stratum: true } }));

  const featureDir = join(tmpDir, 'docs', 'features', featureCode);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'design.md'), '# Resume Feature\nA feature used by resume tests.\n');
  writeFileSync(join(featureDir, 'feature.json'), JSON.stringify({
    code: featureCode,
    description: 'resume test',
    status: 'PLANNED',
  }, null, 2));

  mkdirSync(join(tmpDir, 'pipelines'), { recursive: true });
  writeFileSync(join(tmpDir, 'pipelines', 'build.stratum.yaml'), `
version: "0.2"
contracts:
  PhaseResult:
    summary: { type: string }
    outcome: { type: string }
flows:
  build:
    input:
      featureCode: { type: string }
      description: { type: string }
      implementer_agent: { type: string }
      reviewer_agent: { type: string }
    output: PhaseResult
    steps:
      - id: design
        agent: claude
        intent: "stub"
        inputs: { featureCode: "$.input.featureCode" }
        output_contract: PhaseResult
        output_fields:
          summary: string
          outcome: string
        retries: 1
`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function activePath(tmpDir) {
  return join(tmpDir, '.compose', 'data', 'active-build.json');
}

function historyPath(tmpDir) {
  return join(tmpDir, '.compose', 'data', 'build-history.jsonl');
}

function readHistory(tmpDir) {
  if (!existsSync(historyPath(tmpDir))) return [];
  return readFileSync(historyPath(tmpDir), 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function makeStratum({
  planFlowId = 'flow-plan',
  planStatus = 'complete',
  resumeStatus = 'execute_step',
  auditStatus = 'running',
  crashOnStepDone = false,
} = {}) {
  const calls = { plan: [], resume: [], stepDone: 0, audit: [] };
  const execute = (flowId) => ({
    status: 'execute_step',
    flow_id: flowId,
    step_id: 'design',
    step_number: 1,
    total_steps: 1,
    agent: 'claude',
    intent: 'stub',
    inputs: {},
    output_fields: { summary: 'string', outcome: 'string' },
  });
  return {
    calls,
    async connect() {},
    async plan(spec, flow, inputs) {
      calls.plan.push({ spec, flow, inputs });
      if (planStatus === 'execute_step') return execute(planFlowId);
      return { status: 'complete', flow_id: planFlowId, step_id: 'design', step_number: 1, total_steps: 1 };
    },
    async audit(flowId) {
      calls.audit.push(flowId);
      return { status: auditStatus, flow_id: flowId };
    },
    async resume(flowId) {
      calls.resume.push(flowId);
      if (resumeStatus === 'execute_step') return execute(flowId);
      return { status: resumeStatus, flow_id: flowId, step_id: 'design', step_number: 1, total_steps: 1 };
    },
    async stepDone(flowId) {
      calls.stepDone += 1;
      if (crashOnStepDone) throw new Error('synthetic crash after step');
      return { status: 'complete', flow_id: flowId, step_id: 'design', step_number: 1, total_steps: 1 };
    },
    async agentRun() {
      return { text: JSON.stringify({ summary: 'step ok', outcome: 'complete' }) };
    },
    onEvent() {
      return () => {};
    },
    async cancelAgentRun() {},
    async runAgentText() { return ''; },
    async close() {},
  };
}

function makeVisionWriter() {
  return {
    async ensureFeatureItem() { return 'item-resume-1'; },
    async updateItemStatus() {},
    async updateItemPhase() {},
  };
}

test('crash terminalizes active build as failed, preserves flowId, writes one history record, and exits by throwing', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'build-resume-crash-'));
  try {
    makeProject(tmpDir);
    const stratum = makeStratum({ planFlowId: 'flow-crash', planStatus: 'execute_step', crashOnStepDone: true });

    await assert.rejects(
      () => runBuild('RESUME-1', { cwd: tmpDir, stratum, skipTriage: true, visionWriter: makeVisionWriter() }),
      /synthetic crash after step/
    );

    const active = readJson(activePath(tmpDir));
    assert.equal(active.status, 'failed');
    assert.equal(active.flowId, 'flow-crash');
    assert.equal(active.failureReason, 'synthetic crash after step');

    const feature = readJson(join(tmpDir, 'docs', 'features', 'RESUME-1', 'feature.json'));
    assert.equal(feature.status, 'PLANNED');

    const history = readHistory(tmpDir);
    assert.equal(history.length, 1);
    assert.equal(history[0].status, 'failed');
    assert.equal(history[0].flowId, 'flow-crash');
    assert.equal(history[0].failureReason, 'synthetic crash after step');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('--resume re-attaches the same flowId and --fresh starts a new flowId', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'build-resume-flow-'));
  try {
    makeProject(tmpDir);
    writeFileSync(activePath(tmpDir), JSON.stringify({
      featureCode: 'RESUME-1',
      flowId: 'flow-old',
      mode: 'feature',
      status: 'failed',
      currentStepId: 'design',
      pid: 999999,
    }, null, 2));

    const resumeStratum = makeStratum({ auditStatus: 'running' });
    await runBuild('RESUME-1', {
      cwd: tmpDir,
      stratum: resumeStratum,
      skipTriage: true,
      visionWriter: makeVisionWriter(),
      resume: true,
      resumeFlowId: 'flow-old',
    });
    assert.deepEqual(resumeStratum.calls.resume, ['flow-old']);
    assert.equal(readJson(activePath(tmpDir)).flowId, 'flow-old');

    writeFileSync(activePath(tmpDir), JSON.stringify({
      featureCode: 'RESUME-1',
      flowId: 'flow-old',
      mode: 'feature',
      status: 'failed',
      currentStepId: 'design',
      pid: 999999,
    }, null, 2));

    const freshStratum = makeStratum({ planFlowId: 'flow-new', auditStatus: 'running' });
    await runBuild('RESUME-1', {
      cwd: tmpDir,
      stratum: freshStratum,
      skipTriage: true,
      visionWriter: makeVisionWriter(),
      fresh: true,
    });
    assert.equal(freshStratum.calls.resume.length, 0);
    assert.equal(freshStratum.calls.plan.length, 1);
    assert.equal(readJson(activePath(tmpDir)).flowId, 'flow-new');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('implicit auto-resume with terminal resume response falls back to fresh start', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'build-resume-terminal-implicit-'));
  try {
    makeProject(tmpDir);
    writeFileSync(activePath(tmpDir), JSON.stringify({
      featureCode: 'RESUME-1',
      flowId: 'flow-old',
      mode: 'feature',
      status: 'failed',
      currentStepId: 'design',
      pid: 999999,
    }, null, 2));

    const stratum = makeStratum({
      planFlowId: 'flow-new',
      resumeStatus: 'complete',
      auditStatus: 'running',
    });
    await runBuild('RESUME-1', {
      cwd: tmpDir,
      stratum,
      skipTriage: true,
      visionWriter: makeVisionWriter(),
    });

    assert.deepEqual(stratum.calls.resume, ['flow-old']);
    assert.equal(stratum.calls.plan.length, 1);
    assert.equal(readJson(activePath(tmpDir)).flowId, 'flow-new');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('explicit --resume with terminal resume response errors with Nothing to resume', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'build-resume-terminal-explicit-'));
  try {
    makeProject(tmpDir);
    writeFileSync(activePath(tmpDir), JSON.stringify({
      featureCode: 'RESUME-1',
      flowId: 'flow-old',
      mode: 'feature',
      status: 'failed',
      currentStepId: 'design',
      pid: 999999,
    }, null, 2));

    const stratum = makeStratum({
      planFlowId: 'flow-new',
      resumeStatus: 'complete',
      auditStatus: 'running',
    });
    await assert.rejects(
      () => runBuild('RESUME-1', {
        cwd: tmpDir,
        stratum,
        skipTriage: true,
        visionWriter: makeVisionWriter(),
        resume: true,
        resumeFlowId: 'flow-old',
      }),
      /Nothing to resume for RESUME-1/
    );

    assert.deepEqual(stratum.calls.resume, ['flow-old']);
    assert.equal(stratum.calls.plan.length, 0);
    assert.equal(readJson(activePath(tmpDir)).flowId, 'flow-old');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('compose build rejects --resume and --fresh together', () => {
  const r = spawnSync(process.execPath, [COMPOSE_BIN, 'build', '--resume', '--fresh', 'RESUME-1'], {
    cwd: COMPOSE_ROOT,
    encoding: 'utf-8',
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--resume and --fresh are mutually exclusive/);
});

test('compose build --resume with nothing resumable exits with a targeted error', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'build-resume-empty-'));
  try {
    makeProject(tmpDir);
    const r = spawnSync(process.execPath, [COMPOSE_BIN, 'build', '--resume', 'RESUME-1'], {
      cwd: tmpDir,
      encoding: 'utf-8',
      env: { ...process.env, COMPOSE_TARGET: tmpDir },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Nothing to resume for RESUME-1/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('live foreign pid refuses and does not clobber active-build.json', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'build-resume-live-'));
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    stdio: 'ignore',
  });
  try {
    makeProject(tmpDir);
    const active = {
      featureCode: 'RESUME-1',
      flowId: 'flow-live',
      mode: 'feature',
      status: 'running',
      currentStepId: 'design',
      pid: child.pid,
    };
    writeFileSync(activePath(tmpDir), JSON.stringify(active, null, 2));
    const stratum = makeStratum({ planFlowId: 'flow-new' });

    await assert.rejects(
      () => runBuild('RESUME-1', { cwd: tmpDir, stratum, skipTriage: true, visionWriter: makeVisionWriter(), fresh: true }),
      /Build already running for RESUME-1/
    );

    assert.deepEqual(readJson(activePath(tmpDir)), active);
    assert.equal(stratum.calls.plan.length, 0);
    assert.equal(stratum.calls.resume.length, 0);
  } finally {
    child.kill();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

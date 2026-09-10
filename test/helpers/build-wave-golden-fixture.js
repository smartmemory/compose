/** Test-only carry preset and hybrid inference driver. All engine RPCs are real. */
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { runBuild } from '../../lib/build.js';
import { ConsumerFanoutArtifacts } from '../../lib/consumer-fanout.js';
import { StratumMcpClient } from '../../lib/stratum-mcp-client.js';
import { TS_MCP_BIN } from './stratum-test-bin.js';
import { fakeBuildStratum, agentResult } from './build-stratum-fixture.js';
import { decisionProfiles, decision } from './build-wave-fixture.js';
import { makeFakeCodexProject } from './fake-codex-project.js';
import { git } from './consumer-wave-fixture.js';

export const CODE = 'D3-GOLDEN-1';
export const CORE = 'module.exports = x => x * 2;\n';
export const BROKEN = "const core = require('./core.cjs'); module.exports = x => core(x) + 1;\n";
export const FIXED = "const core = require('./core.cjs'); module.exports = x => core(x);\n";
export const FINDING = { severity: 'error', files: ['adapter.cjs'], claim: 'Adapter adds one to core output',
  evidence: 'adapter(3) must equal 6; integrated assertion failed while core unit test passed' };
export const PROFILES = { ...decisionProfiles,
  plan: 'claude:orchestrator:coordinator', verify: 'claude:orchestrator:coordinator',
  assess: 'claude:orchestrator:coordinator', review: 'codex:reviewer:critical',
  execute: { default: 'codex:implementer:critical', tier_from: 'item.tier' },
  _costCeiling: { input: 'cost_ceiling_usd', default: 150, gates: ['assess_gate'] },
};
export const WAVE_GOLDEN_SPEC = YAML.stringify({ version: 1,
  contracts: {
    TaskGraph: { tasks: 'object[]' }, Work: { outcome: 'string', summary: 'string', files_changed: 'string[]?' },
    Verification: { tests_pass: 'boolean', summary: 'string' }, WaveReview: { blocking: 'boolean', findings: 'object[]' },
    WaveDecision: { action: 'string', rationale: 'string', addressed_findings: 'object[]', open_findings: 'object[]',
      open_count: 'number', blocking: 'boolean', tasks: 'object[]' },
    Ship: { phase: 'string', artifact: 'string', outcome: 'string', summary: 'string', files_changed: 'string[]?', commit_hash: 'string?' },
  },
  flows: { entry: 'bug_fix', bug_fix: {
    input: { task: 'string' }, max_rounds: 4,
    output: { from: '${ship.output}', contract: 'Ship' },
    carry: { wave: { initial: '${plan.output.tasks}', on_revise: { assess_gate: '${assess.output.tasks}' } } },
    steps: [
      { id: 'plan', agent: 'claude', do: 'D3_PLAN', out: 'TaskGraph' },
      { id: 'execute', after: ['plan'], fanout: { over: '${wave}', dispatch: 'consumer', concurrency: 3,
        isolation: 'worktree', require: 'all', merge: 'sequential',
        steps: [{ agent: 'codex', do: 'D3_WORK ${item}', out: 'Work' }] } },
      { id: 'execute_merge', after: ['execute'], gate: { on_approve: 'verify', on_revise: 'execute', on_kill: null, max_rounds: 4 } },
      { id: 'verify', after: ['execute_merge'], agent: 'claude', do: 'D3_VERIFY', out: 'Verification' },
      { id: 'review', after: ['verify'], agent: 'codex', do: 'D3_REVIEW', out: 'WaveReview' },
      { id: 'assess', after: ['review'], agent: 'claude', do: 'D3_ASSESS', out: 'WaveDecision' },
      { id: 'assess_gate', after: ['assess'], gate: { on_approve: 'ship', on_revise: 'execute', on_kill: null, max_rounds: 4 } },
      { id: 'ship', after: ['assess_gate'], agent: 'claude', do: 'ship', out: 'Ship' },
    ],
  } },
});

const task = (id, file, tier) => ({ id, description: id, files_owned: [file], files_read: [], depends_on: [],
  ...(tier === undefined ? {} : { tier }) });
export function goldenTasks(scenario) {
  if (scenario === 'unknown') return Array.from({ length: 6 }, (_, i) => task(`UNKNOWN_${i}`, `unknown-${i}.txt`, i === 5 ? 'imaginary' : 'standard'));
  if (scenario === 'ownership') return [task('ESCAPE', 'owned.txt', 'critical')];
  if (scenario === 'crash') return [task('CORE', 'core.cjs', 'critical')];
  return [task('CORE', 'core.cjs', 'critical'), task('BROKEN', 'adapter.cjs', 'standard'),
    task('FAST', 'fast.txt', 'fast'), task('DEFAULT', 'default.txt')];
}
export const REPAIR = { ...task('REPAIR', 'adapter.cjs', 'critical'), files_read: ['core.cjs'] };

export async function makeWaveGoldenProject(scenario = 'repair') {
  const work = { outcome: 'complete', summary: 'fake worker finished', files_changed: [] };
  const lane = (id, writes, extra = {}) => ({ name: id, match: `"id":"${id}"`, writes, text: JSON.stringify(work), ...extra });
  const fixture = await makeFakeCodexProject({ featureCode: CODE, template: 'bug-fix', spec: WAVE_GOLDEN_SPEC,
    profiles: PROFILES, git: true, recordModel: true, intentOnly: true, costUsd: 0.001,
    files: {
      '.compose/data/settings.json': JSON.stringify({ policies: { execute_merge: 'skip', assess_gate: 'skip' } }),
      'docs/bugs/D3-GOLDEN-1/description.md': '# Deterministic wave golden\n',
      'package.json': JSON.stringify({ scripts: { test: 'node --test unit.test.cjs' } }),
      'unit.test.cjs': "const { test } = require('node:test'); const assert = require('node:assert/strict');\ntest('core doubles', () => assert.equal(require('./core.cjs')(3), 6));\n",
      'untouched.txt': 'parent sentinel\n',
      ...(scenario === 'crash' ? { 'adapter.cjs': FIXED } : {}),
    },
    lanes: [
      { name: 'review', match: 'D3_REVIEW', review: {
        check: "require('node:assert/strict').equal(require('./adapter.cjs')(3), 6)", finding: FINDING } },
      lane('REPAIR', [{ path: 'adapter.cjs', content: FIXED }], { prerequisites: [{ path: 'core.cjs', content: CORE }] }),
      lane('CORE', [{ path: 'core.cjs', content: CORE }]),
      lane('BROKEN', [{ path: 'adapter.cjs', content: BROKEN }]),
      lane('FAST', [{ path: 'fast.txt', content: 'fast once\n' }]),
      lane('DEFAULT', [{ path: 'default.txt', content: 'default once\n' }]),
      lane('ESCAPE', [{ path: 'owned.txt', content: 'owned\n' }, { path: 'untouched.txt', content: 'forbidden\n' }]),
      // Unmatched invocations terminate and fail their contract instead of hanging.
      { name: 'UNEXPECTED', text: '{"unexpected":true}' },
    ],
  });
  git(fixture.workspace, ['config', 'user.name', 'Wave Golden']);
  git(fixture.workspace, ['config', 'user.email', 'wave@example.test']);
  fixture.base = git(fixture.workspace, ['rev-parse', 'HEAD']);
  fixture.artifactRoot = join(fixture.stateRoot, 'artifacts');
  fixture.tracePath = join(fixture.stateRoot, 'trace.jsonl');
  fixture.resultPath = join(fixture.stateRoot, 'result.json');
  fixture.crashPath = join(fixture.stateRoot, 'crash.json');
  fixture.scenario = scenario;
  fixture.tasks = goldenTasks(scenario);
  return fixture;
}

export async function readGoldenJournal(fixture) {
  const dirs = await readdir(fixture.artifactRoot, { withFileTypes: true });
  const paths = dirs.filter(d => d.isDirectory());
  assert.equal(paths.length, 1, 'exactly one flow journal');
  return JSON.parse(await readFile(join(fixture.artifactRoot, paths[0].name, 'journal.json'), 'utf8'));
}
export async function readGoldenTrace(fixture) {
  try { return (await readFile(fixture.tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

/** The real client's agentRun is never replaced. Only Claude calls use the d2 fake path. */
export async function runWaveGolden(fixture, { resumeFlowId, crash = false } = {}) {
  process.env.NODE_ENV = 'test';
  const previousRoot = process.env.STRATUM_STATE_ROOT;
  process.env.STRATUM_STATE_ROOT = fixture.stateRoot;
  const record = value => appendFileSync(fixture.tracePath, `${JSON.stringify(value)}\n`);
  const client = new StratumMcpClient();
  let flowId = resumeFlowId;
  const fake = fakeBuildStratum({ agentRun: async (_provider, prompt, opts) => {
    let output;
    const step = prompt.match(/executing step "([^"]+)"/)?.[1];
    if (step === 'plan') output = { tasks: fixture.tasks };
    else if (step === 'verify') {
      const unitEnv = { ...process.env };
      delete unitEnv.NODE_TEST_CONTEXT;
      const unitOutput = execFileSync(process.execPath, ['--test', 'unit.test.cjs'], { cwd: opts.cwd, env: unitEnv, encoding: 'utf8' });
      assert.match(unitOutput, /# fail 0/);
      output = { tests_pass: true, summary: 'core unit test passes' };
    } else if (step === 'assess') {
      const review = (await client.audit(flowId)).steps.review.output;
      output = review.blocking ? decision('repair', { blocking: true, tasks: [REPAIR], open_findings: review.findings, open_count: review.findings.length })
        : decision('complete', { addressed_findings: fixture.scenario === 'repair' ? [FINDING] : [] });
    } else throw new Error(`Unexpected Claude step: ${step}`);
    record({ kind: 'claude', step, output });
    return { ...agentResult(output, `fake:${step}:${Date.now()}`), usdSource: 'reported' };
  } });
  const stratum = new Proxy(client, { get(target, key) {
    if (key === 'agentRun') return (provider, prompt, opts) => provider === 'claude'
      ? fake.agentRun(provider, prompt, opts) : target.agentRun(provider, prompt, opts);
    if (key === 'plan') return async (...args) => {
      const response = await target.plan(...args); flowId = response.runId; return response;
    };
    if (key === 'stepDone') return async (...args) => {
      const response = await target.stepDone(...args);
      record({ kind: 'step_done', step: args[1], envelope: args[2], token: args[3], status: response.status });
      return response;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const originalMark = ConsumerFanoutArtifacts.prototype.markCheckpointPublished;
  if (crash) ConsumerFanoutArtifacts.prototype.markCheckpointPublished = function (args) {
    // recoverCheckpoint has just CAS-published the ref; the fsynced record is still prepared.
    const checkpoint = this.journal.wave.checkpoints.find(c => c.gateToken === args.gateToken);
    assert.equal(checkpoint.state, 'prepared');
    assert.equal(git(this.targetCwd, ['rev-parse', this.journal.wave.ref]), checkpoint.commit);
    writeFileSync(fixture.crashPath, JSON.stringify({ flowId: this.runId, checkpoint, ref: this.journal.wave.ref }));
    process.kill(process.pid, 'SIGKILL');
  };
  try {
    const connection = { command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
      args: [TS_MCP_BIN], env: fixture.env, cwd: fixture.workspace };
    await client.connect(connection);
    const result = await runBuild(CODE, { cwd: fixture.workspace, mode: 'bug', template: 'bug-fix', stratum,
      skipTriage: true, consumerArtifactsRoot: fixture.artifactRoot,
      gateOpts: { nonInteractive: true }, ...(resumeFlowId ? { resumeFlowId } : {}) });
    // runBuild owns closing even an injected client; reopen for durable terminal audit.
    await client.connect(connection);
    const audit = flowId ? await client.audit(flowId) : null;
    await writeFile(fixture.resultPath, JSON.stringify({ result, audit }, null, 2));
    return { result, audit, flowId };
  } finally {
    ConsumerFanoutArtifacts.prototype.markCheckpointPublished = originalMark;
    await client.close();
    if (previousRoot === undefined) delete process.env.STRATUM_STATE_ROOT;
    else process.env.STRATUM_STATE_ROOT = previousRoot;
  }
}

// Explicit child entry point, inert when imported or discovered by node --test.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--driver') {
  const config = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  await runWaveGolden(config.fixture, config.options);
}

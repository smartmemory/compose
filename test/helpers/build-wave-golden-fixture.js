/** Test-only carry preset and hybrid inference driver. All engine RPCs are real. */
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
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

export const ROUTING_INPUTS = ['route_mode', 'routing_start', 'routing_root', 'routing_plan_intent', 'routing_continuation'];
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

export async function makeWaveGoldenProject(scenario = 'repair', options = {}) {
  const authored = YAML.parse(WAVE_GOLDEN_SPEC);
  if (options.routingInputs) Object.assign(authored.flows.bug_fix.input, Object.fromEntries(
    ROUTING_INPUTS.map(key => [key, 'string?'])));
  const spec = options.routingInputs ? YAML.stringify(authored) : WAVE_GOLDEN_SPEC;
  const work = { outcome: 'complete', summary: 'fake worker finished', files_changed: [] };
  const lane = (id, writes, extra = {}) => ({ name: id, match: `"id":"${id}"`, writes, text: JSON.stringify(work), ...extra });
  const fixture = await makeFakeCodexProject({ featureCode: CODE, template: 'bug-fix', spec,
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
  fixture.spec = spec;
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
export async function runWaveGolden(fixture, { resumeFlowId, crash = false, route_mode, traceRouting = false } = {}) {
  const previousNodeEnv = process.env.NODE_ENV;
  const events = [];
  const capture = value => events.push(serializeGolden(value));
  const routingSnapshots = [];
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
    if (key === 'agentRun') return (provider, prompt, opts) => {
      capture({ kind: 'call', provider, prompt, opts });
      if (traceRouting) routingSnapshots.push(readRoutingEvidence(fixture, flowId));
      return provider === 'claude' ? fake.agentRun(provider, prompt, opts) : target.agentRun(provider, prompt, opts);
    };
    if (key === 'plan') return async (...args) => {
      capture({ kind: 'plan', spec: args[0], flow: args[1], input: args[2], opts: args[3] });
      const response = await target.plan(...args); flowId = response.runId; return response;
    };
    if (key === 'stepDone') return async (...args) => {
      const response = await target.stepDone(...args);
      record({ kind: 'step_done', step: args[1], envelope: args[2], token: args[3], status: response.status,
        ...(traceRouting ? { ready: response.ready?.map(d => ({ id: d.id, token: d.dispatchToken })) } : {}) });
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
      skipTriage: true, consumerArtifactsRoot: fixture.artifactRoot, ...(route_mode === undefined ? {} : { route_mode }),
      gateOpts: { nonInteractive: true }, ...(resumeFlowId ? { resumeFlowId } : {}) });
    // runBuild owns closing even an injected client; reopen for durable terminal audit.
    await client.connect(connection);
    const audit = flowId ? await client.audit(flowId) : null;
    await writeFile(fixture.resultPath, JSON.stringify({ result, audit }, null, 2));
    return { result, audit, flowId, events, routingSnapshots };
  } catch (error) {
    if (traceRouting && flowId) {
      const state = JSON.parse(readFileSync(join(fixture.stateRoot, `${flowId}.json`)));
      console.error('ROUTING_GOLDEN_FAILURE', JSON.stringify({ code: error.code, flowId,
        reports: (await readGoldenTrace(fixture)).filter(e => e.kind === 'step_done'),
        items: state.steps.execute?.fanout?.items?.map(i => ({ index: i.index, status: i.status,
          dispatchToken: i.dispatchToken, acceptedDispatchToken: i.acceptedDispatchToken, generation: i.generation, epoch: i.epoch })) }));
    }
    throw error;
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
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


/** Match the frozen recorder's JSON boundary. Do not project selected options. */
export function serializeGolden(value) {
  return JSON.parse(JSON.stringify(value, (key, value) =>
    typeof value === 'function' || key === 'signal' ? undefined : value));
}
export function frozenRoutingBaseline(name) {
  const frozen = JSON.parse(readFileSync(new URL(`../fixtures/model-route-off-${name}-v0.5.1.json`, import.meta.url)));
  assert.equal(frozen.captured, true);
  assert.equal(frozen.sourceRevision, '5fbf8e0bd5dae18eb92a08197b5a9a50743722dc');
  return frozen;
}

/** Only fixture cwd/workspace, UUIDs, and TAP duration_ms are incidental.
 * Sort contiguous execute calls within a wave, never across ordinary barriers.
 * Sorting precedes UUID numbering so scheduler arrival cannot rename identities.
 */
export function normalizedGoldenCalls(events) {
  const plan = events.find(e => e.kind === 'plan');
  const workspace = plan.opts.workspaceRoot;
  const calls = events.filter(e => e.kind === 'call').map(serializeGolden);
  const step = c => c.opts.telemetry?.step_id ?? c.opts.flow?.stepId;
  for (let i = 0; i < calls.length;) {
    if (!/^execute\/\d+$/.test(step(calls[i]))) { i++; continue; }
    let end = i + 1;
    while (end < calls.length && /^execute\/\d+$/.test(step(calls[end]))) end++;
    calls.splice(i, end - i, ...calls.slice(i, end).sort((a, b) => step(a).localeCompare(step(b), 'en', { numeric: true })));
    i = end;
  }
  const uuids = new Map();
  return calls.map(call => {
    const cwd = call.opts.cwd;
    const walk = value => {
      if (typeof value === 'string') return value
        .replaceAll(cwd, cwd === workspace ? '<workspace>' : '<dispatch-cwd>')
        .replaceAll(workspace, '<workspace>')
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, id => {
          if (!uuids.has(id)) uuids.set(id, `<uuid-${uuids.size}>`);
          return uuids.get(id);
        })
        .replace(/(duration_ms: |# duration_ms )[0-9.]+/g, '$1<TAP-duration>');
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
      return value;
    };
    return walk(call);
  });
}

export function readRoutingEvidence(fixture, flowId) {
  const snapshot = JSON.parse(readFileSync(join(fixture.stateRoot, `${flowId}.json`)));
  const start = JSON.parse(snapshot.input.routing_start);
  const rootBytes = readFileSync(join(fixture.workspace, '.compose/routing/starts', start.startId, 'routing-start.json'), 'utf8');
  const journalDir = readdirSync(fixture.artifactRoot).find(name => name.startsWith(flowId));
  const journal = JSON.parse(readFileSync(join(fixture.artifactRoot, journalDir, 'journal.json')));
  return { rootBytes, input: snapshot.input, journal };
}

export function assertRoutingGolden(evidence, callCount) {
  const { journal, input, rootBytes } = evidence;
  const start = JSON.parse(rootBytes);
  assert.equal(start.rootDigest, input.routing_root);
  assert.equal(start.rootDigest, journal.routing.rootDigest);
  assert.deepEqual(JSON.parse(input.routing_start), start);
  const records = Object.values(journal.routing.records);
  const issuances = records.filter(r => r.type === 'issuance');
  assert.equal(issuances.length, callCount);
  assert.equal(new Set(issuances.map(r => r.issuanceToken)).size, callCount);
  for (const issuance of issuances) {
    assert.equal(journal.routing.tokenIndex[issuance.issuanceToken], issuance.id);
    const admission = journal.routing.records[issuance.admissionId];
    assert.equal(admission.type, 'admission');
    assert.deepEqual(issuance.selected, admission.admitted);
    assert.deepEqual(issuance.would, admission.would);
    assert.equal(issuance.rootDigest, start.rootDigest);
    assert.equal(admission.rootDigest, start.rootDigest);
    const events = records.filter(r => r.type === 'issuance-event' && r.issuanceId === issuance.id);
    assert.deepEqual(events.map(e => e.event), ['launch-intent', 'result-prepared', 'settled']);
  }
  return records;
}

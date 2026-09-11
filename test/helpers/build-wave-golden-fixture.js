/** Test-only carry preset and hybrid inference driver. All engine RPCs are real. */
// HERMETICITY GUARD. These goldens reach a real `execute_merge` gate, and
// lib/build.js:5915 delegates a gate to the web UI whenever probeServer() finds
// a Compose server (resolvePort(): COMPOSE_PORT > PORT > 4001). With a dev
// server up on 4001 the run then polls for a human resolution and the file dies
// on its whole-file --test-timeout, reporting `fail 0 / cancelled N` -- a hang
// wearing the mask of a flake. `npm test` avoids it only because it preloads
// test/suppress-expected-drift.js; a targeted `node --test <file>` invocation
// does not, so the guard belongs with the tests that need it rather than with
// whoever remembers the flag. ESM hoists the imports below above this
// assignment, which is harmless: resolvePort() reads process.env at CALL time
// (lib/resolve-port.js:12), during the gate, not at module load. All three
// golden files import this helper, so the guard covers each of them. An
// explicit COMPOSE_PORT (e.g. a live-server test) is never overridden.
if (!process.env.COMPOSE_PORT) process.env.COMPOSE_PORT = '19997';
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

/** SDK inputs only: both production connectors own output/error/telemetry shapes. */
export async function goldenProviderTool(respond, onCall = () => {}) {
  const { realCodexTool } = await import('./real-codex-tool.js');
  const { ClaudeConnector } = await import('../../../stratum/ts/dist/connectors/claude.js');
  const { McpError, ErrorCode } = await import('@modelcontextprotocol/sdk/types.js');
  return async (request, schema, progress) => {
    const args = request.arguments;
    onCall(serializeGolden(args));
    const input = await respond(args);
    try {
      if (args.agent === 'codex') return await realCodexTool({ sdkEvents: async function* () {
        yield { type: 'item.completed', item: { type: 'agent_message', text: input.text } };
        if (!input.unknown) yield { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 5,
          cached_input_tokens: 2, total_cost_usd: input.usd } };
        if (input.failed) throw Error('controlled SDK failure');
      } })(request, schema, progress);
      let seq = 0;
      const producer = new ClaudeConnector({ model: args.model ?? 'claude-sonnet-4-6', effort: args.effort,
        env: {}, query: async function* () {
          yield { type: 'system', subtype: 'init', model: args.model ?? 'claude-sonnet-4-6' };
          yield { type: 'result', subtype: input.failed ? 'error_max_turns' : 'success', result: input.text,
            ...(input.unknown ? {} : { total_cost_usd: input.usd, duration_ms: 31, usage: { input_tokens: 3, output_tokens: 5 } }) };
        }, onEvent(event) { progress.onprogress({ message: JSON.stringify({ schema_version: '0.2.8',
          step_id: '_agent_run', seq: seq++, ts: new Date().toISOString(), kind: event.kind,
          metadata: { ...event.metadata, stepId: '_agent_run' } }) }); } });
      return { content: [{ type: 'text', text: JSON.stringify(await producer.run(args.prompt)) }] };
    } catch (error) {
      // The MCP server's error boundary carries the real connector's own evidence.
      throw new McpError(ErrorCode.InternalError, error.message, { code: 'AGENT_FAILED',
        ...Object.fromEntries(['usage', 'usdSource', 'split', 'telemetry'].filter(k => error[k] !== undefined).map(k => [k, error[k]])) });
    }
  };
}

/** A real carry runner with independent A/B SDK amounts and receipt identities. */
export async function paidWaveGolden(t, { repair = null, unknown = false, failPrimary = false, late = false } = {}) {
  const { runtimeFixture } = await import('./routing-runtime-fixture.js');
  const { syncBuiltinESMExports } = await import('node:module');
  const crypto = (await import('node:crypto')).default;
  const authored = YAML.parse(WAVE_GOLDEN_SPEC);
  Object.assign(authored.flows.bug_fix.input, Object.fromEntries(ROUTING_INPUTS.map(k => [k, 'string?'])));
  if (failPrimary) authored.flows.bug_fix.steps[1].attempts = 1;
  const tasks = ['A', 'B'].map(id => ({ id, description: id, files_owned: [`${id.toLowerCase()}.txt`],
    files_read: [], depends_on: [], tier: 'standard' }));
  if (repair) {
    authored.contracts.ReviewResult = YAML.parse(readFileSync(new URL('../../presets/team-review.stratum.yaml', import.meta.url), 'utf8')).contracts.ReviewResult;
    authored.flows.bug_fix.steps[1].fanout.steps[0].out = 'ReviewResult';
  }
  const finding = { severity: 'error', files: ['b.txt'], claim: 'B needs repair', evidence: 'B0 differs from B1' };
  let deliver = !late;
  const calls = [], returned = [], gates = [], submissions = [];
  const releases = new Map();
  let stopHolding = false;
  const costs = { A0: 1, B0: 2, A0repair: 4, B0repair: 8, B1: 16, B1repair: 32 };
  const ids = Object.fromEntries(Object.keys(costs).map((k, i) => [k, `d3000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`]));
  const label = prompt => {
    const id = prompt.match(/"id"\s*:\s*"([AB])"/)?.[1];
    const child = /TEXT-([AB][01])/.exec(prompt);
    if (child) return `${child[1]}repair`;
    if (id) return `${id}${f.snapshot().steps.execute.epoch ?? 0}`;
    return prompt.match(/executing step "([^"]+)"/)?.[1] ?? 'other';
  };
  const { _costCeiling, ...paidProfiles } = PROFILES;
  const f = await runtimeFixture(t, { spec: authored, profiles: paidProfiles, intercept(method, args, response) {
    if (method === 'before:usageReport' && args[1].detail?.routing?.kind === 'paid-call') {
      submissions.push(structuredClone(args));
      if (!deliver) throw Error('controlled receipt delivery outage');
    }
    if (method === 'before:gateResolve') gates.push({ args, snapshot: f.snapshot(), journal: f.journal() });
  } });
  const tool = await goldenProviderTool(async args => {
    const name = label(args.prompt); calls.push(name);
    const epoch = f.snapshot().steps.execute?.epoch ?? 0;
    if (!stopHolding && ['A0', 'B0', 'A0repair', 'B0repair'].includes(name)) await new Promise(resolve => releases.set(name, resolve));
    let output;
    if (name === 'plan') output = { tasks };
    else if (name === 'verify') output = { tests_pass: true, summary: 'verified' };
    else if (name === 'review') output = { blocking: epoch === 0, findings: epoch === 0 ? [finding] : [] };
    else if (name === 'assess') output = epoch === 0 ? decision('repair', { blocking: true, tasks: [tasks[1]], open_findings: [finding], open_count: 1 }) : decision('complete');
    else if (name.endsWith('repair')) output = repair === 'success' ? { clean: true, findings: [], summary: 'repaired JSON' } : null;
    else if (/^[AB][01]$/.test(name)) {
      writeFileSync(join(args.cwd, `${name[0].toLowerCase()}.txt`), `${name}\n`);
      output = { outcome: 'complete', summary: name, files_changed: [`${name[0].toLowerCase()}.txt`] };
    } else throw Error(`Unexpected golden call ${name}`);
    returned.push(name);
    return { text: name.endsWith('repair') && !output ? 'still malformed' : repair && /^[AB][01]$/.test(name) ? `TEXT-${name}` : JSON.stringify(output),
      usd: costs[name] ?? 0.25, unknown: unknown && name === 'B1',
      failed: repair === 'failed' && name.endsWith('repair') || failPrimary && name === 'B0' };
  });
  f.connector._testClient = { callTool: tool };
  const originalRun = f.connector.agentRun.bind(f.connector);
  f.connector.agentRun = (provider, prompt, opts = {}) => {
    const name = label(prompt), originalUUID = crypto.randomUUID;
    if (!ids[name]) return originalRun(provider, prompt, opts);
    // Pin entropy at the connector boundary, never write an intent/join ourselves.
    let first = true;
    crypto.randomUUID = () => first ? (first = false, ids[name]) : originalUUID();
    syncBuiltinESMExports();
    try {
      const pinned = Object.create(Object.getPrototypeOf(opts), Object.getOwnPropertyDescriptors(opts));
      pinned.correlationId = `d3-${name}`;
      return originalRun(provider, prompt, pinned);
    }
    finally { crypto.randomUUID = originalUUID; syncBuiltinESMExports(); }
  };
  const until = async name => {
    for (let n = 0; n < 1000 && !releases.has(name); n++) await new Promise(r => setTimeout(r, 10));
    assert.ok(releases.has(name), `producer reached ${name}; calls=${calls.join(',')}`);
  };
  const runBuildFixture = f.run;
  const run = async () => {
    const pending = runBuildFixture(); pending.catch(() => {});
    let scheduleError;
    try {
      await until('A0'); await until('B0'); releases.get('B0')();
      if (repair) await until('B0repair');
      releases.get('A0')();
      if (repair) { await until('A0repair'); releases.get('A0repair')(); releases.get('B0repair')(); }
    } catch (error) {
      scheduleError = error; stopHolding = true;
      for (const release of releases.values()) release();
    }
    const result = await pending;
    if (scheduleError) throw scheduleError;
    return result;
  };
  return Object.assign(f, { paidCalls: calls, returned, costs, ids, gates, submissions, run,
    enableDelivery() { deliver = true; } });
}

/** Check every input key; shadow's declared transport is separately validated. */
export function assertShadowGoldenInput(actual, frozenInput) {
  const start = JSON.parse(actual.routing_start);
  assert.deepEqual(start.originalInput, frozenInput);
  assert.equal(actual.routing_root, start.rootDigest);
  assert.match(actual.routing_plan_intent, /^[0-9a-f-]{36}$/);
  assert.deepEqual(actual, { ...frozenInput, route_mode: 'shadow', routing_start: actual.routing_start,
    routing_root: start.rootDigest, routing_plan_intent: actual.routing_plan_intent });
}

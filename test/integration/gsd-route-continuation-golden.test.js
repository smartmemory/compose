/** Real GSD/TS engine, deterministic inference, real merge/halt/crash writers.
 * The child entry point never registers tests and never invokes the recorder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { runGsd } from '../../lib/gsd.js';
import { resumeRouting, admitConsumerWave } from '../../lib/build.js';
import { ConsumerFanoutArtifacts, ConsumerMergeDecisionError } from '../../lib/consumer-fanout.js';
import { StratumMcpClient } from '../../lib/stratum-mcp-client.js';
import { routingDigest } from '../../lib/model-router.js';
import { routingIssuanceState } from '../../lib/routing-ledger.js';
import { installAgentHarness } from '../helpers/ts-agent-harness.js';
import { TS_MCP_BIN } from '../helpers/stratum-test-bin.js';
import { frozenRoutingBaseline, serializeGolden } from '../helpers/build-wave-golden-fixture.js';

const SELF = fileURLToPath(import.meta.url);
const CODE = 'COMP-GSD-5-FIX';
const SPEC = YAML.parse(readFileSync(new URL('../../pipelines/gsd.stratum.yaml', import.meta.url), 'utf8'));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const resultPath = id => `.compose/gsd/${CODE}/results/${id}.json`;
const taskResult = id => ({ status: 'passed', files_changed: [`${id.toLowerCase()}.txt`], summary: `${id} done`,
  produces: {}, gates: [{ command: 'true', status: 'pass', output: '' }], attempts: 1 });
function fixture(t, ids = ['A', 'B']) {
  const root = mkdtempSync(join(tmpdir(), 'gsd-route-golden-'));
  const f = { root, cwd: join(root, 'workspace'), stateRoot: join(root, 'engine'), artifactRoot: join(root, 'artifacts'), ids };
  mkdirSync(f.cwd); mkdirSync(f.stateRoot);
  const git = args => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8' });
  git(['init', '-q']); git(['config', 'user.name', 'Route Golden']); git(['config', 'user.email', 'route@example.test']);
  mkdirSync(join(f.cwd, 'docs/features', CODE), { recursive: true });
  const rows = ids.map(id => `| \`${id.toLowerCase()}.txt\` | new | ${id} |`).join('\n');
  const slices = ids.map((id, i) => `### S0${i + 1}: ${id}\n\nFile Plan: \`${id.toLowerCase()}.txt\` (new)\n\nProduces:\n  ${id.toLowerCase()}.txt → ${id.toLowerCase()} (function)\n\nConsumes: nothing`).join('\n\n');
  writeFileSync(join(f.cwd, 'docs/features', CODE, 'blueprint.md'), `# Routing\n\n## File Plan\n\n| File | Action | Purpose |\n|------|--------|---------|\n${rows}\n\n## Boundary Map\n\n${slices}\n`);
  // Results must participate in actual worktree diffs/merge; only control files are ignored.
  writeFileSync(join(f.cwd, '.gitignore'), '.compose/data/\n.compose/gsd/**\n!.compose/gsd/\n!.compose/gsd/*/\n!.compose/gsd/*/results/\n!.compose/gsd/*/results/*.json\n');
  git(['add', '.']); git(['commit', '-qm', 'base']);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return f;
}
const control = (f, name) => join(f.cwd, '.compose/gsd', CODE, name);
function trace(f) {
  const path = join(f.root, 'trace.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}
function journal(f, runId) {
  const dir = readdirSync(f.artifactRoot).find(d => d.startsWith(runId));
  assert.ok(dir, `journal for ${runId}`);
  return json(join(f.artifactRoot, dir, 'journal.json'));
}
const snapshot = (f, id) => json(join(f.stateRoot, `${id}.json`));
const records = j => Object.values(j.routing.records);
function rootBytes(f, j) {
  return readFileSync(join(f.cwd, '.compose/routing/starts', j.routing.startId, 'routing-start.json'), 'utf8');
}

async function drive(f, options) {
  process.env.STRATUM_STATE_ROOT = f.stateRoot;
  const record = value => appendFileSync(join(f.root, 'trace.jsonl'), JSON.stringify(serializeGolden(value)) + '\n');
  const client = new StratumMcpClient();
  await client.connect({ command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath, args: [TS_MCP_BIN], cwd: f.cwd,
    env: { ...process.env, STRATUM_STATE_ROOT: f.stateRoot, RESEND_API_KEY: '', STRIPE_API_KEY: '' } });
  installAgentHarness(client, (_provider, opts) => ({
    async *run(prompt) {
      const id = prompt.match(/"id":"([ABC])"/)?.[1];
      record({ kind: 'call', id: id ?? 'decompose', prompt });
      if (!id) {
        yield { type: 'assistant', content: JSON.stringify({ tasks: f.ids.map((id, i) => ({ id, description: `Task ${id}`,
          files_owned: [`${id.toLowerCase()}.txt`, resultPath(id)], files_read: [], depends_on: i ? ['A'] : [] })) }) };
        return;
      }
      if (options.uncertain === id) {
        record({ kind: 'boundary', boundary: options.crash ? 'uncertain-crash' : 'stuck-detector', id });
        if (options.crash) process.kill(process.pid, 'SIGKILL');
        for (let i = 0; i < 4; i++) yield { type: 'tool_use', tool: 'Edit', input: { file_path: `${id.toLowerCase()}.txt` } };
      }
      const changed = [];
      if ((options.complete ?? []).includes(id)) {
        writeFileSync(join(opts.cwd, `${id.toLowerCase()}.txt`), `${id} done\n`);
        mkdirSync(dirname(join(opts.cwd, resultPath(id))), { recursive: true });
        writeFileSync(join(opts.cwd, resultPath(id)), JSON.stringify(taskResult(id)));
        changed.push(`${id.toLowerCase()}.txt`, resultPath(id));
      }
      yield { type: 'assistant', content: JSON.stringify({ outcome: 'complete', summary: `${id} settled`, files_changed: changed }) };
    }, interrupt() {}, get isRunning() { return false; },
  }), f.cwd);
  let flowId;
  let mergeFailed = false;
  const realPrepare = ConsumerFanoutArtifacts.prototype.prepareMerge;
  if (options.revise) ConsumerFanoutArtifacts.prototype.prepareMerge = function (args) {
    if (!mergeFailed) {
      mergeFailed = true;
      record({ kind: 'merge-source', source: snapshot(f, flowId).steps.decompose_gsd });
      // A concurrent target edit conflicts with the worker's add-file patch.
      // Let real Git witness precomputation generate the typed merge error.
      writeFileSync(join(f.cwd, 'a.txt'), 'conflicting target edit\n');
      try { return realPrepare.call(this, args); }
      catch (error) {
        assert.ok(error instanceof ConsumerMergeDecisionError);
        record({ kind: 'merge-error', code: error.code });
        throw error;
      }
    }
    return realPrepare.call(this, args);
  };
  const stratum = new Proxy(client, { get(target, key) {
    if (key === 'plan') return async (...args) => {
      record({ kind: 'plan', input: args[2], flow: args[1], opts: args[3] });
      if (args[2].routing_continuation) {
        const start = JSON.parse(args[2].routing_start);
        const intent = json(join(f.cwd, '.compose/routing/starts', start.startId, 'records', `${args[2].routing_continuation}.json`));
        assert.equal(intent.type, 'continuation-intent', 'intent exists before the real plan RPC');
      }
      const next = await target.plan(...args); flowId = next.runId;
      record({ kind: 'planned', runId: flowId });
      if (options.ambiguousPlan) record({ kind: 'duplicate-plan', runId: (await target.plan(...args)).runId });
      if (options.crashPlan || options.ambiguousPlan) {
        record({ kind: 'boundary', boundary: 'plan-before-ack' }); process.kill(process.pid, 'SIGKILL');
      }
      if (options.lostAck) throw new Error('golden lost plan acknowledgement');
      return next;
    };
    if (key === 'gateResolve') return async (...args) => {
      const next = await target.gateResolve(...args);
      record({ kind: 'gate', runId: args[0], decision: args[2] });
      if (options.revise && args[2] === 'revise') rmSync(join(f.cwd, 'a.txt'), { force: true });
      if (args[2] === 'approve' && options.stop === 'crash') {
        record({ kind: 'boundary', boundary: 'merged-before-gate-ack' }); process.kill(process.pid, 'SIGKILL');
      }
      // Fault injection at the engine-response boundary, AFTER real settlement
      // and merge. The production budget halt writer creates all pause/state bytes.
      if (args[2] === 'approve' && options.stop === 'halt') return { ...next, status: 'budget_exhausted',
        ledger: { spent: { tokens: 1 }, budget: { tokens: 1 } } };
      return next;
    };
    if (key === 'stepDone' && options.stop === 'merge') return async (...args) => {
      const next = await target.stepDone(...args); flowId = args[0];
      if (snapshot(f, flowId).steps.execute_merge?.status === 'waiting_gate') return { ...next, status: 'waiting_gate' };
      return next;
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  try {
    const result = await runGsd(CODE, { cwd: f.cwd, stratum, consumerArtifactsRoot: f.artifactRoot,
      gateCommands: ['true'], preMergeGate: ['true'], route_mode: options.route ?? 'shadow',
      resume: options.resume ?? false, allowDirtyWorkspace: options.resume ?? false });
    record({ kind: 'result', result });
    return result;
  } catch (error) {
    record({ kind: 'error', code: error.code, message: error.message });
    throw error;
  } finally {
    ConsumerFanoutArtifacts.prototype.prepareMerge = realPrepare;
    await client.close();
  }
}
async function child(t, f, options) {
  const config = join(f.root, 'driver.json'); writeFileSync(config, JSON.stringify({ f, options }));
  const env = { ...process.env, STRATUM_STATE_ROOT: f.stateRoot, RESEND_API_KEY: '', STRIPE_API_KEY: '' };
  delete env.NODE_TEST_CONTEXT;
  const proc = spawn(process.execPath, [SELF, '--driver', config], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  proc.stdout.on('data', b => { output = (output + b).slice(-20000); });
  proc.stderr.on('data', b => { output = (output + b).slice(-20000); });
  const timer = setTimeout(() => proc.kill('SIGKILL'), 90000);
  t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); });
  try {
    const status = await new Promise((resolve, reject) => {
      proc.on('error', reject); proc.on('exit', (code, signal) => resolve({ code, signal }));
    });
    proc.stdout.destroy(); proc.stderr.destroy();
    return { ...status, output };
  } finally { clearTimeout(timer); }
}
function latestRun(f) { return trace(f).filter(e => e.kind === 'planned').at(-1).runId; }
function assertContinuation(f, priorId, nextId, retained, indices, removed, saved) {
  const prior = saved.journal, next = journal(f, nextId);
  assert.equal(saved.rootBytes, rootBytes(f, next));
  assert.equal(next.routing.runBinding.previousRunId, priorId, 'continuation must bind the immediately preceding run, not a stale pause owner');
  const link = next.routing.records[next.routing.runBinding.continuationIntentId];
  assert.deepEqual(link.removedTaskIds, removed);
  assert.equal(link.sourceGraphDigest, routingDigest(link.sourceGraph));
  for (const [id, record] of Object.entries(prior.routing.records)) assert.equal(JSON.stringify(next.routing.records[id]), JSON.stringify(record), 'retained record bytes');
  const calls = records(next).filter(r => r.type === 'issuance' && r.logicalTaskId === retained);
  assert.deepEqual(calls.map(r => r.itemIndex), indices);
  assert.equal(new Set(calls.map(r => r.issuanceToken)).size, calls.length);
  assert.equal(new Set(calls.map(r => r.id)).size, calls.length);
  assert.equal(new Set(calls.map(r => r.admissionId)).size, 1);
  assert.equal(new Set(calls.map(r => r.logicalWaveId)).size, 1);
  for (let i = 1; i < calls.length; i++) assert.equal(calls[i].priorRecordId, calls[i - 1].id);
  for (const issuance of calls) assert.equal(routingIssuanceState(next.routing, issuance.id).state, 'settled');
  return link;
}

if (process.argv[1] === SELF && process.argv[2] === '--driver') {
  const { f, options } = json(process.argv[3]);
  try { await drive(f, options); } catch (error) { console.error(error); process.exitCode = 1; }
} else {
  for (const route of ['off', 'shadow']) test(`GSD ${route}: real halt writer → filtered B 1→0 continuation and frozen input`, { timeout: 240000 }, async t => {
    const f = fixture(t);
    const first = await child(t, f, { route, complete: ['A'], stop: 'halt' });
    assert.equal(first.code, 0, first.output);
    const run1 = latestRun(f), pause = json(control(f, 'pause.json'));
    assert.deepEqual(pause.completedTaskIds, ['A']);
    assert.deepEqual(pause.decomposedTasks.map(t => t.id), ['A', 'B']);
    assert.equal(pause.kind, 'budget'); assert.equal(pause.flowId, run1);
    assert.ok(existsSync(control(f, 'budget.json')));
    const saved = route === 'shadow' ? { journal: journal(f, run1), rootBytes: rootBytes(f, journal(f, run1)) } : null;
    if (saved) {
      const b = records(saved.journal).find(r => r.type === 'issuance' && r.logicalTaskId === 'B');
      assert.equal(routingIssuanceState(saved.journal.routing, b.id).state, 'settled');
      assert.equal(existsSync(join(f.cwd, resultPath('B'))), false, 'settled call is not a completed task');
    }
    const second = await child(t, f, { route: 'off', resume: true, complete: ['B'], lostAck: route === 'shadow' });
    assert.equal(second.code, 0, second.output);
    const run2 = latestRun(f); assert.notEqual(run1, run2);
    assert.equal(trace(f).at(-1).result.status, 'complete');
    assert.equal(existsSync(control(f, 'pause.json')), false);
    assert.deepEqual(trace(f).filter(e => e.kind === 'call').map(e => e.id), ['decompose', 'A', 'B', 'B']);
    assert.deepEqual(snapshot(f, run2).steps.decompose_gsd.output.tasks.map(t => [t.id, t.depends_on]), [['B', []]]);
    if (route === 'off') {
      const frozen = frozenRoutingBaseline('gsd-input');
      // Every actual plan must carry the real workspace root; only then is that one known value
      // substituted so the COMPLETE option set can be compared against the frozen envelope.
      const actualPlans = trace(f).filter(e => e.kind === 'plan');
      assert.equal(actualPlans.length, frozen.events.length);
      for (const p of actualPlans) assert.equal(p.opts?.workspaceRoot, f.cwd);
      const envelope = p => ({ flow: p.flow, input: p.input, opts: { ...p.opts, workspaceRoot: '<workspace>' } });
      assert.deepEqual(actualPlans.map(envelope), frozen.events.map(envelope));
      actualPlans.forEach((p, i) => assert.deepEqual(Object.keys(p.opts).sort(), Object.keys(frozen.events[i].opts).sort()));
      assert.equal(existsSync(join(f.cwd, '.compose/routing')), false);
      assert.equal(journal(f, run1).routing, undefined); assert.equal(journal(f, run2).routing, undefined);
    } else {
      const link = assertContinuation(f, run1, run2, 'B', [1, 0], ['A'], saved);
      assert.deepEqual(link.removedDependencies, [{ taskId: 'B', dependency: 'A' }]);
      assert.deepEqual(link.indexMap.map(i => i.newIndex), [null, 0]);
    }
  });

  for (const firstStop of ['crash', 'halt']) test(`GSD three real runs: ${firstStop} then crash retains C 2→1→0 and cumulative A/B completions`, { timeout: 300000 }, async t => {
    const f = fixture(t, ['A', 'B', 'C']);
    const saved = [];
    for (const complete of [['A'], ['B']]) {
      const stop = complete[0] === 'A' ? firstStop : 'crash';
      const attempt = await child(t, f, { complete, resume: complete[0] === 'B', stop });
      if (stop === 'crash') {
        assert.equal(attempt.signal, 'SIGKILL', attempt.output);
        assert.equal(trace(f).at(-1).boundary, 'merged-before-gate-ack');
        assert.equal(json(control(f, 'state.json')).status, 'running');
      } else {
        assert.equal(attempt.code, 0, attempt.output);
        assert.equal(json(control(f, 'pause.json')).kind, 'budget');
      }
      if (firstStop === 'crash') assert.equal(existsSync(control(f, 'pause.json')), false, 'actual crash bridge, no seeded pause');
      const j = journal(f, latestRun(f)); saved.push({ journal: j, rootBytes: rootBytes(f, j) });
    }
    const beforeFinal = { stateRun: json(control(f, 'state.json')).flowId,
      pauseRun: existsSync(control(f, 'pause.json')) ? json(control(f, 'pause.json')).flowId : null };
    const final = await child(t, f, { resume: true, complete: ['C'] });
    assert.equal(final.code, 0, final.output);
    const [a, b, c] = trace(f).filter(e => e.kind === 'planned').map(e => e.runId);
    if (firstStop === 'halt') t.diagnostic(JSON.stringify({ ...beforeFinal, runs: [a, b, c],
      actualPreviousRun: journal(f, c).routing.runBinding.previousRunId,
      cIndices: records(journal(f, c)).filter(r => r.type === 'issuance' && r.logicalTaskId === 'C').map(r => r.itemIndex) }));
    const link2 = assertContinuation(f, a, b, 'C', [2, 1], ['A'], saved[0]);
    const link3 = assertContinuation(f, b, c, 'C', [2, 1, 0], ['B'], saved[1]);
    assert.deepEqual(link3.completedTaskIds, ['A', 'B']); assert.deepEqual(link3.completionChain, [link2.id]);
    assert.deepEqual(trace(f).filter(e => e.kind === 'call').map(e => e.id), ['decompose', 'A', 'B', 'C', 'B', 'C', 'C']);
    assert.equal(trace(f).at(-1).result.status, 'complete');
  });

  for (const crash of [false, true]) test(`GSD ${crash ? 'hard crash' : 'real stuck detector'} leaves uncertain B; resume holds before plan/model`, { timeout: 180000 }, async t => {
    const f = fixture(t);
    const first = await child(t, f, { complete: ['A'], uncertain: 'B', crash });
    if (crash) assert.equal(first.signal, 'SIGKILL', first.output);
    else { assert.equal(first.code, 0, first.output); assert.equal(json(control(f, 'stuck.json')).taskId, 'B'); }
    const run = latestRun(f), j = journal(f, run);
    const b = records(j).find(r => r.type === 'issuance' && r.logicalTaskId === 'B');
    assert.notEqual(routingIssuanceState(j.routing, b.id).state, 'settled');
    const before = trace(f).filter(e => ['plan', 'call'].includes(e.kind));
    const retry = await child(t, f, { resume: true, complete: ['B'] });
    assert.equal(retry.code, 1, retry.output);
    assert.equal(trace(f).at(-1).code, 'ROUTING_ISSUANCE_UNCERTAIN');
    assert.deepEqual(trace(f).filter(e => ['plan', 'call'].includes(e.kind)), before);
  });

  for (const fault of ['lostAck', 'crashPlan', 'ambiguousPlan']) test(`GSD plan ${fault}: real plan recovery never blindly replans`, { timeout: 180000 }, async t => {
    const f = fixture(t);
    const first = await child(t, f, { [fault]: true, stop: 'merge' });
    if (fault === 'lostAck') assert.equal(first.code, 0, first.output);
    else {
      assert.equal(first.signal, 'SIGKILL', first.output);
      assert.equal(trace(f).at(-1).boundary, 'plan-before-ack');
      const retry = await child(t, f, { stop: 'merge' });
      assert.equal(retry.code, fault === 'ambiguousPlan' ? 1 : 0, retry.output);
    }
    assert.equal(trace(f).filter(e => e.kind === 'plan').length, 1);
    if (fault === 'ambiguousPlan') {
      assert.equal(trace(f).at(-1).code, 'ROUTING_PLAN_UNCERTAIN');
      assert.equal(trace(f).filter(e => e.kind === 'call').length, 0);
    } else {
      const run = latestRun(f), j = journal(f, run);
      assert.equal(j.routing.runBinding.runId, run);
      assert.equal(trace(f).filter(e => e.kind === 'call' && e.id === 'decompose').length, 1);
      assert.equal(readdirSync(f.stateRoot).filter(p => p.endsWith('.json')).length, 1);
    }
  });

  test('GSD real merge-revise: decompose epoch 0 → execute epoch 1, source and item fences', { timeout: 180000 }, async t => {
    const f = fixture(t);
    const first = await child(t, f, { revise: true, complete: ['A', 'B'] });
    assert.equal(first.code, 0, first.output);
    const run = latestRun(f), j = journal(f, run), state = snapshot(f, run);
    assert.equal(trace(f).find(e => e.kind === 'merge-error').code, 'MERGE_WITNESS_PRECOMPUTE_FAILED');
    assert.equal(j.mergeTransactions[0].failureCode, 'MERGE_WITNESS_PRECOMPUTE_FAILED');
    const oldSource = trace(f).find(e => e.kind === 'merge-source').source;
    assert.deepEqual(state.steps.decompose_gsd, oldSource);
    assert.equal(oldSource.epoch ?? 0, 0); assert.equal(state.steps.execute.epoch, 1);
    const epochs = records(j).filter(r => r.type === 'epoch-binding' && r.stage === 0);
    assert.deepEqual(epochs.map(r => r.epoch), [0, 1]);
    for (const epoch of epochs) {
      assert.equal(epoch.sourceBinding.epoch, 0);
      assert.equal(epoch.sourceBinding.acceptedDispatchToken, oldSource.acceptedDispatchToken);
      assert.equal(epoch.sourceBinding.outputDigest, routingDigest(oldSource.output));
    }
    assert.equal(epochs[1].logicalWaveId, epochs[0].logicalWaveId);
    assert.equal(epochs[1].priorEpochBindingId, epochs[0].id);
    assert.deepEqual(trace(f).filter(e => e.kind === 'call').map(e => e.id), ['decompose', 'A', 'B', 'A', 'B']);

    // A separate live run stops before merge; perturb only read-side descriptor
    // evidence, never engine state files, and require refusal before a call.
    const g = fixture(t);
    const stopped = await child(t, g, { stop: 'merge' }); assert.equal(stopped.code, 0, stopped.output);
    const oldEnv = process.env.STRATUM_STATE_ROOT; process.env.STRATUM_STATE_ROOT = g.stateRoot;
    const client = new StratumMcpClient();
    try {
      await client.connect({ command: process.execPath, args: [TS_MCP_BIN], cwd: g.cwd, env: { ...process.env } });
      const runId = latestRun(g);
      const routing = await resumeRouting({ runId, cwd: g.cwd, artifactRoot: g.artifactRoot, localSpec: SPEC, profiles: {}, stratum: client });
      const gate = snapshot(g, runId).steps.execute_merge;
      const next = await client.gateResolve(runId, 'execute_merge', 'revise', 'fence probe', 'test', gate.gateToken);
      let calls = 0; client.agentRun = async () => { calls++; throw new Error('must not launch'); };
      for (const field of ['epoch', 'itemIndex', 'generation']) {
        const bad = structuredClone(next.ready[0]); bad[field] += 1;
        await assert.rejects(admitConsumerWave({ descriptor: bad, descriptors: [bad], audit: await client.audit(runId), localSpec: SPEC,
          artifacts: routing.artifacts, stratum: client, flowId: runId, routing }), e => /^(ROUTING_|WAVE_INPUT_INVALID)/.test(e.code), field);
      }
      for (const field of ['token', 'output']) {
        const audit = await client.audit(runId);
        if (field === 'token') audit.steps.decompose_gsd.acceptedDispatchToken = 'changed-source-token';
        else audit.steps.decompose_gsd.output.tasks[0].description += ' changed';
        await assert.rejects(admitConsumerWave({ descriptor: next.ready[0], descriptors: next.ready, audit, localSpec: SPEC,
          artifacts: routing.artifacts, stratum: client, flowId: runId, routing }), e => /^(ROUTING_|WAVE_INPUT_INVALID)/.test(e.code), field);
      }
      assert.equal(calls, 0);
    } finally {
      await client.close(); if (oldEnv === undefined) delete process.env.STRATUM_STATE_ROOT; else process.env.STRATUM_STATE_ROOT = oldEnv;
    }
  });
}

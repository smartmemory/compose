/** Review-2 races: real merges, CLI signal owners, and the same-process web gate. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as build from '../lib/build.js';
import { lookupBuildCancel, withDeadline } from '../lib/build-cancel.js';
import { ConsumerFanoutArtifacts, snapshotWorkingTree } from '../lib/consumer-fanout.js';
import { VisionWriter } from '../lib/vision-writer.js';
import { readEvents } from '../lib/dispatch-ledger.js';
import { FLOW, SPEC, fixture, fakeClient, mergeFixture } from './helpers/build-cancel-s05.js';
import { makeFakeCodexProject } from './helpers/fake-codex-project.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const cli = fileURLToPath(new URL('../bin/compose.js', import.meta.url));
const clientUrl = new URL('../lib/stratum-mcp-client.js', import.meta.url).href;
const visionUrl = new URL('../lib/vision-writer.js', import.meta.url).href;
const streamUrl = new URL('../lib/build-stream-writer.js', import.meta.url).href;
const SIMPLE_SPEC = `version: 1
contracts:
  Result:
    value: string
flows:
  entry: main
  main:
    steps:
      - id: work
        agent: claude
        do: work
        out: Result
`;

for (const timing of ['audit-await', 'gateResolve']) {
  test(`R2-1: cancellation at ${timing} restores the applied merge before acceptance`, async t => {
    const f = mergeFixture(t);
    let applied = false;
    let cancelled = false;
    const apply = ConsumerFanoutArtifacts.prototype.applyMerge;
    t.mock.method(ConsumerFanoutArtifacts.prototype, 'applyMerge', async function(tx) {
      const result = await apply.call(this, tx);
      assert.equal(existsSync(join(f.cwd, 'landed.txt')), true);
      assert.equal(f.journal().issuances[0].state, 'merged');
      applied = true;
      return result;
    });
    f.client.audit = async () => {
      const snapshot = { ...structuredClone(f.audit), status: cancelled ? 'cancelled' : 'running' };
      if (applied && timing === 'audit-await' && !cancelled) {
        await delay(5);
        cancelled = true;
        lookupBuildCancel(FLOW).cancel('flow_cancelled');
      }
      return snapshot; // Deliberately returns the snapshot from BEFORE the await.
    };
    f.client.gateResolve = async () => {
      assert.equal(timing, 'gateResolve', 'audit fence must stop before gate acceptance');
      cancelled = true;
      throw new Error(`run ${FLOW} is cancelled`);
    };
    await assert.rejects(f.run(f.client));
    assert.equal(cancelled, true);
    const journal = f.journal();
    const tx = journal.mergeTransactions[0];
    assert.equal(existsSync(join(f.cwd, 'landed.txt')), false, 'cancelled merge must leave no captured file');
    assert.equal(snapshotWorkingTree(f.cwd), tx.baselineTree);
    assert.equal(tx.rollbackReason, 'cancelled');
    assert.equal(tx.state, 'rolled_back');
    assert.ok(journal.issuances.every(i => ['accepted', 'superseded'].includes(i.state)));
    assert.equal(f.read('active-build.json').status, 'aborted');
  });
}

async function runCliScenario(t, scenario, replacementTiming = 'probe') {
  const project = await makeFakeCodexProject({ featureCode: 'R2', spec: SIMPLE_SPEC });
  const root = project.workspace;
  const dataDir = join(root, '.compose', 'data');
  const activePath = join(dataDir, 'active-build.json');
  writeFileSync(join(dataDir, 'vision-state.json'), JSON.stringify({ items: [{ id: 'r2-item', status: 'in_progress', lifecycle: { featureCode: 'R2' } }], connections: [], gates: [] }));
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ health: { gate_threshold: 101 } }));
  if (scenario === 'abort-replacement') {
    writeFileSync(activePath, JSON.stringify({ featureCode: 'R2', flowId: 'r2-flow', status: 'running', pid: 987654, startedAt: 'old-start' }));
  }
  const preload = join(project.binDir, 'preload.mjs');
  writeFileSync(preload, `
import { StratumMcpClient } from ${JSON.stringify(clientUrl)};
import { VisionWriter } from ${JSON.stringify(visionUrl)};
import { BuildStreamWriter } from ${JSON.stringify(streamUrl)};
import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
const scenario = ${JSON.stringify(scenario)};
const replacementTiming = ${JSON.stringify(replacementTiming)};
const activePath = ${JSON.stringify(activePath)};
const mark = event => appendFileSync('events.txt', event + '\\n');
const client = StratumMcpClient.prototype;
client.connect = async () => {};
client.close = async () => {};
client.onEvent = () => () => {};
client.plan = async () => ({ status: 'ready', runId: 'r2-flow', ready: [{ id: 'work', agent: 'claude', do: 'work', dispatchToken: 'token' }] });
client.audit = async () => ({ status: 'completed', steps: [] });
client.flowCancel = async () => ({ status: 'cancelled', flowSettled: true, acknowledged: true });
client.agentRun = async (_agent, _prompt, opts) => {
  if (scenario.startsWith('health')) return { text: '{"value":"ok"}' };
  mark('agent-entered');
  return new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('agent aborted')), { once: true }));
};
client.stepDone = async () => ({ status: 'completed', runId: 'r2-flow' });
let killing = false;
const installReplacement = () => {
  const active = JSON.parse(readFileSync(activePath));
  writeFileSync(activePath, JSON.stringify({ ...active, flowId: 'replacement-flow', status: 'running', pid: 987655, startedAt: 'replacement-start' }));
  // The replacement owns the shared feature item and marks its own work in progress.
  const visionPath = ${JSON.stringify(join(dataDir, 'vision-state.json'))};
  const vision = JSON.parse(readFileSync(visionPath));
  vision.items[0].status = 'in_progress';
  writeFileSync(visionPath, JSON.stringify(vision));
  mark('replacement-installed');
};
VisionWriter.prototype._serverAvailable = async () => {
  if (killing && scenario.endsWith('replacement') && replacementTiming === 'probe') {
    mark('vision-await');
    await new Promise(resolve => setTimeout(resolve, 10));
    installReplacement();
  }
  return false;
};
const update = VisionWriter.prototype.updateItemStatus;
VisionWriter.prototype.updateItemStatus = async function(id, status) {
  if (status === 'killed') killing = true;
  if (status === 'killed' && scenario.endsWith('replacement') && replacementTiming === 'return') {
    await update.call(this, id, status);
    mark('vision-await');
    await new Promise(resolve => setTimeout(resolve, 10));
    installReplacement();
    return; // A successful update returns AFTER the old claim has expired.
  }
  return update.call(this, id, status);
};
const log = console.log;
console.log = (...args) => {
  log(...args);
  if (scenario === 'health-await' && args[0] === '\\nBuild complete.') {
    // Runs while health finalization awaits its first dynamic lineage import.
    queueMicrotask(() => { mark('health-await-signal'); process.emit('SIGINT'); });
  }
};
const health = BuildStreamWriter.prototype.writeHealthScore;
BuildStreamWriter.prototype.writeHealthScore = function(...args) {
  const result = health.apply(this, args);
  if (scenario === 'health-emission') { mark('health-emission-signal'); process.emit('SIGINT'); }
  return result;
};
`);
  const child = spawn(process.execPath, ['--import', preload, cli, 'build', ...(scenario === 'abort-replacement' ? ['--abort'] : ['R2', '--skip-triage', '--non-interactive'])], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...project.env, NODE_ENV: 'test', NODE_TEST_CONTEXT: 'child-v8', COMPOSE_STRATUM_ENGINE: 'ts', COMPOSE_CANCEL_TIMEOUT_MS: '1000', COMPOSE_TEARDOWN_DRAIN_MS: '1000', COMPOSE_ABORT_DRIVER_WAIT_MS: '20', COMPOSE_PORT: '1', NO_COLOR: '1' },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 12000);
  t.after(async () => {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await project.cleanup();
  });
  const events = () => existsSync(join(root, 'events.txt')) ? readFileSync(join(root, 'events.txt'), 'utf8') : '';
  if (scenario === 'signal-replacement') {
    const until = Date.now() + 8000;
    while (!events().includes('agent-entered') && child.exitCode === null && child.signalCode === null && Date.now() < until) await delay(20);
    assert.match(events(), /agent-entered/, output);
    child.kill('SIGINT');
  }
  const result = await exited;
  clearTimeout(watchdog);
  const json = name => JSON.parse(readFileSync(join(dataDir, name), 'utf8'));
  const historyPath = join(dataDir, 'build-history.jsonl');
  return { ...result, output, events: events(), active: json('active-build.json'), vision: json('vision-state.json'),
    history: existsSync(historyPath) ? readFileSync(historyPath, 'utf8').trim().split('\n').map(JSON.parse) : [],
    actuals: readEvents(root, { kind: 'build-actuals' }),
    health: existsSync(join(dataDir, 'health-scores.json')) ? json('health-scores.json') : [],
  };
}

for (const scenario of ['signal-replacement', 'abort-replacement']) for (const timing of ['probe', 'return']) {
  test(`R2-2: CLI ${scenario} during vision ${timing} await preserves the replacement record and vision`, { timeout: 15000 }, async t => {
    const result = await runCliScenario(t, scenario, timing);
    assert.match(result.events, /vision-await.*replacement-installed/s, result.output);
    assert.equal(result.vision.items[0].status, 'in_progress', 'replacement vision must not be killed');
    assert.equal(result.active.flowId, 'replacement-flow');
    assert.equal(result.active.status, 'running');
    assert.equal(result.active.pid, 987655);
    assert.equal(result.code, scenario === 'signal-replacement' ? 130 : 1, result.output);
    if (scenario === 'abort-replacement') {
      assert.match(result.output, /Build NOT aborted.*ownership_lost/);
      assert.equal(result.actuals.length, 0);
    }
  });
}

test('R2-3: abortBuild releases a pending web-gate driver and its registry handle promptly', async t => {
  const f = fixture(t, SPEC.replace('id: merge', 'id: approval'));
  writeFileSync(join(f.dataDir, 'settings.json'), JSON.stringify({ policies: { approval: 'gate' } }));
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true })); // Probe only: no port binding.
  const oldWait = process.env.COMPOSE_ABORT_DRIVER_WAIT_MS;
  process.env.COMPOSE_ABORT_DRIVER_WAIT_MS = '500';
  t.after(() => { if (oldWait === undefined) delete process.env.COMPOSE_ABORT_DRIVER_WAIT_MS; else process.env.COMPOSE_ABORT_DRIVER_WAIT_MS = oldWait; });
  let entered;
  const pending = new Promise(resolve => { entered = resolve; });
  let release = false;
  let polls = 0;
  t.mock.method(VisionWriter.prototype, 'getGate', async () => {
    polls++;
    entered();
    return release ? { status: 'resolved', outcome: 'approve' } : { status: 'pending' };
  });
  const client = fakeClient({ plan: async () => ({ runId: FLOW, status: 'running' }), audit: async () => ({ status: 'running', steps: { approval: { status: 'waiting_gate', gateToken: 'gate-token' } } }) });
  const running = f.run(client).then(() => null, error => error);
  t.after(async () => { release = true; lookupBuildCancel(FLOW)?.cancel('test cleanup'); await withDeadline(running, 4000); });
  await withDeadline(Promise.race([pending, running.then(error => { throw error ?? new Error('build ended before gate'); })]), 5000);
  const handle = lookupBuildCancel(FLOW);
  const result = await build.abortBuild(f.dataDir, 'S05', f.cwd, { stratum: fakeClient({ flowCancel: async () => ({ status: 'cancelled', flowSettled: true, acknowledged: true }) }) });
  assert.equal(handle.cancelled, true);
  assert.equal(result.driverMode, 'in-process');
  assert.equal(result.driverExited, true, 'abort must interrupt the two-second poll sleep within the driver wait');
  assert.equal(result.terminalWriter, 'driver');
  assert.equal(result.ok, true);
  assert.ok(await withDeadline(running, 500) instanceof Error);
  assert.equal(lookupBuildCancel(FLOW), null);
  assert.equal(polls, 1, 'no later gate decision was needed');
  assert.equal(f.read('active-build.json').status, 'aborted');
  assert.equal(f.read('vision-state.json').items[0].status, 'killed');
  assert.equal(client.calls.some(c => c.name === 'gateResolve'), false);
  assert.equal(client.calls.some(c => c.name === 'close'), true);
});

test('R2-3: pollGateResolution interrupts sleep and releases the signal listener', async () => {
  const controller = new AbortController();
  let polls = 0;
  const writer = { getGate: async () => (++polls === 1 ? { status: 'pending' } : { status: 'resolved' }) };
  const waiting = build.pollGateResolution(writer, 'gate', 1000, controller.signal);
  await delay(10); // The pending response has entered its sleep.
  controller.abort(new Error('stop gate'));
  const result = await Promise.race([waiting.then(() => 'resolved', () => 'aborted'), delay(200).then(() => 'still polling')]);
  await waiting.catch(() => {}); // Also cleans up the pre-fix loop after its second poll.
  assert.equal(result, 'aborted');
  assert.equal(polls, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

for (const scenario of ['health-await', 'health-emission']) {
  test(`R2-4: CLI SIGINT at ${scenario} cannot downgrade aborted history or actuals`, { timeout: 15000 }, async t => {
    const result = await runCliScenario(t, scenario);
    assert.match(result.events, new RegExp(`${scenario}-signal`), result.output);
    assert.equal(result.code, 130, result.output);
    assert.equal(result.active.status, 'aborted');
    assert.equal(result.history.length, 1);
    assert.equal(result.history[0].status, 'aborted');
    assert.equal(result.actuals.length, 1);
    assert.equal(result.actuals[0].terminal_status, 'aborted');
    assert.equal(result.health.length, 0, 'no score is persisted after teardown takes ownership');
    assert.doesNotMatch(result.output, /marking build as failed/);
  });
}

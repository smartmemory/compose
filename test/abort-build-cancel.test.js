import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { abortBuild, runBuild } from '../lib/build.js';
import { createBuildCancel, registerBuildCancel, unregisterBuildCancel, lookupBuildCancel, withDeadline } from '../lib/build-cancel.js';
import { VisionWriter } from '../lib/vision-writer.js';
import { readEvents } from '../lib/dispatch-ledger.js';

const zero = { signalled: 0, reaped: 0, gone: 0, unreachable: 0, alreadySettled: 0, unresolved: 0, unsettled: 0, unreaped: 0 };
const ack = (extra = {}) => ({ status: 'cancelled', flowSettled: true, acknowledged: true, agents: { ...zero }, ...extra });
const refusal = (extra = {}) => Object.assign(new Error('cancel refused'), {
  code: 'CANCELLATION_UNCONFIRMED', status: 'running', flowSettled: false,
  reason: 'engine_dispatch_active', holderPid: 1234, agents: { ...zero }, ...extra,
});
const timeout = () => refusal({ code: 'CANCELLATION_TEARDOWN_TIMEOUT', status: 'cancelled', flowSettled: true,
  reason: 'local_teardown_timeout', holderPid: null, agents: { ...zero, unreaped: 1 } });

function fixture(t, activePatch = {}) {
  const root = mkdtempSync(join(tmpdir(), 's04-abort-'));
  const dataDir = join(root, '.compose', 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(root, '.compose', 'compose.json'), JSON.stringify({ capabilities: { stratum: true, stratumEngine: 'ts' } }));
  const active = { featureCode: 'F-S04', flowId: randomUUID(), status: 'running', pid: 987654,
    startedAt: '2026-09-10T00:00:00.000Z', ...activePatch };
  const activePath = join(dataDir, 'active-build.json');
  const visionPath = join(dataDir, 'vision-state.json');
  const accumulatorPath = join(dataDir, 'build-accumulator', 'F-S04.json');
  const writeActive = (record) => writeFileSync(activePath, JSON.stringify(record));
  writeActive(active);
  writeFileSync(visionPath, JSON.stringify({ items: [{ id: 'item-s04', status: 'in_progress', lifecycle: { featureCode: active.featureCode } }], connections: [], gates: [] }));
  mkdirSync(join(dataDir, 'build-accumulator'), { recursive: true });
  writeFileSync(accumulatorPath, JSON.stringify({ v: 1, build_id: randomUUID(), feature_code: active.featureCode,
    last_terminal: null, review_iterations: 0, escalations: 0, files_changed: [], ship_files_changed: null,
    test_count: null, pass_rate: null, tokens_total: 0, usd: 0 }));
  const original = { active: readFileSync(activePath, 'utf8'), vision: readFileSync(visionPath, 'utf8'), accumulator: readFileSync(accumulatorPath, 'utf8') };
  const kills = [];
  const logs = [];
  t.mock.method(VisionWriter.prototype, '_serverAvailable', async () => false);
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  t.mock.method(process, 'kill', (pid, signal) => {
    kills.push([pid, signal]);
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  const saved = Object.fromEntries(['COMPOSE_ABORT_RETRIES', 'COMPOSE_ABORT_LOCK_WAIT_MS', 'COMPOSE_ABORT_DRIVER_WAIT_MS', 'COMPOSE_STRATUM_ENGINE'].map(k => [k, process.env[k]]));
  process.env.COMPOSE_ABORT_RETRIES = '2';
  process.env.COMPOSE_ABORT_LOCK_WAIT_MS = '17';
  process.env.COMPOSE_ABORT_DRIVER_WAIT_MS = '25';
  delete process.env.COMPOSE_STRATUM_ENGINE;
  t.after(() => {
    unregisterBuildCancel(active.flowId);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(root, { recursive: true, force: true });
  });
  const calls = [];
  let connection;
  const client = (outcomes = [ack()], hooks = {}) => ({
    connect: async (conn) => { connection = conn; calls.push('connect'); await hooks.connect?.(); },
    flowCancel: async (id) => {
      assert.equal(id, active.flowId);
      const index = calls.filter(c => c === 'cancel').length;
      calls.push('cancel');
      assert.equal(readFileSync(visionPath, 'utf8'), original.vision, 'cancel precedes vision mutation');
      assert.equal(readFileSync(accumulatorPath, 'utf8'), original.accumulator, 'cancel precedes actuals');
      await hooks.cancel?.(index);
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    close: async () => { calls.push('close'); await hooks.close?.(); },
  });
  return { root, dataDir, active, activePath, visionPath, accumulatorPath, original, kills, logs, calls, client, writeActive,
    connection: () => connection, readActive: () => JSON.parse(readFileSync(activePath, 'utf8')),
    assertUntouched() {
      assert.equal(readFileSync(activePath, 'utf8'), original.active);
      assert.equal(readFileSync(visionPath, 'utf8'), original.vision);
      assert.equal(readFileSync(accumulatorPath, 'utf8'), original.accumulator);
      assert.equal(readEvents(root, { kind: 'build-actuals' }).length, 0);
    },
  };
}

const rows = [
  { name: 'fresh settled', outcomes: [ack()], ok: true },
  { name: 'already cancelled', outcomes: [ack({ acknowledged: false, reason: 'already_cancelled' })], ok: true },
  ...['completed', 'failed', 'budget_exhausted'].map(status => ({ name: `engine already ${status}`, outcomes: [ack({ status, flowSettled: false, acknowledged: false, reason: `already_${status}` })], ok: true })),
  { name: 'unknown flow', outcomes: [refusal({ code: 'FLOW_NOT_FOUND', status: null, reason: 'flow_not_found', holderPid: null, agents: null })], ok: false, reason: 'flow_not_found' },
  { name: 'raw unknown flow', outcomes: [new Error('ENOENT: no such run')], ok: false, reason: 'flow_not_found' },
  { name: 'transport', outcomes: [new Error('write EPIPE')], ok: false, reason: 'transport' },
  { name: 'lock held exhausts retries', outcomes: [refusal({ reason: 'run_lock_held' })], ok: false, reason: 'run_lock_held', attempts: 3 },
  { name: 'lock retry settles', outcomes: [refusal({ reason: 'run_lock_held' }), ack()], ok: true, attempts: 2 },
  { name: 'engine dispatch active', outcomes: [refusal()], ok: false, reason: 'engine_dispatch_active' },
  { name: 'unreachable after settle', outcomes: [refusal({ status: 'cancelled', flowSettled: true, reason: null, holderPid: null, agents: { ...zero, unreachable: 1 } })], ok: true },
  { name: 'timeout re-sweep succeeds', outcomes: [timeout(), ack({ acknowledged: false, reason: 'already_cancelled' })], ok: true, attempts: 2 },
  { name: 'timeout re-sweep fails', outcomes: [timeout()], ok: true, attempts: 2 },
  { name: 'timeout then transport retains settled evidence', outcomes: [timeout(), new Error('write EPIPE')], ok: true, attempts: 2 },
  { name: 'lock retry then timeout still re-sweeps only once', outcomes: [refusal({ reason: 'run_lock_held' }), timeout(), timeout()], ok: true, attempts: 3 },
  { name: 'flowSettled overrides timeout code', outcomes: [refusal({ code: 'CANCELLATION_TEARDOWN_TIMEOUT' })], ok: false, reason: 'engine_dispatch_active' },
];

for (const row of rows) test(`abort outcome: ${row.name}`, async t => {
  const f = fixture(t);
  const result = await abortBuild(f.dataDir, f.active.featureCode, f.root, { stratum: f.client(row.outcomes) });
  assert.equal(result?.ok, row.ok);
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'flowId', 'status', 'flowSettled', 'acknowledged', 'code', 'reason', 'holderPid', 'agents', 'attempts', 'driverMode', 'driverSignalled', 'driverExited', 'terminalWriter', 'localCleanup'].sort());
  assert.equal(result.flowId, f.active.flowId);
  assert.equal(result.attempts, row.attempts ?? 1);
  assert.equal(f.calls.filter(c => c === 'cancel').length, row.attempts ?? 1);
  assert.equal(f.calls.at(-1), 'close');
  assert.equal(f.connection().env.STRATUM_CANCEL_LOCK_WAIT_MS, '17');
  assert.equal(result.driverMode, 'none');
  assert.equal(result.driverSignalled, false);
  assert.equal(result.localCleanup, row.ok);
  assert.equal(result.terminalWriter, row.ok ? 'abort' : 'none');
  // Pin the engine fields as well as the local side effects. A failed re-sweep
  // retains the prior durable evidence, while a successful one replaces it.
  const last = row.outcomes.at(-1);
  const expected = row.name === 'timeout then transport retains settled evidence' ? row.outcomes[0] : last;
  if (!(expected instanceof Error) || expected.code) {
    assert.equal(result.status, expected.status ?? null);
    assert.equal(result.flowSettled, expected.flowSettled === true);
    assert.equal(result.acknowledged, expected.acknowledged === true);
    assert.equal(result.code, expected.code ?? null);
    assert.equal(result.reason, expected.reason ?? null);
    assert.equal(result.holderPid, expected.holderPid ?? null);
    assert.deepEqual(result.agents, expected.agents ?? null);
  } else {
    assert.equal(result.status, null);
    assert.equal(result.acknowledged, false);
    assert.equal(result.code, row.reason === 'flow_not_found' ? 'FLOW_NOT_FOUND' : 'CANCELLATION_UNCONFIRMED');
    assert.deepEqual(result.agents, row.reason === 'flow_not_found' ? null : zero);
  }
  assert.equal(f.kills.some(([, signal]) => signal === 'SIGTERM'), false);
  if (row.ok) {
    assert.equal(f.readActive().status, 'aborted');
    assert.equal(f.readActive().pid, f.active.pid);
    assert.equal(JSON.parse(readFileSync(f.visionPath)).items[0].status, 'killed');
    assert.equal(existsSync(f.accumulatorPath), false);
    assert.equal(readEvents(f.root, { kind: 'build-actuals' }).length, 1);
    assert.equal(f.logs.at(-1), 'Build aborted.');
  } else {
    assert.equal(result.reason, row.reason);
    assert.equal(result.flowSettled, false);
    f.assertUntouched();
    assert.match(f.logs.at(-1), /Build NOT aborted/);
  }
});

test('connect failure is a structured transport refusal, closes client and writes nothing', async t => {
  const f = fixture(t);
  const result = await abortBuild(f.dataDir, null, f.root, { stratum: f.client([], { connect: () => { throw new Error('spawn EACCES'); } }) });
  assert.equal(result?.reason, 'transport');
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 0);
  assert.deepEqual(f.calls, ['connect', 'close']);
  f.assertUntouched();
});

for (const status of ['complete', 'aborted', 'killed', 'failed']) test(`already ${status} active record is immutable`, async t => {
  const f = fixture(t, { status });
  const result = await abortBuild(f.dataDir, null, f.root, { stratum: f.client() });
  assert.equal(result?.reason, `already_${status}`);
  assert.equal(result.ok, false);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.kills, []);
  f.assertUntouched();
});

for (const reason of ['no_active_build', 'feature_mismatch']) test(`early refusal: ${reason}`, async t => {
  const f = fixture(t);
  if (reason === 'no_active_build') rmSync(f.activePath);
  const result = await abortBuild(f.dataDir, 'OTHER', f.root, { stratum: f.client() });
  assert.equal(result?.reason, reason);
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 0);
  assert.deepEqual(f.calls, []);
});

for (const patch of [
  { flowId: 'replacement-flow' }, { featureCode: 'OTHER' },
  { flowId: null, pid: 42 }, { flowId: null, startedAt: 'later' },
  { flowId: null, pid: null, startedAt: null },
]) test(`identity change refuses before vision, state, actuals or driver mutation: ${JSON.stringify(patch)}`, async t => {
  const f = fixture(t, { pid: process.pid });
  const handle = createBuildCancel();
  registerBuildCancel(f.active.flowId, handle);
  const replacement = { ...f.active, ...patch };
  const result = await abortBuild(f.dataDir, null, f.root, { stratum: f.client([ack()], { cancel: () => f.writeActive(replacement) }) });
  assert.equal(result?.ok, false);
  assert.equal(result.reason, patch.pid === null ? 'ownership_unverifiable' : 'ownership_lost');
  assert.deepEqual(f.readActive(), replacement);
  assert.equal(handle.cancelled, false);
  assert.deepEqual(f.kills, []);
  assert.equal(readFileSync(f.visionPath, 'utf8'), f.original.vision);
  assert.equal(readFileSync(f.accumulatorPath, 'utf8'), f.original.accumulator);
  assert.equal(readEvents(f.root, { kind: 'build-actuals' }).length, 0);
});

for (const present of [true, false]) test(`no flow skips stratum; fallback identity present=${present}`, async t => {
  const f = fixture(t, { flowId: null, pid: present ? process.pid : null, startedAt: present ? 'start' : null });
  const result = await abortBuild(f.dataDir, null, f.root, { stratum: f.client() });
  assert.equal(result?.ok, present);
  assert.equal(result.flowId, null);
  assert.equal(result.attempts, 0);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.kills, []);
  if (!present) { assert.equal(result.reason, 'ownership_unverifiable'); f.assertUntouched(); }
});

for (const settles of [true, false]) test(`same-process handle: driver settles=${settles}`, async t => {
  const f = fixture(t, { pid: process.pid });
  const handle = createBuildCancel();
  registerBuildCancel(f.active.flowId, handle);
  let terminal;
  if (settles) {
    process.env.COMPOSE_ABORT_DRIVER_WAIT_MS = '500';
    handle.signal.addEventListener('abort', () => {
      setTimeout(() => {
        terminal = { ...f.active, status: 'aborted', completedAt: 'driver-time', driverReceipt: true };
        f.writeActive(terminal);
        unregisterBuildCancel(f.active.flowId);
      }, 10);
    }, { once: true });
  }
  const result = await abortBuild(f.dataDir, null, f.root, { stratum: f.client() });
  assert.equal(result?.ok, true);
  assert.equal(handle.reason, 'abort');
  assert.equal(result.driverMode, 'in-process');
  assert.equal(result.driverSignalled, false);
  assert.equal(result.driverExited, settles);
  assert.equal(result.terminalWriter, settles ? 'driver' : 'abort');
  assert.deepEqual(f.kills, []);
  if (settles) {
    assert.deepEqual(f.readActive(), terminal);
    assert.equal(readFileSync(f.visionPath, 'utf8'), f.original.vision);
    assert.equal(readFileSync(f.accumulatorPath, 'utf8'), f.original.accumulator);
    assert.equal(readEvents(f.root, { kind: 'build-actuals' }).length, 0);
  } else assert.equal(f.readActive().pid, process.pid);
});

for (const outcome of [ack(), refusal(), ack({ status: 'completed', flowSettled: false, reason: 'already_completed' })]) {
  test(`foreign driver: flowSettled=${outcome.flowSettled}, reason=${outcome.reason}`, async t => {
    const f = fixture(t);
    t.mock.method(process, 'kill', (pid, signal) => {
      assert.notEqual(pid, process.pid);
      f.kills.push([pid, signal]);
      if (signal === 'SIGTERM') {
        f.writeActive({ ...f.active, status: 'aborted', completedAt: 'driver-time' });
      }
    });
    const result = await abortBuild(f.dataDir, null, f.root, { stratum: f.client([outcome]) });
    assert.equal(result?.driverMode, 'foreign-pid');
    assert.equal(result.driverSignalled, outcome.flowSettled);
    assert.equal(f.kills.filter(([, signal]) => signal === 'SIGTERM').length, outcome.flowSettled ? 1 : 0);
    if (outcome instanceof Error) { assert.equal(result.ok, false); f.assertUntouched(); }
    if (outcome.flowSettled) {
      assert.equal(result.terminalWriter, 'driver');
      assert.equal(result.driverExited, true);
      assert.equal(readFileSync(f.visionPath, 'utf8'), f.original.vision);
      assert.equal(readFileSync(f.accumulatorPath, 'utf8'), f.original.accumulator);
    }
  });
}

test('current pid without a registry handle is never probed or signalled', async t => {
  const f = fixture(t, { pid: process.pid });
  const result = await abortBuild(f.dataDir, null, f.root, { stratum: f.client() });
  assert.equal(result?.driverMode, 'none');
  assert.deepEqual(f.kills, []);
});

test('a pre-plan foreign driver is stopped without connecting to stratum', async t => {
  const f = fixture(t, { flowId: null });
  t.mock.method(process, 'kill', (pid, signal) => {
    f.kills.push([pid, signal]);
    if (signal === 'SIGTERM') f.writeActive({ ...f.active, status: 'aborted' });
  });
  const result = await abortBuild(f.dataDir, null, f.root, { stratum: f.client() });
  assert.equal(result?.ok, true);
  assert.equal(result.flowSettled, true);
  assert.equal(result.driverSignalled, true);
  assert.equal(result.terminalWriter, 'driver');
  assert.deepEqual(f.calls, []);
});

test('ownership lost during a driver wait preserves the replacement and all local evidence', async t => {
  const f = fixture(t, { pid: process.pid });
  const handle = createBuildCancel();
  registerBuildCancel(f.active.flowId, handle);
  const replacement = { ...f.active, flowId: 'replacement' };
  handle.signal.addEventListener('abort', () => f.writeActive(replacement), { once: true });
  const result = await abortBuild(f.dataDir, null, f.root, { stratum: f.client() });
  assert.equal(result?.ok, false);
  assert.equal(result.reason, 'ownership_lost');
  assert.equal(result.driverSignalled, false);
  assert.deepEqual(f.readActive(), replacement);
  assert.equal(readFileSync(f.visionPath, 'utf8'), f.original.vision);
  assert.equal(readFileSync(f.accumulatorPath, 'utf8'), f.original.accumulator);
});

test('a completed driver record is not overwritten when its handle is still unwinding', async t => {
  const f = fixture(t, { pid: process.pid });
  const handle = createBuildCancel();
  registerBuildCancel(f.active.flowId, handle);
  const terminal = { ...f.active, status: 'complete', completedAt: 'driver-time' };
  handle.signal.addEventListener('abort', () => f.writeActive(terminal), { once: true });
  const result = await abortBuild(f.dataDir, null, f.root, { stratum: f.client() });
  assert.equal(result?.ok, false);
  assert.equal(result.reason, 'already_complete');
  assert.equal(result.driverExited, false);
  assert.deepEqual(f.readActive(), terminal);
  assert.equal(readFileSync(f.visionPath, 'utf8'), f.original.vision);
  assert.equal(readFileSync(f.accumulatorPath, 'utf8'), f.original.accumulator);
});

test('a delivered SIGTERM remains reported if ownership is subsequently lost', async t => {
  const f = fixture(t);
  const replacement = { ...f.active, flowId: 'replacement' };
  t.mock.method(process, 'kill', (_pid, signal) => { if (signal === 'SIGTERM') f.writeActive(replacement); });
  const result = await abortBuild(f.dataDir, null, f.root, { stratum: f.client() });
  assert.equal(result?.ok, false);
  assert.equal(result.reason, 'ownership_lost');
  assert.equal(result.driverSignalled, true, 'do not falsify a signal already delivered');
  assert.equal(result.localCleanup, false);
  assert.deepEqual(f.readActive(), replacement);
  assert.equal(readFileSync(f.visionPath, 'utf8'), f.original.vision);
  assert.equal(readFileSync(f.accumulatorPath, 'utf8'), f.original.accumulator);
});

test('runBuild returns the structured abort result', async t => {
  const f = fixture(t, { flowId: null, pid: process.pid });
  const result = await runBuild(null, { cwd: f.root, abort: true });
  assert.equal(result?.ok, true);
  assert.equal(result.terminalWriter, 'abort');
});

test('abort during the real Codex preflight reaches the already-registered build handle', { timeout: 15000 }, async t => {
  const f = fixture(t);
  rmSync(f.activePath);
  rmSync(f.accumulatorPath);
  mkdirSync(join(f.root, 'pipelines'));
  mkdirSync(join(f.root, 'docs', 'features', f.active.featureCode), { recursive: true });
  writeFileSync(join(f.root, 'pipelines', 'build.stratum.yaml'), `version: 1
contracts:
  Result:
    value: string
flows:
  entry: main
  main:
    steps:
      - id: execute
        do: work
        out: Result
`);
  // Only this disposable fixture repository is committed; never the checkout under test.
  const git = args => execFileSync('git', args, { cwd: f.root, stdio: 'pipe' });
  git(['init', '-q']);
  git(['-c', 'user.name=S04 Test', '-c', 'user.email=s04@example.test', 'commit', '--allow-empty', '-qm', 'probe fixture']);
  const skipped = process.env.COMPOSE_SKIP_CODEX_PROBE;
  delete process.env.COMPOSE_SKIP_CODEX_PROBE;
  t.after(() => { if (skipped === undefined) delete process.env.COMPOSE_SKIP_CODEX_PROBE; else process.env.COMPOSE_SKIP_CODEX_PROBE = skipped; });
  process.env.COMPOSE_ABORT_DRIVER_WAIT_MS = '1000';
  let entered;
  const probing = new Promise(resolve => { entered = resolve; });
  let probeSignal;
  let handle;
  const stratum = {
    plan: async () => ({ runId: f.active.flowId, status: 'running', ready: [{ id: 'execute' }] }),
    audit: async () => ({ status: 'cancelled', steps: [] }),
    close: async () => {},
    runAgentText: async (_agent, _prompt, opts) => {
      assert.equal(opts.telemetry.site, 'preflight');
      handle = lookupBuildCancel(f.active.flowId);
      assert.ok(handle, 'the handle is registered before the real preflight dispatch');
      probeSignal = opts.signal;
      entered();
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('probe cancelled')), { once: true });
      });
    },
  };
  const building = runBuild(f.active.featureCode, { cwd: f.root, stratum, template: 'build', skipTriage: true, implementer: 'codex' })
    .then(() => null, error => error);
  t.after(async () => { handle?.cancel('test cleanup'); await building; });
  await withDeadline(Promise.race([probing, building.then(error => { throw error ?? new Error('build ended before preflight'); })]), 5000);
  const result = await abortBuild(f.dataDir, null, f.root, { stratum: { connect: async () => {}, flowCancel: async () => ack(), close: async () => {} } });
  assert.equal(result.driverMode, 'in-process');
  assert.equal(result.driverSignalled, false);
  assert.equal(handle.reason, 'abort');
  assert.equal(probeSignal.aborted, true);
  assert.deepEqual(f.kills, []);
  assert.ok(await withDeadline(building, 5000) instanceof Error, 'the never-settling probe was interrupted');
});

for (const command of ['build', 'fix', 'plan']) for (const success of [false, true]) {
  test(`CLI ${command} --abort exits ${success ? 0 : 1} from result`, t => {
    const f = fixture(t, { flowId: null, mode: command === 'fix' ? 'bug' : command === 'plan' ? 'plan' : 'feature', status: success ? 'running' : 'complete' });
    mkdirSync(join(f.root, 'pipelines'));
    for (const name of ['build', 'bug-fix', 'plan']) writeFileSync(join(f.root, 'pipelines', `${name}.stratum.yaml`), '# abort never loads a pipeline\n');
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/compose.js', import.meta.url)), command, '--abort'], {
      cwd: f.root, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, COMPOSE_ABORT_DRIVER_WAIT_MS: '0', COMPOSE_PORT: '1', NO_COLOR: '1' },
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, success ? 0 : 1, child.stdout + child.stderr);
    assert.match(child.stdout, success ? /Build aborted\./ : /Build NOT aborted.*already_complete/);
  });
}

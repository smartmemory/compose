/**
 * COMP-BUILD-CANCEL S06 — SIGINT/SIGTERM does a real teardown.
 *
 * Most cases unit-test `runCancelTeardown` with a fake client, a fake process and
 * injected deadlines (blueprint §9 Tests). One case spawns a REAL child
 * `compose build` against a real stratum MCP server with a fake `codex` on its
 * PATH, sends it SIGINT, and asserts the exit code and the on-disk record.
 *
 * The child case asserts the process-group receipt for C21 only once S03 tags the
 * dispatch — see the assertion's own comment.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createBuildCancel,
  runCancelTeardown,
  cancelBudgets,
  withDeadline,
  registerBuildCancel,
  unregisterBuildCancel,
  pendingTeardown,
} from '../lib/build-cancel.js';
import { makeFakeCodexProject } from './helpers/fake-codex-project.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A teardown wired to fakes. Returns the deps so a case can inspect the calls. */
function harness(overrides = {}) {
  const calls = { flowCancel: [], killVision: 0, writeTerminal: 0, removeListeners: 0, exit: [], log: [] };
  const buildCancel = createBuildCancel();
  const deps = {
    buildCancel,
    signal: 'SIGINT',
    flowId: 'run-1',
    flowCancel: async (id) => { calls.flowCancel.push(id); },
    timeoutMs: 50,
    drainMs: 50,
    killVision: async () => { calls.killVision += 1; },
    writeTerminal: () => { calls.writeTerminal += 1; },
    removeListeners: () => { calls.removeListeners += 1; },
    exit: (code) => { calls.exit.push(code); },
    log: (message) => { calls.log.push(message); },
    ...overrides,
  };
  return { calls, buildCancel, deps };
}

describe('runCancelTeardown', () => {
  test('the first signal cancels the flow once; a second signal during teardown does not', async () => {
    const { calls, buildCancel, deps } = harness();
    buildCancel.resolveDrained();
    await runCancelTeardown(deps);
    assert.deepEqual(calls.flowCancel, ['run-1']);

    await runCancelTeardown(deps);
    assert.deepEqual(calls.flowCancel, ['run-1'], 'a second signal must not re-cancel the flow');
    assert.deepEqual(calls.exit, [130, 130]);
    assert.equal(calls.writeTerminal, 1, 'the terminal record is written exactly once');
  });

  test('a handle already cancelled by a cross-process detector still runs the full teardown (C27)', async () => {
    const { calls, buildCancel, deps } = harness();
    buildCancel.cancel('flow_cancelled');
    buildCancel.resolveDrained();
    await runCancelTeardown(deps);
    assert.deepEqual(calls.flowCancel, ['run-1'], 'the force-exit keys on teardownStarted, not cancelled');
    assert.equal(calls.writeTerminal, 1);
    assert.equal(buildCancel.reason, 'flow_cancelled', 'the first cancel reason is preserved');
  });

  test('the teardown waits for drained before it kills vision or writes', async () => {
    const { calls, buildCancel, deps } = harness({ drainMs: 5000 });
    const running = runCancelTeardown(deps);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls.writeTerminal, 0, 'no write before the build finally drains');
    assert.equal(calls.killVision, 0);
    buildCancel.resolveDrained();
    await running;
    assert.equal(calls.killVision, 1);
    assert.equal(calls.writeTerminal, 1);
  });

  test('a pump that never unwinds still terminalizes: drained times out and the write happens anyway', async () => {
    const { calls, deps } = harness({ drainMs: 40 });
    const startedAt = Date.now();
    await runCancelTeardown(deps);              // drained never resolved
    assert.ok(Date.now() - startedAt >= 35, 'the drain wait is real');
    assert.equal(calls.writeTerminal, 1, 'a wedged pump must not block the terminal record');
    assert.deepEqual(calls.exit, [130]);
  });

  test('a flowCancel that never resolves is abandoned at the deadline and the local teardown still runs', async () => {
    const { calls, buildCancel, deps } = harness({
      timeoutMs: 40,
      flowCancel: () => new Promise(() => {}),
    });
    buildCancel.resolveDrained();
    const startedAt = Date.now();
    await runCancelTeardown(deps);
    assert.ok(Date.now() - startedAt >= 35, 'the flow-cancel wait is bounded, not skipped');
    assert.equal(calls.writeTerminal, 1);
    assert.equal(calls.removeListeners, 1);
    assert.deepEqual(calls.exit, [130]);
  });

  test("reason 'already_cancelled' is success and logs nothing", async () => {
    const { calls, buildCancel, deps } = harness({
      flowCancel: async () => { throw Object.assign(new Error('nope'), { reason: 'already_cancelled' }); },
    });
    buildCancel.resolveDrained();
    await runCancelTeardown(deps);
    assert.deepEqual(calls.log, [], 'abortBuild getting there first is not a failure');
    assert.equal(calls.writeTerminal, 1);
  });

  test('any other flow-cancel failure is logged and does not stop the local teardown', async () => {
    const { calls, buildCancel, deps } = harness({
      flowCancel: async () => { throw Object.assign(new Error('boom'), { reason: 'run_lock_held' }); },
    });
    buildCancel.resolveDrained();
    await runCancelTeardown(deps);
    assert.equal(calls.log.length, 1);
    assert.match(calls.log[0], /run_lock_held/);
    assert.equal(calls.writeTerminal, 1, 'the local record must not be left running');
  });

  test('vision is killed, then the record is written, then the listeners go, then exactly one exit', async () => {
    const order = [];
    const buildCancel = createBuildCancel();
    buildCancel.resolveDrained();
    await runCancelTeardown({
      buildCancel,
      signal: 'SIGTERM',
      flowId: 'run-1',
      flowCancel: async () => { order.push('flowCancel'); },
      timeoutMs: 50,
      drainMs: 50,
      killVision: async () => { order.push('killVision'); },
      writeTerminal: () => { order.push('writeTerminal'); },
      removeListeners: () => { order.push('removeListeners'); },
      exit: (code) => { order.push(`exit:${code}`); },
      log: () => {},
    });
    assert.deepEqual(order, ['flowCancel', 'killVision', 'writeTerminal', 'removeListeners', 'exit:143']);
  });

  test('the teardown emits no actuals — finalizeBuildAttempt stays the sole emitter (C45)', async () => {
    let emitted = 0;
    let streamClosed = 0;
    const { calls, buildCancel, deps } = harness();
    buildCancel.resolveDrained();
    await runCancelTeardown({
      ...deps,
      emitActuals: () => { emitted += 1; },
      closeStream: () => { streamClosed += 1; },
    });
    assert.equal(emitted, 0, 'a second actuals emitter is exactly the duplicate §3.6 removes');
    assert.equal(streamClosed, 0, 'the stream close belongs to the build\'s inner finally');
    assert.equal(calls.writeTerminal, 1);
  });

  test('exit code is 130 for SIGINT and 143 for SIGTERM', async () => {
    for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
      const { calls, buildCancel, deps } = harness({ signal });
      buildCancel.resolveDrained();
      await runCancelTeardown(deps);
      assert.deepEqual(calls.exit, [code]);
    }
  });
});

describe('the teardown budgets and the join bound', () => {
  test('the join bound is DERIVED from the two deadlines, never a literal (C46)', () => {
    const budgets = cancelBudgets({ COMPOSE_CANCEL_TIMEOUT_MS: '3000', COMPOSE_TEARDOWN_DRAIN_MS: '2000' });
    assert.equal(budgets.cancelMs, 3000);
    assert.equal(budgets.drainMs, 2000);
    assert.equal(budgets.joinMs, budgets.cancelMs + budgets.drainMs + 1000);
  });

  test('the defaults are the documented 15000 / 10000', () => {
    const budgets = cancelBudgets({});
    assert.equal(budgets.cancelMs, 15000);
    assert.equal(budgets.drainMs, 10000);
    assert.equal(budgets.joinMs, 26000);
  });

  test('withDeadline resolves early and rejects at the bound', async () => {
    assert.equal(await withDeadline(Promise.resolve('ok'), 1000), 'ok');
    await assert.rejects(() => withDeadline(new Promise(() => {}), 20));
  });
});

describe('pendingTeardown', () => {
  test('returns the in-flight teardown of a registered build and null when nothing is tearing down', async () => {
    const handle = createBuildCancel();
    registerBuildCancel('run-pending', handle);
    try {
      assert.equal(pendingTeardown(), null);
      handle.teardown = Promise.resolve('torn down');
      assert.equal(await pendingTeardown(), 'torn down');
    } finally {
      unregisterBuildCancel('run-pending');
    }
    assert.equal(pendingTeardown(), null);
  });

  test('all three CLI command paths await it before exiting (S06-3)', () => {
    const cli = readFileSync(join(REPO_ROOT, 'bin', 'compose.js'), 'utf8');
    const awaits = cli.match(/await pendingTeardown\(\)/g) ?? [];
    assert.equal(awaits.length, 6,
      'three runBuild command paths, each with a .then and a .catch, must await a pending teardown');
    assert.match(cli, /import\(['"]\.\.\/lib\/build-cancel\.js['"]\)|from ['"]\.\.\/lib\/build-cancel\.js['"]/);
  });
});

const CANCEL_SPEC = `
version: 1
contracts:
  Result:
    value: string
flows:
  entry: build
  build:
    input:
      featureCode: string
      description: string
      implementer_agent: string
      reviewer_agent: string
    output:
      from: \${work.output}
      contract: Result
    steps:
      - id: work
        agent: codex
        do: "build \${input.description}"
        out: Result
`;

describe('a real child build torn down by SIGINT', () => {
  test('exits 130 and leaves active-build.json aborted', { timeout: 120000 }, async (t) => {
    if (process.platform === 'win32') {
      t.skip('cancellationId dispatches are refused on win32 (CANCELLATION_UNSUPPORTED_PLATFORM)');
      return;
    }
    const fixture = await makeFakeCodexProject({
      featureCode: 'CANCEL-1',
      spec: CANCEL_SPEC,
      lanes: [{ name: 'sleeper', sleep: true }],
    });
    t.after(() => fixture.cleanup());

    const child = spawn(process.execPath, [
      join(REPO_ROOT, 'bin', 'compose.js'), 'build', 'CANCEL-1', '--skip-triage', '--non-interactive',
    ], { cwd: fixture.workspace, env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });

    const activePath = join(fixture.workspace, '.compose', 'data', 'active-build.json');
    const deadline = Date.now() + 90000;
    let agents = [];
    while (Date.now() < deadline) {
      if (existsSync(activePath)) {
        const record = JSON.parse(await readFile(activePath, 'utf8'));
        agents = await fixture.readAgentPids();
        if (record.status === 'running' && record.flowId && agents.length > 0) break;
      }
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(agents.length > 0, `the fake codex agent never started. Child output:\n${output}`);

    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    child.kill('SIGINT');
    const { code } = await exited;

    assert.equal(code, 130, `SIGINT must exit 130. Child output:\n${output}`);
    const final = JSON.parse(await readFile(activePath, 'utf8'));
    assert.equal(final.status, 'aborted', 'the teardown must write the terminal record');
    assert.equal(final.pid, child.pid, "the driver's own pid stays stamped on its record");
    // The C21 process-group receipt is added by S03: only a TAGGED dispatch is
    // reachable by `stratum_flow_cancel`, so before tagging there is no agent for
    // the teardown's flow cancel to kill.
  });
});

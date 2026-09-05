import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';
import {
  runAndNormalize, AgentTimeoutError, UserInterruptError, AgentAbortedError,
} from '../lib/result-normalizer.js';

function progress() {
  return Object.assign(new EventEmitter(), {
    debug() {}, warn() {}, info() {}, toolUse() {}, consumeAction: () => 'skip',
  });
}

function repairHarness({ interrupt = false, uncertain = false, primary = false } = {}) {
  const ui = progress();
  const calls = [];
  let unsubscribed = false;
  let cleanupFinished = false;
  const uncertainty = Object.assign(new Error('Remote termination not acknowledged'), {
    code: 'CANCELLATION_UNCONFIRMED', dispatchId: 'unconfirmed-dispatch',
  });
  const stratum = {
    onEvent: () => () => { unsubscribed = true; },
    async agentRun(agent, prompt, opts) {
      calls.push({ agent, prompt, opts });
      if (!primary && calls.length === 1) {
        return { text: 'Review result needs formatting.', usage: { tokens: 11 }, dispatchId: 'primary-dispatch' };
      }
      assert.ok(opts.signal instanceof AbortSignal, 'every repair has a cancellable execution handle');
      if (interrupt) queueMicrotask(() => ui.emit('interrupt'));
      return new Promise((_resolve, reject) => {
        const abort = () => {
          // The wrapper must await the execution owner's cleanup, not merely
          // race its timer against a still-running repair.
          setTimeout(() => {
            cleanupFinished = true;
            reject(uncertain ? uncertainty : Object.assign(new Error('stopped'), {
              name: 'AbortError', usage: { tokens: 7 }, dispatchId: 'repair-dispatch',
            }));
          }, 15);
        };
        if (opts.signal.aborted) abort();
        else opts.signal.addEventListener('abort', abort, { once: true });
      });
    },
  };
  return {
    ui, stratum, calls, uncertainty,
    assertCleanedUp() {
      assert.equal(cleanupFinished, true);
      assert.equal(unsubscribed, true);
      assert.equal(ui.listenerCount('interrupt'), 0);
    },
  };
}

for (const mode of ['timeout', 'interrupt']) {
  test(`review repair preserves ${mode} through tolerant parsing and waits for cleanup`, { timeout: 2_000 }, async () => {
    const fixture = repairHarness({ interrupt: mode === 'interrupt' });
    await assert.rejects(
      runAndNormalize(null, 'Review the code', { step_id: 'review', agent: 'claude' }, {
        stratum: fixture.stratum, progress: fixture.ui, reviewMode: true,
        profile: 'claude:read-only-reviewer:critical', maxDurationMs: mode === 'timeout' ? 30 : 1_000,
      }),
      (error) => {
        assert.ok(error instanceof (mode === 'timeout' ? AgentTimeoutError : UserInterruptError));
        if (mode === 'interrupt') assert.equal(error.action, 'skip');
        assert.equal(error.dispatchId, 'repair-dispatch');
        assert.deepEqual(error.usage, { tokens: 7 });
        return true;
      },
    );
    assert.equal(fixture.calls.length, 2);
    assert.equal(fixture.calls[1].opts.signal, fixture.calls[0].opts.signal);
    assert.deepEqual(fixture.calls[1].opts.disallowedTools, ['Edit', 'Write', 'Bash']);
    assert.deepEqual(fixture.calls[1].opts.allowedTools, fixture.calls[0].opts.allowedTools);
    assert.equal(fixture.calls[1].opts.modelID, fixture.calls[0].opts.modelID);
    fixture.assertCleanedUp();
  });
}

for (const primary of [true, false]) {
  test(`unconfirmed ${primary ? 'primary' : 'repair'} termination survives timeout wrapping and review fallback`, { timeout: 2_000 }, async () => {
    const fixture = repairHarness({ uncertain: true, primary });
    await assert.rejects(
      runAndNormalize(null, 'Review the code', { step_id: 'review', agent: 'codex' }, {
        stratum: fixture.stratum, progress: fixture.ui, reviewMode: true,
        profile: 'codex::critical', sandboxMode: 'workspace-write', maxDurationMs: 30,
      }),
      (error) => {
        assert.equal(error, fixture.uncertainty, 'do not relabel uncertainty as an acknowledged timeout');
        return true;
      },
    );
    assert.equal(fixture.calls.length, primary ? 1 : 2);
    for (const call of fixture.calls) {
      assert.equal(call.opts.sandboxMode, 'workspace-write');
      assert.match(call.opts.modelID, /^gpt-/);
      assert.equal(call.opts.thinking, undefined);
    }
    fixture.assertCleanedUp();
  });
}

for (const cancellationReply of ['unknown status', 'transport error', 'hung agent']) {
  test(`real client preserves cancellation uncertainty for ${cancellationReply}`, { timeout: 2_000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'compose-cancellation-control-'));
    const previousMode = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    const oldDeadline = process.env.COMPOSE_CANCEL_TIMEOUT_MS;
    process.env.COMPOSE_CANCEL_TIMEOUT_MS = '35';
    const client = new StratumMcpClient();
    let finishAgent;
    const calls = [];
    client._testClient = {
      async callTool({ name, arguments: args }) {
        calls.push({ name, args });
        if (name === 'stratum_agent_run') {
          return new Promise((resolve) => { finishAgent = resolve; });
        }
        assert.equal(name, 'stratum_cancel_agent_run');
        assert.equal(args.runId, calls[0].args.cancellationId);
        if (cancellationReply !== 'hung agent') finishAgent({ structuredContent: { text: 'late result', usage: {} } });
        if (cancellationReply === 'transport error') throw new Error('connection closed before acknowledgement');
        return { structuredContent: { status: cancellationReply === 'hung agent' ? 'cancelled' : 'unknown' } };
      },
    };
    try {
      await assert.rejects(
        runAndNormalize(null, 'Review', { step_id: 'review', agent: 'codex' }, {
          stratum: client, cwd, telemetry: { project_cwd: cwd }, maxDurationMs: 20,
        }),
        (error) => {
          assert.equal(error.code, cancellationReply === 'hung agent' ? 'CANCELLATION_TEARDOWN_TIMEOUT' : 'CANCELLATION_UNCONFIRMED');
          assert.equal(error instanceof AgentTimeoutError, false);
          return true;
        },
      );
      assert.equal(calls.length, 2);
    } finally {
      finishAgent?.({ structuredContent: { text: 'late result', usage: {} } });
      if (oldDeadline === undefined) delete process.env.COMPOSE_CANCEL_TIMEOUT_MS; else process.env.COMPOSE_CANCEL_TIMEOUT_MS = oldDeadline;
      if (previousMode === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousMode;
      await rm(cwd, { recursive: true, force: true });
    }
  });
}


test('optional policy revision fails open for stuck-detector abort and stops only for user control or uncertain teardown', async () => {
  const { policyRevisionMustStop } = await import('../lib/build.js');
  assert.equal(policyRevisionMustStop(new AgentAbortedError('revision', 'repeated tool calls')), false);
  assert.equal(policyRevisionMustStop(new AgentTimeoutError('revision', 10)), false);
  assert.equal(policyRevisionMustStop(new Error('provider unavailable')), false);
  assert.equal(policyRevisionMustStop(new UserInterruptError('revision', 'skip')), true);
  for (const code of ['CANCELLATION_UNCONFIRMED', 'CANCELLATION_TEARDOWN_TIMEOUT']) {
    assert.equal(policyRevisionMustStop(Object.assign(new Error('still running'), { code })), true);
  }
});

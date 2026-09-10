/**
 * COMP-BUILD-CANCEL S03-2 — `opts.buildSignal` on `runAndNormalize` (D-F, C13).
 *
 * One branch-agnostic hook, because both dispatch branches hang off the single
 * `abortController` declared at lib/result-normalizer.js: the local SDK agent and
 * the two MCP dispatches. `executionOptions` is deliberately NOT touched — an
 * AbortSignal does not belong on the MCP wire request.
 */

process.env.NODE_ENV = 'test';

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const { StratumMcpClient } = await import('../lib/stratum-mcp-client.js');
const { runAndNormalize } = await import('../lib/result-normalizer.js');
const { createBuildCancel } = await import('../lib/build-cancel.js');

const DISPATCH = { flow_id: 'flow-1', step_id: 'work', agent: 'claude', output_fields: {} };

/** A client whose agentRun never settles until its signal aborts. */
function hangingClient() {
  const seen = { dispatches: 0, aborted: 0 };
  const client = new StratumMcpClient();
  client.agentRun = (agentType, prompt, opts = {}) => {
    seen.dispatches += 1;
    return new Promise((_resolve, reject) => {
      const onAbort = () => { seen.aborted += 1; reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })); };
      if (opts.signal?.aborted) onAbort();
      else opts.signal?.addEventListener('abort', onAbort, { once: true });
    });
  };
  client.onEvent = () => () => {};
  return { client, seen };
}

describe('buildSignal chains into runAndNormalize', () => {
  test('aborting the handle aborts an in-flight MCP dispatch', async () => {
    const buildCancel = createBuildCancel();
    const { client, seen } = hangingClient();
    const running = runAndNormalize(null, 'work', DISPATCH, {
      stratum: client,
      buildSignal: buildCancel.signal,
      telemetry: { site: 'build-step' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(seen.dispatches, 1);
    buildCancel.cancel('signal:SIGINT');
    await assert.rejects(() => running);
    assert.equal(seen.aborted, 1);
  });

  test('aborting the handle aborts an in-flight localExecution run', async () => {
    const buildCancel = createBuildCancel();
    const client = new StratumMcpClient();
    client.onEvent = () => () => {};
    let localStarted = false;
    // The local SDK seam: an async generator that never yields until it is aborted.
    const localQuery = ({ options }) => (async function* stream() {
      localStarted = true;
      const signal = options?.abortController?.signal ?? options?.signal;
      await new Promise((_resolve, reject) => {
        const onAbort = () => reject(new DOMException('local agent aborted', 'AbortError'));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
      yield { type: 'result', subtype: 'success', result: '{}' };
    })();

    const running = runAndNormalize(null, 'work', { ...DISPATCH, agent: 'claude' }, {
      stratum: client,
      localExecution: true,
      localQuery,
      buildSignal: buildCancel.signal,
      telemetry: { site: 'build-step' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(localStarted, 'the local branch must have started');
    buildCancel.cancel('signal:SIGINT');
    await assert.rejects(() => running);
  });

  test('a signal already aborted before dispatch aborts the run without reaching the server', async () => {
    const buildCancel = createBuildCancel();
    buildCancel.cancel('already');
    const toolCalls = [];
    const client = new StratumMcpClient();
    client.onEvent = () => () => {};
    Object.defineProperty(client, '_testClient', {
      configurable: true,
      value: {
        async callTool({ name }) {
          toolCalls.push(name);
          return { content: [{ type: 'text', text: '{}' }] };
        },
      },
    });
    await assert.rejects(() => runAndNormalize(null, 'work', DISPATCH, {
      stratum: client,
      buildSignal: buildCancel.signal,
      telemetry: { site: 'build-step' },
    }));
    assert.deepEqual(toolCalls, [], 'an already-cancelled build must not reach the MCP server at all');
  });

  test('the buildSignal listener is released when the run settles', async () => {
    const buildCancel = createBuildCancel();
    const client = new StratumMcpClient();
    client.onEvent = () => () => {};
    client.agentRun = async () => ({ text: '{}', usage: { tokens: 1 } });

    const before = buildCancel.signal.listenerCount?.('abort');
    for (let i = 0; i < 5; i += 1) {
      await runAndNormalize(null, 'work', DISPATCH, {
        stratum: client,
        buildSignal: buildCancel.signal,
        telemetry: { site: 'build-step' },
      });
    }
    const after = buildCancel.signal.listenerCount?.('abort');
    assert.equal(after, before, 'N sequential runs must leave no accumulated abort listeners');
  });

  test('executionOptions never carries the signal onto the wire (C13)', async () => {
    const buildCancel = createBuildCancel();
    const client = new StratumMcpClient();
    client.onEvent = () => () => {};
    let seenOpts = null;
    client.agentRun = async (agentType, prompt, opts) => { seenOpts = opts; return { text: '{}' }; };
    await runAndNormalize(null, 'work', DISPATCH, {
      stratum: client,
      buildSignal: buildCancel.signal,
      telemetry: { site: 'build-step' },
    });
    assert.equal(seenOpts.buildSignal, undefined, 'buildSignal is a compose-side hook, not a wire field');
    assert.ok(seenOpts.signal instanceof AbortSignal, 'the run still carries its own controller signal');
  });
});

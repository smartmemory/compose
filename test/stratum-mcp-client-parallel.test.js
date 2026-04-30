/**
 * Tests for StratumMcpClient.parallelStart and .parallelPoll (T2-F5-COMPOSE-MIGRATE).
 *
 * Uses a lightweight mock client injected via `_testClient` to avoid requiring
 * a live stratum-mcp subprocess.
 */

// Enable the _testClient injection hook (gated on NODE_ENV=test).
process.env.NODE_ENV = 'test';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';

function makeMockClient(responses) {
  const calls = [];
  return {
    calls,
    mock: {
      callTool: async ({ name, arguments: args }) => {
        calls.push({ name, args });
        const next = responses.shift() ?? {};
        return { content: [{ type: 'text', text: JSON.stringify(next) }] };
      },
    },
  };
}

describe('StratumMcpClient.parallelStart', () => {
  it('calls stratum_parallel_start with snake_case args and returns parsed JSON', async () => {
    const { calls, mock } = makeMockClient([
      { status: 'started', flow_id: 'f1', step_id: 's1', task_count: 3, tasks: ['a', 'b', 'c'] },
    ]);
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    const result = await client.parallelStart('flow-xyz', 'step-abc');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'stratum_parallel_start');
    assert.deepEqual(calls[0].args, { flow_id: 'flow-xyz', step_id: 'step-abc' });
    assert.equal(result.status, 'started');
    assert.equal(result.task_count, 3);
  });
});

describe('StratumMcpClient.parallelPoll', () => {
  it('calls stratum_parallel_poll with snake_case args and returns parsed JSON', async () => {
    const { calls, mock } = makeMockClient([{
      flow_id: 'f1',
      step_id: 's1',
      summary: { pending: 0, running: 0, complete: 3, failed: 0, cancelled: 0 },
      tasks: {},
      require_satisfied: true,
      can_advance: true,
      outcome: { status: 'execute_step', step_id: 'next' },
    }]);
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    const result = await client.parallelPoll('flow-xyz', 'step-abc');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'stratum_parallel_poll');
    assert.deepEqual(calls[0].args, { flow_id: 'flow-xyz', step_id: 'step-abc' });
    assert.equal(result.can_advance, true);
    assert.equal(result.outcome.status, 'execute_step');
  });
});

describe('StratumMcpClient.onEvent (STRAT-PAR-STREAM)', () => {
  it('routes BuildStreamEvents from progress callback to subscribed handlers by (flowId, stepId)', async () => {
    // Mock client that captures the onprogress callback and lets us drive it manually.
    let capturedOnProgress = null;
    const mock = {
      callTool: async (_params, _schema, opts) => {
        capturedOnProgress = opts?.onprogress ?? null;
        // Simulate emitting 2 push events mid-call.
        if (capturedOnProgress) {
          capturedOnProgress({
            progress: 1,
            message: JSON.stringify({
              schema_version: '0.2.5',
              flow_id: 'f1', step_id: 's1', task_id: 't1',
              seq: 0, ts: '2026-04-26T00:00:00Z',
              kind: 'agent_started',
              metadata: { agent: 'claude', model: 'opus', prompt_chars: 5 },
            }),
          });
          capturedOnProgress({
            progress: 2,
            message: JSON.stringify({
              schema_version: '0.2.5',
              flow_id: 'f1', step_id: 's1', task_id: 't1',
              seq: 1, ts: '2026-04-26T00:00:01Z',
              kind: 'agent_relay',
              metadata: { text: 'hello', role: 'assistant' },
            }),
          });
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({
            flow_id: 'f1', step_id: 's1',
            summary: { pending: 0, running: 0, complete: 1, failed: 0, cancelled: 0 },
            tasks: {}, require_satisfied: true, can_advance: true,
            outcome: { status: 'execute_step', step_id: 'next' },
          }) }],
        };
      },
    };

    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    const got = [];
    const unsub = client.onEvent('f1', 's1', (ev) => got.push(ev));

    const result = await client.parallelPoll('f1', 's1');
    assert.equal(result.outcome.status, 'execute_step');
    assert.equal(got.length, 2);
    assert.equal(got[0].kind, 'agent_started');
    assert.equal(got[1].kind, 'agent_relay');

    unsub();
  });

  it('ignores progress messages that are not BuildStreamEvents', async () => {
    const mock = {
      callTool: async (_params, _schema, opts) => {
        if (opts?.onprogress) {
          opts.onprogress({ progress: 1, message: 'not json' });
          opts.onprogress({ progress: 2, message: JSON.stringify({ unrelated: true }) });
          opts.onprogress({ progress: 3 }); // no message
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({
            flow_id: 'f1', step_id: 's1',
            summary: {}, tasks: {}, require_satisfied: true, can_advance: true,
            outcome: { status: 'execute_step' },
          }) }],
        };
      },
    };
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    const got = [];
    client.onEvent('f1', 's1', (ev) => got.push(ev));
    await client.parallelPoll('f1', 's1');
    assert.equal(got.length, 0);
  });

  it('unsubscribe removes handler', async () => {
    const mock = {
      callTool: async (_p, _s, opts) => {
        if (opts?.onprogress) {
          opts.onprogress({ progress: 1, message: JSON.stringify({
            schema_version: '0.2.5', flow_id: 'f1', step_id: 's1',
            seq: 0, ts: '2026-04-26T00:00:00Z',
            kind: 'agent_relay', metadata: { text: 'x', role: 'assistant' },
          }) });
        }
        return { content: [{ type: 'text', text: JSON.stringify({
          flow_id: 'f1', step_id: 's1', summary: {}, tasks: {},
          require_satisfied: true, can_advance: true, outcome: { status: 'execute_step' },
        }) }] };
      },
    };
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    const got = [];
    const unsub = client.onEvent('f1', 's1', (ev) => got.push(ev));
    unsub();
    await client.parallelPoll('f1', 's1');
    assert.equal(got.length, 0);
  });
});

describe('StratumMcpClient.parallelAdvance', () => {
  it('calls stratum_parallel_advance with snake_case args and returns parsed JSON', async () => {
    const { calls, mock } = makeMockClient([{
      status: 'complete',
      output: { outcome: 'failed', merge_status: 'conflict' },
    }]);
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    const result = await client.parallelAdvance('flow-xyz', 'step-abc', 'conflict');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'stratum_parallel_advance');
    assert.deepEqual(calls[0].args, { flow_id: 'flow-xyz', step_id: 'step-abc', merge_status: 'conflict' });
    assert.equal(result.status, 'complete');
    assert.equal(result.output.merge_status, 'conflict');
  });
});

// ---------------------------------------------------------------------------
// STRAT-DEDUP-AGENTRUN-V3: agentRun / runAgentText / cancelAgentRun
// ---------------------------------------------------------------------------

describe('StratumMcpClient.agentRun', () => {
  it('calls stratum_agent_run with snake_case kwargs and returns {text, correlation_id}', async () => {
    let captured = null;
    const mock = {
      callTool: async ({ name, arguments: args }, _s, _opts) => {
        captured = { name, args };
        return { content: [{ type: 'text', text: JSON.stringify({ text: 'hi', correlation_id: args.correlation_id }) }] };
      },
    };
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    const out = await client.agentRun('claude', 'do thing', {
      correlationId: 'corr-1',
      schema: { type: 'object' },
      modelID: 'claude-sonnet-4-6',
      allowedTools: ['Read'],
      disallowedTools: ['Bash'],
      thinking: { type: 'enabled' },
      effort: 'high',
      cwd: '/tmp',
    });

    assert.equal(captured.name, 'stratum_agent_run');
    assert.equal(captured.args.type, 'claude');
    assert.equal(captured.args.prompt, 'do thing');
    assert.deepEqual(captured.args.allowed_tools, ['Read']);
    assert.deepEqual(captured.args.disallowed_tools, ['Bash']);
    assert.deepEqual(captured.args.thinking, { type: 'enabled' });
    assert.equal(captured.args.effort, 'high');
    assert.equal(captured.args.modelID, 'claude-sonnet-4-6');
    assert.equal(captured.args.cwd, '/tmp');
    assert.equal(captured.args.correlation_id, 'corr-1');
    assert.equal(out.text, 'hi');
    assert.equal(out.correlation_id, 'corr-1');
  });

  it('subscribed onEvent receives BuildStreamEvents emitted via progress during agentRun', async () => {
    const mock = {
      callTool: async ({ arguments: args }, _s, opts) => {
        const correlationId = args.correlation_id;
        opts.onprogress({
          progress: 1,
          message: JSON.stringify({
            schema_version: '0.2.5',
            flow_id: correlationId, step_id: '_agent_run',
            seq: 0, ts: '2026-04-26T00:00:00Z',
            kind: 'agent_relay',
            metadata: { role: 'assistant', text: 'hello' },
          }),
        });
        opts.onprogress({
          progress: 2,
          message: JSON.stringify({
            schema_version: '0.2.5',
            flow_id: correlationId, step_id: '_agent_run',
            seq: 1, ts: '2026-04-26T00:00:01Z',
            kind: 'step_usage',
            // STRAT-PAR-STREAM-CONSUMER-VALIDATE: metadata must match closed step_usage schema
            metadata: { stepId: '_agent_run', input_tokens: 5, output_tokens: 3, cost_usd: 0, model: 'claude-sonnet-4-6' },
          }),
        });
        return { content: [{ type: 'text', text: JSON.stringify({ text: 'hello', correlation_id: correlationId }) }] };
      },
    };
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    const got = [];
    client.onEvent('cor-2', '_agent_run', (ev) => got.push(ev));
    const out = await client.agentRun('claude', 'p', { correlationId: 'cor-2' });

    assert.equal(out.text, 'hello');
    assert.equal(got.length, 2);
    assert.equal(got[0].kind, 'agent_relay');
    assert.equal(got[1].kind, 'step_usage');
  });

  it('two concurrent agentRun calls with different correlationIds do not cross-talk', async () => {
    let resolveA, resolveB;
    const mock = {
      callTool: async ({ arguments: args }, _s, opts) => {
        const correlationId = args.correlation_id;
        const emit = (kind, text) => opts.onprogress({
          progress: 1,
          message: JSON.stringify({
            schema_version: '0.2.5',
            flow_id: correlationId, step_id: '_agent_run',
            seq: 0, ts: '2026-04-26T00:00:00Z',
            kind,
            metadata: { role: 'assistant', text },
          }),
        });
        if (correlationId === 'A') {
          await new Promise((r) => { resolveA = r; });
          emit('agent_relay', 'a');
        } else {
          await new Promise((r) => { resolveB = r; });
          emit('agent_relay', 'b');
        }
        return { content: [{ type: 'text', text: JSON.stringify({ text: correlationId, correlation_id: correlationId }) }] };
      },
    };
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    const aGot = [], bGot = [];
    client.onEvent('A', '_agent_run', (ev) => aGot.push(ev.metadata.text));
    client.onEvent('B', '_agent_run', (ev) => bGot.push(ev.metadata.text));

    const pa = client.agentRun('claude', 'pa', { correlationId: 'A' });
    const pb = client.agentRun('claude', 'pb', { correlationId: 'B' });

    // Release in opposite order to confirm independence.
    while (!resolveB) await new Promise((r) => setImmediate(r));
    resolveB();
    while (!resolveA) await new Promise((r) => setImmediate(r));
    resolveA();

    const [ra, rb] = await Promise.all([pa, pb]);
    assert.equal(ra.text, 'A');
    assert.equal(rb.text, 'B');
    assert.deepEqual(aGot, ['a']);
    assert.deepEqual(bGot, ['b']);
  });
});

describe('StratumMcpClient.runAgentText', () => {
  it('returns just the text string from stratum_agent_run', async () => {
    const { calls, mock } = makeMockClient([{ text: 'plain answer' }]);
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    const out = await client.runAgentText('claude', 'q', { cwd: '/x' });
    assert.equal(out, 'plain answer');
    assert.equal(calls[0].name, 'stratum_agent_run');
    assert.equal(calls[0].args.cwd, '/x');
  });
});

describe('StratumMcpClient.cancelAgentRun', () => {
  it('calls stratum_cancel_agent_run with correlation_id', async () => {
    const { calls, mock } = makeMockClient([{ status: 'cancelled', correlation_id: 'c1' }]);
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    const out = await client.cancelAgentRun('c1');
    assert.equal(calls[0].name, 'stratum_cancel_agent_run');
    assert.deepEqual(calls[0].args, { correlation_id: 'c1' });
    assert.equal(out.status, 'cancelled');
  });
});

// ---------------------------------------------------------------------------
// STRAT-PAR-STREAM-CONSUMER-VALIDATE: wiring tests for dispatchEvent validation
// Exercises the actual #makeProgressHandler → validateBuildStreamEvent → warn/drop/dispatch path.
// ---------------------------------------------------------------------------

describe('StratumMcpClient consumer validation wiring', () => {
  it('drops invalid envelope (missing schema_version) and does not dispatch to onEvent subscriber', async () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));

    const mock = {
      callTool: async ({ arguments: args }, _s, opts) => {
        const correlationId = args.correlation_id;
        // Emit an invalid envelope: schema_version missing
        opts.onprogress({
          progress: 1,
          message: JSON.stringify({
            // schema_version intentionally omitted
            flow_id: correlationId, step_id: '_agent_run',
            seq: 0, ts: '2026-04-29T00:00:00Z',
            kind: 'agent_relay',
            metadata: { role: 'assistant', text: 'should not arrive' },
          }),
        });
        return { content: [{ type: 'text', text: JSON.stringify({ text: 'ok', correlation_id: correlationId }) }] };
      },
    };

    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    const received = [];
    client.onEvent('v-1', '_agent_run', (ev) => received.push(ev));
    await client.agentRun('claude', 'p', { correlationId: 'v-1' });

    console.warn = origWarn;

    assert.equal(received.length, 0, 'invalid envelope must not be dispatched');
    assert.ok(warnings.some(w => w.includes('dropping invalid')), `expected warn about dropping; got: ${warnings}`);
  });

  it('drops event with unknown schema_version and does not dispatch', async () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));

    const mock = {
      callTool: async ({ arguments: args }, _s, opts) => {
        const correlationId = args.correlation_id;
        opts.onprogress({
          progress: 1,
          message: JSON.stringify({
            schema_version: '0.1.0',   // unknown version
            flow_id: correlationId, step_id: '_agent_run',
            seq: 0, ts: '2026-04-29T00:00:00Z',
            kind: 'agent_relay',
            metadata: { role: 'assistant', text: 'should not arrive' },
          }),
        });
        return { content: [{ type: 'text', text: JSON.stringify({ text: 'ok', correlation_id: correlationId }) }] };
      },
    };

    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    const received = [];
    client.onEvent('v-2', '_agent_run', (ev) => received.push(ev));
    await client.agentRun('claude', 'p', { correlationId: 'v-2' });

    console.warn = origWarn;

    assert.equal(received.length, 0, 'unknown schema_version must be dropped');
    assert.ok(warnings.some(w => w.includes('dropping invalid')), `expected warn; got: ${warnings}`);
  });

  it('forwards valid v0.2.6 envelope to onEvent subscriber', async () => {
    const mock = {
      callTool: async ({ arguments: args }, _s, opts) => {
        const correlationId = args.correlation_id;
        opts.onprogress({
          progress: 1,
          message: JSON.stringify({
            schema_version: '0.2.6',
            flow_id: correlationId, step_id: '_agent_run',
            seq: 0, ts: '2026-04-29T00:00:00Z',
            kind: 'agent_relay',
            metadata: { role: 'assistant', text: 'valid event' },
          }),
        });
        return { content: [{ type: 'text', text: JSON.stringify({ text: 'ok', correlation_id: correlationId }) }] };
      },
    };

    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    const received = [];
    client.onEvent('v-3', '_agent_run', (ev) => received.push(ev));
    await client.agentRun('claude', 'p', { correlationId: 'v-3' });

    assert.equal(received.length, 1, 'valid envelope must be dispatched');
    assert.equal(received[0].kind, 'agent_relay');
    assert.equal(received[0].metadata.text, 'valid event');
  });
});

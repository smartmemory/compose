/**
 * Tests for the TS StratumMcpClient workflow and progress-event surface.
 *
 * Uses a lightweight mock client injected via `_testClient` to avoid requiring
 * a live Stratum subprocess.
 */

// Enable the _testClient injection hook (gated on NODE_ENV=test).
process.env.NODE_ENV = 'test';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StratumMcpClient, StratumError } from '../lib/stratum-mcp-client.js';

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

describe('StratumMcpClient.plan', () => {
  it('calls stratum_plan with the TS spec/input shape and returns parsed JSON', async () => {
    const { calls, mock } = makeMockClient([
      { status: 'ready', runId: 'f1', ready: [{ id: 's1', dispatchToken: 'tok-1' }] },
    ]);
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    const spec = { version: 1, flows: { entry: 'main', main: { steps: [] } } };
    const result = await client.plan(spec, 'main', { task: 'x' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'stratum_plan');
    assert.deepEqual(calls[0].args, { spec, input: { task: 'x' } });
    assert.equal(result.status, 'ready');
    assert.equal(result.ready[0].dispatchToken, 'tok-1');
  });
});

describe('StratumMcpClient.stepDone', () => {
  it('calls stratum_step_done with the TS run and dispatch-token shape', async () => {
    const { calls, mock } = makeMockClient([{ status: 'completed', runId: 'f1' }]);
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    const result = await client.stepDone('flow-xyz', 'step-abc', { output: { ok: true } }, 'tok-1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'stratum_step_done');
    assert.deepEqual(calls[0].args, {
      runId: 'flow-xyz', stepId: 'step-abc', result: { output: { ok: true } }, dispatchToken: 'tok-1',
    });
    assert.equal(result.status, 'completed');
  });
});

describe('StratumMcpClient.onEvent (STRAT-PAR-STREAM)', () => {
  it('routes BuildStreamEvents from agentRun progress to the subscribed correlation id', async () => {
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
              step_id: '_agent_run', task_id: 't1',
              seq: 0, ts: '2026-04-26T00:00:00Z',
              kind: 'agent_started',
              metadata: { agent: 'claude', model: 'opus', prompt_chars: 5 },
            }),
          });
          capturedOnProgress({
            progress: 2,
            message: JSON.stringify({
              schema_version: '0.2.5',
              step_id: '_agent_run', task_id: 't1',
              seq: 1, ts: '2026-04-26T00:00:01Z',
              kind: 'agent_relay',
              metadata: { text: 'hello', role: 'assistant' },
            }),
          });
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({
            text: 'ok',
          }) }],
        };
      },
    };

    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    const got = [];
    const unsub = client.onEvent('f1', '_agent_run', (ev) => got.push(ev));

    const result = await client.agentRun('claude', 'prompt', { correlationId: 'f1', cwd: '/tmp' });
    assert.equal(result.text, 'ok');
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
            text: 'ok',
          }) }],
        };
      },
    };
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    const got = [];
    client.onEvent('f1', '_agent_run', (ev) => got.push(ev));
    await client.agentRun('claude', 'prompt', { correlationId: 'f1', cwd: '/tmp' });
    assert.equal(got.length, 0);
  });

  it('unsubscribe removes handler', async () => {
    const mock = {
      callTool: async (_p, _s, opts) => {
        if (opts?.onprogress) {
          opts.onprogress({ progress: 1, message: JSON.stringify({
            schema_version: '0.2.5', step_id: '_agent_run',
            seq: 0, ts: '2026-04-26T00:00:00Z',
            kind: 'agent_relay', metadata: { text: 'x', role: 'assistant' },
          }) });
        }
        return { content: [{ type: 'text', text: JSON.stringify({
          text: 'ok',
        }) }] };
      },
    };
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    const got = [];
    const unsub = client.onEvent('f1', '_agent_run', (ev) => got.push(ev));
    unsub();
    await client.agentRun('claude', 'prompt', { correlationId: 'f1', cwd: '/tmp' });
    assert.equal(got.length, 0);
  });
});

describe('StratumMcpClient.resume', () => {
  it('calls stratum_resume with the TS runId shape', async () => {
    const { calls, mock } = makeMockClient([{ status: 'ready', runId: 'flow-xyz', ready: [] }]);
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    const result = await client.resume('flow-xyz');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'stratum_resume');
    assert.deepEqual(calls[0].args, { runId: 'flow-xyz' });
    assert.equal(result.status, 'ready');
  });
});

// ---------------------------------------------------------------------------
// STRAT-DEDUP-AGENTRUN-V3: agentRun / runAgentText / cancelAgentRun
// ---------------------------------------------------------------------------

describe('StratumMcpClient.agentRun', () => {
  it('calls stratum_agent_run with the TS wire shape and returns the TS result', async () => {
    let captured = null;
    const mock = {
      callTool: async ({ name, arguments: args }, _s, _opts) => {
        captured = { name, args };
        return { content: [{ type: 'text', text: JSON.stringify({ text: 'hi' }) }] };
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

    // D1: the TS surface accepts only {agent, prompt, cwd, model?, sandboxMode?}
    // and rejects any other key. The python-era knobs (type/allowed_tools/
    // thinking/effort/correlation_id) are compose-side concerns and are NOT sent.
    assert.equal(captured.name, 'stratum_agent_run');
    assert.equal(captured.args.agent, 'claude');
    assert.equal(captured.args.prompt, 'do thing');
    assert.equal(captured.args.cwd, '/tmp');
    assert.equal(captured.args.model, 'claude-sonnet-4-6');
    assert.ok(!('type' in captured.args), 'python-era `type` must not be on the wire');
    assert.ok(!('allowed_tools' in captured.args), 'allowed_tools is compose-side, not on the wire');
    assert.ok(!('thinking' in captured.args), 'thinking is compose-side, not on the wire');
    assert.ok(!('correlation_id' in captured.args), 'correlation_id is not on the TS wire');
    assert.equal(out.text, 'hi');
    assert.deepEqual(out, { text: 'hi' });
  });

  it('subscribed onEvent receives BuildStreamEvents emitted via progress during agentRun', async () => {
    const mock = {
      callTool: async ({ arguments: _args }, _s, opts) => {
        const correlationId = 'cor-2';
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
        return { content: [{ type: 'text', text: JSON.stringify({ text: 'hello' }) }] };
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
        // Two concurrent calls: distinguish them by their on-wire prompt (the
        // client no longer sends correlation_id — see buildAgentRunRequest) to
        // drive the interleaved release order and tag each envelope's flow_id.
        const correlationId = args.prompt === 'pa' ? 'A' : 'B';
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
        return { content: [{ type: 'text', text: JSON.stringify({ text: correlationId }) }] };
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
  it('calls stratum_cancel_agent_run with the TS {runId} shape (V2)', async () => {
    const { calls, mock } = makeMockClient([{ status: 'cancelled', runId: 'c1' }]);
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    const out = await client.cancelAgentRun('c1');
    assert.equal(calls[0].name, 'stratum_cancel_agent_run');
    // The engine rejects the python-era {correlation_id}; the wire shape is {runId}.
    assert.deepEqual(calls[0].args, { runId: 'c1' });
    assert.ok(!('correlation_id' in calls[0].args), 'python-era correlation_id must not be sent');
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
      callTool: async ({ arguments: _args }, _s, opts) => {
        const correlationId = 'v-1';
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
        return { content: [{ type: 'text', text: JSON.stringify({ text: 'ok' }) }] };
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
      callTool: async ({ arguments: _args }, _s, opts) => {
        const correlationId = 'v-2';
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
        return { content: [{ type: 'text', text: JSON.stringify({ text: 'ok' }) }] };
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
      callTool: async ({ arguments: _args }, _s, opts) => {
        const correlationId = 'v-3';
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
        return { content: [{ type: 'text', text: JSON.stringify({ text: 'ok' }) }] };
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

  it('delivers a producer-echo envelope whose flow_id equals the call correlationId (V6)', async () => {
    const mock = {
      callTool: async ({ arguments: _args }, _s, opts) => {
        // Python-parity: the producer echoed the correlation id as flow_id.
        opts.onprogress({
          progress: 1,
          message: JSON.stringify({
            schema_version: '0.2.6', flow_id: 'echo-call', step_id: '_agent_run',
            seq: 0, ts: '2026-04-29T00:00:00Z', kind: 'agent_relay',
            metadata: { role: 'assistant', text: 'echoed' },
          }),
        });
        return { content: [{ type: 'text', text: JSON.stringify({ text: 'ok' }) }] };
      },
    };
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });
    const received = [];
    client.onEvent('echo-call', '_agent_run', (ev) => received.push(ev));
    await client.agentRun('claude', 'p', { correlationId: 'echo-call' });
    assert.equal(received.length, 1, 'a producer-echoed flow_id matching the call must deliver');
    assert.equal(received[0].metadata.text, 'echoed');
  });

  it('drops a misrouted envelope whose flow_id targets a different call (V6)', async () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    const mock = {
      callTool: async ({ arguments: _args }, _s, opts) => {
        // Adversarial: this call ('A') emits an envelope stamped for another
        // call ('B'). It must not leak into B's stream (or A's).
        opts.onprogress({
          progress: 1,
          message: JSON.stringify({
            schema_version: '0.2.6', flow_id: 'B', step_id: '_agent_run',
            seq: 0, ts: '2026-04-29T00:00:00Z', kind: 'agent_relay',
            metadata: { role: 'assistant', text: 'leak' },
          }),
        });
        return { content: [{ type: 'text', text: JSON.stringify({ text: 'ok' }) }] };
      },
    };
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });
    const aGot = [], bGot = [];
    client.onEvent('A', '_agent_run', (ev) => aGot.push(ev));
    client.onEvent('B', '_agent_run', (ev) => bGot.push(ev));
    await client.agentRun('claude', 'p', { correlationId: 'A' });
    console.warn = origWarn;
    assert.equal(bGot.length, 0, 'a misrouted flow_id must not leak into another call\'s subscriber');
    assert.equal(aGot.length, 0, 'the misrouted envelope is dropped, not delivered');
    assert.ok(warnings.some((w) => w.includes('misrouted')), `expected a misroute warning; got: ${warnings}`);
  });

  // F7: only an ABSENT flow_id (undefined) is stamped with the call correlation
  // id. A present-but-falsy flow_id ('' / null / 0) is malformed producer output
  // — it must be dropped+warned, NOT laundered into a valid locally-attributed
  // event by the truthiness check.
  for (const bad of [{ label: 'empty-string', flow_id: '' }, { label: 'null', flow_id: null }]) {
    it(`drops a present-but-falsy flow_id (${bad.label}) instead of stamping it (F7)`, async () => {
      const warnings = [];
      const origWarn = console.warn;
      console.warn = (...a) => warnings.push(a.join(' '));
      const mock = {
        callTool: async ({ arguments: _args }, _s, opts) => {
          opts.onprogress({
            progress: 1,
            message: JSON.stringify({
              schema_version: '0.2.6', flow_id: bad.flow_id, step_id: '_agent_run',
              seq: 0, ts: '2026-04-29T00:00:00Z', kind: 'agent_relay',
              metadata: { role: 'assistant', text: 'malformed' },
            }),
          });
          return { content: [{ type: 'text', text: JSON.stringify({ text: 'ok' }) }] };
        },
      };
      const client = new StratumMcpClient();
      Object.defineProperty(client, '_testClient', { value: mock, writable: true });
      const got = [];
      client.onEvent('A', '_agent_run', (ev) => got.push(ev));
      await client.agentRun('claude', 'p', { correlationId: 'A' });
      console.warn = origWarn;
      assert.equal(got.length, 0, 'a present-but-falsy flow_id must not be stamped and delivered');
      assert.ok(warnings.some((w) => w.includes('misrouted')), `expected a misroute warning; got: ${warnings}`);
    });
  }
});

// ---------------------------------------------------------------------------
// H7(a): client lifecycle edges (re-expressed from the deleted
// stratum-mcp-client.test.js:179-196,245). The python-era originals drove a live
// python MCP; these exercise the same client-side guards against the TS client
// via the mock-injection seam (no live subprocess).
// ---------------------------------------------------------------------------
describe('StratumMcpClient lifecycle edges', () => {
  it('a tool call before connect throws "not connected"', async () => {
    const client = new StratumMcpClient(); // no _testClient, never connected
    await assert.rejects(
      () => client.plan({ version: 1, flows: { entry: 'main', main: { steps: [] } } }, 'main', {}),
      /not connected/i,
    );
  });

  it('close on a never-connected client is a safe no-op (double-close guard)', async () => {
    const client = new StratumMcpClient();
    await client.close();
    await client.close(); // must not throw
    assert.ok(true);
  });

  it('resume propagates a StratumError when the engine reports an unknown run', async () => {
    const { mock } = makeMockClient([
      { status: 'error', error: { code: 'NOT_FOUND', message: "run 'nonexistent' not found" } },
    ]);
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });
    await assert.rejects(
      () => client.resume('nonexistent'),
      (err) => err instanceof StratumError,
    );
  });
});

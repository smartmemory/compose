/**
 * STRAT-PAR-STREAM consumer integration test.
 *
 * Uses an in-memory MCP server (FastMCP-equivalent on the JS side) talking to
 * StratumMcpClient via paired in-memory transports — no real subprocess needed.
 * The fake server emits 3 progress notifications during a `stratum_parallel_poll`
 * tool call, each carrying a JSON-stringified BuildStreamEvent in `message`.
 * The client's onEvent subscription must receive all 3 parsed events.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StratumMcpClient } from '../../lib/stratum-mcp-client.js';

const FLOW_ID = 'flow-test-1';
const STEP_ID = 'execute';

function makeEvent(seq, kind, metadata, taskId = 'task-001') {
  return {
    schema_version: '0.2.5',
    flow_id: FLOW_ID,
    step_id: STEP_ID,
    task_id: taskId,
    seq,
    ts: new Date().toISOString(),
    kind,
    metadata,
  };
}

function buildFakeServer() {
  const server = new Server(
    { name: 'fake-stratum', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );

  // Canonical parallel_poll response shape.
  const POLL_RESULT = {
    flow_id: FLOW_ID,
    step_id: STEP_ID,
    summary: { pending: 0, running: 0, complete: 1, failed: 0, cancelled: 0 },
    tasks: { 'task-001': { state: 'complete', started_at: '', finished_at: '', result: {}, error: null } },
    require_satisfied: true,
    can_advance: true,
    outcome: { status: 'execute_step', step_id: 'next' },
  };

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name;
    const progressToken = req.params._meta?.progressToken;

    if (name === 'stratum_parallel_poll') {
      // Emit 3 push events mid-call.
      if (progressToken !== undefined && extra?.sendNotification) {
        const events = [
          makeEvent(0, 'agent_started',     { agent: 'claude', model: 'opus', prompt_chars: 42 }),
          makeEvent(1, 'tool_use_summary',  { tool: 'Read', summary: 'foo.js', ok: true, duration_ms: 12 }),
          makeEvent(2, 'agent_relay',       { text: 'Hello from agent', role: 'assistant' }),
        ];
        for (let i = 0; i < events.length; i++) {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: i + 1,
              total: events.length,
              message: JSON.stringify(events[i]),
            },
          });
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify(POLL_RESULT) }] };
    }

    if (name === 'stratum_parallel_start') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'started', flow_id: FLOW_ID, step_id: STEP_ID, task_count: 1, tasks: ['task-001'] }) }],
      };
    }

    return { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool' }) }], isError: true };
  });

  return server;
}

describe('STRAT-PAR-STREAM consumer integration', () => {
  let client;
  let fakeServer;

  before(async () => {
    fakeServer = buildFakeServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await fakeServer.connect(serverTransport);

    client = new StratumMcpClient();
    // Bypass `connect()` — connect the underlying SDK Client directly with our paired transport.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const sdkClient = new Client({ name: 'compose-test', version: '0.0.1' }, { capabilities: {} });
    await sdkClient.connect(clientTransport);
    // Inject as the live client (NODE_ENV=test gate is on; reuse _testClient hook).
    process.env.NODE_ENV = 'test';
    Object.defineProperty(client, '_testClient', { value: sdkClient, writable: true });
  });

  after(async () => {
    if (client) await client.close();
    if (fakeServer) await fakeServer.close();
  });

  test('onEvent receives all 3 BuildStreamEvent envelopes during parallelPoll', async () => {
    const received = [];
    const unsub = client.onEvent(FLOW_ID, STEP_ID, (ev) => received.push(ev));

    const result = await client.parallelPoll(FLOW_ID, STEP_ID);

    // Canonical poll shape preserved.
    assert.equal(result.flow_id, FLOW_ID);
    assert.equal(result.step_id, STEP_ID);
    assert.equal(result.can_advance, true);
    assert.equal(result.outcome.status, 'execute_step');
    assert.ok(result.tasks);
    assert.ok(result.summary);

    // All 3 push events delivered with parsed BuildStreamEvent shape.
    assert.equal(received.length, 3);
    assert.equal(received[0].kind, 'agent_started');
    assert.equal(received[0].schema_version, '0.2.5');
    assert.equal(received[0].metadata.agent, 'claude');
    assert.equal(received[1].kind, 'tool_use_summary');
    assert.equal(received[1].metadata.tool, 'Read');
    assert.equal(received[2].kind, 'agent_relay');
    assert.equal(received[2].metadata.text, 'Hello from agent');

    // Per-task seq monotonic.
    assert.equal(received[0].seq, 0);
    assert.equal(received[1].seq, 1);
    assert.equal(received[2].seq, 2);

    unsub();
  });

  test('unsubscribed handler stops receiving events', async () => {
    const a = [];
    const b = [];
    const unsubA = client.onEvent(FLOW_ID, STEP_ID, (ev) => a.push(ev));
    const unsubB = client.onEvent(FLOW_ID, STEP_ID, (ev) => b.push(ev));

    unsubA();

    await client.parallelPoll(FLOW_ID, STEP_ID);

    assert.equal(a.length, 0);
    assert.equal(b.length, 3);
    unsubB();
  });

  test('events for a different (flow, step) scope do not leak', async () => {
    const wrongScope = [];
    const rightScope = [];
    const unsubWrong = client.onEvent('other-flow', 'other-step', (ev) => wrongScope.push(ev));
    const unsubRight = client.onEvent(FLOW_ID, STEP_ID, (ev) => rightScope.push(ev));

    await client.parallelPoll(FLOW_ID, STEP_ID);

    assert.equal(wrongScope.length, 0);
    assert.equal(rightScope.length, 3);
    unsubWrong();
    unsubRight();
  });
});

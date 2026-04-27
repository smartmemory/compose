/**
 * STRAT-DEDUP-AGENTRUN-V3 — consumer-side integration test for the new
 * `agentRun` / `runAgentText` / `cancelAgentRun` methods on StratumMcpClient.
 *
 * Mirrors test/integration/stratum-stream.test.js: paired in-memory MCP
 * transports, fake server emits BuildStreamEvent envelopes via progress
 * notifications, client subscribes via `onEvent` and verifies all envelopes
 * arrive in order. Verifies two concurrent agentRun calls on different
 * correlationIds do not cross-talk.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StratumMcpClient } from '../../lib/stratum-mcp-client.js';

const STEP_ID = '_agent_run';

function makeEvent(correlationId, seq, kind, metadata) {
  return {
    schema_version: '0.2.5',
    flow_id:        correlationId,
    step_id:        STEP_ID,
    task_id:        null,
    seq,
    ts:             new Date().toISOString(),
    kind,
    metadata,
  };
}

function buildFakeServer() {
  const server = new Server(
    { name: 'fake-stratum-agent-run', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};
    const progressToken = req.params._meta?.progressToken;

    if (name === 'stratum_agent_run') {
      const correlationId = args.correlation_id ?? 'srv-gen-corr';
      if (progressToken !== undefined && extra?.sendNotification) {
        const events = [
          makeEvent(correlationId, 0, 'agent_started',    { agent: args.type ?? 'claude', model: 'opus', prompt_chars: (args.prompt ?? '').length }),
          makeEvent(correlationId, 1, 'tool_use_summary', { tool: 'Read', summary: 'README.md', ok: true, duration_ms: 8 }),
          makeEvent(correlationId, 2, 'agent_relay',      { text: 'final answer', role: 'assistant' }),
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
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ text: 'final answer', correlation_id: correlationId }),
        }],
      };
    }

    if (name === 'stratum_cancel_agent_run') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'cancelled', correlation_id: args.correlation_id }) }],
      };
    }

    return { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool' }) }], isError: true };
  });

  return server;
}

describe('STRAT-DEDUP-AGENTRUN-V3 consumer integration', () => {
  let client;
  let fakeServer;

  before(async () => {
    fakeServer = buildFakeServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await fakeServer.connect(serverTransport);

    client = new StratumMcpClient();
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const sdkClient = new Client({ name: 'compose-test', version: '0.0.1' }, { capabilities: {} });
    await sdkClient.connect(clientTransport);
    process.env.NODE_ENV = 'test';
    Object.defineProperty(client, '_testClient', { value: sdkClient, writable: true });
  });

  after(async () => {
    if (client) await client.close();
    if (fakeServer) await fakeServer.close();
  });

  test('onEvent receives all 3 BuildStreamEvent envelopes during agentRun', async () => {
    const received = [];
    const correlationId = 'corr-int-1';
    const unsub = client.onEvent(correlationId, STEP_ID, (ev) => received.push(ev));

    const result = await client.agentRun('claude', 'do thing', { correlationId });

    assert.equal(result.text, 'final answer');
    assert.equal(result.correlation_id, correlationId);
    assert.equal(received.length, 3);
    assert.equal(received[0].kind, 'agent_started');
    assert.equal(received[1].kind, 'tool_use_summary');
    assert.equal(received[2].kind, 'agent_relay');
    assert.equal(received[0].seq, 0);
    assert.equal(received[2].metadata.text, 'final answer');

    unsub();
  });

  test('two concurrent agentRun calls on distinct correlationIds do not cross-talk', async () => {
    const aGot = [], bGot = [];
    const unsubA = client.onEvent('corr-A', STEP_ID, (ev) => aGot.push(ev));
    const unsubB = client.onEvent('corr-B', STEP_ID, (ev) => bGot.push(ev));

    const [resA, resB] = await Promise.all([
      client.agentRun('claude', 'A', { correlationId: 'corr-A' }),
      client.agentRun('claude', 'B', { correlationId: 'corr-B' }),
    ]);

    assert.equal(resA.correlation_id, 'corr-A');
    assert.equal(resB.correlation_id, 'corr-B');
    assert.equal(aGot.length, 3);
    assert.equal(bGot.length, 3);
    for (const ev of aGot) assert.equal(ev.flow_id, 'corr-A');
    for (const ev of bGot) assert.equal(ev.flow_id, 'corr-B');

    unsubA();
    unsubB();
  });

  test('runAgentText returns the plain text string', async () => {
    const text = await client.runAgentText('claude', 'tell me a thing');
    assert.equal(text, 'final answer');
  });

  test('cancelAgentRun round-trips and returns the producer status', async () => {
    const out = await client.cancelAgentRun('any-corr');
    assert.equal(out.status, 'cancelled');
    assert.equal(out.correlation_id, 'any-corr');
  });
});

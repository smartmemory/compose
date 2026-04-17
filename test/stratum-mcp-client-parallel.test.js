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

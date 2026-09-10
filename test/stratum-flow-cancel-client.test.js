/**
 * S02: `flow` on the request, an unconditional `cancellationId` whenever `flow` is set,
 * and `StratumMcpClient.flowCancel(runId)` unwrapping the flow_cancel_unacknowledged
 * envelope into a StratumError.
 */
process.env.NODE_ENV = 'test';

import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  StratumMcpClient,
  StratumError,
  buildAgentRunRequest,
  isUnknownFlowError,
  asTransportRefusal,
} from '../lib/stratum-mcp-client.js';

function makeMockClient(responder) {
  const calls = [];
  return {
    calls,
    mock: {
      callTool: async ({ name, arguments: args }) => {
        calls.push({ name, args });
        return responder(name, args, calls.length);
      },
    },
  };
}

describe('buildAgentRunRequest: flow', () => {
  it('emits flow only when opts.flow is set, positioned last', () => {
    const withoutFlow = buildAgentRunRequest('claude', 'p', {});
    assert.ok(!('flow' in withoutFlow));

    const flow = { runId: 'r1', stepId: 's1', itemIndex: 0 };
    const withFlow = buildAgentRunRequest('claude', 'p', { flow, cancellationId: 'c1' });
    assert.deepEqual(withFlow.flow, flow);
    assert.deepEqual(Object.keys(withFlow).slice(-1), ['flow']);
  });
});

describe('StratumMcpClient#agentRun: cancellationId minting with flow', () => {
  it('mints a cancellationId when opts.flow is set and no signal is passed', async () => {
    const { calls, mock } = makeMockClient(() => ({
      content: [{ type: 'text', text: JSON.stringify({ text: 'done', usage: {} }) }],
    }));
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    await client.agentRun('claude', 'p', { cwd: '/tmp', flow: { runId: 'r1' } });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.cancellationId, 'expected a minted cancellationId');
  });

  it('mints a different cancellationId on each call', async () => {
    const { calls, mock } = makeMockClient(() => ({
      content: [{ type: 'text', text: JSON.stringify({ text: 'done', usage: {} }) }],
    }));
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    await client.agentRun('claude', 'p', { cwd: '/tmp', flow: { runId: 'r1' } });
    await client.agentRun('claude', 'p', { cwd: '/tmp', flow: { runId: 'r1' } });
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].args.cancellationId, calls[1].args.cancellationId);
  });
});

describe('StratumMcpClient#flowCancel', () => {
  it('calls stratum_flow_cancel with exactly {runId}', async () => {
    const { calls, mock } = makeMockClient(() => ({
      content: [{ type: 'text', text: JSON.stringify({
        runId: 'r1', status: 'cancelled', flowSettled: true, acknowledged: true,
        ledger: { spent: {} },
        agents: { signalled: 1, reaped: 1, gone: 0, unreachable: 0, alreadySettled: 0, unresolved: 0, unsettled: 0, unreaped: 0 },
      }) }],
    }));
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    const result = await client.flowCancel('r1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'stratum_flow_cancel');
    assert.deepEqual(calls[0].args, { runId: 'r1' });
    assert.equal(result.status, 'cancelled');
    assert.equal(result.flowSettled, true);
    assert.deepEqual(result.agents, { signalled: 1, reaped: 1, gone: 0, unreachable: 0, alreadySettled: 0, unresolved: 0, unsettled: 0, unreaped: 0 });
  });

  it('resolves unmodified on an already-terminal success envelope', async () => {
    const { mock } = makeMockClient(() => ({
      content: [{ type: 'text', text: JSON.stringify({
        runId: 'r1', status: 'completed', flowSettled: false, acknowledged: false,
        reason: 'already_completed', ledger: { spent: {} },
        agents: { signalled: 0, reaped: 0, gone: 0, unreachable: 0, alreadySettled: 3, unresolved: 0, unsettled: 0, unreaped: 0 },
      }) }],
    }));
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    const result = await client.flowCancel('r1');
    assert.equal(result.acknowledged, false);
    assert.equal(result.reason, 'already_completed');
    assert.equal(result.flowSettled, false);
  });

  for (const holderPid of [1234, undefined]) {
    for (const code of ['CANCELLATION_UNCONFIRMED', 'CANCELLATION_TEARDOWN_TIMEOUT']) {
      test(`${code} with holderPid=${holderPid}: unwraps into a StratumError carrying the full field set`, async () => {
        const data = {
          code, status: 'running', flowSettled: code === 'CANCELLATION_TEARDOWN_TIMEOUT',
          reason: 'run_lock_held', holderPid,
          agents: { signalled: 2, reaped: 0, gone: 0, unreachable: 0, alreadySettled: 0, unresolved: 2, unsettled: 2, unreaped: 2 },
        };
        const { mock } = makeMockClient(() => {
          const err = new Error(`cancel refused: ${code}`);
          err.code = -32001;
          err.data = data;
          throw err;
        });
        const client = new StratumMcpClient();
        Object.defineProperty(client, '_testClient', { value: mock, writable: true });

        await assert.rejects(client.flowCancel('r1'), (error) => {
          assert.ok(error instanceof StratumError);
          assert.equal(error.name, 'StratumError');
          assert.equal(error.code, data.code);
          assert.equal(error.status, data.status);
          assert.equal(error.flowSettled, data.flowSettled);
          assert.equal(error.reason, data.reason);
          assert.equal(error.holderPid ?? undefined, holderPid);
          assert.deepEqual(error.agents, data.agents);
          return true;
        });
      });
    }
  }

  it('an ENOENT-shaped unknown-run rejection becomes FLOW_NOT_FOUND, sweeping nothing', async () => {
    const { mock } = makeMockClient(() => {
      const err = new Error('ENOENT: no such run r-missing');
      throw err;
    });
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    await assert.rejects(client.flowCancel('r-missing'), (error) => {
      assert.ok(error instanceof StratumError);
      assert.equal(error.code, 'FLOW_NOT_FOUND');
      assert.equal(error.flowSettled, false);
      assert.equal(error.reason, 'flow_not_found');
      assert.equal(error.agents, null);
      return true;
    });
  });

  it('a transport failure (dead server, broken pipe) normalises to CANCELLATION_UNCONFIRMED/transport, sweeping nothing', async () => {
    const { mock } = makeMockClient(() => {
      throw new Error('write EPIPE');
    });
    const client = new StratumMcpClient();
    Object.defineProperty(client, '_testClient', { value: mock, writable: true });

    await assert.rejects(client.flowCancel('r1'), (error) => {
      assert.ok(error instanceof StratumError);
      assert.equal(error.code, 'CANCELLATION_UNCONFIRMED');
      assert.equal(error.flowSettled, false);
      assert.equal(error.reason, 'transport');
      assert.ok(error.agents && Object.values(error.agents).every((n) => n === 0));
      return true;
    });
  });
});

describe('isUnknownFlowError', () => {
  it('matches an McpError with absent data and an ENOENT-shaped message', () => {
    const err = new Error('ENOENT: no such run');
    assert.equal(isUnknownFlowError(err), true);

    const err2 = new Error('flow not found: r1');
    assert.equal(isUnknownFlowError(err2), true);
  });

  it('does not match a CANCELLATION_* error (coded, with data)', () => {
    const err = new Error('cancel refused');
    err.code = 'CANCELLATION_UNCONFIRMED';
    err.data = { code: 'CANCELLATION_UNCONFIRMED', status: 'running' };
    assert.equal(isUnknownFlowError(err), false);
  });

  it('does not match a plain transport error with no data and an unrelated message', () => {
    const err = new Error('write EPIPE');
    assert.equal(isUnknownFlowError(err), false);
  });

  it('does not match a generic InternalError with an unrelated message', () => {
    const err = new Error('internal server error');
    err.code = -32603;
    assert.equal(isUnknownFlowError(err), false);
  });
});

describe('asTransportRefusal', () => {
  it('produces the one shape every unclassifiable cancel failure takes', () => {
    const refusal = asTransportRefusal(new Error('boom'));
    assert.ok(refusal instanceof StratumError);
    assert.equal(refusal.code, 'CANCELLATION_UNCONFIRMED');
    assert.equal(refusal.status, null);
    assert.equal(refusal.flowSettled, false);
    assert.equal(refusal.reason, 'transport');
    assert.equal(refusal.holderPid, null);
    assert.ok(refusal.agents && Object.values(refusal.agents).every((n) => n === 0));
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StratumMcpClient, isUnknownFlowError } from '../../lib/stratum-mcp-client.js';
import { TS_MCP_BIN } from '../helpers/stratum-test-bin.js';
import { makeFakeCodexProject, CANCEL_FANOUT_SPEC, processGroupGone, waitForReceipt } from '../helpers/fake-codex-project.js';

test('S07-1: second real MCP client cancels a registered exec group and pins the wire contract', { timeout: 120000 }, async t => {
  if (process.platform === 'win32') {
    t.skip('win32 refuses cancellationId dispatch before spawn: CANCELLATION_UNSUPPORTED_PLATFORM');
    return;
  }
  const fixture = await makeFakeCodexProject({ featureCode: 'S07-FLOW', spec: CANCEL_FANOUT_SPEC });
  const a = new StratumMcpClient();
  const b = new StratumMcpClient();
  const groups = new Set();
  // The public flowCancel wrapper normalizes unknown-run errors. A separate real
  // wire probe below pins the raw C4 envelope without intercepting either client.
  const wire = new Client({ name: 's07-unknown-wire', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [TS_MCP_BIN], env: fixture.env, stderr: 'pipe' });
  t.after(async () => {
    for (const entry of await fixture.readAgentPids()) groups.add(entry.pid);
    for (const entry of await fixture.readForegroundEntries()) {
      for (const group of entry.groups) groups.add(group.childPid);
    }
    for (const pid of groups) {
      try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error; }
    }
    await Promise.all([a.close(), b.close(), wire.close()]);
    await fixture.cleanup();
    for (const pid of groups) assert.ok(processGroupGone(pid), `stray process group ${pid}`);
  });
  const connection = { command: process.execPath, args: [TS_MCP_BIN], cwd: fixture.workspace, env: fixture.env };
  await a.connect(connection);
  await b.connect(connection);
  const planned = await a.plan(CANCEL_FANOUT_SPEC, 'main', {
    featureCode: 'S07-FLOW', description: 'cancel golden', implementer_agent: 'codex', reviewer_agent: 'codex',
  }, { workspaceRoot: fixture.workspace });
  await a.stepDone(planned.runId, 'enumerate', { output: { items: ['S07_LANE_A', 'S07_LANE_B'] } }, planned.ready[0].dispatchToken);
  const flow = { runId: planned.runId, stepId: 'fan', itemIndex: 0 };
  const pending = a.agentRun('codex', 'S07 registered sleeper', {
    cwd: fixture.workspace, cancellationId: randomUUID(), flow,
  });
  // Attach immediately, but keep the original promise for assert.rejects.
  pending.catch(() => {});
  const entry = await waitForReceipt(async () => (await fixture.readForegroundEntries())
    .find(meta => meta.flow?.runId === planned.runId && meta.state === 'running' && meta.groups.length > 0), 'running registry with a stamped group');
  assert.equal(entry.state, 'running');
  assert.deepEqual(entry.flow, flow);
  for (const group of entry.groups) groups.add(group.childPid);
  const invoked = await waitForReceipt(async () => (await fixture.readAgentPids())[0], 'fake codex exec invocation');
  assert.ok(groups.has(invoked.pid), 'the actual PATH executable is the registered exec group');
  assert.equal(processGroupGone(invoked.pid), false, 'group was live before cancel');

  // A rejection here fails the test: cancel success and agent failure are distinct.
  const ack = await b.flowCancel(planned.runId);
  assert.equal(ack.runId, planned.runId);
  assert.equal(ack.status, 'cancelled');
  assert.equal(ack.flowSettled, true);
  assert.equal(ack.acknowledged, true);
  assert.deepEqual(Object.keys(ack).sort(), ['acknowledged', 'agents', 'flowSettled', 'ledger', 'runId', 'status']);
  assert.ok(processGroupGone(invoked.pid), 'cancel resolves only after the fake group is gone');
  await assert.rejects(pending);
  assert.equal((await b.audit(planned.runId)).status, 'cancelled');
  await assert.rejects(b.agentRun('codex', 'must never spawn', {
    cwd: fixture.workspace, cancellationId: randomUUID(), flow,
  }), error => { assert.equal(error.code, 'flow_not_running'); return true; });
  assert.equal((await fixture.readAgentPids()).length, 1, 'refused dispatch did not spawn');
  assert.equal(isUnknownFlowError(ack), false);
  for (const code of ['CANCELLATION_UNCONFIRMED', 'CANCELLATION_TEARDOWN_TIMEOUT']) {
    assert.equal(isUnknownFlowError({ code: -32603, message: 'ENOENT', data: { code } }), false);
  }

  const unknownId = `s07-missing-${randomUUID()}`;
  await assert.rejects(b.flowCancel(unknownId), error => {
    assert.equal(error.code, 'FLOW_NOT_FOUND');
    assert.equal(error.flowSettled, false);
    assert.equal(error.reason, 'flow_not_found');
    assert.equal(error.agents, null);
    assert.equal(error.data, undefined);
    assert.match(error.message, /ENOENT/);
    assert.equal(isUnknownFlowError(error), false, 'normalized coded error is no longer the raw C4 shape');
    return true;
  });
  await wire.connect(transport);
  await assert.rejects(wire.callTool({ name: 'stratum_flow_cancel', arguments: { runId: unknownId } }), error => {
    assert.equal(error.data, undefined);
    assert.equal(typeof error.code, 'number');
    assert.match(error.message, /ENOENT/);
    assert.equal(isUnknownFlowError(error), true);
    return true;
  });
});

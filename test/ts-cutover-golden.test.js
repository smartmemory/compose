/**
 * TS-cutover acceptance test (STRAT-PY-RETIRE — compose→TS producer port).
 *
 * Concretizes the migration goal: compose's build execution client
 * (StratumMcpClient) drives a full golden build lifecycle over the *TS* stratum
 * engine — plan → step → gate → approve → finish → audit — with the flow visible
 * in the TS engine's own store (isolated STRATUM_STATE_ROOT).
 *
 * RED until the producer is ported: today the client speaks the Python MCP
 * vocabulary ({spec, flow, inputs}, flow_id, outcome) and the TS server rejects
 * it (TS-native: {spec, input}, runId, decision, ready/running/completed). Making
 * this pass is the compose→TS execution cutover — porting the producer to the
 * TS-native interface, NOT a Python↔TS translation shim.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';

// The TS engine's MCP stdio bin. Spawned directly (bypasses .mcp.json), with an
// isolated state root so the test never touches real ~/.stratum state.
import { TS_MCP_BIN, TS_CLI_BIN } from './helpers/stratum-test-bin.js';

// Node ≥22 (the TS engine's runtime pin). Fall back to the current node.
function tsNode() {
  return process.env.COMPOSE_STRATUM_TS_NODE || process.execPath;
}

// A v1 golden spec (TS IR): work → review gate → finish. Client-executed
// dispatch model — the client supplies each step's output via stepDone; no real
// agent runs inside the engine.
const V1_GOLDEN = {
  version: 1,
  contracts: { Result: { value: 'string' } },
  flows: {
    entry: 'main',
    main: {
      input: { topic: 'string' },
      output: { from: '${finish.output}', contract: 'Result' },
      steps: [
        { id: 'work', do: 'draft ${input.topic}', out: 'Result' },
        { id: 'review', after: ['work'], gate: { on_approve: 'finish', on_revise: null, on_kill: null } },
        { id: 'finish', after: ['review'], do: 'publish', out: 'Result' },
      ],
    },
  },
};

describe('compose runs a golden build over the TS stratum engine', () => {
  test('plan → step → gate → approve → finish → audit completes on TS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compose-ts-cutover-'));
    const client = new StratumMcpClient();
    try {
      await client.connect({
        command: tsNode(),
        args: [TS_MCP_BIN],
        env: { ...process.env, STRATUM_STATE_ROOT: root },
      });

      // 1. Plan — TS-native: a ready dispatch for the first step.
      const planned = await client.plan(V1_GOLDEN, 'main', { topic: 'the cutover' });
      assert.equal(planned.status, 'ready', 'plan should return a ready dispatch');
      const flowId = planned.runId;
      assert.ok(flowId, 'plan should return a runId');
      const work = planned.ready.find((s) => s.id === 'work');
      assert.ok(
        work,
        'first ready step should be "work"',
      );

      // 2. Complete "work" → the review gate becomes pending (running).
      const afterWork = await client.stepDone(
        flowId, 'work', { output: { value: 'drafted' } }, work.dispatchToken,
      );
      assert.equal(afterWork.status, 'running', 'after work, the flow waits at the gate');

      // 3. Approve the gate → "finish" becomes ready.
      const gateToken = (await client.audit(flowId)).steps.review.gateToken;
      const afterGate = await client.gateResolve(
        flowId, 'review', 'approve', 'looks good', 'human', gateToken,
      );
      assert.equal(afterGate.status, 'ready', 'approving the gate readies the next step');
      const finish = afterGate.ready.find((s) => s.id === 'finish');
      assert.ok(finish, 'finish should be ready');

      // 4. Complete "finish" → the flow completes.
      const done = await client.stepDone(
        flowId, 'finish', { output: { value: 'published' } }, finish.dispatchToken,
      );
      assert.equal(done.status, 'completed', 'completing finish completes the flow');

      // 5. Audit reflects the terminal state.
      const audit = await client.audit(flowId);
      assert.equal(audit.status, 'completed', 'audit shows the completed flow');

      // 6. Coherence: the flow is visible in the TS engine's own store, so the
      //    monitor (which reads the same root) can see it.
      const listed = execFileSync(
        tsNode(),
        [
          TS_CLI_BIN,
          'query',
          'flows',
        ],
        { env: { ...process.env, STRATUM_STATE_ROOT: root }, encoding: 'utf8' },
      );
      const flows = JSON.parse(listed);
      assert.ok(
        flows.some((f) => f.flow_id === flowId || f.runId === flowId),
        'the completed flow is queryable from the TS store the monitor reads',
      );
    } finally {
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

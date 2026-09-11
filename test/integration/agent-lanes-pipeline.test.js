import { checkedConsumerAdapter } from '../helpers/routing-adapter-check.js';
/**
 * COMP-AGENT-LANES — end-to-end pipeline smoke (Phase 7 step 2).
 *
 * Golden flow across the three shipped layers, all real (no fabricated
 * events): runConsumerIssuance produces lane-stamped writes into a real
 * build-stream.jsonl → the real BuildStreamBridge tails the file and maps to
 * SSE shapes → the real lane reducer builds per-worker lanes. Asserts the
 * user-visible outcome: one lane per worker, output routed to its own lane,
 * explicit terminal statuses (a failed worker shows failed).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { BuildStreamBridge } from '../../server/build-stream-bridge.js';
import { applyLaneEvent, deriveParallelSummary, laneKey } from '../../src/components/agent-stream-lanes.js';

process.env.NODE_ENV = 'test';

const TASK_CLOSURE = {
  root: 'TaskResult',
  contracts: { TaskResult: { outcome: 'string', summary: 'string' } },
};

function stubProgress() {
  return { stepStart() {}, stepDone() {}, info() {}, debug() {}, warn() {}, toolUse() {}, toolSummary() {}, findings() {} };
}

function queryFor({ outcome, text, toolName }) {
  return function () {
    return (async function* () {
      yield { type: 'system', subtype: 'init', model: 'claude-test' };
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text },
            ...(toolName ? [{ type: 'tool_use', name: toolName, input: { file_path: '/x' } }] : []),
          ],
        },
      };
      yield {
        type: 'result', subtype: 'success',
        result: JSON.stringify({ outcome, summary: text }),
        total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 1,
      };
    })();
  };
}

async function driveItem({ itemIndex, query, streamWriter }) {
  const descriptor = {
    id: `execute_tasks/${itemIndex}`, step: 'execute_tasks', flow: 'build',
    itemIndex, stage: 0, generation: 1, attempt: 1, epoch: 1,
    dispatchToken: `tok-${itemIndex}`,
    agent: 'claude', do: `Run task ${itemIndex}`,
    item: { id: `t${itemIndex}` }, policy: { isolation: 'none' }, contract: TASK_CLOSURE,
  };
  const artifacts = {
    hooks: {},
    reconcileDescriptor: () => ({ action: 'execute', worktree: process.cwd() }),
    prepareIssuance: () => ({ diff: null }),
    reconcileAudit: () => {},
    restoreToPreStageWitness: () => {},
  };
  const stratum = {
    _localQuery: query,
    onEvent: () => () => {},
    stepDone: async () => ({ status: 'completed' }),
    audit: async () => ({}),
    agentRun: async () => ({ text: '' }),
    cancelAgentRun: async () => {},
  };
  const localSpec = {
    flows: { build: { steps: [{ id: 'execute_tasks', fanout: { steps: [{ agent: 'claude', do: 'x', out: 'TaskResult' }] } }] } },
  };
  await checkedConsumerAdapter({
    descriptor, flowId: 'flow-lanes', stratum, artifacts, localSpec,
    context: { cwd: process.cwd() },
    progress: stubProgress(), streamWriter,
  });
}

describe('COMP-AGENT-LANES pipeline: producer → bridge → reducer', () => {
  let tmpDir;
  let composeDir;
  let filePath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lanes-e2e-'));
    composeDir = join(tmpDir, '.compose');
    mkdirSync(composeDir, { recursive: true });
    filePath = join(composeDir, 'build-stream.jsonl');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('two parallel workers (one failing) yield two attributed lanes with explicit statuses', async () => {
    // Real bridge tails the real JSONL file; broadcasts feed the real reducer.
    const lanes = new Map();
    let seq = 0;
    const bridge = new BuildStreamBridge(composeDir, (msg) => applyLaneEvent(lanes, msg));
    bridge.start();
    await sleep(100);

    // The producer's streamWriter appends to the same JSONL the real
    // BuildStreamWriter writes (one JSON object per line, seq-tagged).
    const streamWriter = {
      write(event) {
        appendFileSync(filePath, `${JSON.stringify({ ...event, seq: seq++ })}\n`);
      },
    };

    await driveItem({
      itemIndex: 0,
      query: queryFor({ outcome: 'complete', text: 'worker zero output', toolName: 'Read' }),
      streamWriter,
    });
    await driveItem({
      itemIndex: 1,
      query: queryFor({ outcome: 'failed', text: 'worker one output' }),
      streamWriter,
    });

    await sleep(300); // let the bridge's debounced tail fire
    bridge.stop();

    // One lane per worker slot.
    assert.equal(lanes.size, 2, 'one lane per parallel worker');
    const lane0 = lanes.get('flow-lanes:execute_tasks/0:0');
    const lane1 = lanes.get('flow-lanes:execute_tasks/1:1');
    assert.ok(lane0 && lane1, 'lanes keyed flowId:stepId:itemIndex');

    // Labels are the human mandate.
    assert.equal(lane0.lane.label, 'Run task 0');
    assert.equal(lane1.lane.label, 'Run task 1');

    // Explicit terminal statuses — the failed worker shows failed.
    assert.equal(lane0.status, 'succeeded');
    assert.equal(lane1.status, 'failed');

    // Output routed to the owning lane only (worker A never in worker B).
    const textsOf = (lane) => lane.messages
      .flatMap((m) => m.message?.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text);
    assert.ok(textsOf(lane0).some((t) => t.includes('worker zero output')));
    assert.ok(!textsOf(lane0).some((t) => t.includes('worker one output')), 'no cross-lane leakage');
    assert.ok(textsOf(lane1).some((t) => t.includes('worker one output')));
    assert.ok(!textsOf(lane1).some((t) => t.includes('worker zero output')), 'no cross-lane leakage');

    // Tool use attributed to the lane that ran it.
    const tools0 = lane0.messages.flatMap((m) => m.message?.content ?? []).filter((b) => b.type === 'tool_use');
    assert.ok(tools0.some((b) => b.name === 'Read'), 'tool_use lands in the owning lane');

    // Derived legacy summary agrees.
    const summary = deriveParallelSummary(lanes);
    assert.equal(summary.total, 2);
    assert.equal(summary.completed, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.active, 0);
  });
});

/**
 * gsd-dispatch-instrumentation.test.js — COMP-GSD-7 S3 (TS re-expression).
 *
 * Spec source: the pre-deletion test/gsd-dispatch-instrumentation.test.js at
 * cc390a7, which drove the (now-removed) executeParallelDispatchServer poll loop.
 * The TS v1 GSD path fans out per ITEM through runConsumerIssuance, so this
 * re-expression drives that function directly and asserts the same sidecars:
 *   - GSD mode (context.gsd === true) persists per-task timing.json + per-task
 *     diffs/<id>.diff (the diff tapped read-only from the artifacts journal entry);
 *   - build mode (no context.gsd) writes NO .compose/gsd sidecars.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runConsumerIssuance } from '../lib/build.js';

process.env.NODE_ENV = 'test';

const FEATURE = 'COMP-INT-1';
const TASK_CLOSURE = {
  root: 'TaskResult',
  contracts: { TaskResult: { outcome: 'string', summary: 'string' } },
};

function stubProgress() {
  return { stepStart() {}, stepDone() {}, info() {}, debug() {}, warn() {}, toolUse() {}, toolSummary() {}, findings() {} };
}

// A local-query stub (NODE_ENV=test seam) yielding a success TaskResult.
function successQuery() {
  return function () {
    return (async function* () {
      yield { type: 'system', subtype: 'init', model: 'claude-test' };
      yield {
        type: 'result', subtype: 'success',
        result: JSON.stringify({ outcome: 'complete', summary: 'did the thing' }),
        total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 1,
      };
    })();
  };
}

function taskDescriptor(itemId, itemIndex, diffText) {
  return {
    descriptor: {
      id: `execute_tasks/${itemIndex}`, step: 'execute_tasks', flow: 'build',
      itemIndex, stage: 0, generation: 1, attempt: 1, epoch: 1,
      dispatchToken: `tok-${itemIndex}`,
      agent: 'claude', do: `Run task ${itemId}`,
      item: { id: itemId },
      policy: { isolation: 'none' },
      contract: TASK_CLOSURE,
    },
    // The artifacts journal entry carries the cumulative worktree diff at final
    // stage; the fake returns it so the instrumentation taps it read-only.
    diffText,
  };
}

async function driveItem(cwd, { descriptor, diffText }, context) {
  const artifacts = {
    hooks: {},
    reconcileDescriptor: () => ({ action: 'execute', worktree: cwd }),
    prepareIssuance: () => ({ diff: diffText }),
    reconcileAudit: () => {},
    restoreToPreStageWitness: () => {},
  };
  const stratum = {
    _localQuery: successQuery(),
    onEvent: () => () => {},
    stepDone: async () => ({ status: 'completed' }),
    audit: async () => ({}),
    agentRun: async () => ({ text: '' }),
    cancelAgentRun: async () => {},
  };
  const localSpec = {
    flows: { build: { steps: [{ id: 'execute_tasks', fanout: { steps: [{ agent: 'claude', do: 'x', out: 'TaskResult' }] } }] } },
  };
  await runConsumerIssuance({
    descriptor, flowId: 'flow-1', stratum, artifacts, localSpec,
    context: { cwd, ...context },
    progress: stubProgress(), streamWriter: { write() {} },
  });
}

describe('COMP-GSD-7 dispatch instrumentation (TS runConsumerIssuance)', () => {
  it('gsd path persists timing.json + per-task diff snapshots', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gsd-instr-gsd-'));
    try {
      const diffA = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1,2 @@\n A\n+A2\n';
      const diffB = 'diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1,2 @@\n B\n+B2\n';
      await driveItem(cwd, taskDescriptor('ta', 0, diffA), { featureCode: FEATURE, gsd: true, filesChanged: [] });
      await driveItem(cwd, taskDescriptor('tb', 1, diffB), { featureCode: FEATURE, gsd: true, filesChanged: [] });

      const timingPath = join(cwd, '.compose', 'gsd', FEATURE, 'timing.json');
      assert.ok(existsSync(timingPath), 'timing.json written');
      const timing = JSON.parse(readFileSync(timingPath, 'utf-8'));
      assert.ok(timing.ta && timing.ta.startedAt, 'ta has timing');
      assert.ok(timing.tb && timing.tb.startedAt, 'tb has timing');
      assert.equal(typeof timing.ta.durationMs, 'number', 'ta has a numeric durationMs');
      assert.ok(timing.ta.durationMs >= 0, 'duration is non-negative');

      const diffPathA = join(cwd, '.compose', 'gsd', FEATURE, 'diffs', 'ta.diff');
      const diffPathB = join(cwd, '.compose', 'gsd', FEATURE, 'diffs', 'tb.diff');
      assert.ok(existsSync(diffPathA) && existsSync(diffPathB), 'both diff snapshots written');
      assert.match(readFileSync(diffPathA, 'utf-8'), /a\.txt/);
      assert.match(readFileSync(diffPathB, 'utf-8'), /b\.txt/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('build mode (no context.gsd) writes NO timing/diff sidecars', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gsd-instr-build-'));
    try {
      const diffA = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1,2 @@\n A\n+A2\n';
      // build-mode context: no gsd marker.
      await driveItem(cwd, taskDescriptor('ta', 0, diffA), { filesChanged: [] });
      assert.ok(!existsSync(join(cwd, '.compose', 'gsd')), 'no .compose/gsd sidecars in build mode');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

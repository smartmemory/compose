# T2-F5-CONSUMER-MERGE-STATUS-COMPOSE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Compose's `executeParallelDispatchServer` to consume Stratum's new `defer_advance` sentinel, call `stratum_parallel_advance` with real merge_status, and fix the `buildStatus='complete'` regression on client-side conflict.

**Architecture:** 5 changes — new client method; split `applyServerDispatchDiffs` into pure core + throwing wrapper; branch on sentinel in `executeParallelDispatchServer`; narrow-check `output.merge_status` in build's complete branch; opt-in `capture_diff:true`+`defer_advance:true` on the execute step in build.stratum.yaml.

**Tech Stack:** Node.js 22 (`node --test`), ES modules.

**Design doc:** `compose/docs/features/T2-F5-CONSUMER-MERGE-STATUS-COMPOSE/design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `compose/lib/stratum-mcp-client.js` | Modify | Add `parallelAdvance(flowId, stepId, mergeStatus)` |
| `compose/lib/build.js` | Modify | Split `applyServerDispatchDiffs` into Core + wrapper; branch `executeParallelDispatchServer` on sentinel; fix buildStatus in complete-branch |
| `compose/pipelines/build.stratum.yaml` | Modify | Add `capture_diff: true` + `defer_advance: true` to `execute` step |
| `compose/test/stratum-mcp-client-parallel.test.js` | Modify | Test for `parallelAdvance` |
| `compose/test/parallel-dispatch-server-defer.test.js` | Create | Integration tests for defer path |
| `compose/test/build-status-merge-conflict.test.js` | Create | Unit test for buildStatus narrowing |
| `compose/README.md`, `compose/CHANGELOG.md`, `compose/ROADMAP.md`, `/Users/ruze/reg/my/forge/ROADMAP.md` | Modify | Docs + roadmap |

---

## Task 1: `parallelAdvance` client method (TDD)

**Files:** `compose/lib/stratum-mcp-client.js`, `compose/test/stratum-mcp-client-parallel.test.js`

- [ ] **Step 1: Add failing test**

Append to `compose/test/stratum-mcp-client-parallel.test.js`:

```js
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
```

Run: `cd /Users/ruze/reg/my/forge/compose && node --test test/stratum-mcp-client-parallel.test.js 2>&1 | tail -10` — expect failure.

- [ ] **Step 2: Implement**

In `lib/stratum-mcp-client.js`, beside `parallelPoll`, add:

```js
async parallelAdvance(flowId, stepId, mergeStatus) {
  return this.#callTool('stratum_parallel_advance', {
    flow_id: flowId,
    step_id: stepId,
    merge_status: mergeStatus,
  });
}
```

- [ ] **Step 3: Verify**

```bash
node --test test/stratum-mcp-client-parallel.test.js
node --test test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)" | tail -5
```

Expected: new test passes; full suite baseline + 1.

- [ ] **Step 4: Commit**

```bash
git add lib/stratum-mcp-client.js test/stratum-mcp-client-parallel.test.js
git commit -m "feat(t2-f5-consumer-merge-status-compose): add parallelAdvance MCP client method"
```

---

## Task 2: Split `applyServerDispatchDiffs` into Core + throwing wrapper

**Files:** `compose/lib/build.js`

- [ ] **Step 1: Record baseline**

```bash
cd /Users/ruze/reg/my/forge/compose
node --test test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)" | tail -3
```

Expected: baseline from Task 1 completion.

- [ ] **Step 2: Rename existing `applyServerDispatchDiffs` to `applyServerDispatchDiffsCore` and neuter the throw**

Locate the existing `applyServerDispatchDiffs` (around `lib/build.js:2369-2434`). Rename it and remove the throw; return a result object instead.

```bash
grep -n "function applyServerDispatchDiffs" /Users/ruze/reg/my/forge/compose/lib/build.js
```

New shape:

```js
/**
 * Apply per-task diffs from a poll envelope to baseCwd. Pure — returns the
 * merge result without throwing on conflict. Callers decide what to do on
 * conflict:
 *  - Legacy (non-deferred) path uses the throwing wrapper applyServerDispatchDiffs.
 *  - Deferred path calls this directly and reports mergeStatus back via parallelAdvance.
 */
function applyServerDispatchDiffsCore(taskList, pollTasks, baseCwd, streamWriter, stepId, context) {
  const diffMap = new Map();
  for (const [taskId, ts] of Object.entries(pollTasks ?? {})) {
    if (ts?.state !== 'complete') continue;
    if (ts?.diff_error) {
      if (streamWriter) {
        streamWriter.write({
          type: 'build_error', stepId,
          message: `Task ${taskId} completed but diff capture failed: ${ts.diff_error}. Its changes were NOT applied.`,
        });
      }
      continue;
    }
    if (ts?.diff != null) diffMap.set(taskId, ts.diff);
  }

  if (diffMap.size === 0) {
    return { mergeStatus: 'clean', conflictedTaskId: null, conflictError: null, appliedFiles: [] };
  }

  const patchDir = mkdtempSync(join(tmpdir(), 'compose-server-patch-'));
  try {
    const { mergeStatus, conflictedTaskId, conflictError, appliedFiles } =
      applyTaskDiffsToBaseCwd(taskList, diffMap, baseCwd, streamWriter, stepId, patchDir);

    if (mergeStatus !== 'conflict' && appliedFiles.length > 0 && context) {
      const set = new Set(context.filesChanged ?? []);
      for (const f of appliedFiles) set.add(f);
      context.filesChanged = [...set];
    }

    return { mergeStatus, conflictedTaskId, conflictError, appliedFiles };
  } finally {
    try { rmSync(patchDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/**
 * Legacy throwing wrapper — preserves the existing throw-on-conflict semantics
 * for specs that haven't opted into defer_advance. Flow advances server-side
 * with hardcoded merge_status='clean'; on client conflict we halt the CLI.
 * Deferred specs route around this via applyServerDispatchDiffsCore.
 */
function applyServerDispatchDiffs(taskList, pollTasks, baseCwd, streamWriter, stepId, context) {
  const result = applyServerDispatchDiffsCore(taskList, pollTasks, baseCwd, streamWriter, stepId, context);
  if (result.mergeStatus === 'conflict') {
    if (streamWriter) {
      streamWriter.write({
        type: 'build_error', stepId,
        message:
          `CLIENT-SIDE MERGE CONFLICT applying diff for task ${result.conflictedTaskId}: ${result.conflictError}. ` +
          `Flow has already advanced server-side (merge_status reported as "clean" — spec missing defer_advance: true). ` +
          `Working tree may contain partial merge state — resolve manually before resuming.`,
      });
    }
    throw new Error(
      `parallel_dispatch[${stepId}]: client-side merge conflict on task ${result.conflictedTaskId}`,
    );
  }
}
```

The existing callers of `applyServerDispatchDiffs` (there's only the one in `executeParallelDispatchServer`) stay on the throwing wrapper for now. Task 3 updates that caller.

- [ ] **Step 3: Run full suite — expect no regressions**

```bash
node --test test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)" | tail -3
```

The existing tests for the throw-on-conflict path should still pass because the wrapper preserves behavior byte-for-byte. If anything breaks, the split diverged — fix before continuing.

- [ ] **Step 4: Commit**

```bash
git add lib/build.js
git commit -m "refactor(build): split applyServerDispatchDiffs into Core + throwing wrapper"
```

---

## Task 3: Branch `executeParallelDispatchServer` on sentinel

**Files:** `compose/lib/build.js`

- [ ] **Step 1: Locate the current worktree block in `executeParallelDispatchServer`**

```bash
grep -n "applyServerDispatchDiffs\|awaiting_consumer_advance\|isolation === 'worktree'" /Users/ruze/reg/my/forge/compose/lib/build.js | head -10
```

- [ ] **Step 2: Replace the worktree block**

Find the existing block (around lines 2235-2261 from T2-F5-COMPOSE-MIGRATE-WORKTREE). It currently looks like:

```js
const isolation = dispatchResponse.isolation ?? 'worktree';
if (isolation === 'worktree' && dispatchResponse.capture_diff === true) {
  try {
    applyServerDispatchDiffs(
      dispatchResponse.tasks ?? [],
      pollResult.tasks,
      baseCwd,
      streamWriter,
      stepId,
      context,
    );
  } catch (err) {
    if (streamWriter) {
      streamWriter.write({
        type: 'build_step_done', stepId,
        parallel: true,
        summary: { ...pollResult.summary, merge_status: 'conflict' },
        flowId,
      });
    }
    throw err;
  }
}
```

Replace with:

```js
// Defensive: spec declared defer_advance:true but misses the companions
// (isolation:worktree + capture_diff:true). Unblock the flow with 'clean'.
const isolation = dispatchResponse.isolation ?? 'worktree';
const hasServerMerge = isolation === 'worktree' && dispatchResponse.capture_diff === true;

if (pollResult.outcome?.status === 'awaiting_consumer_advance' && !hasServerMerge) {
  if (streamWriter) {
    streamWriter.write({
      type: 'build_error', stepId,
      message:
        `Spec declared defer_advance:true without (isolation:worktree + capture_diff:true); ` +
        `no diffs to merge. Calling parallelAdvance with merge_status='clean' to unblock the flow.`,
    });
  }
  const advanceResult = await stratum.parallelAdvance(flowId, stepId, 'clean');
  if (advanceResult?.error) {
    throw new Error(
      `stratum_parallel_advance failed: ${advanceResult.error}: ${advanceResult.message || ''}`,
    );
  }
  pollResult.outcome = advanceResult;
}

if (hasServerMerge) {
  if (pollResult.outcome?.status === 'awaiting_consumer_advance') {
    // DEFER PATH: merge locally, report merge_status, let flow advance with truth.
    const { mergeStatus, conflictedTaskId, conflictError } = applyServerDispatchDiffsCore(
      dispatchResponse.tasks ?? [],
      pollResult.tasks,
      baseCwd,
      streamWriter,
      stepId,
      context,
    );

    if (mergeStatus === 'conflict' && streamWriter) {
      streamWriter.write({
        type: 'build_error', stepId,
        message:
          `Client-side merge conflict on task ${conflictedTaskId}: ${conflictError}. ` +
          `Reporting merge_status='conflict' to Stratum; flow will route through its failure handler.`,
      });
    }

    const advanceResult = await stratum.parallelAdvance(flowId, stepId, mergeStatus);
    if (advanceResult?.error) {
      throw new Error(
        `stratum_parallel_advance failed: ${advanceResult.error}: ${advanceResult.message || ''}`,
      );
    }
    pollResult.outcome = advanceResult;
  } else {
    // LEGACY PATH: non-deferred spec. Use throwing wrapper for backward compat.
    try {
      applyServerDispatchDiffs(
        dispatchResponse.tasks ?? [],
        pollResult.tasks,
        baseCwd,
        streamWriter,
        stepId,
        context,
      );
    } catch (err) {
      if (streamWriter) {
        streamWriter.write({
          type: 'build_step_done', stepId,
          parallel: true,
          summary: { ...pollResult.summary, merge_status: 'conflict' },
          flowId,
        });
      }
      throw err;
    }
  }
}
```

- [ ] **Step 3: Run full suite — expect no regressions**

```bash
node --test test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)" | tail -3
```

Existing T2-F5-COMPOSE-MIGRATE-WORKTREE tests use poll envelopes whose `outcome.status` is a real dispatch (e.g., `execute_step`, `ensure_failed`), not the sentinel, so they exercise the `else` (LEGACY PATH) branch — byte-identical to before.

- [ ] **Step 4: Commit**

```bash
git add lib/build.js
git commit -m "feat(t2-f5-consumer-merge-status-compose): branch executeParallelDispatchServer on defer sentinel"
```

---

## Task 4: Integration tests for the defer path

**Files:** `compose/test/parallel-dispatch-server-defer.test.js` (new)

- [ ] **Step 1: Write the test file**

Create `compose/test/parallel-dispatch-server-defer.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { executeParallelDispatchServer } from '../lib/build.js';

function initRepo(name, seedFiles = {}) {
  const repo = mkdtempSync(join(tmpdir(), `compose-defer-test-${name}-`));
  execSync('git init -q -b main', { cwd: repo });
  execSync('git config user.email "test@example.com"', { cwd: repo });
  execSync('git config user.name "Test"', { cwd: repo });
  for (const [path, content] of Object.entries(seedFiles)) {
    writeFileSync(join(repo, path), content);
    execSync(`git add ${path}`, { cwd: repo });
  }
  execSync('git commit -q -m init', { cwd: repo });
  return repo;
}

function unifiedDiff(repo, editFn) {
  editFn(repo);
  execSync('git add -A', { cwd: repo });
  const diff = execSync('git diff --cached HEAD', { cwd: repo, encoding: 'utf-8' });
  execSync('git reset --hard HEAD', { cwd: repo });
  return diff;
}

function makeStubStratum({ startResult, pollResults, advanceResult }) {
  let pollIdx = 0;
  const advanceCalls = [];
  return {
    advanceCalls,
    stratum: {
      parallelStart: async () => startResult,
      parallelPoll: async () => {
        const r = pollResults[pollIdx];
        pollIdx = Math.min(pollIdx + 1, pollResults.length - 1);
        return r;
      },
      parallelAdvance: async (flowId, stepId, mergeStatus) => {
        advanceCalls.push({ flowId, stepId, mergeStatus });
        return advanceResult;
      },
    },
  };
}

function sw() {
  const events = [];
  return { events, write: (e) => events.push(e) };
}

describe('executeParallelDispatchServer — defer-advance happy path', () => {
  it('calls parallelAdvance with clean when all diffs apply, returns advance result as response', async () => {
    const repo = initRepo('defer-happy', { 'a.txt': 'A\n' });
    const diffA = unifiedDiff(repo, () => writeFileSync(join(repo, 'a.txt'), 'A\nA2\n'));

    const dispatch = {
      flow_id: 'f1', step_id: 's1', step_number: 1, total_steps: 1,
      tasks: [{ id: 'ta' }],
      isolation: 'worktree', capture_diff: true,
    };
    const sentinelPoll = {
      flow_id: 'f1', step_id: 's1',
      summary: { pending: 0, running: 0, complete: 1, failed: 0, cancelled: 0 },
      tasks: { ta: { task_id: 'ta', state: 'complete', diff: diffA } },
      require_satisfied: true, can_advance: false,
      outcome: { status: 'awaiting_consumer_advance', aggregate: { merge_status: 'clean' } },
    };
    const advanceResult = { status: 'execute_step', step_id: 'next' };

    const { stratum, advanceCalls } = makeStubStratum({
      startResult: { status: 'started' },
      pollResults: [sentinelPoll],
      advanceResult,
    });

    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
    try {
      const resp = await executeParallelDispatchServer(
        dispatch, stratum, { filesChanged: [] }, null, sw(), repo,
      );
      assert.equal(advanceCalls.length, 1);
      assert.equal(advanceCalls[0].mergeStatus, 'clean');
      assert.equal(resp.status, 'execute_step');
      assert.equal(resp.step_id, 'next');
      assert.equal(readFileSync(join(repo, 'a.txt'), 'utf-8'), 'A\nA2\n');
    } finally {
      delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('executeParallelDispatchServer — defer-advance conflict path', () => {
  it('reports merge_status=conflict, does NOT throw, returns terminal failure envelope', async () => {
    const repo = initRepo('defer-conflict', { 'shared.txt': 'line1\nline2\n' });
    const diffX = unifiedDiff(repo, () => writeFileSync(join(repo, 'shared.txt'), 'X1\nline2\n'));
    const diffY = unifiedDiff(repo, () => writeFileSync(join(repo, 'shared.txt'), 'Y1\nline2\n'));

    const dispatch = {
      flow_id: 'f1', step_id: 's1', step_number: 1, total_steps: 1,
      tasks: [{ id: 'tx' }, { id: 'ty' }],
      isolation: 'worktree', capture_diff: true,
    };
    const sentinelPoll = {
      flow_id: 'f1', step_id: 's1',
      summary: { pending: 0, running: 0, complete: 2, failed: 0, cancelled: 0 },
      tasks: {
        tx: { task_id: 'tx', state: 'complete', diff: diffX },
        ty: { task_id: 'ty', state: 'complete', diff: diffY },
      },
      require_satisfied: true, can_advance: false,
      outcome: { status: 'awaiting_consumer_advance', aggregate: { merge_status: 'clean' } },
    };
    // Stratum's response to advance(..., 'conflict'): terminal failure envelope
    const advanceResult = {
      status: 'complete',
      output: { outcome: 'failed', merge_status: 'conflict', failed: [{ task_id: 'ty' }] },
    };

    const { stratum, advanceCalls } = makeStubStratum({
      startResult: { status: 'started' },
      pollResults: [sentinelPoll],
      advanceResult,
    });

    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
    const streamWriter = sw();
    try {
      // MUST NOT throw
      const resp = await executeParallelDispatchServer(
        dispatch, stratum, { filesChanged: [] }, null, streamWriter, repo,
      );
      assert.equal(advanceCalls.length, 1);
      assert.equal(advanceCalls[0].mergeStatus, 'conflict');
      // Returns the terminal failure envelope directly
      assert.equal(resp.status, 'complete');
      assert.equal(resp.output?.outcome, 'failed');
      assert.equal(resp.output?.merge_status, 'conflict');
      // Conflict was surfaced as a build_error
      assert.ok(streamWriter.events.some(
        e => e.type === 'build_error' && /Client-side merge conflict/.test(e.message),
      ));
    } finally {
      delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('executeParallelDispatchServer — defer-advance with spec mispairing', () => {
  it('calls parallelAdvance(clean) defensively when sentinel arrives but capture_diff is false', async () => {
    const repo = initRepo('defer-mispair');

    const dispatch = {
      flow_id: 'f1', step_id: 's1', step_number: 1, total_steps: 1,
      tasks: [{ id: 'ta' }],
      // Missing capture_diff: true, but spec declared defer_advance: true
      isolation: 'worktree',
    };
    const sentinelPoll = {
      flow_id: 'f1', step_id: 's1',
      summary: { pending: 0, running: 0, complete: 1, failed: 0, cancelled: 0 },
      tasks: { ta: { task_id: 'ta', state: 'complete' } },
      require_satisfied: true, can_advance: false,
      outcome: { status: 'awaiting_consumer_advance', aggregate: {} },
    };
    const advanceResult = { status: 'execute_step', step_id: 'next' };

    const { stratum, advanceCalls } = makeStubStratum({
      startResult: { status: 'started' },
      pollResults: [sentinelPoll],
      advanceResult,
    });

    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
    const streamWriter = sw();
    try {
      const resp = await executeParallelDispatchServer(
        dispatch, stratum, { filesChanged: [] }, null, streamWriter, repo,
      );
      assert.equal(advanceCalls.length, 1);
      assert.equal(advanceCalls[0].mergeStatus, 'clean');
      assert.equal(resp.status, 'execute_step');
      assert.ok(streamWriter.events.some(
        e => e.type === 'build_error' && /without \(isolation:worktree \+ capture_diff/.test(e.message),
      ));
    } finally {
      delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('executeParallelDispatchServer — advance error propagates', () => {
  it('throws if parallelAdvance returns error envelope', async () => {
    const repo = initRepo('advance-err', { 'a.txt': 'A\n' });
    const diffA = unifiedDiff(repo, () => writeFileSync(join(repo, 'a.txt'), 'A\nA2\n'));

    const dispatch = {
      flow_id: 'f1', step_id: 's1', step_number: 1, total_steps: 1,
      tasks: [{ id: 'ta' }],
      isolation: 'worktree', capture_diff: true,
    };
    const sentinelPoll = {
      flow_id: 'f1', step_id: 's1',
      summary: { pending: 0, running: 0, complete: 1, failed: 0, cancelled: 0 },
      tasks: { ta: { task_id: 'ta', state: 'complete', diff: diffA } },
      require_satisfied: true, can_advance: false,
      outcome: { status: 'awaiting_consumer_advance', aggregate: {} },
    };
    const advanceResult = { error: 'spec_integrity_violation', message: 'tampered' };

    const { stratum } = makeStubStratum({
      startResult: { status: 'started' },
      pollResults: [sentinelPoll],
      advanceResult,
    });

    process.env.COMPOSE_SERVER_DISPATCH_POLL_MS = '5';
    try {
      await assert.rejects(
        executeParallelDispatchServer(
          dispatch, stratum, { filesChanged: [] }, null, sw(), repo,
        ),
        /stratum_parallel_advance failed: spec_integrity_violation/,
      );
    } finally {
      delete process.env.COMPOSE_SERVER_DISPATCH_POLL_MS;
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
```

Run: `node --test test/parallel-dispatch-server-defer.test.js 2>&1 | tail -15` — expect 4 pass.

- [ ] **Step 2: Full suite**

```bash
node --test test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)" | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add test/parallel-dispatch-server-defer.test.js
git commit -m "test(t2-f5-consumer-merge-status-compose): integration tests for defer-advance path"
```

---

## Task 5: Fix buildStatus on merge_status=conflict

**Files:** `compose/lib/build.js`, `compose/test/build-status-merge-conflict.test.js` (new)

- [ ] **Step 1: Write failing test**

The buildStatus logic is inside `runBuild`. Test it by calling `runBuild` with a stubbed stratum — but that's heavy. Simpler: factor the "determine buildStatus from response" logic into an exported helper, test the helper directly, use it in the main loop.

Create `compose/test/build-status-merge-conflict.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBuildStatusForCompleteResponse } from '../lib/build.js';

describe('resolveBuildStatusForCompleteResponse', () => {
  it('returns complete for a plain complete response', () => {
    assert.equal(resolveBuildStatusForCompleteResponse({ status: 'complete' }), 'complete');
  });

  it('returns complete when output exists but has no merge_status', () => {
    assert.equal(
      resolveBuildStatusForCompleteResponse({ status: 'complete', output: { tasks: [] } }),
      'complete',
    );
  });

  it('returns failed when output.merge_status is "conflict"', () => {
    assert.equal(
      resolveBuildStatusForCompleteResponse({
        status: 'complete',
        output: { outcome: 'failed', merge_status: 'conflict' },
      }),
      'failed',
    );
  });

  it('returns complete when output.outcome is "failed" but merge_status is not conflict (narrow check)', () => {
    // Defensive: unrelated failure signals should not flip buildStatus here.
    // That's handled by other terminal branches elsewhere in the dispatch loop.
    assert.equal(
      resolveBuildStatusForCompleteResponse({
        status: 'complete',
        output: { outcome: 'failed' },
      }),
      'complete',
    );
  });
});
```

Run: expect failures.

- [ ] **Step 2: Add the exported helper**

In `compose/lib/build.js`, add an export alongside other exports (e.g., next to `shouldUseServerDispatch`):

```js
/**
 * Determine the final buildStatus for a terminal 'complete' response.
 * Returns 'failed' specifically when the response carries a client-side
 * merge_status='conflict' signal from the deferred-advance path, otherwise
 * 'complete'. Other failure modes are handled by their own terminal branches
 * in the dispatch loop.
 */
export function resolveBuildStatusForCompleteResponse(response) {
  if (response?.output?.merge_status === 'conflict') return 'failed';
  return 'complete';
}
```

- [ ] **Step 3: Use it in the main loop**

Find the `response.status === 'complete'` branch (around `build.js:1357-1370`):

```bash
grep -n "buildStatus = 'complete'\|response.status === 'complete'" /Users/ruze/reg/my/forge/compose/lib/build.js | head -5
```

Where `buildStatus = 'complete'` is currently assigned unconditionally inside the complete-branch, replace with:

```js
buildStatus = resolveBuildStatusForCompleteResponse(response);
```

Preserve all other side effects in that branch (stream writes, state persist, etc.) — only that one assignment changes.

- [ ] **Step 4: Run tests**

```bash
node --test test/build-status-merge-conflict.test.js 2>&1 | tail -10
node --test test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)" | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add lib/build.js test/build-status-merge-conflict.test.js
git commit -m "fix(t2-f5-consumer-merge-status-compose): set buildStatus=failed on merge_status=conflict"
```

---

## Task 6: Opt in the execute step

**Files:** `compose/pipelines/build.stratum.yaml`

- [ ] **Step 1: Locate the step**

```bash
grep -n "id: execute\|type: parallel_dispatch" /Users/ruze/reg/my/forge/compose/pipelines/build.stratum.yaml | head -10
```

Around line 352. Read the full step definition.

- [ ] **Step 2: Add both flags**

In the `execute` step block (around lines 352-369), add two lines right after `isolation: worktree`:

```yaml
  isolation: worktree
  capture_diff: true
  defer_advance: true
```

Preserve ordering and comments.

- [ ] **Step 3: Validate the spec**

```bash
cd /Users/ruze/reg/my/forge/compose
# There's likely a spec validation test or command; if not, running the
# full suite will catch syntax errors since many tests load the spec.
node --test test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)" | tail -3
```

- [ ] **Step 4: Commit**

```bash
git add pipelines/build.stratum.yaml
git commit -m "chore(pipelines): opt execute step into capture_diff + defer_advance"
```

---

## Task 7: Docs

**Files:** `compose/README.md`, `compose/CHANGELOG.md`, `compose/ROADMAP.md`, `/Users/ruze/reg/my/forge/ROADMAP.md`

- [ ] **Step 1: README env var update**

Find the `COMPOSE_SERVER_DISPATCH` row in README. Update description to note the new semantics under defer_advance:

```
Set to `1` to route `parallel_dispatch` steps through Stratum's server-side executor. Covers `isolation: "none"` unconditionally, and `isolation: "worktree"` steps that declare `capture_diff: true` (Compose consumes diffs from poll response and merges them client-side). When the step also declares `defer_advance: true`, Compose reports merge_status back via `stratum_parallel_advance` — client-side merge conflicts surface as `{status: 'complete', output: {outcome: 'failed', merge_status: 'conflict'}}` and Compose sets `buildStatus='failed'` accordingly.
```

- [ ] **Step 2: CHANGELOG entry**

Prepend under `[Unreleased]`:

```
- T2-F5-CONSUMER-MERGE-STATUS-COMPOSE: Compose now routes `isolation: "worktree"` + `capture_diff: true` + `defer_advance: true` through Stratum's new consumer-driven advance. When `stratum_parallel_poll` returns the `awaiting_consumer_advance` sentinel, Compose applies diffs via the extracted `applyServerDispatchDiffsCore`, calls new `parallelAdvance(flow_id, step_id, merge_status)` client method, and replaces the sentinel with the real advance result. On client-side merge conflict: Stratum advances with `merge_status='conflict'`, returning a terminal failure envelope; Compose detects this via `output.merge_status` and sets `buildStatus='failed'` (fixing the regression from T2-F5-COMPOSE-MIGRATE-WORKTREE W1 where conflicts halted the CLI but closed the stream with `buildStatus='complete'`). Legacy throwing wrapper retained for non-deferred specs (backward-compat for specs without `defer_advance: true`). `build.stratum.yaml`'s `execute` step opts in. N new tests (1 client + 4 integration + 4 buildStatus unit), M total.
```

- [ ] **Step 3: compose/ROADMAP update**

Under the T2-F5-COMPOSE-MIGRATE section, add a row for this feature:

```
| 91 | T2-F5-CONSUMER-MERGE-STATUS-COMPOSE | **Consumer-driven merge status:** Branches on `outcome.status === 'awaiting_consumer_advance'` from poll, reports real merge_status via new `parallelAdvance` client method. Fixes `buildStatus='complete'` regression on conflict. Execute step in build.stratum.yaml opts in. | COMPLETE |
```

- [ ] **Step 4: outer Forge ROADMAP**

Mark the existing planned entry complete:

```
| ~~T2-F5-CONSUMER-MERGE-STATUS-COMPOSE~~ | **COMPLETE** — Final T2-F5 feature. Compose routes `isolation:worktree + capture_diff:true + defer_advance:true` through Stratum's consumer-driven advance: applies diffs locally, calls new `stratum_parallel_advance` with real merge_status, flow advances with truth. Client-side merge conflicts now produce `{status:'complete', output:{outcome:'failed', merge_status:'conflict'}}`; Compose's `resolveBuildStatusForCompleteResponse` helper detects this and sets `buildStatus='failed'`, closing the regression from T2-F5-COMPOSE-MIGRATE-WORKTREE W1. Legacy throwing path retained for non-deferred specs. build.stratum.yaml execute step opts in. Full T2-F5 arc now closed end-to-end. | M | COMPLETE |
```

- [ ] **Step 5: Commit**

```bash
cd /Users/ruze/reg/my/forge/compose
git add README.md CHANGELOG.md ROADMAP.md
git commit -m "docs(t2-f5-consumer-merge-status-compose): env var + changelog + roadmap"
```

Outer Forge ROADMAP is outside any git repo — no commit.

---

## Task 8: Final integration review

- [ ] **Step 1: Full suite**

```bash
cd /Users/ruze/reg/my/forge/compose
node --test test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)" | tail -3
```

- [ ] **Step 2: Dispatch Claude-based integration review**

Use `superpowers:code-reviewer` with the cumulative diff from the design commit. Focus on:
- Does the sentinel detection in `executeParallelDispatchServer` correctly distinguish the defer path from the legacy path?
- Does the `parallelAdvance` call site handle error envelopes consistently with `parallelStart`/`parallelPoll`?
- Does the `resolveBuildStatusForCompleteResponse` helper integrate cleanly with the dispatch loop's existing complete branch without dropping side effects?
- Are the defensive "mispairing" branch and build_error message actionable enough for a user to fix their spec?
- Full T2-F5 arc integration: does a Compose build that runs parallel_review (isolation:none) then execute (isolation:worktree + both flags) behave correctly end-to-end?

Address any blockers; ship WARNs as follow-ups.

---

## Self-Review Checklist

- [x] Design §1 parallelAdvance client method → Task 1
- [x] Design §2 split applyServerDispatchDiffs → Task 2
- [x] Design §3 sentinel branch + defensive mispairing → Task 3
- [x] Design §4 buildStatus fix → Task 5 (with helper extraction for testability)
- [x] Design §5 build.stratum.yaml opt-in → Task 6
- [x] Design §7 test coverage (client + integration + buildStatus unit) → Tasks 1, 4, 5

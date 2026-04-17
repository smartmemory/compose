# T2-F5-CONSUMER-MERGE-STATUS-COMPOSE: Compose routes worktree path through defer-advance

**Status:** DRAFT
**Date:** 2026-04-18
**Scope:** Compose-side. Final feature in the T2-F5 arc — closes the merge-status gap and fixes the `buildStatus='complete'` regression from T2-F5-COMPOSE-MIGRATE-WORKTREE.
**Depends on:** T2-F5-DEFER-ADVANCE (shipped on `stratum/main` — `defer_advance` IR field + `stratum_parallel_advance` tool).

## Related Documents

- T2-F5-COMPOSE-MIGRATE-WORKTREE (shipped) — current throw-on-conflict + `buildStatus='complete'` regression (W1)
- T2-F5-DEFER-ADVANCE (shipped stratum-side)
- `compose/lib/build.js:2241-2434` — `executeParallelDispatchServer` + `applyServerDispatchDiffs`
- `compose/lib/build.js:1334-1341` — main-loop parallel_dispatch branch
- `compose/lib/build.js:1357-1392` — main-loop exit + buildStatus terminal branches
- `compose/lib/build.js:1533` — `streamWriter.close(buildStatus, ...)`
- `compose/lib/stratum-mcp-client.js:324-344` — existing `parallelStart` / `parallelPoll`
- `compose/pipelines/build.stratum.yaml:352-369` — current `execute` step definition

## Problem

Three connected issues, all from T2-F5-COMPOSE-MIGRATE-WORKTREE:

1. **Client-side merge conflicts throw to halt the CLI.** The throw propagates out of `applyServerDispatchDiffs` (build.js:2431) with no `catch` before the main loop's `finally`. This halts execution but loses the ability for the flow to report the failure through its normal channels.

2. **`buildStatus` stays `'complete'` on conflict.** The throw bypasses the terminal branches at build.js:1357-1392 that set `buildStatus='failed'`. The stream-writer closes at build.js:1533 with the stale default. Downstream consumers (status dashboards, exit code) see a successful build.

3. **Server-side flow state shows `merge_status: "clean"` after a client-side conflict.** Stratum auto-advanced before Compose could report the real status. Manual resume after resolution gets the flow into the wrong next-step dispatch.

T2-F5-DEFER-ADVANCE (shipped stratum-side) provides the fix: when a step declares `defer_advance: true`, `stratum_parallel_poll` returns a sentinel `{status: "awaiting_consumer_advance", aggregate}` instead of auto-advancing; Compose calls `stratum_parallel_advance(flow_id, step_id, merge_status)` after its client-side merge. Stratum then advances with the real merge_status, producing `{status: "complete", output: {outcome: "failed", merge_status: "conflict"}}` on conflict — a terminal envelope Compose can inspect.

## Design

### 1. Client method: `parallelAdvance`

Add to `compose/lib/stratum-mcp-client.js` alongside the existing `parallelStart` / `parallelPoll`:

```js
async parallelAdvance(flowId, stepId, mergeStatus) {
  return this.#callTool('stratum_parallel_advance', {
    flow_id: flowId,
    step_id: stepId,
    merge_status: mergeStatus,
  });
}
```

Matches the existing snake_case translation pattern.

### 2. Split `applyServerDispatchDiffs` into core + throwing wrapper

`applyServerDispatchDiffs` currently (build.js:2369-2434) does everything and throws on conflict. Split:

```js
// Pure — returns merge status, never throws (filters diff_error, runs topo-merge).
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

// Thin wrapper preserving the existing throw-on-conflict semantics for non-deferred specs.
// Callers on the legacy path continue to get a throw (and halted build) on conflict.
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

The throwing wrapper is unchanged external contract — any spec that hasn't opted into `defer_advance: true` keeps the old behavior. The message now explicitly points at the missing flag, which is actionable.

### 3. `executeParallelDispatchServer` branches on the sentinel

Current code (build.js:2235-2246):

```js
const isolation = dispatchResponse.isolation ?? 'worktree';
if (isolation === 'worktree' && dispatchResponse.capture_diff === true) {
  try {
    applyServerDispatchDiffs(...);
  } catch (err) {
    // emit build_step_done with merge_status: 'conflict', then re-throw
    ...
  }
}
```

Replace with branching on `pollResult.outcome.status`:

```js
// Defensive: if the spec declared defer_advance:true but misses the companions
// (isolation:worktree + capture_diff:true), the poll still returns the sentinel
// but we have nothing to merge. Call advance with "clean" to unblock the flow
// before the worktree-merge block below. Ideally Stratum rejects this pairing
// at plan time; this branch is fallback to prevent flow-wedging.
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
    // DEFER PATH: do the merge, report merge_status back, let the flow advance with truth.
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

    // Replace the sentinel with the real advance result. The function ends with
    // `return pollResult.outcome` (build.js:2270), so mutating pollResult.outcome
    // here is what the main build loop receives as its next `response`.
    const advanceResult = await stratum.parallelAdvance(flowId, stepId, mergeStatus);
    if (advanceResult?.error) {
      throw new Error(
        `stratum_parallel_advance failed: ${advanceResult.error}: ${advanceResult.message || ''}`,
      );
    }
    pollResult.outcome = advanceResult;
  } else {
    // LEGACY PATH: spec didn't opt into defer_advance. Use throwing wrapper for backward compat.
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

The returned `pollResult.outcome` is now whatever `_advance_after_parallel` produced server-side — either the real next-step dispatch (merge clean) or a terminal failure envelope with `output.outcome: "failed"` and `output.merge_status: "conflict"` (conflict). The main build loop at build.js:1334 consumes it the same way it consumes any other response.

### 4. Fix the `buildStatus` regression

In the main loop's terminal "complete" branch (around build.js:1361 where `buildStatus = 'complete'` is assigned), narrow the check to detect a deferred-advance merge-conflict terminal:

```js
} else if (response.status === 'complete') {
  // ... preserve ALL existing completion handling (stream writes, state persist,
  // summary emission, etc.) — only the buildStatus assignment changes ...

  // Inspect the terminal output for a merge_status='conflict' signal from a
  // deferred-advance parallel_dispatch step. Stratum advances with a `{status:
  // 'complete', output: {outcome: 'failed', merge_status: 'conflict'}}` envelope
  // when the consumer reports a client-side conflict. Set buildStatus='failed'
  // so stream close + CI exit code reflect reality.
  //
  // Narrow the check to `output.merge_status === 'conflict'` specifically,
  // rather than `output.outcome === 'failed'` alone, to avoid flipping
  // buildStatus on any unrelated flow that happens to emit `outcome:'failed'`
  // in its output for benign reasons.
  const mergeConflict = response?.output?.merge_status === 'conflict';
  buildStatus = mergeConflict ? 'failed' : 'complete';
}
```

**Terminology note:** two separate fields are both called "outcome" in this context — the top-level `response.outcome` (the poll envelope wrapper, now carrying the advance result) and the nested `response.output.outcome` (the aggregate-level success/failure signal from `_evaluate_parallel_results`). This section reads the nested one; Section 3 mutates the wrapper one.

The fix targets the specific conflict-propagation path; other Stratum mechanisms that might surface failure via `output.outcome` are out of scope here and can be added later when needed.

### 5. Opt in the execute step

Edit `compose/pipelines/build.stratum.yaml:352-369`. Add both flags to the `execute` step:

```yaml
- id: execute
  type: parallel_dispatch
  source: "$.steps.decompose.output.tasks"
  agent: claude
  max_concurrent: 3
  isolation: worktree
  capture_diff: true      # ← added
  defer_advance: true     # ← added
  require: all
  merge: sequential_apply
  intent_template: >
    Implement this task using TDD. Write the test first, watch it fail,
    implement, watch it pass.
    ...
  depends_on: [decompose]
```

Under `COMPOSE_SERVER_DISPATCH=1`:
- Stratum captures each task's diff (capture_diff: true) into `ts.diff`
- Stratum does not auto-advance (defer_advance: true); poll returns sentinel
- Compose applies diffs, reports merge_status, flow advances with truth

Under `COMPOSE_SERVER_DISPATCH` unset (default):
- Compose uses consumer-dispatch; capture_diff and defer_advance are inert (never read by Stratum since the server path isn't exercised)

Both flags are additive and safe by construction.

### 6. Interaction with T2-F5-COMPOSE-MIGRATE-WORKTREE's existing tests

The existing test `merge conflict aborts build` (parallel-dispatch-server-worktree.test.js) uses a poll envelope that returns `{status: "execute_step", ...}` on terminal — the old auto-advance shape. To keep the test valid, its poll envelope stays unchanged (no `awaiting_consumer_advance` status), which means it exercises the legacy throwing wrapper. That's the right coverage for that path. New tests in this feature cover the defer path specifically.

### 7. Testing

**Client method test** (`compose/test/stratum-mcp-client-parallel.test.js`):
- `parallelAdvance calls stratum_parallel_advance with snake_case args and returns parsed JSON`

**Integration tests** (`compose/test/parallel-dispatch-server-defer.test.js` — new file):
- **Defer happy path:** poll returns sentinel; Compose applies diffs cleanly; calls `parallelAdvance(…, 'clean')`; advance returns next-step dispatch; function returns that dispatch as `response`; main loop continues; repo files updated
- **Defer conflict path:** poll returns sentinel; two tasks edit same line; Compose merges → conflict; calls `parallelAdvance(…, 'conflict')`; advance returns `{status: 'complete', output: {outcome: 'failed', merge_status: 'conflict'}}`; function does NOT throw; returned response is the terminal failure envelope
- **Sentinel + advance error:** `parallelAdvance` returns `{error: 'spec_integrity_violation', ...}`; assert function throws (advance errors are hard-fail)
- **Sentinel without `capture_diff`:** malformed spec pairing (shouldn't happen in practice, but defensive) — verify the routing falls through cleanly
- **buildStatus fix test** (new `compose/test/build-status-terminal.test.js` or integrate into existing build suite): given a `response = {status: 'complete', output: {outcome: 'failed', merge_status: 'conflict'}}`, the buildStatus-determination logic sets `buildStatus = 'failed'`

**Routing regression:** the existing routing tests from T2-F5-COMPOSE-MIGRATE-WORKTREE continue to pass unchanged — this feature doesn't modify `shouldUseServerDispatch`.

## Out of Scope

- **Updating other pipelines.** Only `build.stratum.yaml`'s `execute` step opts in. Other parallel_dispatch steps (e.g., `parallel_review` in the same file) don't need this — they're `isolation: none` and don't do client-side merges.
- **Removing the legacy throwing path.** The split keeps the throwing wrapper for specs that haven't migrated. Removing it is **T2-F5-LEGACY-REMOVAL** (already on the roadmap).
- **Automatic conflict resolution.** Conflicts still surface to the user; resolution is still manual (or agent-driven at a higher layer). What changes: the build reports failure truthfully instead of throwing.
- **Retry/on_fail semantics for the conflict case.** Whatever Stratum's step spec declares (`on_fail`, `retries`) is now honored because the flow advances with the real failure signal. No Compose-side logic needed — it's all in `_advance_after_parallel`.

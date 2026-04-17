# T2-F5-COMPOSE-MIGRATE-WORKTREE: Server-dispatch for isolation:worktree paths

**Status:** DRAFT
**Date:** 2026-04-18
**Scope:** Compose-side. Extends T2-F5-COMPOSE-MIGRATE (which shipped `isolation: "none"` only) to also cover `isolation: "worktree"` by consuming `ts.diff` from `stratum_parallel_poll`.
**Depends on:** T2-F5-DIFF-EXPORT (shipped on stratum/main).

## Related Documents

- T2-F5-ENFORCE (Stratum server-side dispatch)
- T2-F5-COMPOSE-MIGRATE (Compose v1 for `isolation: "none"`)
- T2-F5-DIFF-EXPORT (Stratum side; provides `ts.diff` field)
- `compose/lib/build.js:2143-2442` — existing consumer-dispatch merge logic (reused)
- `compose/lib/build.js:2180-2241` — `executeParallelDispatchServer` (extended here)

## Problem

T2-F5-COMPOSE-MIGRATE v1 routed `isolation: "none"` parallel_dispatch steps (parallel_review) through Stratum's server-side dispatch; `isolation: "worktree"` remained on consumer-dispatch because Stratum discarded worktrees before exporting their contents. T2-F5-DIFF-EXPORT closed that gap: Stratum now populates `ts.diff` on each `ParallelTaskState` when `capture_diff: true` is set on the step.

Compose can now consume those diffs and do the topological merge client-side, mirroring what the existing consumer-dispatch path does in `executeParallelDispatch`. The plumbing is mostly: route the step, read diffs off poll, feed them into the existing merge logic.

## The merge-status gap (known trade-off)

Stratum's server-dispatch auto-advances the flow when all tasks reach a terminal state, using a hardcoded `merge_status: "clean"` in `_evaluate_parallel_results` (since Stratum has no visibility into consumer-side merge). If Compose's client-side merge conflicts, the flow has **already advanced** server-side by the time `stratum_parallel_poll` returns.

Implications:
- Flow state shows the step as "passed" (merge_status=clean).
- Compose surfaces the conflict locally (error event, prominent stream message, repo left in conflicted state with merge markers).
- **Compose aborts the local CLI build** by throwing after the event emits, so downstream build steps never run against a broken repo (§4).
- Flow state remains advanced; manual `stratum resume` (or re-run) required after the user/agent resolves the conflict.
- No automatic retry or on_fail routing triggers at the Stratum level.

This is a real semantic weakening vs. consumer-dispatch, but in practice:
- Compose's existing topological merge + dependency-aware ordering makes conflicts rare.
- The conflicted repo state is detectable (staged conflicts, merge markers) and recoverable (user/agent resolves, commits).
- Build-agent workflows already handle "try a thing, re-run on failure" at a higher level.

**Follow-up feature: T2-F5-CONSUMER-MERGE-STATUS** (Stratum-side) will add a defer-advance path so Compose can report merge status back before the flow advances. Explicitly out of scope here.

## Design

### 1. Extend the routing check

`shouldUseServerDispatch` currently requires `isolation === "none"`. Extend it to also accept `isolation === "worktree"` when the step declared `capture_diff: true`:

```js
export function shouldUseServerDispatch(dispatchResponse) {
  if (process.env.COMPOSE_SERVER_DISPATCH !== '1') return false;
  const isolation = dispatchResponse?.isolation ?? 'worktree';
  if (isolation === 'none') return true;
  if (isolation === 'worktree' && dispatchResponse?.capture_diff === true) return true;
  return false;
}
```

`capture_diff` is the signal that the spec author intends server-dispatch + merge-back. If `capture_diff` is false or absent on a `worktree` step, Compose falls through to consumer-dispatch (unchanged behavior).

### 2. Extend `executeParallelDispatchServer` to handle worktree merge

After the poll loop terminates with `outcome != null`, check whether diffs need merging:

```js
// existing: poll loop, then
if (pollResult.outcome.status === 'already_advanced') { /* throw, existing */ }

// NEW: if isolation:worktree, apply diffs before returning the outcome
const isolation = dispatchResponse.isolation ?? 'worktree';
if (isolation === 'worktree' && dispatchResponse.capture_diff === true) {
  const tasks = dispatchResponse.tasks ?? [];
  const taskResults = Object.entries(pollResult.tasks ?? {}).map(([taskId, ts]) => ({
    taskId, state: ts.state, diff: ts.diff ?? null, diffError: ts.diff_error ?? null,
  }));
  await applyServerDispatchDiffs(
    tasks, taskResults, context.baseCwd, streamWriter, stepId,
  );
}

// existing: emit build_step_done, return outcome
```

### 3. Extract and reuse topo-merge logic

The existing `executeParallelDispatch` (consumer-dispatch path) has ~100 lines of merge logic at `build.js:2322-2422`:
- Topological sort by `depends_on`
- Stash any pre-existing dirty state
- For each task in topo order: write patch file, `git apply --check` dry run, `git apply`, track applied files
- On `--check` failure: mark merge_status=conflict, rollback via `git checkout -- . && git clean -fd`
- Restore stash

Extract into a helper `applyTaskDiffsToBaseCwd(taskList, diffMap, baseCwd, streamWriter, stepId)` that both paths can call. The helper takes:
- `taskList`: ordered task objects with `depends_on`
- `diffMap`: `Map<taskId, string>` of unified diffs
- `baseCwd`: the main repo root (where to apply)
- `streamWriter`: for event emission
- `stepId`: for event attribution

Returns `{ mergeStatus: 'clean' | 'conflict', appliedFiles: string[], conflictedTaskId: string | null }`.

Consumer-dispatch keeps using this helper with diffs it collected from local worktrees. Server-dispatch uses it with diffs pulled from `pollResult.tasks[*].diff`.

**Stash contract (explicit):** The helper always stashes `baseCwd`'s pre-existing working-tree changes before applying task diffs, and restores the stash after (whether the merge succeeded or conflicted). Under consumer-dispatch this handles mid-build dirt from unrelated steps; under server-dispatch the same behavior catches any stray dirt in `baseCwd` from earlier steps that ran locally before the parallel step kicked off. This contract is preserved by the extraction.

**Behaviorally identical** to today's inline consumer-dispatch code: same git commands, same event payloads, same ordering. The regression test in §6 is a behavior equivalence check, not a byte-for-byte stream snapshot.

### 4. `applyServerDispatchDiffs` wrapper

New function that:
1. Filters `taskResults` for `state === 'complete'` with non-null `diff`. Tasks that failed server-side, or whose diff capture failed (`diff_error` set), are skipped with an error event.
2. Builds a `Map<taskId, diff>` from the filtered list.
3. Calls `applyTaskDiffsToBaseCwd(taskList, diffMap, baseCwd, streamWriter, stepId)`.
4. If result is `conflict`, emits a `build_error` stream event with the conflicted taskId and advises the user/agent to resolve. Does not throw — the flow has already advanced server-side; Compose's job is to surface it loudly and return.

```js
async function applyServerDispatchDiffs(
  taskList, taskResults, baseCwd, streamWriter, stepId,
) {
  const diffMap = new Map();
  for (const tr of taskResults) {
    if (tr.state !== 'complete') continue;
    if (tr.diffError) {
      if (streamWriter) {
        streamWriter.write({
          type: 'build_error', stepId,
          message: `Task ${tr.taskId} succeeded but diff capture failed: ${tr.diffError}. Its changes were NOT applied.`,
        });
      }
      continue;
    }
    if (tr.diff != null) diffMap.set(tr.taskId, tr.diff);
  }

  const { mergeStatus, conflictedTaskId, appliedFiles } =
    await applyTaskDiffsToBaseCwd(taskList, diffMap, baseCwd, streamWriter, stepId);

  if (mergeStatus === 'conflict') {
    if (streamWriter) {
      streamWriter.write({
        type: 'build_error', stepId,
        message:
          `CLIENT-SIDE MERGE CONFLICT applying diff for task ${conflictedTaskId}. ` +
          `The flow has already advanced server-side (merge_status reported as "clean"). ` +
          `Working tree may contain partial merge state — resolve manually before resuming.`,
      });
    }
    // Abort the local build — the function throws so the main build loop's
    // existing try/catch halts the CLI before the next step runs against a
    // broken repo. Stratum flow state stays "advanced"; user must resume
    // manually after resolving conflicts, or re-run the build.
    throw new Error(
      `parallel_dispatch[${stepId}]: client-side merge conflict on task ${conflictedTaskId}`,
    );
  }

  // Track applied files on the build context so downstream steps (coverage,
  // reviews, etc.) see the changes. Matches consumer-dispatch behavior — see
  // context.filesChanged usage at build.js:820-848 / 1096 / 1177-1181.
  if (appliedFiles.length > 0) {
    const set = new Set(context.filesChanged ?? []);
    for (const f of appliedFiles) set.add(f);
    context.filesChanged = [...set];
  }
}
```

### 4b. `already_advanced` interaction

If a poll returns `outcome.status === 'already_advanced'` (should not happen under normal operation — see T2-F5-COMPOSE-MIGRATE §3), the existing throw fires *before* the new merge block runs. Diffs collected from the envelope are discarded. This is intentional: `already_advanced` means the flow state was already processed by a prior poll; re-applying diffs on a post-advance race would be worse than skipping them.

### 5. No Stratum-side changes

T2-F5-DIFF-EXPORT already provides everything needed. This feature is pure Compose consumer work.

### 6. Testing

**Routing test updates** (`compose/test/parallel-dispatch-routing.test.js`):

Extend existing tests to cover the new cases:
- flag=1 + isolation=worktree + capture_diff=true → server-dispatch
- flag=1 + isolation=worktree + capture_diff=false (or absent) → consumer-dispatch
- flag=1 + isolation=worktree + capture_diff="true" (string) → consumer-dispatch (strict bool check)
- flag=0 + isolation=worktree + capture_diff=true → consumer-dispatch (flag gate overrides everything)
- flag=1 + isolation=none + capture_diff=true → server-dispatch (existing v1 behavior, unchanged)

**New integration tests** (`compose/test/parallel-dispatch-server-worktree.test.js`):

- **Happy path (3 tasks, clean merge):** poll returns 3 complete tasks with non-empty diffs that apply cleanly to a temp git repo; assert files land at expected paths, outcome returned correctly
- **Topological merge ordering:** 3 tasks with `depends_on` edges (C depends on B depends on A); diffs can only apply in order A→B→C (e.g., C modifies a file B creates); assert ordering respected
- **Merge conflict:** 2 tasks modify the same line of the same file; assert `build_error` event emitted, repo left in detectable state, outcome still returned (flow doesn't block)
- **Mixed success/failure:** 1 task failed server-side, 2 complete; assert only the 2 successful diffs are applied
- **Task with diff_error:** task complete but diff capture failed on Stratum side (diff_error set); assert error event emitted, diff skipped, no crash
- **Helper extraction regression:** run an existing consumer-dispatch test and verify it still passes via the extracted helper (behavior equivalence, not a byte-for-byte stream snapshot)

Tests use real git repos in `tmp_path`-like temp dirs + a stub stratum client that returns canned poll envelopes. No live stratum MCP.

### 7. Spec change in build.stratum.yaml

The `execute` step (or whichever `parallel_dispatch` step has `isolation: worktree` and code-writing tasks) needs `capture_diff: true` added to its definition. Example:

```yaml
- id: execute
  type: parallel_dispatch
  source: "$.steps.decompose.output.tasks"
  isolation: worktree
  capture_diff: true            # ← added for server-dispatch eligibility
  max_concurrent: 3
  require: all
  agent: claude
  intent_template: |
    Implement task {task.id}: {task.description}
```

Under server-dispatch, Stratum captures diffs and Compose reads them. Under consumer-dispatch (flag off), `capture_diff: true` has no effect since Stratum isn't running the tasks. Forward-compatible.

### 8. Docs

- Update README's `COMPOSE_SERVER_DISPATCH` env var description to note it now covers both isolation modes (when `capture_diff: true` is set on worktree steps).
- CHANGELOG entry.
- Outer Forge ROADMAP.md: new line for T2-F5-COMPOSE-MIGRATE-WORKTREE.

## Out of Scope

- **T2-F5-CONSUMER-MERGE-STATUS** — Stratum-side defer-advance so Compose can report merge_status=conflict back before flow advances. Separate feature, separate ticket.
- **Automatic conflict resolution.** Conflicts are surfaced to the user; recovery is manual (or handled by a higher-level agent loop).
- **Diff size caps.** Inherits whatever size contract T2-F5-DIFF-EXPORT ships with (currently uncapped).
- **T2-F5-LEGACY-REMOVAL** — the consumer-dispatch code path stays. Remove later once server-dispatch has baked across both isolation modes.

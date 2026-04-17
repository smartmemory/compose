# T2-F5-COMPOSE-MIGRATE: Compose → Server-Side Parallel Dispatch

**Status:** DRAFT
**Date:** 2026-04-17
**Roadmap:** T2-F5-COMPOSE-MIGRATE (follow-on to T2-F5-ENFORCE)
**Scope (v1):** `isolation: "none"` paths only. `isolation: "worktree"` stays on consumer-dispatch pending T2-F5-DIFF-EXPORT.

## Related Documents

- Predecessor: T2-F5-ENFORCE (shipped server-side parallel dispatch in stratum-mcp; ROADMAP line 50)
- `stratum/stratum-mcp/src/stratum_mcp/server.py` — `stratum_parallel_start` (line 813), `stratum_parallel_poll` (line 931), `stratum_parallel_done` (line 500)
- `stratum/stratum-mcp/src/stratum_mcp/parallel_exec.py` — `ParallelExecutor`, worktree lifecycle
- `compose/lib/build.js:2123-2442` — `executeParallelDispatch` (consumer-dispatch)
- `compose/lib/stratum-mcp-client.js:305-312` — `parallelDone()` client call

## Stratum `stratum_parallel_poll` return envelope (verified against server.py:920-1060)

```js
// In-flight (one or more tasks still pending/running):
{
  flow_id: "...",
  step_id: "...",
  summary: { pending: 1, running: 2, complete: 0, failed: 0, cancelled: 0 },
  tasks: { "<task_id>": { task_id, state, started_at, finished_at, result, error, cert_violations, worktree_path }, ... },
  require_satisfied: false,
  can_advance: false,
  outcome: null
}

// All tasks terminal, require satisfied, step still pending — advance fires:
{
  summary: { ..., complete: 3, failed: 0 },
  require_satisfied: true,
  can_advance: true,
  outcome: { status: "execute_step" | "await_gate" | "parallel_dispatch" | "complete" | ..., /* next-step dispatch envelope */ }
}

// All tasks terminal, but require NOT satisfied (e.g., all-failed with require:all):
{
  summary: { ..., failed: 3 },
  require_satisfied: false,
  can_advance: false,         // ← false!
  outcome: { /* still set — _advance_after_parallel is called regardless */
    status: "execute_step" | "await_gate" | "ensure_failed" | ...,
    /* per _advance_after_parallel retry/on_fail routing */
  }
}

// Idempotent re-poll after flow already advanced:
{ ..., outcome: { status: "already_advanced", aggregate: {...} } }
```

**Critical insight:** `outcome` is non-null whenever `all_terminal AND step_still_pending` — **regardless of `can_advance`**. `_advance_after_parallel` runs in both the happy path and failure-retry paths. The Compose poll loop must therefore break on `outcome !== null`, **not** on `can_advance`, or it will spin forever when tasks fail under `require: all`.

## Problem

T2-F5-ENFORCE shipped server-side parallel dispatch in `stratum-mcp` — `ParallelExecutor` drives tasks via `asyncio.gather` + per-flow locks + cascade cancel + startup reparenting. Compose still uses the legacy consumer-dispatch path (`stratum_parallel_done`): it creates its own worktrees under `.compose/par/<taskId>/`, runs each task via its local `AgentConnector`, collects diffs, and submits aggregated results in one call.

Until Compose actually calls `stratum_parallel_start` / `_poll`, the enforcement gap T2-F5-ENFORCE was built to close remains open — nothing is enforced server-side because nothing uses the server-side path.

### Critical constraint

Stratum's v1 server-dispatch **discards worktree contents** when each task completes (`parallel_exec.py` finally block calls `remove_worktree`). There is no diff-export hook. Tasks that *return* structured results via their final `result` message are preserved; tasks that *write code to disk* lose their output.

This means the `execute` step in `build.stratum.yaml` (which decomposes a feature into code-writing tasks under `isolation: "worktree"` and relies on Compose merging diffs back into the main repo) is **not safe to migrate** without a new Stratum mechanism to export per-task diffs before cleanup.

Scope of this feature is therefore the `isolation: "none"` paths only — principally `parallel_review`, where tasks return findings as structured JSON and make no file changes.

## Design

### 1. Routing decision in `executeParallelDispatch`

Add a routing branch at the top of `executeParallelDispatch` (currently `build.js:2123`):

```js
const useServerDispatch =
  process.env.COMPOSE_SERVER_DISPATCH === '1' &&
  (dispatchResponse.isolation ?? 'worktree') === 'none';

if (useServerDispatch) {
  return executeParallelDispatchServer(
    dispatchResponse, stratum, context, progress, streamWriter
  );
}
// ... existing consumer-dispatch body unchanged ...
```

Both preconditions must hold:
- `COMPOSE_SERVER_DISPATCH=1` — explicit opt-in during bake period.
- `isolation === "none"` — the task shape Stratum v1 can safely execute. Any other isolation falls through to consumer-dispatch.

No change to the existing consumer-dispatch body.

### 2. New function: `executeParallelDispatchServer`

Lives in the same file (`compose/lib/build.js`) next to the existing function. Signature mirrors the existing one minus `getConnector` and `baseCwd` — Stratum owns agent execution and working directory on the server-dispatch path:

```js
const POLL_INTERVAL_MS = Number(process.env.COMPOSE_SERVER_DISPATCH_POLL_MS) || 500;

async function executeParallelDispatchServer(
  dispatchResponse,
  stratum,
  context,
  progress,
  streamWriter,
) {
  const { flow_id: flowId, step_id: stepId,
          step_number: stepNum, total_steps: totalSteps,
          tasks } = dispatchResponse;

  // 1. Stream "start" event for observability (mirror existing event shape)
  if (streamWriter) {
    streamWriter.write({
      type: 'system', subtype: 'build_step_start',
      stepId, stepNum: `∥${stepNum}`, totalSteps,
      parallel: true, taskCount: tasks.length, flowId,
    });
  }

  const emittedStates = new Map(); // task_id → last emitted state (local scope — no cross-build leak)

  // 2. Start server-side execution; tolerate already_started for crash-recovery
  const startResult = await stratum.parallelStart(flowId, stepId);
  if (startResult?.error) {
    if (startResult.error === 'already_started') {
      // Previous process started this step and crashed, or same call racing — fall through to poll.
      // The existing executor's progress will be observed via the polling loop.
    } else {
      throw new Error(
        `stratum_parallel_start failed: ${startResult.error}: ${startResult.message || ''}`
      );
    }
  } else if (startResult?.status !== 'started') {
    throw new Error(`stratum_parallel_start returned unexpected envelope: ${JSON.stringify(startResult)}`);
  }

  // 3. Poll until outcome is present (NOT until can_advance — see envelope doc above).
  //    outcome is non-null whenever all tasks are terminal and the step hasn't already advanced,
  //    including failure cases where can_advance remains false.
  let pollResult;
  while (true) {
    pollResult = await stratum.parallelPoll(flowId, stepId);
    if (pollResult?.error) {
      throw new Error(
        `stratum_parallel_poll failed: ${pollResult.error}: ${pollResult.message || ''}`
      );
    }
    emitPerTaskProgress(streamWriter, pollResult, emittedStates);
    if (pollResult.outcome != null) break;
    await sleep(POLL_INTERVAL_MS);
  }

  // 4. Guard against already_advanced envelope (should not reach here since we break on
  //    first non-null outcome, but defensive — see stratum server.py:1020-1030).
  if (pollResult.outcome.status === 'already_advanced') {
    throw new Error(
      `stratum_parallel_poll returned already_advanced for step ${stepId} — ` +
      `flow state desync. Aggregate: ${JSON.stringify(pollResult.outcome.aggregate)}`
    );
  }

  // 5. Stream "done" event and return the outcome as the next dispatch
  if (streamWriter) {
    streamWriter.write({
      type: 'system', subtype: 'build_step_done',
      stepId, parallel: true,
      summary: pollResult.summary, flowId,
    });
  }

  // outcome is the next dispatch (execute_step / await_gate / complete / ensure_failed / ...)
  // exactly the shape the main build loop at build.js:1334 expects as its next `response`.
  return pollResult.outcome;
}
```

**Polling cadence:** `POLL_INTERVAL_MS = 500`. Stratum's `_poll` is cheap and idempotent. 500ms trades off latency vs. MCP round-trip load. Adjustable via `COMPOSE_SERVER_DISPATCH_POLL_MS` env var (not required for v1).

**Max wait:** no explicit timeout here — individual task timeouts (`task_timeout`, default 1800s) are enforced by Stratum. If the poll loop hangs indefinitely, the existing Compose session/build timeouts apply at higher layers.

### 3. Shape translation: `pollResult.outcome` vs. `parallelDone()` return

Both paths must return a value the main build loop at `build.js:1334-1344` can consume as the next `response`. Read the existing main loop:

```js
} else if (response.status === 'parallel_dispatch') {
  response = await executeParallelDispatch(...);
}
// loop continues with new response
```

Under consumer-dispatch, `executeParallelDispatch` returns whatever `stratum.parallelDone()` returns — the *next* dispatch (e.g., `{status: 'execute_step', ...}` or `{status: 'complete'}`).

Under server-dispatch, `pollResult.outcome` *is* the next dispatch when auto-advance fires — same shape. When Stratum's `process_step_result` flips the flow to the next step, the outcome contains the full next-step dispatch envelope. When the flow completes, `outcome.status === 'complete'`.

**One gotcha:** the server-dispatch `outcome` may also contain `{status: "already_advanced"}` if Compose polls after the flow has already advanced. This only happens on the *second+* poll after terminal — the first poll that observes terminal state is the one that triggers advance and returns the real next dispatch. The poll loop above exits after the first `outcome !== null`, so we always consume the advance-triggering poll. `already_advanced` should not be reachable under normal operation; step 4 of the code throws defensively if it is.

### 4. Per-task progress streaming

Stratum's poll returns a full `tasks` dict on every call. To avoid flooding the build stream with duplicate events, the caller passes a local `emittedStates` Map (scoped to a single `executeParallelDispatchServer` invocation — no cross-build leak) and the helper only emits an event when a task's state changes:

```js
function emitPerTaskProgress(streamWriter, pollResult, emittedStates) {
  if (!streamWriter) return;
  const stepId = pollResult.step_id;

  for (const [taskId, ts] of Object.entries(pollResult.tasks ?? {})) {
    const prev = emittedStates.get(taskId);
    if (prev === ts.state) continue;
    emittedStates.set(taskId, ts.state);

    if (ts.state === 'running') {
      streamWriter.write({
        type: 'system', subtype: 'build_task_start',
        stepId, taskId, parallel: true,
      });
    } else if (ts.state === 'complete' || ts.state === 'failed' || ts.state === 'cancelled') {
      streamWriter.write({
        type: 'system', subtype: 'build_task_done',
        stepId, taskId, parallel: true,
        status: ts.state,
        error: ts.error ?? null,
      });
    }
  }
}
```

**Naming:** uses new subtypes `build_task_start` / `build_task_done` (not `build_step_start` / `build_step_done`) so downstream consumers (VisionSurface stream demux, BuildStreamBridge) can distinguish a parallel task transition from a step transition and won't collide on `stepId` map keys. The step-level envelope events continue to use `build_step_start` / `build_step_done` with `parallel: true` (matches the existing consumer-dispatch shape at `build.js:2242-2293`).

### 5. New client methods in `stratum-mcp-client.js`

Add two thin wrappers alongside the existing `parallelDone()`:

```js
async parallelStart(flowId, stepId) {
  return this.#callTool('stratum_parallel_start', {
    flow_id: flowId, step_id: stepId,
  });
}

async parallelPoll(flowId, stepId) {
  return this.#callTool('stratum_parallel_poll', {
    flow_id: flowId, step_id: stepId,
  });
}
```

Consistent with existing `parallelDone()` shape. No other changes to the client.

### 6. Error handling

Both `_start` and `_poll` can return `{error, message}` envelopes. Enumerated errors from the Stratum side:

| Tool | Error key | Meaning | Response |
|------|-----------|---------|----------|
| `_start` | `already_started` | This step was already dispatched | Fall through to poll path |
| `_start` | `wrong_step_type` | Step isn't `parallel_dispatch` | Hard fail, bug in Compose's routing |
| `_start` | `branch` | `isolation: branch` not supported | Hard fail (shouldn't reach here — routing filters to `isolation:none`) |
| `_start` | `no_tasks` | Empty task list | Hard fail, decompose produced no tasks |
| `_start` | `flow_complete` | Flow already finished | Hard fail, state corruption |
| `_poll` | `step_not_dispatched` | Called before `_start` | Hard fail |
| `_poll` | `flow_not_found` | Flow state missing (restart / stale flow_id) | Hard fail |
| `_poll` | `unknown_step` | Step ID not in flow | Hard fail |

For v1, all errors except `already_started` raise. `already_started` is recoverable — proceed straight to the poll loop, which will observe the existing executor's progress. This handles two scenarios:

1. A previous Compose process started this step then crashed; the new process resumes observing.
2. A caller ran `_start` twice by mistake (harmless in Stratum; the second call is a no-op).

### 7. Out of scope for v1

**Code-writing paths (`isolation: "worktree"`):** remain on consumer-dispatch. When `dispatchResponse.isolation === 'worktree'`, the `useServerDispatch` check returns false and the existing path runs. A future `T2-F5-DIFF-EXPORT` ticket will add a Stratum mechanism to export per-task diffs before worktree cleanup; the same routing flag will then enable server-dispatch for those paths too.

**Legacy removal:** the `stratum_parallel_done` client method and the consumer-dispatch body stay. Removal is the separate `T2-F5-LEGACY-REMOVAL` ticket, after at least one release bakes with `COMPOSE_SERVER_DISPATCH=1` as the working default.

**Compose-side worktrees under `.compose/par/`:** unused on the server-dispatch path (Stratum creates them elsewhere). No cleanup needed — the directory just won't be created when the flag is on.

### 8. Testing

**Routing tests** (`compose/test/parallel-dispatch-routing.test.js`):

- `COMPOSE_SERVER_DISPATCH` unset → consumer-dispatch path runs regardless of isolation
- `COMPOSE_SERVER_DISPATCH=1` + `isolation: 'none'` → server-dispatch path runs
- `COMPOSE_SERVER_DISPATCH=1` + `isolation: 'worktree'` → consumer-dispatch path runs (fall-through)
- `COMPOSE_SERVER_DISPATCH=1` + isolation omitted (default `'worktree'`) → consumer-dispatch

All four assertions exercise the routing decision by stubbing `executeParallelDispatchServer` and `executeParallelDispatch` with spies. No live stratum calls.

**Server-dispatch integration tests** (`compose/test/parallel-dispatch-server.test.js`):

- **Happy path:** `_start` returns `{status:'started'}`; poll returns `outcome:null` twice, then `outcome:{status:'execute_step',...}` with `can_advance:true` → function returns the `execute_step` envelope as `response`
- **Crash-recovery:** `_start` returns `{error:'already_started'}` → function proceeds straight to poll loop, returns final outcome
- **Hard error:** `_start` returns `{error:'wrong_step_type'}` → function throws
- **Unexpected start envelope:** `_start` returns `{status:'weird'}` with no `.error` → function throws
- **Failure golden flow (the one B3 surfaced):** 3-task parallel_review, all tasks transition pending → running → failed. `outcome` becomes non-null with `can_advance:false` because require is unsatisfied; Stratum's `_advance_after_parallel` returns an `ensure_failed` or retry dispatch. Assert the function returns the failure envelope (does NOT spin forever) and the main build loop receives it correctly.
- **Poll idempotency edge:** `outcome.status === 'already_advanced'` → function throws with the flow-desync diagnostic
- **Per-task progress streaming:** 3 tasks transition pending → running → complete across 4 polls; assert exactly 3 `build_task_start` + 3 `build_task_done` events + 1 `build_step_start` + 1 `build_step_done` (no duplicates, task events don't collide with step events)

Both test files use a mock `stratum` client — no live MCP round-trips required. Stratum-side behavior is covered by `stratum-mcp/tests/test_parallel_server_dispatch.py`.

**Manual smoke** (not part of CI): run a real `compose build` against a pipeline with a `parallel_review` step, with and without the flag, verify the build completes and the review results are identical.

## Sequencing

1. Add `parallelStart` + `parallelPoll` client methods (use the `#callTool` private method — same pattern as existing `parallelDone` at `stratum-mcp-client.js:305-312`).
2. Add `executeParallelDispatchServer` + `emitPerTaskProgress` helpers.
3. Add the routing decision at the top of `executeParallelDispatch`.
4. Write tests (see §8).
5. Smoke-test a real build with the flag on.
6. Document the flag in `README.md` and `CHANGELOG.md` (same commit as code per `.claude/rules/documentation.md`).

No changes to `build.stratum.yaml`. No Stratum-side changes.

## Non-Goals

- Diff export from Stratum worktrees — separate feature (T2-F5-DIFF-EXPORT).
- Removing `stratum_parallel_done` from the client or the consumer-dispatch code path (T2-F5-LEGACY-REMOVAL).
- Streaming agent output in real-time from server-dispatched tasks (T2-F5-STREAM). Per-task *state* transitions stream; per-task tool-use / assistant message bodies do not. Consumers who need fine-grained streaming stay on consumer-dispatch or wait for T2-F5-STREAM.
- OpenCode support on server-dispatch (T2-F5-OPENCODE-DISPATCH, Stratum-side).
- `isolation: "branch"` support (T2-F5-BRANCH, Stratum-side).
- Respecting `depends_on` ordering on server-dispatch (T2-F5-DEPENDS-ON, Stratum-side). Safe for `parallel_review` tasks which have no inter-task dependencies.

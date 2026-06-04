# COMP-PAR-MERGE-QUEUE-CONSUMER — Pre-merge gate + bounce on the consumer-dispatch path: Design

**Status:** DESIGN (Phase 1 — intent, not yet implemented). file:line anchors are current-state references for the blueprint to verify, not claims of existing behavior.
**Date:** 2026-06-04
**Roadmap:** COMP-PAR-MERGE-QUEUE-CONSUMER (forge-top Standalone Ticket) · **Parent:** COMP-PAR-MERGE-QUEUE (server-dispatch, SHIPPED 2026-06-04)
**Repos:** `compose/` (primary — Compose runs these agents) + `stratum/` (small — surface the resolved gate on the dispatch envelope).

## Problem

COMP-PAR-MERGE-QUEUE shipped the per-task pre-merge gate + bounce-with-context for the **server-dispatch**
path (`executeParallelDispatchServer` → Stratum's `ParallelExecutor._run_one`), used by GSD. But Compose
runs `parallel_dispatch` **two** ways, and the gate doesn't cover the other one:

- **server-dispatch** (`executeParallelDispatchServer`): agents run *inside Stratum's `_run_one`* (worktrees +
  diff capture server-side). The gate runs there. Reached when `COMPOSE_SERVER_DISPATCH=1` (+worktree/capture)
  **or** unconditionally by GSD (`gsd.js` calls `executeParallelDispatchServer` directly).
- **consumer-dispatch** (`executeParallelDispatch` → `stratum_parallel_done`): agents run *in Compose*
  (`runAndNormalize`, worktree per task at `.compose/par/<taskId>`, diff captured + applied Compose-side).
  This is the **default for `compose build`** (`shouldUseServerDispatch` returns false unless
  `COMPOSE_SERVER_DISPATCH=1`, `build.js:2905`), plus child-flows / `isolation:none`.

So today a `compose build` parallel task (the default path) can merge a diff that fails lint/build, and a
merge conflict re-dispatches blind — exactly the holes the parent feature closed for GSD.

### Verified current state (verify-first, 2026-06-04)

| Fact | Location |
|------|----------|
| `executeParallelDispatch` runs each task via `runAndNormalize` in its worktree (`cwd: taskCwd`) | `build.js:3676` |
| Diff captured immediately after the agent returns (`git add -A` + `git diff --cached HEAD` → `taskDiffs`) | `build.js:3696-3701` |
| Diffs applied to base via the **shared** `applyTaskDiffsToBaseCwd` (now returns `conflictFiles`) then `parallelDone` | `build.js:3749`, `:3787` |
| `parallelDone(flowId, stepId, taskResults, mergeStatus)` — `mergeStatus` already accepted as str **or** dict by `_evaluate_parallel_results`; the `ensure_failed` envelopes already thread `bounced_tasks` (parent feature) | `build.js:3787`; `server.py` `stratum_parallel_done` |
| `buildMergeConflictBounce` / `extractConflictFiles` already exist (parent feature) | `build.js` |
| The parallel **dispatch surface** (`get_current_step_info`) does NOT carry `pre_merge_verify` | `executor.py:1872-1888` |
| `_resolve_pre_merge_verify` (list / `$.input.*` → list) lives in `server.py`; `resolve_ref` is in `executor.py` | `server.py` `_resolve_pre_merge_verify` |
| Consumer-path failure (`ensure_failed` from `parallelDone`) currently routes to runBuild's single-agent retry branch | `build.js:~1641` (pre-existing) |

## Goal

Bring the parent feature's two guarantees to the consumer-dispatch path:

1. **Per-task pre-merge gate** — run the gate in each task's worktree *before* its diff is captured/applied;
   a failure marks the task failed, records a `gate_failed` bounce, and **skips diff capture** (the bad work
   never merges). Mirrors `_run_one`, but Compose-side.
2. **Bounce-with-context** — gate-failed + merge-conflict bounces surface on the `parallelDone` `ensure_failed`
   envelope, and are injected into the re-run task's prompt. For consumer-dispatch the agents run *in Compose*,
   so injection is **Compose-side** (`buildStepPrompt` for the re-run) — the symmetric opposite of the server
   path's lesson (there the server re-resolved tasks, forcing server-side injection).

**Non-goals:**
- Not changing the server-dispatch path (parent feature, already shipped).
- Not adding new gate semantics — same `pre_merge_verify` IR field, same `ParMergeBounce` contract.

## Decisions (Phase 1)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | How the gate-command list reaches Compose | **Stratum surfaces the resolved `pre_merge_verify` on the parallel dispatch envelope** (`get_current_step_info`), so `executeParallelDispatch` reads `dispatchResponse.pre_merge_verify`. Architecture requirement: **one shared resolver** used by both the surface and the server-start site (the exact file it lives in is an impl detail — co-locating with `resolve_ref` in `executor.py` is the likely shape, blueprint's call). | The consumer path has no other clean handle on the flow input; surfacing it on the envelope is how every other dispatch param (isolation/merge/intent_template) already travels. |
| D2 | Where the Compose gate runs | In the per-task async block of `executeParallelDispatch`, **after `runAndNormalize`, before diff capture** (`build.js:3681`→`:3696`), in `wtPath`. A new Compose helper `runPreMergeGateLocal(cwd, commands, timeout)` mirrors Stratum's `run_pre_merge_gate` (node_modules symlink, per-command run, first non-zero ⇒ `gate_failed` bounce). **Only the worktree/capture-diff shape gets the gate** — `isolation:none` (`worktreeIsolation === false`) has no per-task diff to gate, so the gate is a no-op there (it can still share D4's retry-routing fix). | Symmetric with `_run_one`; the worktree + base are both in hand here. |
| D3 | Bounce surfacing | Compose assembles the full `bounced_tasks` (gate-failed from the local gate + merge-conflict from `buildMergeConflictBounce`) and passes `parallelDone` a **structured** `merge_status` `{status, bounced_tasks}` (the same shape `parallel_advance` already accepts; `_evaluate_parallel_results` already threads it). | Reuses the parent feature's channel — minimal Stratum change. |
| D4 | Retry-with-context routing + state model | **DEFERRED to follow-up `COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY`** (scope decision 2026-06-04). The full retry loop is materially heavier on the consumer path than the server path: Compose applies successful diffs to base *before* `parallelDone`, so a re-run can't naively replay onto a mutated base — it needs either failed-only-re-run-with-carry-forward, or roll-base-back-to-clean-and-re-run-all (server semantics). Both touch `compose build`'s default path. **v1 defers this.** Consequence: the existing single-agent mis-route of a parallel `ensure_failed` (top-level `runBuild` + child flows) stays as-is, and the bounce is not yet injected into a parallel re-run. | The gate (D2) is the high-value, low-risk core — it *prevents* the bad merge regardless of retry. v1 makes the gate failure visible + surfaces structured bounces for the follow-up to consume. |
| D4-VIS | Make the gate failure visible in v1 (so it's actionable without D4) | A gate failure contributes a **human-readable violation string** (e.g. `task <id> failed pre-merge gate \`pnpm build\` (exit 1)`) to the `parallelDone` failure envelope's `violations`, in addition to the structured `bounced_tasks` record. So the user sees exactly which task failed which gate and that its diff was NOT merged — even though the bounce isn't yet auto-injected into a retry. | Prevents the structured `bounced_tasks` from being write-only/unwired in v1; the user gets the actionable signal now. |
| D5 | How a pipeline opts in | **Per-step `pre_merge_verify`.** The machinery activates for ANY `parallel_dispatch` step that declares a `pre_merge_verify` (literal list or `$.input.*` ref) — Stratum surfaces the resolved list on the dispatch envelope and `executeParallelDispatch` enforces it. **`build.stratum.yaml`'s own default-OFF opt-in is deferred** (with COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY): threading a config-gated `pre_merge_gate` flow input through `runBuild`'s 5 `startFresh` call sites adds hot-path surface the low-risk v1 doesn't need, and the retry follow-up is the natural place to land build-mode enablement alongside the proper retry routing. | v1 ships a complete, usable, tested gate for the consumer path without changing `compose build`'s default behavior — truly byte-identical unless a pipeline declares the field. |

## Reuse from the parent feature (no rebuild)

- `applyTaskDiffsToBaseCwd` already returns `conflictFiles`; `buildMergeConflictBounce` / `extractConflictFiles`
  exist; `_evaluate_parallel_results` accepts a structured `merge_status` and threads `bounced_tasks`; the
  `ParMergeBounce` contract is committed. The Compose gate helper mirrors `worktree.run_pre_merge_gate`.

## Flow (after)

```
executeParallelDispatch, per task in its worktree:
  agent runs (runAndNormalize)
  → [NEW] run pre_merge_verify in wtPath
       fail → task failed + gate_failed bounce → (skip diff capture)
       pass → capture diff (as today)
  → applyTaskDiffsToBaseCwd: conflict → merge_conflict bounce (buildMergeConflictBounce)
  → parallelDone(flowId, stepId, taskResults, {status, bounced_tasks})   [NEW: structured]
       → ensure_failed { bounced_tasks:[...] }   (server threads it — parent feature)
  → [NEW] executeParallelDispatch re-dispatches the failed tasks with bounce-injected prompts (its own loop)
       terminal complete / retries_exhausted → return to outer loop
```

## Risks / open questions

- **Retry-loop ownership is the largest piece** and touches a hot path (`compose build`'s default). Byte-identical
  envelope: **absent `pre_merge_verify` AND no parallel failure/bounce ⇒ byte-identical.** (D4 *does* change the
  existing no-gate *failure* path — it replaces the single-agent mis-route with a proper parallel re-run; that's a
  deliberate fix, not a regression, but it means "byte-identical when no gate" is only true on the success path.)
- **Retry state model** (D4): the must-confirm item — re-run only failed tasks, carry successes forward, don't
  replay applied diffs. The blueprint must pin exactly how failed-task subset is recomputed each round and how
  the aggregate is rebuilt for `parallelDone`.
- **node_modules symlink in `.compose/par/<taskId>`**: same best-effort approach as the server gate.
- **Child-flow path** (`executeParallelDispatch` is also called at `build.js:2863` inside `executeChildFlow`):
  the gate/bounce + retry loop ride along (same function), so child flows get the routing fix too — confirm the
  retry loop is safe there (child flows have their own `ensure_failed` fix/retry branch that must not double-handle).
- **`isolation:none`**: no per-task worktree/diff, so the gate is a no-op there; only the retry-routing fix applies.
- **Gate timeout**: reuse the step timeout (consumer path uses `STEP_TIMEOUT_MS`), per-command.

## Acceptance criteria (v1 — gate + surfacing)

- [ ] Stratum surfaces resolved `pre_merge_verify` on the `parallel_dispatch` dispatch envelope; one shared resolver used by both surfaces
- [ ] `executeParallelDispatch` runs the gate in each task worktree before diff capture; gate-fail ⇒ task failed, diff skipped, `gate_failed` bounce (worktree shape only; `isolation:none` is a no-op)
- [ ] Compose passes a structured `merge_status` to `parallelDone` carrying gate-failed + merge-conflict bounces
- [ ] A gate failure surfaces a human-readable `violations` string on the `parallelDone` failure envelope (actionable without D4)
- [ ] Gate activates for any `parallel_dispatch` step declaring `pre_merge_verify` (build.stratum.yaml default-OFF opt-in deferred with the retry follow-up)
- [ ] **Byte-identical when `pre_merge_verify` is absent** (no gate ⇒ the consumer path is unchanged, including its existing retry routing)
- [ ] Full stratum + compose suites green; new tests for the Compose gate (pass/fail/skip-diff), the shared resolver/surface, and the structured `parallelDone` + violation string
- [ ] Reuses `ParMergeBounce` contract + `buildMergeConflictBounce` + `applyTaskDiffsToBaseCwd` (no parallel rebuild)

## Follow-ups

- **COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY** — the deferred D4: `executeParallelDispatch` owns its retry loop
  (re-run from a rolled-back-clean base = server semantics, OR failed-only-re-run with carry-forward),
  Compose-side bounce injection into the re-run prompt, and fixing the pre-existing single-agent mis-route
  of a parallel `ensure_failed` for both `runBuild` and `executeChildFlow`. Materially heavier on the
  consumer path (incremental base mutation); deferred from v1 so the gate (the bad-merge *prevention*) ships
  low-risk on `compose build`'s default path.

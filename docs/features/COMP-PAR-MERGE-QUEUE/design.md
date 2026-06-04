# COMP-PAR-MERGE-QUEUE — Per-Task Pre-Merge Gate + Conflict-Bounce-with-Context: Design

**Status:** DESIGN (Phase 1 — intent, not yet implemented). This is a design doc, not shipped code; file:line anchors are current-state references for the blueprint phase to verify, not claims of existing behavior.
**Date:** 2026-06-04
**Roadmap:** COMP-PAR-MERGE-QUEUE (forge-top Standalone Tickets) · **Unblocks:** COMP-GSD-3 (PARTIAL → COMPLETE)
**Repos touched:** `stratum/` (primary — IR field + gate exec + bounce channel) and `compose/` (consumer — config + conflict context + retry-prompt injection)

## Problem

`parallel_dispatch` dispatches N agent tasks into isolated git worktrees, captures each task's diff,
and merges them to base in topo order. Two quality holes remain after the worktree/diff/merge core
shipped (GSD-2):

1. **No per-task pre-merge gate.** A task's diff is captured and merged with only `git apply --check`
   (conflict detection) standing between it and base. The GSD `execute` step *instructs* the agent to
   run gates (`"GATES — you MUST run..."` in the intent template) but nothing **enforces** them — a
   task that self-reports green merges even if its tests are red. Project lint/build/test runs once at
   `ship_gsd`, **after all merges**, so a bad task pollutes the base every subsequent task builds on.
2. **Bounce is blind.** On a merge conflict the re-dispatched agent receives
   `violations: ["merge conflict: merge_status='conflict'"]` — no task id, no files, no diff. It
   retries with zero information about what collided.

### Verified current state (verify-first, 2026-06-04)

Confirmed against on-disk source in both repos — the feature is **unstarted** (no code, no stubs, no
commits in either repo reference it):

| Fact | Location |
|------|----------|
| Per-task diff captured in worktree `finally`, stored on `ts.diff`; **no gate hook** before capture | `stratum/stratum-mcp/src/stratum_mcp/parallel_exec.py` (`_run_one`, capture_diff block) |
| `merge: sequential_apply` is a **metadata label only** — Stratum applies nothing | `parallel_exec.py` / `executor.py` (dispatch envelope) |
| Actual merge engine (topo-sort, `git apply --check`, `git apply`, rollback, conflict detect) lives in **Compose** | `compose/lib/build.js` `applyTaskDiffsToBaseCwd`, `applyServerDispatchDiffsCore` |
| Compose computes `conflictedTaskId` / `conflictError` then **discards** them: `parallelAdvance` only carries `clean\|conflict` | `compose/lib/build.js` (advance call) + `CHANGELOG.md:489` |
| Conflict → `ensure_failed` with a bare-string violation | `stratum/.../server.py` `_evaluate_parallel_results` |
| Retry prompt built from `violations`; `response.conflicts` is only populated for `decompose` `no_file_conflicts`, **not** for merge conflicts | `compose/lib/build.js` `buildRetryPrompt`, `step-prompt.js` |
| `parallel_dispatch` IR accepts no per-task `verify`/`gate`/`pre_merge`/`ensure` field | `stratum/.../spec.py` (`IRStepDef` + v0.3 schema) |
| Static complement `no_file_conflicts` (STRAT-PAR-2) is a **pre-dispatch** gate on decompose | `executor.py` `_ENSURE_BUILTINS`; used in `gsd.stratum.yaml` / `build.stratum.yaml` decompose steps |

## Goal

Add a **dynamic post-dispatch merge gate** to `parallel_dispatch`:

1. Each task runs a configurable **pre-merge verify** command list in its worktree *before its diff is
   captured/merged*. Failure marks the task failed and bounces it.
2. **Both** failure kinds (gate-failed and merge-conflict) feed **structured context** to the
   re-dispatched agent: task id, files, and a bounded failure excerpt.

**Non-goals:**
- Not a replacement for `no_file_conflicts` (static, pre-dispatch) — this is the dynamic complement.
- Not semantic-conflict detection beyond what running the gate catches (no AST cross-task analysis).
- Not gating the *integrated* base after prior merges — see Decision 1 trade-off (gate runs
  per-worktree, in isolation). Acceptable because tasks never see each other's uncommitted work today
  (merge is one batched `git apply` pass after all tasks complete).
- **Not** covering the consumer-dispatch path (`executeParallelDispatch` — child-flows,
  `isolation:none`, flag-off). That path runs agents in Compose, not Stratum's `_run_one`, so it needs
  a separate Compose-side gate — deferred follow-up. v1 is server-dispatch only.
- No `force`/bypass of the gate (consistent with STRAT-GUARD discipline).

## Decision record (Phase 1, locked with user 2026-06-04)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Where the gate lives | **Stratum `pre_merge_verify` IR field**, run per-worktree before diff capture, **server-dispatch only** | The gate runs in `ParallelExecutor._run_one`, which is reached **only** by the server-dispatch path (`parallelStart`/poll). It covers GSD + build (both use `executeParallelDispatchServer`). Trade-off accepted: gates the diff in isolation, not atop the integrated base. |
| D2 | v1 scope | **Both** gate-bounce + conflict-bounce, **server-dispatch path only** | They share one bounce record; delivering both is barely more than one and is what flips COMP-GSD-3 → COMPLETE (its `feature.json` requires both; GSD is server-dispatch). |
| D3 | Gate cost + source of truth | **Fast-gate default, single-source via a flow input** | Per-task gate defaults to `pnpm lint` + `pnpm build` (fast). The list is a **flow input** (`pre_merge_gate`) that both the *enforced* gate (resolved by Stratum) and the *instructed* gate (GSD's prompt template) read — one runtime value, no split-brain. Full `pnpm test` stays once at `ship_gsd`. Standard merge-queue economics. |

> **Two dispatch paths (Codex review, 2026-06-04).** Compose runs `parallel_dispatch` two ways:
> **server-dispatch** (`executeParallelDispatchServer` → `parallelStart`/poll → `parallelAdvance`, used
> by GSD + build) runs the agents *inside Stratum's `ParallelExecutor._run_one`* (worktrees + diff
> capture). **Consumer-dispatch** (`executeParallelDispatch` → `parallelDone`, used by child-flows /
> `isolation:none` / flag-off) runs the agents *in Compose* and never enters `_run_one`. A Stratum-side
> gate therefore **cannot** cover consumer-dispatch. **v1 scopes both gate and bounce to
> server-dispatch only** (the GSD/build path). Consumer-dispatch coverage (a Compose-side gate +
> `parallelDone` bounce) is a deferred follow-up — see Follow-ups. (GSD — the closing target — is
> server-dispatch, so this still closes COMP-GSD-3.)
>
> **No runtime pass-through via `parallelStart` (Codex review).** `parallelStart(flowId, stepId)` carries
> no payload slot. So `pre_merge_verify` is **authored in the pipeline YAML as a JSONPath reference to a
> flow input** (`pre_merge_verify: "$.input.pre_merge_gate"`), and Stratum resolves it at dispatch from
> the flow input — exactly how `source: "$.steps.decompose.output.tasks"` already resolves. The gate
> list enters as a flow input at flow start (the same place GSD already puts `gateCommands`), not pushed
> at task-dispatch time. This is what makes enforcement and instruction single-source.

## Chosen approach (cross-repo)

A single **bounce record** is the contract that unifies both failure kinds and flows
task-runner → Stratum → Compose retry prompt.

### Bounce record (the contract)

```jsonc
// contracts/par-merge-bounce.json  (new; _source = this design, _roadmap = COMP-PAR-MERGE-QUEUE)
{
  "task_id": "string",                       // which task to bounce
  "reason": "gate_failed" | "merge_conflict", // why
  "files":  ["string"],                       // files involved (gate: from diff; conflict: from git apply)
  "command": "string|null",                   // gate command that failed e.g. "pnpm build" (gate_failed only)
  "exit_code": "integer|null",                // gate exit code (gate_failed only)
  "excerpt": "string"                         // bounded (~2KB) tail of gate output OR git-apply error
}
```

### Stratum side (primary)

1. **IR field** (`spec.py` + v0.3 JSON schema): add optional `pre_merge_verify` to `parallel_dispatch`
   — a list of shell command strings, **authored in the pipeline YAML** and read from the parsed spec
   (no runtime pass-through; `parallelStart` has no payload slot). Backward-compatible (absent ⇒
   current behavior, byte-identical).
2. **Field resolution** (`parallel_exec.py` dispatch / `executor.py`): resolve `pre_merge_verify` from
   the flow input via JSONPath at dispatch (same machinery as `source`), yielding a list of command
   strings for the step. A literal list is also accepted.
3. **Gate execution** (`parallel_exec.py` `_run_one`): after the agent completes and **before**
   `capture_worktree_diff`, if the resolved `pre_merge_verify` is non-empty, run each command in the
   task's worktree (`cwd = worktree_path`, `core.hooksPath=/dev/null` like diff capture, per-command
   timeout reusing `task_timeout` semantics). First non-zero exit ⇒ set `ts.state = failed` and populate
   a `gate_failed` bounce record on the task state (`command`, `exit_code`, `excerpt` = bounded tail,
   `files` from `git diff --name-only`). Skip diff capture for a failed gate. All-pass ⇒ proceed to
   capture exactly as today.
4. **Surface gate failures** (`server.py`): extend the existing per-task failure surfacing
   (the `per_task_cert_strs` pattern) so a `gate_failed` task contributes a structured bounce record to
   the step's failure payload, not just a string.
5. **Widen the bounce channel** (`server.py` `stratum_parallel_advance` + `_evaluate_parallel_results`):
   accept an optional structured merge result from the consumer carrying `merge_conflict` bounce records
   (back-compat: a bare `clean`/`conflict` string still works). Merge-conflict bounce records from the
   consumer and gate-failed bounce records computed server-side are unified into one
   `bounced_tasks: [BounceRecord]` array on the `ensure_failed` envelope. *(Server-dispatch only; the
   `parallelDone`/consumer-dispatch widening is the deferred follow-up.)*

### Compose side (consumer, server-dispatch path)

6. **Gate as flow input (single source)**: set a `pre_merge_gate` flow input from `resolveGateCommands`
   — defaulting to `pnpm lint` + `pnpm build` (fast) — at flow start, the same value GSD's prompt
   template reads, so enforced and instructed gates can't diverge. Author
   `pre_merge_verify: "$.input.pre_merge_gate"` in `gsd.stratum.yaml` `execute` (and optionally
   `build.stratum.yaml`). Reconcile `gsd.js` so the per-task injected gate is the fast list and the full
   `pnpm test` runs once at `ship_gsd`.
7. **Conflict context out**: when `applyTaskDiffsToBaseCwd` detects a conflict, pass a structured
   `merge_conflict` bounce record (`task_id` = `conflictedTaskId`, `files`, `excerpt` = `conflictError`)
   through `parallelAdvance` instead of the bare `'conflict'` string.
8. **Retry-prompt injection** (`buildRetryPrompt`): when the `ensure_failed` envelope carries
   `bounced_tasks`, render them into the re-dispatched agent's prompt — per task: reason, files, and
   the excerpt — so the bounce is informed, not blind.

### Flow (after)

```
dispatch task → agent works in worktree
  → [NEW] run pre_merge_verify in worktree
       fail → ts.failed + gate_failed bounce record → (skip capture)
       pass → capture_worktree_diff (as today)
  → compose applyTaskDiffsToBaseCwd: git apply --check / apply
       conflict → merge_conflict bounce record → parallelAdvance(structured)   [NEW: was bare 'conflict']
  → server unifies gate_failed + merge_conflict → ensure_failed { bounced_tasks:[...] }   [NEW]
  → compose buildRetryPrompt injects per-task reason/files/excerpt   [NEW: was blind]
  → re-dispatch with context
```

## Alternatives considered (rejected)

- **Compose-owned merge queue (gate atop integrated base in `applyTaskDiffsToBaseCwd`).** Matches the
  ROADMAP's "replay each on the working tree" wording and catches cross-task integration failures.
  **Rejected (D1):** pushes the gate into compose-only (build path doesn't benefit other consumers),
  and the integrated-base advantage is moot today since tasks never see each other's uncommitted work
  (one batched apply pass). Revisit if `parallel_dispatch` ever commits between tasks.
- **Compose-only, no Stratum change.** Zero build-twice (TS port pending). **Rejected:** the retry
  loop routes through Stratum's `ensure_failed`; doing the bounce purely compose-side means
  short-circuiting the advance path and tighter coupling. The IR field is the cleaner seam.
- **Gate-only v1, defer conflict-bounce.** **Rejected (D2):** wouldn't complete COMP-GSD-3, and the
  conflict path reuses the same channel — splitting saves little.

## Risks & open questions

- **Build-twice:** the IR field re-lands in the TS port (`STRAT-TS-PORT`/T1-12). Accepted — keep the
  tool contract thin; consistent with how STRAT-GUARD/STRAT-WORKFLOW-* were built in Python now.
- **Gate cost on serial GSD:** GSD runs `max_concurrent: 1`, so the gate is N sequential fast-gate
  runs. Fast-gate default (lint+build, not full test) keeps this bounded; configurable per pipeline.
- **Excerpt sizing / secrets:** bound the excerpt (~2KB tail) and avoid echoing env. Confirm no
  credential leakage from gate stdout into the audit trail.
- **`parallelAdvance` back-compat:** existing callers pass `clean|conflict` strings; the structured
  form must be strictly additive. (Open: confirm all advance call sites in the blueprint.)
- **Flow-input field resolution:** `pre_merge_verify: "$.input.pre_merge_gate"` requires Stratum to
  resolve a JSONPath input reference to a *list of strings* on a step scalar field. `source` resolves a
  JSONPath today — confirm in the blueprint whether list-valued input resolution on this field needs
  new code or reuses existing resolution.
- **Single-source gate vs existing GSD contract:** reconciling `gateCommands` to a fast per-task list
  (lint+build) relaxes the per-task *test* instruction GSD gives today — net rigor still rises (the
  gate is now *enforced*, not just instructed, and full `pnpm test` still runs at `ship_gsd`). Confirm
  this is the intended GSD behavior change in the blueprint.
- **Worktree gate vs hooks:** run with `core.hooksPath=/dev/null` (as diff capture does) so repo git
  hooks don't fire inside the per-task gate.

## Acceptance criteria

- [ ] `pre_merge_verify` accepted on `parallel_dispatch` in `spec.py` + v0.3 schema; absent ⇒ byte-identical current behavior
- [ ] Stratum resolves `pre_merge_verify` from a flow-input JSONPath (e.g. `$.input.pre_merge_gate`) to a list of strings; literal list also accepted
- [ ] Gate commands run in the task worktree before diff capture; first failure ⇒ task `failed`, diff capture skipped (**server-dispatch path**)
- [ ] `gate_failed` produces a structured bounce record (`command`, `exit_code`, `files`, bounded `excerpt`)
- [ ] `parallel_advance` accepts a structured merge result carrying `merge_conflict` bounce records; bare `clean|conflict` still works
- [ ] `ensure_failed` envelope exposes a unified `bounced_tasks: [BounceRecord]` array
- [ ] Compose sets a `pre_merge_gate` flow input from `resolveGateCommands` (default `pnpm lint` + `pnpm build`); `gsd.stratum.yaml` `execute` references it; full `pnpm test` stays at `ship_gsd`
- [ ] `gsd.js` per-task gate is single-source: the resolved `pre_merge_verify` == the gate list injected into task prompts (no split-brain); honors `gateCommands` override
- [ ] Compose passes structured conflict context through `parallelAdvance` on conflict
- [ ] `buildRetryPrompt` injects per-task reason/files/excerpt for bounced tasks (no longer blind)
- [ ] Bounce-record contract committed in `contracts/` with `_source` + `_roadmap`
- [ ] Stratum full suite green; compose `pnpm test` green; cross-repo integration test exercises gate-fail-bounce and conflict-bounce end-to-end (server-dispatch)
- [ ] COMP-GSD-3 `feature.json` + ROADMAP reconciled PARTIAL → COMPLETE

## Follow-ups (deferred from v1)

- **COMP-PAR-MERGE-QUEUE-CONSUMER** — extend the gate + bounce to the consumer-dispatch path
  (`executeParallelDispatch` → `parallelDone`; child-flows / `isolation:none`). Needs a Compose-side
  gate (those agents don't run in Stratum's `_run_one`) and structured `parallelDone` bounce. Out of v1
  scope (GSD/build are server-dispatch).
- **Integrated-base gate** — gate each task's diff *after* it's applied atop prior merges (catches
  cross-task integration failures the isolated-worktree gate misses). Only relevant if
  `parallel_dispatch` ever commits between tasks.

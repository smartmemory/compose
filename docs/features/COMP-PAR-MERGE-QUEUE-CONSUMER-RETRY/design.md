# COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY — Consumer-path parallel retry loop: Design

**Status:** DESIGN (Phase 1 — intent, not yet implemented). `file:line` anchors are current-state references for the blueprint to verify, not claims of existing behavior.
**Date:** 2026-06-04
**Roadmap:** COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY (forge-top Standalone Ticket) · **Parent:** COMP-PAR-MERGE-QUEUE-CONSUMER (gate+surfacing v1, SHIPPED 2026-06-04) · **Grandparent:** COMP-PAR-MERGE-QUEUE (server-dispatch, SHIPPED 2026-06-04)
**Repos:** `compose/` only (the consumer dispatch path lives entirely in Compose; no Stratum change — the `parallelDone` `{status, bounced_tasks}` channel already exists).

## Problem

The parent v1 (CONSUMER, gate+surfacing) made Compose's **consumer-dispatch** path (`executeParallelDispatch` → `stratum_parallel_done`, the default for `compose build`) *prevent* a bad merge: a per-task pre-merge gate runs in each worktree, gate/conflict failures produce structured `ParMergeBounce` records, and the bounce surfaces on the `parallelDone` failure envelope. But it stopped at **surfacing** — three gaps remain (the deferred D4 + D5):

1. **No consumer-side retry loop.** When `parallelDone` returns `ensure_failed`/`schema_failed`, the envelope flows back into the outer `runBuild` loop and **mis-routes into the single-agent retry branch** (`build.js:1640`), which re-runs **one** agent in the **base** cwd and closes with `stratum.stepDone` — losing the parallel fan-out, worktree isolation, per-task gates, and the bounce context. The per-step retry cap eventually force-fails it via the wrong mechanism. The same mis-route exists in `executeChildFlow` (`build.js:2784`).
2. **The bounce is never injected into a re-run.** The structured `bounced_tasks` are surfaced but no re-dispatch consumes them, so even if a retry happened it would be **blind**.
3. **No build-mode opt-in.** The gate activates only for a `parallel_dispatch` step that *declares* `pre_merge_verify`; `build.stratum.yaml` does not, so `compose build`'s default path has no gate at all.

The grandparent solved (1)+(2) for the **server** path: `executeParallelDispatchServer` owns a retry loop (`build.js:3244-3268`) that re-dispatches the failed subset, with Stratum computing the subset and injecting bounces **server-side**. The consumer path is the symmetric opposite — Compose runs the agents, so the loop, the subset math, and the bounce injection must all live **Compose-side**.

### Verified current state (verify-first, 2026-06-04 — from two source sweeps)

| Fact | Location |
|------|----------|
| `executeParallelDispatch(dispatchResponse, stratum, context, progress, streamWriter, baseCwd, parentFlowId)` — consumer dispatch | `build.js:3577` |
| Tasks fan out into `.compose/par/<taskId>` worktrees; agent runs via `runAndNormalize` in `taskCwd` | `build.js:3642-3650`, `:3737` |
| v1 pre-merge gate `runPreMergeGateLocal(wtPath, gateCmds, baseCwd, timeout)` runs in-worktree **before** diff capture; fail ⇒ `{status:'failed', gateBounce}`, diff skipped | `build.js:3749-3763` |
| Diff captured (`git add -A` / `git diff --cached HEAD` → `taskDiffs`) only if the gate passed | `build.js:3778-3782` |
| Aggregate built: `taskResults[] = {task_id, status:'complete', result} \| {task_id, status:'failed', error}`; `bouncedTasks[]` collects gate bounces | `build.js:3820-3830` |
| **`applyTaskDiffsToBaseCwd` applies good diffs to base SYNCHRONOUSLY at `:3834`, BEFORE `parallelDone` at `:3882`** | `build.js:3834`, `:3882` |
| On merge conflict, `applyTaskDiffsToBaseCwd` rolls the base back (`git checkout -- . && git clean -fd`) and **breaks** → net **no diffs applied**, `mergeStatus:'conflict'` + `conflictedTaskId` | `build.js:3451-3477` |
| `parallelDone(flowId, stepId, taskResults, mergeArg)` — `mergeArg = {status, bounced_tasks}` when bounces exist, else bare string; returns the next envelope | `build.js:3879-3882` |
| Returned `ensure_failed`/`schema_failed` mis-routes to the single-agent branch (one agent, base cwd, `stratum.stepDone`) | `build.js:1640`, `:1718-1755` |
| Same mis-route in `executeChildFlow`'s `ensure_failed` branch | `build.js:2784-2843` |
| Call sites that reassign the parallel envelope into the loop var | `build.js:1830` (runBuild), `:2863` (executeChildFlow) |
| **Server reference** retry loop: detect `ensure_failed/schema_failed` + `Array.isArray(out.tasks)` + `out.step_id===stepId` + `redispatchDepth<10` → recurse, terminal events suppressed until final | `build.js:3244-3268` |
| Prompt build hook for each dispatched task: `buildStepPrompt(syntheticDispatch, context)` | `build.js:3703` |
| Server-side bounce injection to mirror: `_format_bounce_for_prompt` + `_render_prompt` | `stratum-mcp/.../parallel_exec.py:154-185`, `:437-446` |
| Stale note flagging consumer injection as not-yet-done | `step-prompt.js:165-169` |
| `ParMergeBounce` contract (task_id, reason `gate_failed\|merge_conflict`, files, command, exit_code, excerpt) | `contracts/par-merge-bounce.json` |
| Bounce constructors (reuse, do not rebuild) | `buildMergeConflictBounce` `build.js:3315`, `runPreMergeGateLocal` `build.js:3355` |
| D5 opt-in surfaces: `build.stratum.yaml` `execute` step + `input` blocks | `pipelines/build.stratum.yaml:14-20,189-192,339-359` |
| GSD reference for the opt-in: `pre_merge_verify: "$.input.pre_merge_gate"` + `resolvePreMergeGate` | `gsd.stratum.yaml:21-23,42,96-105`; `gsd.js:131,267-271,456-474` |
| `startFresh(...)` builds `planInputs` (the 5 runBuild call sites: 871/874/887/898/908) | `build.js:3885-3913` |
| `composeConfig` already parsed; `capabilities.*` booleans in `.compose/compose.json` | `build.js:620-627` |

## Goal

Bring the grandparent's retry-with-context guarantee to the consumer path, Compose-side, and make `compose build` opt into the gate by config — **byte-identical when the gate is off / no failure occurs**.

1. `executeParallelDispatch` **owns its retry loop**: on a parallel `ensure_failed`/`schema_failed`, re-run the **failed subset** (not one base-cwd agent) with bounce-injected prompts, until the step passes or a cap is hit — returning only a **terminal** envelope so the outer loops never re-handle it.
2. **Compose-side bounce injection** into each re-run task's prompt (port the server's `_format_bounce_for_prompt`).
3. **Fix the single-agent mis-route** for both `runBuild` (`build.js:1640`) and `executeChildFlow` (`build.js:2784`) — a parallel envelope must never fall into the single-agent branch.
4. **D5 opt-in**: wire a config-gated `pre_merge_gate` flow input into `build.stratum.yaml`'s `execute` step, **default OFF**.

**Non-goals:** no change to the server-dispatch path or the gate semantics; no new bounce kinds; no Stratum change (the `{status, bounced_tasks}` channel and the `tasks` surface on the failure envelope already exist).

## The crux: retry state model (the one real decision)

The hard part the parent's design gate flagged: **the consumer path's base state after a failed round differs by failure kind**, because successful diffs are applied to base *before* `parallelDone`:

- **gate-failure round** (`mergeStatus:'clean'`, ≥1 task `gate_failed`): the successful tasks' diffs **are in base**; the gate-failed tasks have no diff. A naive "re-run everything" would replay the good diffs.
- **conflict round** (`mergeStatus:'conflict'`): `applyTaskDiffsToBaseCwd` already **rolled the base back** to its pre-round state — **no diffs are in base**, and `conflictedTaskId` names the loser.

So there is no single "current base" to retry from. Three models:

| Model | Mechanism | Pros | Cons |
|-------|-----------|------|------|
| **A — re-run all from a clean snapshot** (server-semantics) | Snapshot base at round start; each retry restore to snapshot and re-run **every** task (bounce prompts for failed ones) | Uniform, simplest control flow, mirrors the server mental model | Re-runs successful agents (wasteful tokens); agents are non-deterministic, so prior good work can regress |
| **B — failed-only, carry-forward in place** | Keep applied good diffs in base; re-run only the failed subset; apply new diffs on top | Most efficient | "Carry-forward" is ill-defined for the **conflict** round (base was rolled back); base-state branches by failure kind → fragile bookkeeping |
| **C — failed-only, replay successful captured diffs onto a per-round anchor** | Each retry: build a **throwaway anchor commit** = round-start HEAD + replayed successful captured `taskDiffs` (no agent re-run); create the failed-subset retry worktrees off **that anchor** (not bare HEAD); re-run only the failed subset with bounce prompts → re-capture → `applyTaskDiffsToBaseCwd(union)` → re-gate/merge → recompute subset; drop the anchor | Preserves successful **work** without re-running agents; the failed task now *sees* the round's successful changes (better than round 0's blind fan-out), so conflict-avoidance bounces are meaningful | Needs the anchor-commit machinery — task worktrees are `git worktree add --detach HEAD` (`build.js:3646`), so replaying into the base worktree alone does **not** seed retry worktrees (Codex design-gate, 2026-06-04); more bookkeeping than A |

**The worktree-seeding constraint (Codex catch):** every task worktree is created `--detach HEAD` (`build.js:3646`) and the agent runs there (`build.js:3737`); successful diffs are `git apply`-ed to the *base working tree*, never committed. So "replay good diffs into base" does **not** make a retry task's fresh worktree see them. Model C therefore requires a per-round **anchor commit** (HEAD + replayed good diffs) that retry worktrees branch from. Model A sidesteps this entirely (it re-runs *all* tasks off the clean round-start HEAD, exactly like round 0 — no seeding question), which is why A is materially simpler.

**Conflict-round subset rule (must be explicit — Codex catch):** `applyTaskDiffsToBaseCwd` stops at the **first** conflict, rolls the base back, and marks only `conflictedTaskId` failed; tasks topologically **after** the conflict were never applied yet still read `status:'complete'`. So the re-run subset is **not** simply "failed `taskResults` ∪ `bounced_tasks[].task_id`". Rule: re-**run** only the conflict-loser (+ any gate-failed tasks); the never-applied later tasks are **re-applied** (replayed) at merge after the loser's new diff lands — and if one of *them* then conflicts, it becomes the next round's loser. A task is re-run only when its own work is rejected (gate fail or it is the conflict-loser), never merely because an earlier task in topo order conflicted.

**DECISION (gate, 2026-06-05): C.** The user chose the efficient faithful-mirror model over the simpler fallback A. C retains successful results, re-runs only the rejected subset, and seeds the retry worktrees from a throwaway per-round anchor commit (HEAD + replayed good diffs) so re-run tasks see the round's successful work. The blueprint owns the anchor-commit git sequence, the per-round subset/diff bookkeeping, and the conflict-round rule. (A is retained here only as documented context, not the path taken.)

## Decisions (Phase 1)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Retry loop ownership | `executeParallelDispatch` wraps its terminal `parallelDone` (`build.js:3882`): capture the envelope; if `ensure_failed/schema_failed` **and** `Array.isArray(env.tasks)` **and** `env.step_id===dispStepId` **and** depth < cap → re-enter (loop, not recursion, to keep diff/subset state local); else return it. Mirrors the server guard at `build.js:3250-3253`. | Keeps the parallel envelope from ever reaching the single-agent branch; one place owns the subset+diff state. |
| D2 | Retry state model | **C — CONFIRMED at design gate (2026-06-05).** Failed-subset re-run; replay successful captured diffs onto a throwaway per-round anchor commit that retry worktrees branch from. | Preserves successful work (no agent-regression), faithful mirror of the shipped server loop. User chose C over the simpler fallback A. See "The crux" above. |
| D3 | Bounce injection | Port `_format_bounce_for_prompt` (`parallel_exec.py:154-185`) to JS; append after `buildStepPrompt` at `build.js:3703` when the task carries an inbound bounce (Compose keys it locally by `task_id` from the prior round's `bounced_tasks`). Update the stale `step-prompt.js:165-169` note. | Compose owns prompt-building on this path; this is the symmetric mirror of the server's `_render_prompt`. |
| D4 | Mis-route fix | At `build.js:1640` and `build.js:2784`, a parallel-shaped `ensure_failed` (carries `tasks`/`step_id` of the just-dispatched parallel step) must NOT enter the single-agent branch. Cleanest: `executeParallelDispatch` only ever returns a **terminal** envelope (D1), so the branches are never reached with a parallel envelope; add a defensive guard if a parallel envelope still appears (re-route to the parallel handler or hard-fail, never single-agent). Confirm `executeChildFlow` doesn't double-handle. | Removes the pre-existing latent bug for both top-level and child flows. |
| D5 | Build-mode opt-in | Add `pre_merge_gate` to `build.stratum.yaml`'s `workflow.input` + `flows.build.input` (declared `required: false`); add `pre_merge_verify: "$.input.pre_merge_gate"` to the `execute` step (copy GSD verbatim). Gate on a default-OFF `compose.json` flag (`capabilities.preMergeGate`): **when off, omit the `pre_merge_gate` key from `planInputs` entirely and do NOT call `resolvePreMergeGate`** (it defaults to `DEFAULT_FAST_GATE`, not `[]`); when on, resolve once via `resolvePreMergeGate` (`gsd.js:474`) and thread through `startFresh`'s `planInputs` (one new param, all 5 sites). | True byte-identical = **field absent**, not `pre_merge_gate: []` (which already changes the plan/input envelope — Codex catch). With the key omitted, the whole opt-in is invisible to the flow. Reuses the GSD resolver, no new mechanism. |
| D6 | Termination | Honor the step's configured `retries` (parse from spec like COMP-FIX-HARD's retry-cap enforcement) with a defensive ceiling mirroring the server's `redispatchDepth < 10`. Terminal round → emit the real `build_step_done`, suppressing intermediate step events (mirror `build.js:3270`). | Bounded, observable, matches the server's event discipline. |

## Flow (after, model C)

```
executeParallelDispatch:
  round = 0; subset = all tasks; goodDiffs = {}
  loop:
    anchor = (round == 0) ? HEAD : throwaway commit(HEAD + replay goodDiffs)   # seeds retry worktrees
    run `subset` tasks in worktrees created off `anchor`, bounce-injected prompts for inbound bounces
    per task: pre-merge gate (v1) -> capture diff on pass / gate_failed bounce on fail
    merge: applyTaskDiffsToBaseCwd(goodDiffs-from-prior + new diffs)  -> conflict => merge_conflict bounce(loser)
    drop anchor (restore base)
    parallelDone(flowId, stepId, taskResults, {status, bounced_tasks})
      clean + require satisfied => terminal complete -> emit build_step_done, return
      ensure_failed w/ tasks =>
         goodDiffs += this round's accepted diffs (clean-applied tasks)
         subset = gate-failed tasks U conflict-loser   # NOT later-topo never-applied tasks (they replay)
         round++; if round > cap -> return terminal ensure_failed (force-fail); else continue
```

## Risks / open questions

- **Hot path.** `executeParallelDispatch` is `compose build`'s default. Invariant to preserve and test: **absent `pre_merge_verify` AND a clean first round ⇒ byte-identical to today** (no snapshot, no extra apply). The retry machinery only engages on a parallel failure — which today mis-routes anyway, so engaging it is strictly an improvement, but the success path must not change.
- **Anchor mechanism (C).** Retry worktrees branch off a throwaway anchor commit (HEAD + replayed good diffs) since `git worktree add --detach HEAD` can't see base-worktree changes. Base may also carry pre-existing dirty state (`applyTaskDiffsToBaseCwd` already `git stash`es it); the anchor must compose with that stash discipline without losing the user's uncommitted work, and the anchor commit must be dropped (not left on any ref) — blueprint pins the exact `git` sequence. **A avoids all of this** (re-run all off clean HEAD), the main reason it's a serious fallback.
- **Conflict-round subset (now an explicit rule, above).** Re-run only the conflict-loser + gate-failed tasks; never-applied later-topo tasks replay at merge and only bounce if they then conflict. Blueprint adds a test for a 3-task conflict where task 3 is topo-after the loser.
- **`executeChildFlow` double-handle.** Its own `ensure_failed` fix/retry branch (`build.js:2784-2843`) must never see the parallel envelope (D4). Add a test that a child-flow parallel failure retries in-place, not via the single-agent fix.
- **`isolation:none`.** No per-task worktree/diff ⇒ gate is a no-op and there's nothing to replay; the retry-routing fix (D4) still applies (re-run subset without diff bookkeeping). Keep that path simple.
- **Model A fallback** is materially simpler; if the captured-diff replay (C) proves fiddly in the blueprint, A is the documented escape hatch — decide at the gate, not mid-implementation.

## Acceptance criteria

- [ ] `executeParallelDispatch` owns a bounded retry loop; a parallel `ensure_failed`/`schema_failed` re-runs the **failed subset** (not a single base-cwd agent) and returns only a **terminal** envelope
- [ ] Bounce context injected into each re-run task's prompt (ported `_format_bounce_for_prompt`); `step-prompt.js:165-169` note updated
- [ ] The single-agent mis-route is fixed for **both** `runBuild` (`build.js:1640`) and `executeChildFlow` (`build.js:2784`) — covered by tests
- [ ] Retry state model implemented per the gate decision (C recommended; A fallback), correct across **both** a gate-failure round and a conflict round
- [ ] `build.stratum.yaml` opt-in: `pre_merge_gate` input + `pre_merge_verify` on `execute`, resolved once, **gated default-OFF**; when off the `pre_merge_gate` key is **omitted** from `planInputs` (not `[]`) and `resolvePreMergeGate` is not called
- [ ] **Byte-identical when off:** field absent from the plan envelope; and on the success path (no snapshot/anchor/extra apply when `pre_merge_verify` absent and round 0 is clean) — asserted by a plan-input envelope test, not just runtime behavior
- [ ] Bounded by step `retries` + defensive depth ceiling; intermediate step events suppressed, terminal `build_step_done` emitted once
- [ ] Full compose suite green; new tests: retry-subset re-run, bounce-prompt injection, mis-route fix (both loops), gate-round vs conflict-round state model, default-OFF byte-identical
- [ ] Reuses `ParMergeBounce` + `buildMergeConflictBounce` + `runPreMergeGateLocal` + `applyTaskDiffsToBaseCwd` + `resolvePreMergeGate` (no parallel rebuild)

## Reuse (no rebuild)

`applyTaskDiffsToBaseCwd` (returns `conflictFiles`), `buildMergeConflictBounce`, `extractConflictFiles`, `runPreMergeGateLocal`, the `ParMergeBounce` contract, `resolvePreMergeGate` (gsd.js), and the `parallelDone` `{status, bounced_tasks}` channel all exist. New code = the Compose-side retry loop + subset math + captured-diff replay + the JS bounce formatter + the `build.stratum.yaml` opt-in wiring.

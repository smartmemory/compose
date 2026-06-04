# COMP-PAR-MERGE-QUEUE — Implementation Report

**Status:** SHIPPED · **Date:** 2026-06-04 · **Design:** [design.md](design.md) · **Blueprint:** [blueprint.md](blueprint.md)
**Repos:** `stratum/stratum-mcp/` (primary) + `compose/` (consumer). **Closes:** COMP-GSD-3 (PARTIAL → COMPLETE).

## What shipped

A **per-task pre-merge verify gate** for Stratum's `parallel_dispatch`, plus structured **bounce records**
(gate-failed / merge-conflict) that flow back into the re-dispatched task's prompt — so a parallel task
that fails its gate or conflicts at merge is rejected *before* polluting base, and re-runs *informed*.

### Stratum (substrate)
- **`pre_merge_verify` IR field** (`spec.py`): optional list of shell commands OR a `$.input.*` JSONPath
  ref, on `parallel_dispatch`. Absent ⇒ byte-identical (no gate). Tamper-detected via `_step_fingerprint`
  (`executor.py`).
- **Worktree gate** (`worktree.py` `run_pre_merge_gate`): runs each command in the task worktree *before*
  diff capture; best-effort symlinks `node_modules` from base (bare worktrees lack it); first non-zero exit
  (or not-found / timeout) ⇒ a `gate_failed` bounce record. Wired in `parallel_exec.py` `_run_one` after
  cert resolution; **diff capture is skipped** for a gate-failed task (its work never merges).
- **Bounce channel** (`server.py`): gate bounces collected into `ensure_failed.bounced_tasks[]`;
  `stratum_parallel_advance` accepts `merge_status` as a bare string (back-compat) OR a structured
  `{status, bounced_tasks}` carrying consumer-computed merge-conflict bounces.
- **Bounce-into-reprompt** (`parallel_exec.py`): a re-dispatched task's prompt carries its prior-attempt
  bounce. The executor snapshots inbound bounces (`_inbound_bounces`) at construction, `_run_one` clears
  the task's bounce for a fresh attempt, and `_render_prompt` appends `_format_bounce_for_prompt(...)`.
  Merge-conflict bounces are persisted onto the conflicting task's state by `stratum_parallel_advance`.

### Compose (consumer)
- **Merge-conflict bounce** (`build.js`): `extractConflictFiles` + `buildMergeConflictBounce`; the
  deferred-advance path sends the structured `{status:'conflict', bounced_tasks:[…]}` payload.
- **Parallel retry loop** (`build.js`): `executeParallelDispatchServer` now **owns** the parallel retry —
  on an `ensure_failed`/`schema_failed` parallel outcome it re-dispatches the same step (carrying
  `isolation`/`capture_diff` forward so the re-run still merges), depth-capped, returning only terminal
  results. `runGsd` treats a terminal `error` (retries_exhausted) as a clean failure.
- **GSD wiring** (`gsd.js` + `pipelines/gsd.stratum.yaml`): a `pre_merge_gate` flow input
  (`resolvePreMergeGate`, default `pnpm lint` + `pnpm build`) is single-sourced into both the enforced gate
  (`execute.pre_merge_verify: $.input.pre_merge_gate`) and the instructed per-task gate; the execute step
  gains `defer_advance: true`; full `pnpm test` stays at `ship_gsd`.
- **Contract**: `contracts/par-merge-bounce.json` (`ParMergeBounce`).

## Deviations from the blueprint (discovered during implementation + review)

The blueprint's mental model was that the bounce reaches the re-run task via Compose's `buildRetryPrompt`.
**Codex review of the implementation falsified this** (the first review round, must-fix):

1. **The bounce delivery had to move server-side.** Stratum re-resolves the task list from flow state on
   each re-dispatch, so a Compose-side prompt edit never reaches the re-run task. The injection now lives in
   Stratum's `ParallelExecutor._render_prompt`. The original Compose-side `buildBounceSection`/`buildRetryPrompt`
   wiring was **removed as dead code**.
2. **Parallel-step retry routing was broken/regressing.** Making `_advance_after_parallel` return
   `ensure_failed` (necessary so a gate-failed task can't silently advance past — e.g. GSD `execute` → `ship`)
   exposed that neither outer loop re-dispatched a failed *parallel* step: `runGsd` threw `unknown response
   status`, and `runBuild` would have retried it as a single agent. The fix made
   `executeParallelDispatchServer` own the parallel retry loop (one place; fixes build mode, GSD, and child
   flows uniformly) and taught `runGsd` to handle terminal failure.

These were genuine design-time gaps the blueprint did not anticipate; they were resolved under the
"full fix" scope chosen with the user rather than deferred.

## Verification

- **Stratum:** full suite **1409 passed, 2 skipped**. New: `tests/test_par_merge_queue.py` (resolution, gate
  runner, node_modules symlink, bounce-into-reprompt) + `test_parallel_server_dispatch.py` (gate-bounce
  surfacing, structured-conflict advance, re-dispatch is covered compose-side).
- **Compose:** full `node --test` suite **3401 passed, 0 fail**. New: `test/par-merge-queue.test.js` +
  `test/parallel-dispatch-server-defer.test.js` (parallel `ensure_failed` re-dispatch recursion;
  no-regression on success).
- **Codex review:** 3 rounds → **REVIEW CLEAN**. Round 1 caught the two design-gap must-fixes above; round 2
  confirmed the fixes and flagged a `build_step_done` event-ordering should-fix; round 3 confirmed clean.

## Acceptance criteria

All design acceptance criteria met. The two bounce kinds (gate-failed + merge-conflict) are both produced,
surfaced on `ensure_failed.bounced_tasks[]`, and **injected into the re-dispatched task's prompt** — closing
COMP-GSD-3's residual (per-task pre-merge gating + conflict-bounce-with-context).

## Follow-ups

- **COMP-PAR-MERGE-QUEUE-CONSUMER** — extend the gate + bounce to the consumer-dispatch path
  (`executeParallelDispatch` → `parallelDone`; child-flows / `isolation:none`). Out of v1 (GSD/build are
  server-dispatch). The IR field re-lands in the TS port (`STRAT-TS-PORT`).

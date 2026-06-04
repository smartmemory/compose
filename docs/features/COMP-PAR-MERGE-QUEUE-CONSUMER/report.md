# COMP-PAR-MERGE-QUEUE-CONSUMER — Implementation Report

**Status:** SHIPPED (v1: gate + surfacing) · **Date:** 2026-06-04 · **Design:** [design.md](design.md)
**Parent:** COMP-PAR-MERGE-QUEUE (server-dispatch, shipped 2026-06-04) · **Repos:** `compose/` (primary) + `stratum/` (small).

## What shipped (v1 = gate + surfacing)

Brings the per-task pre-merge gate + structured bounce records to Compose's **consumer-dispatch** path
(`executeParallelDispatch` → `stratum_parallel_done`) — the default for `compose build` (agents run in
Compose, not Stratum's `_run_one`). The parent feature only covered server-dispatch (GSD).

- **Stratum:** one shared resolver `resolve_pre_merge_verify` (`executor.py`) used by both the
  server-start site (`server.py`, via an import alias) and `get_current_step_info`, which now **surfaces
  the resolved `pre_merge_verify` on the parallel_dispatch dispatch envelope** (only when non-empty, so a
  no-gate step is byte-identical). `stratum_parallel_done` accepts `merge_status: str | dict`.
  `_evaluate_parallel_results` derives **human-readable violation strings** from the structured bounces
  (appended to `per_task_cert_strs`, which flows to every failure envelope) so a gate failure is actionable.
- **Compose:** `runPreMergeGateLocal` (the consumer-dispatch mirror of Stratum's `run_pre_merge_gate` —
  node_modules symlink, per-command run, bounded excerpt, changed-files) runs in each task's worktree in
  `executeParallelDispatch` **before diff capture**; a gate failure marks the task failed, records a
  `gate_failed` bounce, emits a `build_error` stream event, and **skips diff capture** (the bad work never
  merges). Gate-failed + merge-conflict bounces are collected and passed to `parallelDone` via a structured
  `{status, bounced_tasks}` `merge_status` (bare string when no bounces — byte-identical).
- **Reuse:** `applyTaskDiffsToBaseCwd` (+`conflictFiles`), `buildMergeConflictBounce`, the `ParMergeBounce`
  contract, and the `merge_status` str|dict channel all came from the parent — no parallel rebuild.

## Scope decisions (locked with the user 2026-06-04)

The Codex **design gate** approved the approach and caught one real design gap before any code: the
consumer retry state-model is materially heavier than the server path's (Compose applies successful diffs to
base *before* `parallelDone`, so a re-run can't naively replay onto a mutated base). Given that, v1 was
**narrowed to gate + surfacing**, deferring the retry loop:

- **D4 (retry-with-context loop) → DEFERRED** to follow-up **COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY**:
  `executeParallelDispatch` owning its retry loop (re-run from a rolled-back-clean base or failed-only with
  carry-forward), Compose-side bounce injection into the re-run prompt, and fixing the pre-existing
  single-agent mis-route of a parallel `ensure_failed` (runBuild + child flows). v1 *prevents* the bad merge
  (the high-value part) and surfaces the bounce; the informed re-run is the follow-up.
- **D5 (build.stratum.yaml default-OFF opt-in) → DEFERRED** with the retry follow-up. v1's gate activates
  for **any** `parallel_dispatch` step that declares `pre_merge_verify` — a complete, tested, usable feature
  that does **not** change `compose build`'s default behavior (truly byte-identical unless a step opts in).

## Verification

- **Stratum:** full suite **1413 passed, 2 skipped**. New tests: dispatch-surface carries/omits the resolved
  gate; `_evaluate_parallel_results` surfaces structured consumer bounces + readable violations.
- **Compose:** full `node --test` suite **3395 passed, 0 fail**. New tests: `runPreMergeGateLocal`
  (pass/fail/empty/exit-code/excerpt-bound/changed-files/node_modules-symlink).
- **Codex review:** design gate (approach sound, 1 must-fix design gap → narrowed scope) + 1 impl round
  (no must-fix; 1 byte-identical should-fix + doc nits, all fixed) + confirmation → **REVIEW CLEAN**.

## Follow-ups

- **COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY** — the deferred D4 + D5 (consumer retry loop with Compose-side
  bounce injection, the single-agent-misroute fix, and the `build.stratum.yaml` default-OFF opt-in).

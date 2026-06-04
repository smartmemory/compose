# Session 54: COMP-PAR-MERGE-QUEUE-CONSUMER — gate on the consumer-dispatch path (v1)

**Date:** 2026-06-04
**Feature:** COMP-PAR-MERGE-QUEUE-CONSUMER (forge-top Standalone Ticket; impl cross-repo stratum + compose)

## What happened

Right after shipping COMP-PAR-MERGE-QUEUE (the server-dispatch gate that closed COMP-GSD-3), the human picked
its follow-on: extend the per-task pre-merge gate to Compose's **other** dispatch path. The verify-first
sweep surfaced the scoping fact that made this worth doing — `shouldUseServerDispatch` returns false unless
`COMPOSE_SERVER_DISPATCH=1`, so **consumer-dispatch (`executeParallelDispatch` → `stratum_parallel_done`) is
the default for `compose build`**. The parent gate only covered server-dispatch (GSD). So a default `compose
build` parallel task could still merge a lint/build-failing diff.

We ran the full lifecycle, and this time leaned on the **Codex design gate** before writing code — which
paid off immediately. Codex approved the approach (surface the resolved gate on the dispatch envelope;
Compose-side gate; structured `parallelDone`) but caught a must-fix **design** gap: the consumer retry
state-model is materially heavier than the server path's. The server path re-dispatches by re-running ALL
tasks in fresh worktrees off base; the consumer path **applies successful diffs to base before
`parallelDone`**, so a naive whole-step re-dispatch would replay already-applied diffs onto a mutated base.
A correct retry needs failed-only-re-run-with-carry-forward, or roll-base-back-to-clean-and-re-run-all.

That's a real chunk of work on `compose build`'s default path. We surfaced it as a **scope decision** and the
human chose **gate + surfacing first** (low-risk): ship the gate (which *prevents* the bad merge — the
high-value part) + bounce surfacing, and defer the retry loop to `COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY`. The
implementation then went clean: a lot reused from the parent (`applyTaskDiffsToBaseCwd`+`conflictFiles`,
`buildMergeConflictBounce`, the `merge_status` str|dict channel, the `ParMergeBounce` contract), and the new
pieces were a shared resolver + dispatch-surface field (Stratum) and `runPreMergeGateLocal` + structured
`parallelDone` (Compose). The Codex impl review found no must-fix; one byte-identical should-fix (surface the
field only when non-empty) + doc nits, all fixed; confirmation → CLEAN.

## What we built

- **Stratum:** `executor.py` — shared `resolve_pre_merge_verify` + the resolved gate surfaced on the
  `get_current_step_info` parallel envelope (omitted when empty). `server.py` — `stratum_parallel_done`
  accepts `merge_status: str | dict`; `_evaluate_parallel_results` derives readable violation strings from
  the structured bounces; the resolver de-duplicated to an import alias.
- **Compose:** `lib/build.js` — `runPreMergeGateLocal` (worktree gate runner: node_modules symlink,
  per-command, bounded excerpt, changed-files), gate wired into `executeParallelDispatch` before diff
  capture (fail → task failed + bounce + skip diff), gate/conflict bounce collection → structured
  `parallelDone`. `lib/stratum-mcp-client.js` — `parallelDone` JSDoc.
- **Docs/reconciliation:** `report.md`, `feature.json` (COMPLETE), CHANGELOGs (both repos), forge-top
  ROADMAP row + the `COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY` follow-up.

## What we learned

1. **The design gate earns its keep when it catches a *state-model* gap, not a typo.** The parent feature's
   analogous retry issue surfaced at *impl* review (costly). Here, doing a real design-gate pass first
   surfaced the "Compose mutates base before parallelDone" trap *before* any code — and turned it into a
   clean scope decision instead of a mid-build pivot.
2. **Verify-first reframes value.** "Consumer-dispatch is a rare legacy path" was the assumption; the
   `shouldUseServerDispatch` default flipped it to "this is the default build path," which is what justified
   the work at all.
3. **Narrow ≠ inert.** Shipping the gate without the retry loop still delivers the core guarantee (bad diffs
   don't merge) and surfaces the bounce; the informed re-run is a clean follow-up, not a missing half.

## Open threads

- [ ] **COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY** (filed): the consumer retry loop (re-run model + Compose-side
      bounce injection), the pre-existing single-agent-misroute fix for `runBuild` + `executeChildFlow`, and
      the `build.stratum.yaml` default-OFF opt-in.
- [ ] Not yet pushed — commits land on `main` in both repos pending the human's push call.

Two features in a day on the same seam: the parent prevented bad merges for GSD; this one does it for the default build path.

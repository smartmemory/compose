# Session 53: COMP-PAR-MERGE-QUEUE — per-task pre-merge gate + bounce-with-context (closes COMP-GSD-3)

**Date:** 2026-06-04
**Feature:** COMP-PAR-MERGE-QUEUE (forge-top Standalone Ticket; impl cross-repo stratum + compose)

## What happened

The human picked COMP-PAR-MERGE-QUEUE off the forge-top roadmap — the last open piece of the COMP-GSD
umbrella, carrying GSD-3's residual: a *per-task pre-merge gate* and *conflict-bounce-with-context*. A
design.md + blueprint.md already existed from earlier the same day (decisions locked with the human), so we
verified the anchors against on-disk source (two parallel read-only sweeps surfaced four load-bearing
corrections — `_step_fingerprint` lives in `executor.py` not `spec.py`; `ParallelTaskState` likewise; the
active pipelines are `compose/pipelines/`; `ensure_failed` returns span two server.py functions) and built
in topology order: contract → Stratum IR field → resolution → worktree gate → bounce channel → Compose
conflict bounce → retry-prompt → GSD wiring. TDD throughout; both full suites green.

Then the Codex review gate earned its keep. **Round 1 found two must-fixes the blueprint never anticipated:**

1. The bounce-with-context delivery couldn't work as designed. The blueprint routed it through Compose's
   `buildRetryPrompt`, but Stratum **re-resolves the task list from flow state on every re-dispatch**, so a
   Compose-side prompt edit never reaches the re-run task. The injection had to move *server-side* into
   `ParallelExecutor._render_prompt`, and the Compose `buildBounceSection` we'd just written was dead code.

2. Making `_advance_after_parallel` return `ensure_failed` (necessary so a gate-failed task can't silently
   advance past — GSD `execute` would otherwise proceed to `ship` with broken work) exposed that **neither
   outer loop re-dispatched a failed parallel step**: `runGsd` threw `unknown response status`, and `runBuild`
   would have retried a parallel step as a single agent. `process_step_result` only evaluates `ensure`
   clauses, and GSD's `execute` has none — so the failure surfaced as `"ok"` and the loops mis-routed it.

The human chose the full fix (closes GSD-3) over narrowing. The fix made `executeParallelDispatchServer`
**own the parallel retry loop** — on a parallel `ensure_failed` it re-dispatches the same step (one place,
fixes build/GSD/child-flow uniformly), carrying `isolation`/`capture_diff` forward (the parallel *surface*
omits them — a 30s SIGABRT debugging session traced an infinite recursion to a *test stub* returning the
same poll object by reference, which production mutation then poisoned; production returns fresh JSON each
poll, so the bug was the stub). `runGsd` learned to treat terminal `error` as a clean failure. Round 2
confirmed the fixes and flagged a `build_step_done` event-ordering should-fix; round 3 → REVIEW CLEAN.

## What we built

- **Stratum** (`stratum-mcp/`): `spec.py` (`pre_merge_verify` IR field + schema + builder), `executor.py`
  (fingerprint inclusion + `ParallelTaskState.gate_bounce`), `worktree.py` (`run_pre_merge_gate` +
  `_symlink_node_modules` + `_gate_changed_files`), `parallel_exec.py` (gate call in `_run_one`, capture
  skip on gate fail, `_inbound_bounces` + `_format_bounce_for_prompt` reprompt injection), `server.py`
  (`_resolve_pre_merge_verify`, executor wiring, unified `bounced_tasks`, structured `parallel_advance`,
  conflict-bounce persistence, `_advance_after_parallel` revert-and-fail). New `tests/test_par_merge_queue.py`.
- **Compose** (`compose/`): `lib/build.js` (`extractConflictFiles`/`buildMergeConflictBounce`, structured
  conflict advance payload, server-owned parallel retry loop, terminal `build_step_done`), `lib/gsd.js`
  (`DEFAULT_FAST_GATE` + `resolvePreMergeGate` + single-sourced instructed gate + terminal-error handling),
  `pipelines/gsd.stratum.yaml` (`pre_merge_gate` input + `defer_advance` + `pre_merge_verify` on `execute`),
  `lib/step-prompt.js` (removed dead bounce injection), `lib/stratum-mcp-client.js` (JSDoc),
  `contracts/par-merge-bounce.json` (new). New `test/par-merge-queue.test.js` + re-dispatch cases.
- **Reconciliation:** COMP-GSD-3 + COMP-GSD umbrella → COMPLETE (feature.json + ROADMAP); CHANGELOGs (both
  repos); `docs/features/COMP-PAR-MERGE-QUEUE/report.md`.

## What we learned

1. **A blueprint can be internally consistent and still wrong about a load-bearing mechanism.** "Inject the
   bounce via buildRetryPrompt" passed design + blueprint review because nobody traced that the parallel
   re-dispatch re-resolves tasks server-side. Only the *implementation* review (Codex round 1, reading the
   real control flow) caught it. This is exactly why review on the impl — not just the blueprint — matters.
2. **A necessary correctness fix can expose a latent, broader gap.** Stopping the silent-advance was right,
   but it surfaced that the deferred parallel path's retry semantics were never exercised. The "small
   feature" had to grow to fix retry routing across both outer loops. When the scope balloons mid-build,
   surface it as a decision (we asked) rather than absorbing it silently.
3. **Mutation + shared references = heisenbugs in test stubs.** Production code mutates `pollResult.outcome`;
   that's fine when each MCP poll returns a fresh JSON object, but a stub returning the same object by
   reference leaks state across a recursion. The fix was `structuredClone` in the stub, not the production
   code — verify *which side* is wrong before "fixing."

## Open threads

- [ ] **COMP-PAR-MERGE-QUEUE-CONSUMER** (follow-up): extend the gate + bounce to the consumer-dispatch path
      (`executeParallelDispatch` → `parallelDone`; child-flows / `isolation:none`). Out of v1.
- [ ] The IR field re-lands in the TS port (`STRAT-TS-PORT`) — accepted build-twice, consistent with how
      STRAT-GUARD / STRAT-WORKFLOW-* were built in Python first.
- [ ] Not yet pushed — commits land on `main` in both repos pending the human's push call.

A feature that looked like a two-repo wiring job turned out to be a lesson in why you review the code, not the plan.

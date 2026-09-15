# Decision Log

Decisions accumulate here during builds.

## [2026-08-18] COMP-GUARD-CLAIM-1 — design_gate
**Outcome:** approve
**Rationale:** Design read: correct line refs (8, 56), accurate measurements, explicit must-NOT-say list forbidding 'completions are guarded', four open paths named. Approved on merits.

## [2026-08-18] COMP-GUARD-CLAIM-1 — execute_merge
**Outcome:** approve
**Rationale:** Merge clean (no witness error — the no-op filter held). Verified the worker's commit carries the report.md corrections before approving.

## [2026-08-18] COMP-GUARD-CLAIM-1 — review_lenses_gate
**Outcome:** approve
**Rationale:** review_triage dispatched and completed — the sandboxMode fix is proven live. Three lenses ran and merged clean.

## [2026-08-30] COMP-SEMVER-STRICT — design_gate
**Outcome:** approve
**Rationale:** approved

## [2026-08-30] COMP-SEMVER-STRICT — execute_merge
**Outcome:** revise
**Rationale:** MERGE_WITNESS_PRECOMPUTE_FAILED: consumer merge witness precompute failed: Command failed: git apply --cached --binary -
error: patch failed: test/version-check.test.js:5
error: test/version-check.test.js: patch does not apply

## [2026-08-30] COMP-SEMVER-STRICT — execute_merge
**Outcome:** revise
**Rationale:** MERGE_WITNESS_PRECOMPUTE_FAILED: consumer merge witness precompute failed: Command failed: git apply --cached --binary -
error: patch failed: test/version-check.test.js:5
error: test/version-check.test.js: patch does not apply

## [2026-09-15] COMP-TUI-4 — design_gate
**Outcome:** approve
**Rationale:** Approved by the controller after verifying the design's file:line anchors against the tree rather than trusting them: lib/cli-progress.js is 483 lines; build.js:1768 forms parallelStepNum; :1775 calls progress.stepStart; :1781 already has `descriptor.agent ?? 'claude'` in scope but unforwarded; :2011 calls progress.stepDone with no status. All four correct — which is the thing agent-written designs most often get wrong on this project.

Scope matches the ROADMAP row exactly (live 2-4 row grid during parallel_dispatch, per-task status + agent + elapsed). Two files, no new modules, no new dependencies, no protocol change; explicit non-goals covering NOOP_PROGRESS/GSD headless, the web cockpit, and sub-heartbeat animation. Backward-compatible signature extensions on both methods. Quick path is the right call for an S.

The three open questions carry stated defaults (use descriptor.id for the label; keep the existing toggle contract; leave an all-done grid standing until the next sequential stepStart) and none of them blocks implementation.

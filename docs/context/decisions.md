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


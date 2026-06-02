---
date: 2026-06-03
session_number: 47
slug: validate-status-mismatch-vision-vocab
summary: Reconciled the 8 error-level status-mismatch validate findings — validator PARTIAL→IN_PROGRESS vision-vocabulary projection plus local vision-state refresh; errors 18→10.
closing_line: "The drift wasn't one bug — it was a vocabulary that couldn't say \"partial\" and three statuses that had stopped telling the truth."
---

# Session 47 — Reconciled the 8 error-level status-mismatch validate findings — validator PARTI

**Date:** 2026-06-03

## What happened

We resumed from `.claude/session-context.md` with one ask: fix the 8 `STATUS_MISMATCH_*_VS_VISION_STATE` validate errors flagged as the only genuine drift residual. First move was re-checking the shared tree — it had moved (a parallel stream was mid-TDD on COMP-GSD-5 in the same clone), so we scoped our work to files no one else was touching.

Validate showed 49 status-mismatch findings, but only 8 were error-severity, across four features: COMP-MCP-MIGRATION-2-1 (PARTIAL vs in_progress), COMP-GSD (IN_PROGRESS vs complete), COMP-GSD-3 (PARTIAL vs complete), COMP-WORKSPACE-HTTP (COMPLETE vs in_progress). Reading the validator and the vision-state data, the '8 mismatches' turned out to be two different problems wearing one label. (1) A vocabulary gap: vision-state's status enum is the tracker's set minus PARTIAL, so a legitimately-PARTIAL feature can only ever be `in_progress` on the vision side — not drift, just a naive cross-vocabulary string compare. (2) Stale vision-state: three items had a `status` set back in May and never updated; two even contradicted their own `lifecycle.currentPhase` (still stuck at `explore_design`, empty phaseHistory — the known lifecycle-never-driven gap). Git history confirmed the tracker was the current, deliberate side (e.g. `2fc7285` reconciled GSD-3 to PARTIAL last session), so truth flowed tracker→vision, not the other way.

We fixed the vocabulary gap at root cause in the validator (a PARTIAL→IN_PROGRESS projection applied only to the *_VS_VISION_STATE comparisons) and refreshed the three stale vision-state statuses to reality. Codex review caught a real edge case our happy-path tests missed: a malformed/legacy vision `"partial"` would false-fire under a one-sided projection. We made the projection symmetric (project both operands) and added a regression test reproducing exactly that case. Second Codex pass: clean.

## What we built

- `lib/feature-validator.js` — `projectToVisionStatus(s)` (PARTIAL→IN_PROGRESS, identity otherwise) and `runStateMismatchChecks` now projects BOTH operands before the two `*_VS_VISION_STATE` comparisons. Tracker↔tracker (`ROADMAP_VS_FEATUREJSON`) untouched — PARTIAL stays a real distinction there.
- `test/feature-validator.integration.test.js` — 4 regression tests: PARTIAL↔in_progress is not drift; PARTIAL vs complete still fires (error); ROADMAP PARTIAL vs feature.json IN_PROGRESS still fires (tracker keeps full vocab); malformed vision `"partial"` aligns yet still reports VISION_STATE_SCHEMA_VIOLATION.
- `CHANGELOG.md` — 2026-06-03 entry.
- Local-only: `.compose/data/vision-state.json` (git-ignored) — COMP-GSD & COMP-GSD-3 → `in_progress`, COMP-WORKSPACE-HTTP → `complete`, via a precondition-checked atomic read-modify-write (server was down, so VisionWriter's direct path semantics).

## What we learned

1. **The mismatch was a category split, not one drift.** Half the findings were a vocabulary mismatch (PARTIAL has no vision equivalent) and half were stale data. Treating all eight as 'flip a status' would have been wrong — downgrading the deliberate PARTIAL tracker statuses to silence the validator would have destroyed real information.
2. **'Lifecycle-as-truth' can't mean 'trust vision-state' when the lifecycle was never driven.** Every target item sat at `explore_design` with empty phaseHistory and a hand-set, stale `status`. Truth came from the tracker + git history, and vision-state was the side that needed reconciling.
3. **Verify, don't assume the source of truth.** Vision-state for COMP-GSD-5 said `complete` while the parallel stream was actively designing it — proof vision-state is not authoritative. We checked each feature against git before deciding direction.
4. **Impl-stage Codex review earns its keep.** The malformed-`"partial"` false-positive was invisible to happy-path tests; the reviewer found it and we encoded it as a test. Symmetric projection > one-sided.
5. **Know what's git-ignored.** `.compose/data/` is ignored, so the vision-state fix is local validate hygiene, not a committed artifact — and our git-status 'clean' checks on it were meaningless; the script's precondition assert was the real concurrency guard.

## Open threads

- [ ] Push is HELD: local is ahead of origin/main by parallel-stream commits + the held `c626eb8` + this fix; pushing carries others' work and runs the pre-push `npm test` gate. User decision.
- [ ] 10 residual error findings remain (4 FEATURE_JSON_SCHEMA_VIOLATION, 3 MISSING_DESIGN_ARTIFACT, 2 DANGLING_LINK_FEATURES_TARGET, 1 XREF_TARGET_MISSING) — owner-domain / entangled, intentionally untouched.
- [ ] Pre-push validate stays advisory until the residual 10 clear; only then flip `bin/git-hooks/pre-push.template` to strict.
- [ ] Deeper cause unaddressed: `lifecycle.currentPhase`/phaseHistory are never advanced, so vision-state `status` drifts from reality over time. Reconciliation is a patch, not the cure.

---

*The drift wasn't one bug — it was a vocabulary that couldn't say "partial" and three statuses that had stopped telling the truth.*

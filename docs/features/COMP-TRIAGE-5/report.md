# COMP-TRIAGE-5 — Implementation Report

**Status:** COMPLETE
**Date:** 2026-07-15
**Design:** `design.md` · **Blueprint:** `blueprint.md` · **Plan:** `plan.md`

## 1. Summary

Implemented E3 (Estimate → Execute → Expand) on top of the existing COMP-TRIAGE-1/3 engine: the tier/profile estimate now runs at the **front of the pipeline** from the raw request (before any design doc is read), and a **verification-gated escalation** widens the lane when a ship-time test gate fails. This moves the cost-saving decision upstream (the paper's central point: don't pay for a codebase audit before learning you didn't need it) and adds a safety net for the case where the lean lane was the wrong call.

## 2. Delivered vs Planned

| Slice | Planned | Delivered |
|---|---|---|
| S01 | `estimateScope` + `tierToComplexity` + `narrowerLane` (doc-free front estimate + safety clamp) | ✅ + `floorProfileToLane`, `tierToLane` exported |
| S02 | `lane`/`triageTier`/`estimateSource` fields + `validateFeatureFields` (close complexity bypass) | ✅ |
| S03 | `lib/escalation.js` pure bounded ladder | ✅ |
| S04 | front-seam wiring + ship-time escalation observer | ✅ via `lib/lane-gate.js` (`applyFrontTriage` + `maybeEscalateLane`) |

## 3. Architecture deviations

- **New module `lib/lane-gate.js`** (not in the original File Plan): extracted the front-seam and observer out of the 3000-line `build.js` so they are unit-testable in isolation. Improves testability and keeps `build.js` edits to import + two call sites.
- **Escalation via persisted lane + checkpoint, not inline re-entry.** The ship-time test gate is advisory and end-of-pipeline; rather than tear open `runBuild` to re-enter mid-flight, escalation persists a widened lane + bounded counter + resume checkpoint, and the next build honors it. An escalated lane overrides the triage-staleness check (a deliberate override, not a stale cache).
- **`floorProfileToLane`** added to reconcile lane and profile — the safety clamp raises the lane, but skip_if is driven by the profile, so without the floor a clamped lane still skipped verification.

## 4. Key implementation decisions

- **Front estimate is authoritative; refinement narrows only.** The doc-reading pass (`runTriage`) runs only when design/plan/blueprint exist and may only *narrow* the front lane. Widening is the escalation path's job. This keeps the E3 "estimate before reading" property while letting confirmed-simple work narrow.
- **Bias to the safe lane.** Low confidence (no named paths, no clear verb) clamps up to at least `standard`; under-scoping is the only dangerous error.
- **Bounded escalation.** Max 2 rungs, then STOP + human handoff — no infinite widen-retry loop.

## 5. Test coverage

58 feature tests (5 files) + `proof-run.test.js` as pipeline E2E. Full suite **4494/4494**.
- estimate-scope: lane mapping, safety clamp, tierToComplexity, narrowerLane.
- feature-fields: complexity-enum guard, triageTier integer, bypass regression.
- escalation: ladder, bound, no-lane skip.
- front-golden: trivial lane + validated persist + description fallback + refinement (narrow-confirms / never-widens).
- escalation-golden: trivial→standard (verification restored), standard→complex (full), bounded STOP, checkpoint.

## 6. Files changed

`lib/triage.js` (estimateScope, tierToComplexity, narrowerLane, tierToLane, floorProfileToLane), `lib/feature-writer.js` (+validateFeatureFields, 3 fields), `lib/escalation.js` (new), `lib/lane-gate.js` (new), `lib/build.js` (front-seam + observer + escalated-lane honor), `contracts/feature-json.schema.json` (3 fields). 5 new test files.

## 7. Known issues & tech debt (v1 boundaries)

- **Automatic in-build re-entry not implemented.** The advisory ship-time test gate is pre-existing (failing tests already ship); v1 escalation detects + persists + checkpoints for a re-run, and does not block completion or auto-re-enter. Auto-re-entry needs ship/completion-path surgery. **Follow-up.**
- **Review-gate escalation deferred.** Observer triggers on the test gate only; the same `escalate()` fn against the review `.clean` verdict is a fast-follow.
- **ACRR metric deferred** (COMP-TRIAGE-6 proposed). Fix-mode front estimate deferred.

## 8. Lessons learned

- The Codex review loop earned its keep: 4 rounds, each surfacing a real integration defect that unit tests missed (CLI never fed the estimator; lane/profile disagreement; escalation self-invalidating via build artifacts; an unwired refinement pass). Classic "green tests, dead wiring."
- Reusing the triage-staleness cache for escalation state was the wrong instinct — build artifacts invalidate it. Treating an escalation as an explicit override was the correct model.

# COMP-TRIAGE-5 — Build Progress Ledger

Live ledger for the Compose build of COMP-TRIAGE-5 (E3 front-seam + escalation).
Recovery map: this file + `git log` in `/Users/ruze/reg/my/forge/compose`.

## State

- **Feature:** COMP-TRIAGE-5 — front-of-pipeline scope estimation + verification-gated escalation (E3)
- **Design:** `docs/features/COMP-TRIAGE-5/design.md` (committed `8808f39`)
- **Authority model:** C (advisory entry, enforced escalation)
- **Vision item:** registered, status IN_PROGRESS
- **Workspace binding:** compose

## Phase Ledger (build mode)

| Phase | Status | Notes |
|---|---|---|
| 1 Explore & Design | DONE | design.md written + committed `8808f39` |
| 4 Blueprint | DONE | blueprint.md; corrections table + boundary map (validates clean) |
| 5 Blueprint Verification | DONE | all anchors verified vs real code; boundary-map validator ok:true, 0 violations |
| 6 Plan | DONE | plan.md — 4 TDD slices S01–S04 |
| 7 Execute (TDD+E2E+review+sweep) | IN_PROGRESS | S01-S04 done, full suite 4490/4490; E2E via proof-run; codex review next |

## S01-S04 landed

- S01: `estimateScope`/`tierToComplexity`/`narrowerLane` in triage.js (16 tests)
- S02: `lane`/`triageTier`/`estimateSource` + `validateFeatureFields` (20 tests, closes complexity bypass)
- S03: `lib/escalation.js` pure bounded ladder (12 tests)
- S04: `lib/lane-gate.js` (`applyFrontTriage`+`maybeEscalateLane`) wired into build.js front seam (:983) + ship observer; 2 goldens
- **Integration bug caught by proof-run.test.js + fixed:** safety clamp raised the LANE but not the PROFILE → a clamped-to-standard lane still skipped verification. Added `floorProfileToLane` in estimateScope (standard keeps verification; complex keeps all). This matched proof-run's asserted contract exactly.
- Full suite 4490/4490 (proof-run flakes under full-suite concurrency; passes isolated — known issue).

## Load-bearing finding (Phase 4)

Escalation trigger has NO existing seam. Review verdict `.clean` is observable mid-pipeline (`build.js:2174,2180`, `synthesis.clean:3335`), but the test gate (`deriveTestsPass`, `test-bootstrap.js:561`) is computed only at ship (`build.js:2883`), is advisory, never blocks. So the observer is NEW and its test-signal half fires end-of-pipeline. Front-seam savings unaffected.
| 8 Report | PENDING | |
| 9 Docs | PENDING | CHANGELOG/README/ROADMAP |
| 10 Ship | PENDING | stratum_audit + commit |

## Key seams (from exploration, verify in blueprint)

- `lib/triage.js` — add `estimateScope(request, repoSignals)`; reuse pattern-sets (`:33-54`), `isTriageStale` (`:244`)
- `lib/build.js:963` — front-seam call site (before spec load); `:997,1006` complexity-write bug; `:1045-1075` skip_if toggling (reuse)
- `lib/feature-writer.js:107-149` — feature.json field set + validators (add `lane`, `triageTier`, `estimateSource`)
- `server/compose-mcp-tools.js:836` — `item.lifecycle.currentPhase` (escalation re-entry phase source)
- `lib/lifecycle-modes.js:66,103` — runsTriage build-only (v1)
- `lib/escalation.js` (NEW) — bounded lane escalation on gate failure

## Two prerequisite bolt-fixes (in scope)

1. Reconcile `complexity` field: `triageTier` (0-4) machine field + mapped S/M/L/XL through validator; stop the `String(tier)` bypass at `lib/build.js:997,1006`.
2. Escalation reads `item.lifecycle.currentPhase`, never `feature.json.phase`.

## Deferred follow-ups

- COMP-TRIAGE-6 (proposed): ACRR audit metric
- fix-mode front estimate
- COMP-TRIAGE-4 (parked): tier history — unblocked by `triageTier`

## S04 architecture decision (2026-07-15)

Escalation re-entry is achieved by **persisting the escalated lane/profile + bounded counter + resume checkpoint**, NOT by inline `runBuild` re-entry surgery. The next `compose build` reads the wider lane via the existing cache-read path (`build.js:976-980`); `triageTimestamp` set on the escalation write so `isTriageStale` treats it as fresh. Faithful to E3 Expand (next execution is wider), small blast radius. v1 observer = **ship-time test gate** (`deriveTestsPass` at `build.js:2883`); review-gate escalation via the same `escalate()` fn is a fast-follow.

S04 split: **S04a** front-seam (estimateScope on raw request → lane before genesis → validated persist, closing the `:997/:1006` bypass); **S04b** ship-time test-gate observer → `escalate()` → persist escalated lane + checkpoint / STOP→human.

## Decisions log

- 2026-07-15: Reframed from "build a triage gate" to "move estimate to front + escalation" after finding COMP-TRIAGE-1/3 already ship the classifier + skip enforcement, positioned post-design.
- 2026-07-15: Authority C chosen (enforcement already exists; wrong-trivial must be recoverable).

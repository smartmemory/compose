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
| 7 Execute (TDD+E2E+review+sweep) | IN_PROGRESS | S01 first (estimateScope) |

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

## Decisions log

- 2026-07-15: Reframed from "build a triage gate" to "move estimate to front + escalation" after finding COMP-TRIAGE-1/3 already ship the classifier + skip enforcement, positioned post-design.
- 2026-07-15: Authority C chosen (enforcement already exists; wrong-trivial must be recoverable).

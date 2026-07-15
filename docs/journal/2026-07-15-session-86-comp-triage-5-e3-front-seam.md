---
date: 2026-07-15
session_number: 86
slug: comp-triage-5-e3-front-seam
summary: "COMP-TRIAGE-5: moved the complexity estimate to the front of the build (E3) and added a bounded verification-gated escalation net."
feature_code: COMP-TRIAGE-5
closing_line: "The Codex loop earned its keep: four rounds, four real defects that green tests never saw."
---

# Session 86 — COMP-TRIAGE-5

**Date:** 2026-07-15
**Feature:** `COMP-TRIAGE-5`

## What happened

The human read an arXiv paper (2607.13034, 'Do AI Agents Know When a Task Is Simple?') and asked what we could learn. Its E3 model (Estimate -> Execute -> Expand) mapped almost exactly onto a gap we already had: our triage engine (COMP-TRIAGE-1/3) classified complexity and skipped phases, but it ran INSIDE runBuild after design/plan/blueprint were already written -- so the pipeline paid for the design audit before learning it wasn't needed. We reframed the work from 'build a triage gate' to 'move the estimate to the front + add escalation', then built it.

## What we built

Front seam: estimateScope(request, repoSignals) in lib/triage.js derives {tier, profile, lane, confidence} doc-free, with a low-confidence safety clamp (never trivial). Fields: lane/triageTier/estimateSource + a shared validateFeatureFields guard that closes the old complexity: String(tier) bypass. Escalation: lib/escalation.js is a pure bounded ladder; lib/lane-gate.js wires applyFrontTriage into the front seam and maybeEscalateLane into the ship-time test gate (persist widened lane + resume checkpoint, bounded -> human handoff). floorProfileToLane reconciles lane and profile. A doc-gated, narrow-only refinement pass lets confirmed-simple work shrink further. 5 new test files (58 tests); full suite 4494/4494.

## What we learned

1. The safety clamp raised the LANE but skip_if is driven by the PROFILE -- a clamped-to-standard lane still skipped verification until floorProfileToLane reconciled them. The proof-run test caught it, and its asserted contract (verification on, prd/architecture/report off) WAS the correct standard-lane semantics. 2. Reusing the triage-staleness cache for escalation state was wrong -- a completed build writes audit.json into the feature dir, which invalidated the escalation; treating an escalated lane as an explicit override fixed it. 3. Codex found what unit tests couldn't: the CLI never fed a description to the estimator (every build classified the code string), and the refinement pass was unwired (narrowerLane had no caller). Green tests, dead wiring.

## Open threads

- [ ] Automatic in-build re-entry: the ship-time test gate is advisory (failing tests already ship); v1 escalation is detect+persist+checkpoint, not auto-re-entry. Needs ship/completion-path surgery.
- [ ] Review-gate escalation: observer triggers on the test gate only; wire the same escalate() to the review .clean verdict.
- [ ] COMP-TRIAGE-6 (proposed): ACRR audit metric (files_inspected / files_needed).
- [ ] Fix-mode front estimate (build mode only in v1).

---

*The Codex loop earned its keep: four rounds, four real defects that green tests never saw.*

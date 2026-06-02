---
date: 2026-06-03
session_number: 48
slug: comp-gsd-4-budget-ceilings
summary: COMP-GSD-4 budget ceilings for gsd runs — adopted the stratum flow budget rather than rebuilding; Codex gate caught a real issue at every phase.
feature_code: COMP-GSD-4
closing_line: The best budget engine is the one you already shipped — the work was finding it, not building it.
---

# Session 48 — COMP-GSD-4

**Date:** 2026-06-03
**Feature:** `COMP-GSD-4`

## What happened

Continued the COMP-GSD umbrella with GSD-4 (budget ceilings + stop conditions), the second autonomy-safety rail after GSD-5's stuck detection. The ask read like 'build budget ceilings,' but verify-first reshaped it into 'adopt the substrate': STRAT-WORKFLOW-BUDGET already ships flow-execution-wide enforcement (ms/dispatches/tokens/usd), per-task usage accounting, a budget_exhausted terminal, AND the budget_state envelope compose needs — the same situation as GSD-3. So GSD-4 became glue + surface, not a new engine. We also confirmed (against current source, not the stale 2026-05-29 report) that usd is now enforced via the dollars pricing table, and that gsd runs with a no-op streamWriter so a live OpsStrip pill needs telemetry that doesn't exist yet. The Codex gate earned its keep at all three phases.

## What we built

lib/gsd-budget.js (new): readGsdBudgetConfig, buildBudgetBlock, injectBudget (identity when unconfigured — the byte-identical guarantee), trippedAxis, composeBudgetDiagnostic. lib/budget-ledger.js: recordGsdUsage/checkGsdCumulativeBudget/resetGsdUsage (back-compat with COMP-BUDGET iteration fields). lib/gsd.js: budget injection, cumulative pre-check+refusal, budget_exhausted terminal branch, writeBudgetArtifacts, claimResumeLock split from loadResumeTaskGraph + ownership-aware releasePauseLock in finally. lib/build.js: guarded budget_exhausted short-circuit in executeParallelDispatchServer (no-op in build mode). contracts/gsd-stuck.json: optional kind discriminator + budget block (if/then/else). bin/compose.js: budget result branch + --reset-budget. Tests: gsd-budget.test.js (20), gsd-budget-run.test.js (5), contracts-gsd-stuck.test.js (+5). Full suite 3110 lib + 146 UI + 100 tracker, 0 fail.

## What we learned

1. Verify-first against the *current* substrate, not memories/reports: the 2026-05-29 STRAT-WORKFLOW-BUDGET report said usd was recorded-only, but the dollars follow-up had since made it enforced — Codex caught the stale claim. 2. The budget_exhausted terminal already carries budget_state in the advance/step envelopes (server.py:181/3839), so no stratum prerequisite was needed (unlike GSD-5's telemetry gap). 3. A no-op streamWriter is a real seam limit: gsd emits no build-stream telemetry, so we honestly deferred the live OpsStrip pill instead of overclaiming reuse. 4. The pause.lock lifecycle is subtle: an unconditional release-in-finally clobbers a concurrent claim and a claim-race loser deletes the winner's lock — release must be ownership-aware. Each of these was a Codex finding (design/blueprint/impl), none caught by tests first.

## Open threads

- [ ] COMP-GSD-4-OPSSTRIP-LIVE: live cockpit burn pill (needs a gsd build-stream telemetry surface).
- [ ] COMP-GSD-4-PERTASK-TOKENS: per-task token hard cutoff (needs a stratum-side change).
- [ ] COMP-GSD umbrella still IN_PROGRESS: GSD-6 (headless + crash recovery, reuses GSD-4/5 pause.json shape), GSD-7 (milestone reports — owns budget actuals-vs-caps reporting), COMP-PAR-MERGE-QUEUE closes GSD-3.

---

*The best budget engine is the one you already shipped — the work was finding it, not building it.*

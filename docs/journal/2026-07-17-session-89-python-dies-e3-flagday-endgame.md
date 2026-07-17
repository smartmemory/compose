---
date: 2026-07-17
session_number: 89
slug: python-dies-e3-flagday-endgame
summary: "E3 + flag-day + endgame in one arc: the python execution path is deleted, TS is the only engine, and the first fully green suite of the migration (4608/4608)"
feature_code: STRAT-PY-RETIRE
closing_line: "The python path died the way it lived: guarded by tests, and survived by the two branches that remember it."
---

# Session 89 — STRAT-PY-RETIRE

**Date:** 2026-07-17
**Feature:** `STRAT-PY-RETIRE`

## What happened

We resumed from a flush file with Slice E3 sitting uncommitted and a review pass owed, and ended the day with the python execution path deleted. Three slices landed in one arc. E3 (the full v0.3→v1 pipeline conversion) went through four codex review passes and three fix rounds — among the catches: subflow steps couldn't resolve their output contracts (the engine scopes ready ids by parent step, compose exact-matched the entry flow), the SDK's allowedTools turned out to be a no-prompt list rather than an availability restriction (so 'read-only' reviewers weren't), and GSD double-counted every token once the engine ledger started carrying envelope usage. Flag-day then closed the migration window in both repos: the engine now REQUIRES token echoes and rejects the epoch field (surface 9), and compose flipped its default engine to TS. The flag-day whole-slice review found the cockpit seams the goldens never exercise — the server adapter would boot 'healthy' against the wrong binary named stratum, and the pipeline editor wrote python-era fields into v1 yaml. The editor's concurrency guard then ate four review rounds of bypass findings until the owner pushed back on pace and we simplified the design instead of hardening the classifier: baseHash is always required, end of story. The endgame deletion was the sharpest lesson. Codex deleted 10k lines; the mandated two-lens review (Codex + Opus) found the deletion had taken LIVE behavior with it — dirty-review recovery, GSD instrumentation, bug checkpoints, diagnose retry context, the cockpit's parallel-task display — and Opus caught an untracked load-bearing test helper that a tracked-files-only commit would have left behind. The first restoration round then validated against proxies (injected flags, fabricated history) while the production wiring stayed dead; the closing reviews caught that too, and the real-path mandate that followed surfaced two more masked defects. Along the way we killed two of E3's own inventions as over-authoring: the ship step's judged ensure and the vocabulary judged guard, both unevaluable from {result, input} — the judge fails closed forever. Enforcement moved to deterministic compose-side code.

## What we built

compose 9221548 (E3: v1 pipelines, local claude connector, vocabulary-compliance port, exactly-once usage), stratum 9c78b73 (flag-day: surface 9, required tokens, epoch retired, observation-time gate CLI), compose cc390a7 (flag-day: Surface-9 adoption, TS default via lib/stratum-engine.js, 10 fixture ports, always-require-baseHash editor saves), compose 62f115a (endgame: python path deleted −9,968 lines; engine-native review_gate recovery loop; GSD timing/diff instrumentation on the real driver; bug-mode checkpoints keyed by exhausted step; real-path golden coverage incl. ts-cutover-review-gate-golden). python-legacy branches archive the last python-bearing commits in both repos. Ledger: stratum docs/plans/2026-07-11-strat-py-retire-progress.md (entries 80f68be, 642dda3, d6f19b0); design.md flipped SHIPPED.

## What we learned

1. Deletion reviews need a different lens than build reviews: the failure mode is silently lost behavior, and the deleted tests ARE the spec — we recovered every re-expression from git show at the pre-deletion commit. 2. A fixer under RED-first discipline can still validate against proxies; the mandate that closed the hole was 'the test drives the REAL path (engine-audit assertions over the live bin)' — that requirement alone surfaced four masked production defects across two rounds. 3. Judged ensures that demand evidence the judge context cannot carry ({result, input} only) fail closed forever — an unevaluable judged statement is a production landmine, not a safety net; enforcement belongs in deterministic consumer code. 4. When a guard accumulates bypass findings round after round, the classifier is the wrong design — remove the optionality it guards instead of hardening it (always-require-baseHash ended a four-round finding stream in one move). 5. Recovery loops belong in the flow as engine-native gates, not in consumer-side rescheduling the consumer doesn't control. 6. The two-lens (Codex + Opus) mandate for the endgame paid for itself twice over: independent lenses caught disjoint blocker classes (behavioral loss vs staging/architecture).

## Open threads

- [ ] Merge day (owner-gated): atomic develop→main in BOTH repos; stratum-repo python tree (src/stratum, stratum-mcp) removal is merge-day housekeeping
- [ ] gh reauth, then file the two stratum issues: workspace-write bg agent mode + claude allowlists; deterministic test-judge backend
- [ ] TS runGsd/runBuild harness + port the 3 still-passing python-era survivor suites (fidelity debt)
- [ ] Editor-endpoint hardening follow-ups beyond the shipped guard (deliberately descoped from the migration)
- [ ] Intermittent load flakes to watch, not chase: Bridge-to-SSE under full-suite parallelism, single 90s cancellation

---

*The python path died the way it lived: guarded by tests, and survived by the two branches that remember it.*

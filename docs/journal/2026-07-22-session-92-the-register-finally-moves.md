---
date: 2026-07-22
session_number: 92
slug: the-register-finally-moves
summary: Top-down review found the judgment layer had never run; five owner rulings in one sitting resolved the register's first three joints; COMP-JUDGMENT-WRITER designed through five gate rounds (31 findings) to plan-ready; OKF adopted for projections.
feature_code: COMP-JUDGMENT-WRITER
closing_line: The system built to resolve cheap questions first had been sitting on three minute-cost questions for two days — asking them took five minutes and reshaped the roadmap.
---

# Session 92 — COMP-JUDGMENT-WRITER

**Date:** 2026-07-22
**Feature:** `COMP-JUDGMENT-WRITER`

## What happened

Resumed from the canon-guard flush and, instead of picking a build thread, the owner asked for a top-down hole hunt. The highest-altitude finding embarrassed the whole stack: the judgment layer had never actually run. Its three cheapest joints (commercial-intent, horizon, success-criteria — all owner-ASSERT, minutes each) had sat open for two days while infrastructure work proceeded around them, and the single UNDER TEST slot was held by a joint blocked on sharpening, which P3 forbids. Lower altitudes: the epic's plan-of-record waited on log data its own correction proved would never arrive; the build_id-null mystery root-caused to cross-process env (runBuild sets COMPOSE_BUILD_ID in the CLI process, writers read it in the MCP server process — architecturally guaranteed null); and two canon docs flatly contradicted each other on where the judgment writer should write.

The owner then answered everything in one sitting: instrument-now-product-later, months horizon, all four success criteria, v1 agent-only provenance, provider records over markdown. The register got its first three resolutions ever. From there COMP-JUDGMENT-WRITER was carved out of the epic and driven through the full lifecycle: three parallel exploration reports (SmartMemory ontology, seam precedents, writer mechanics), design rev 1, then five Codex gate rounds at gpt-5.6-sol/xhigh — 31 findings, curve 9/9/10/3/0 to REVIEW CLEAN. Mid-flight the owner asked two orthogonal questions that both landed in the design: OKF adopted for projections (reversing okf-set-aside after evaluating the shipped codec), and workflows-under-procedural filed as SmartMemory RFC item 2. Blueprint passed validateBoundaryMap with zero violations; a Codex Phase 5 pass checked all sixteen file:line assumptions (six verified, ten precision corrections — including the real adapter symbol guardedTransition and its true return shape). Plan T1–T7 written. Parked at execute, deliberately, for a fresh session.

## What we built

- docs/judgment/LEDGER.md session 3: eight owner decisions (intent, horizon, success criteria, OQ1 agent-only, writer substrate, records-under-docs, ASSERT elicitation amendment, OKF adoption) plus an [AGENT] re-rank moving joint-is-non-obvious into UNDER TEST
- docs/judgment/REGISTER.md: first Resolved section (three joints), differentiated/elicitation-works/candidates-generatable demoted under the instrument-first ruling
- docs/features/COMP-CANON-GUARD/design.md: OQ1 resolved, S2b retirement reflected in the table, markdown-as-floor argument overruled, S3 cross-linked out
- docs/features/COMP-JUDGMENT-WRITER/: design.md rev 5 (gate-clean, 31 findings adjudicated in-doc), blueprint.md (7 slices, Boundary Map clean, binding corrections table), plan.md (T1–T7 TDD), status.md (resume: execute), feature.json + ROADMAP row
- Memory: codex-max standing directive recorded

## What we learned

1. Cheap owner-ASSERT joints must be put to the owner immediately, not queued behind build work — three minute-cost questions blocked two days and their answers deleted whole swaths of assumed scope (sell-path parked, minutes bucket gone, v1 owner-proof mechanism cancelled for lack of traffic).
2. The adversarial-gate finding curve is a scope instrument: 9/9/10 meant broad spec, and three round-3 findings were correctly resolved by NARROWING (evidence store sequenced to the Answerer, positions collapsed to revision chains) rather than adding machinery. Round 4 dropping to three editorial items was the convergence signal.
3. Design-by-assertion about neighboring repos fails at the same rate as about your own: the OKF upsert claim and the reference:true fallback were both disproven by reading ingest.ts — the parent epic's five-wrong-assertions lesson, reproduced across a repo boundary on day one.
4. A reviewer cannot clear an owner decision: Codex kept re-flagging the ASSERT amendment until it was explicitly scoped as gate input with both branches specified. Owner-gated items need to be fenced out of review scope or rounds never converge.
5. Cross-process env is a silent architecture killer: COMPOSE_BUILD_ID null on all 777 events wasn't traffic pattern, it was two processes that never share an environment. Check process topology before designing any env-carried correlation.
6. Derived status beats stored status wherever records are immutable — the round-4 supersession contradiction dissolved entirely once status became a read-time computation.

## Open threads

- [ ] Execute T1–T7 (fresh session; corrections table binding; cutover commit human-gated)
- [ ] W4 fast-follow: SmartMemory enrichment (team_id persistence, OKF resource ids) + file the three-item RFC in the SmartMemory repo
- [ ] Epic follow-ups now concretized: replace the no-op decision sink (build.js:3999) and the build_id handshake file — small, separate items
- [ ] joint-is-non-obvious is UNDER TEST — the next working sessions are its experiment; owner adjudicates
- [ ] Track 2 from the review still unclaimed: feed one real build decision through P1–P3 by hand
- [ ] Journal-91 leftovers unchanged: source DEMAND-HAS-KNOWN-SIGNALS, ASSERT/DERIVED origin audit, viability rubric, distribution design

---

*The system built to resolve cheap questions first had been sitting on three minute-cost questions for two days — asking them took five minutes and reshaped the roadmap.*

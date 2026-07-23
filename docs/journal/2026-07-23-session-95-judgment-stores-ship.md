---
date: 2026-07-23
session_number: 95
slug: judgment-stores-ship
summary: "COMP-JUDGMENT-STORES ships: person/situation/goal stores, crash-safe intent publication, full-Codex pipeline; review-loop economics lesson"
feature_code: COMP-JUDGMENT-STORES
closing_line: The inspector found the bug in the inspector's fix — and the owner found the bill.
---

# Session 95 — COMP-JUDGMENT-STORES

**Date:** 2026-07-23
**Feature:** `COMP-JUDGMENT-STORES`

## What happened

Phase 7 of COMP-JUDGMENT-STORES, resumed from a flush after the ten-round design gate and Codex-authored blueprint. Six sequential TDD slices (T1 contracts → T6 MCP surface), every one implemented by a Codex sol/xhigh dispatch under the corrections-bound blueprint, verified locally and committed by the controller. T1 deliberately broke 8 writer tests (old intent envelopes); the plan scheduled their retirement for T4 and T4 delivered — the family went 187/187 the moment the typed-intent dispatcher and publish-then-regenerate protocol landed. The exit review loop found 2 MAJOR + 3 MINOR across three rounds: rests_on enforced on the way in but invisible on the way out (unwired MCP schema + ledger rendering), a crash window that was design-accepted but untested, and a date precheck that disagreed with the contract validator — a bug the reviewer caught in my own round-1 fix. The owner stopped round 4: after ~3 rounds, trivial findings don't justify another multi-million-token pass. One flaky non-judgment test failed one full-suite run and passed the rerun.

## What we built

contracts/judgment-record.schema.json (33 new closed definitions: person/situation/goal roots, typed intents, attestations, rests_on); lib/judgment/store/records.js + index.js (aggregates, parameterized r<N>/v<N> chains, goal state sidecar, effectiveStore adapter, goalCutoverComplete, strict clearIntent); lib/judgment-writer.js (judgmentPersonWrite/judgmentSituationWrite/judgmentGoalWrite, allocateStableEntryId, publishIntentLocked, INTENT_APPLIERS, UndoLog capture/created, contract-delegated date-time precheck); lib/judgment-gen.js (people/SITUATION/dual-read OBJECTIVE projections, orphan pruning, YAML-safe titles, counts); server MCP registration 46→49 tools; ~1,900 lines of new tests across seven files (206 family tests).

## What we learned

1. Deliberate intermediate red works when the plan owns it: committing T1 with 8 known-red tests was safe because the blueprint named the exact failure set and the task that retires it — honesty in the commit message substituted for green. 2. The review loop's highest-value catch was again an unwired surface (rests_on stored but never rendered or advertised) — tests pass, feature invisible; this is the third feature where independent review caught wiring that unit tests structurally cannot. 3. A reviewer catching a bug in a review FIX (the date regex diverging from ajv) is the argument for re-reviewing risky fixes — and only risky ones. The owner's rule: ~3 rounds is the budget; trivial fixes need no independent confirmation, delegate down-ladder and verify with free local tests. 4. Cost order is Fable > Opus > Codex > Sonnet, but cheap models can eat more tokens end-to-end than smart ones; effort tiers make it two-dimensional; nobody knows the real curve until dispatch metrics exist over time (COMP-TRIAGE-6 territory). Until then: right-size by guess, default to Codex.

## Open threads

- [ ] COMP-JUDGMENT-PACKAGES: own design gate before build (seeded r1)
- [ ] COMP-JUDGMENT-GOAL-MIGRATE: own design gate; goal store ships LOCKED (JUDGMENT_MIGRATION_REQUIRED) until it lands
- [ ] COMP-CANON-GUARD: consume the canon-manifest handoff rows from the blueprint
- [ ] Coverage sweep was subsumed by the 206-test family + full suite; no separate sweep run
- [ ] Dispatch metrics for model×effort routing (revive as COMP-TRIAGE-6 when promoted)
- [ ] Push: main is 9 commits ahead, unpushed

---

*The inspector found the bug in the inspector's fix — and the owner found the bill.*

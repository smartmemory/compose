---
date: 2026-07-16
session_number: 88
slug: consumer-fanout-crash-safe-loop
summary: "Slice E complete: token echoes (E1) + crash-safe consumer fanout loop (E2) survive a 4-round adversarial review that kept finding ways for recovery to destroy approved work"
feature_code: STRAT-TS-FANOUT-CONSUMER
closing_line: The gate was green all along; the reviewer kept finding ways for recovery to eat approved work anyway.
---

# Session 88 — STRAT-TS-FANOUT-CONSUMER

**Date:** 2026-07-16
**Feature:** `STRAT-TS-FANOUT-CONSUMER`

## What happened

We closed Slice E of the TS cutover — the compose half of consumer-dispatch fanout — in two commits: E1 (`bda27ef`, token echoes everywhere on the TS path) and E2 (`c325db7`, the consumer loop itself). E1 was almost routine: codex built it RED-first, review returned two P2s, we rejected one as designed flag-day scope and fixed the other (the parallel-lifecycle guard failed OPEN when tool discovery errored — it now fails closed).

E2 was the opposite of routine. The build itself landed clean (26/26 gate), but the review loop became a four-round excavation of crash-recovery topology. Round 1: seven findings, including blanket revise-supersession and a resume path that trusted the mutable local spec instead of the persisted `revisionDigest`. Round 2: three findings IN THE FIXES — the drift guard had a crash window between journal creation and pin binding, rollback stranded issuances as `merged`, and a legal empty contract wedged items forever. Round 3 found the worst bug of the epic: recovery reprocessed EVERY transaction in the journal, so a crash after a round-2 approved merge could restore round 1's revised baseline over it — permanently destroying approved work. That round forced the unifying principle we should have stated up front: recovery and rollback act only on the CURRENT unresolved transaction round, with the engine's audit as ground truth; resolved rounds are durable history, never inputs to recovery. Round 4 was down to two narrower edges (isolation:none items silently losing writes; pin adoption missing for legacy journals), and the fifth pass came back REVIEW CLEAN.

Mid-session the owner redirected process: stop doing menial work inline, dispatch subagents. From that point a persistent Opus fixer subagent did every fix round (RED-first, reverting each fix to prove the failure), codex sol/high stayed the independent reviewer, and the controller only adjudicated, verified, and committed. The same session also absorbed a Claude Code harness-parity research pass (dynamic workflows, /goal, ultracode, routines) that produced a roadmap promotion (COMP-ITER-BUDGET), two parked ideas, and a first-party competitive filing (native auto-memory, CA-412).

## What we built

- `lib/consumer-fanout.js` (new) — generation-keyed out-of-tree worktrees (canonical-path + symlink rejection), fsync+rename journal (pre-stage witnesses, prepared-before-every-step_done envelopes, accepted only via `acceptedDispatchToken` reconciliation, run-revision pins in the FIRST durable write, adopted onto legacy unpinned journals), witness-chain merge transactions (temporary-index snapshot pattern, unique-tree-id precondition, baseline restore + replay-from-zero on unmatched trees), current-round-only recovery.
- `lib/build.js` — consumer descriptor routing off the TS ready[] pump, token echoes on every stepDone/gateResolve (E1), resume recovery seam with fail-closed revision verification, isolation-aware merge-gate integration, item-local connector-error envelopes, NODE_ENV-gated crash hooks.
- `lib/stratum-mcp-client.js` — optional dispatchToken/gateToken transmission; python-era parallel lifecycle fails explicitly (and fails CLOSED on discovery errors).
- `lib/result-normalizer.js` + `lib/step-prompt.js` — full contract-closure schemas (named refs, typed arrays, unions, optionality, empty contracts) and previousFailure rendering.
- `test/ts-cutover-token-echo-golden.test.js` + `test/ts-cutover-consumer-fanout-golden.test.js` — 30 new real-engine golden subtests: crash windows A–D, multi-round revise/merge recovery, out-of-band re-enumeration supersession, empty-input/empty-contract edges, isolation:none + mixed fanouts, discovery fail-closed. Gate: 42/42.

## What we learned

1. **State the recovery principle before writing recovery code.** Three of four rounds were violations of one sentence — "recovery acts only on the current unresolved round, audit as ground truth" — that nobody had written down. Once stated explicitly in the round-3 brief, the loop converged immediately.
2. **Crash-safety bugs live in the FIXES, not just the code.** Round 2's findings were all introduced or exposed by round 1's fixes; the eligibility-restore (R2) then had to be constrained twice more (T1, T3) to compose with history and re-enumeration. Every fix to a recovery path needs its own crash test.
3. **Fail-open compat guards are worse than no guards.** Both slices had one: E1's tool-discovery fallback and E2's populated-values-only pin verification. A guard that silently disables itself under the exact failure it exists for reads as safety but isn't.
4. **A persistent fixer subagent beats fresh dispatches for review loops.** The Opus fixer kept all four rounds in context, which is why round 4 could say "T1 ensures R2 only runs for the current round" — cross-round composition reasoning a fresh agent would have had to rebuild.
5. **Adversarial review earns its cost on exactly this kind of code.** Sixteen accepted findings, one of them approved-work-destroying, in code whose gate was green the whole time. The goldens proved the happy paths; the reviewer found the topologies nobody thought to test.

## Open threads

- [ ] Task #8 (owner decision): accept temporarily-serial fanout items or land concurrency before E3 ships real traffic onto the loop
- [ ] Slice E3: re-author pipelines/build.stratum.yaml + gsd.stratum.yaml parallel steps to native consumer fanout + merge gate; verify the GSD driver path (engine facts for the brief: isolation enum worktree|none, merge:"sequential" required, step ids /^[a-z][a-z0-9_-]*$/)
- [ ] Task #9: triage ~17 pre-existing full-suite failures (full-suite run capturing the list is in flight)
- [ ] Flag-day (task #6) then epic endgame (task #11: atomic merges, python path deletion)
- [ ] stratum#16 (descriptor final-stage marker) and stratum#17 (bg consumer dispatch) filed as follow-ups
- [ ] One golden timeout flake under parallel load (individual tests ≤3.4s vs 90s ceiling) — watch, not chase

---

*The gate was green all along; the reviewer kept finding ways for recovery to eat approved work anyway.*

---
date: 2026-10-11
session_number: 122
slug: gate-jev-kill-reversed-and-shipped
summary: "COMP-GATE-JEV-1: Jev gate default killed on latency, re-timed with a kept-alive connection, reversed, built, and a live-key tripwire caught the suite billing 66 live calls per run"
feature_code: COMP-GATE-JEV-1
closing_line: We killed it by the rules, then found the rules had been timing the wrong thing.
---

# Session 122 — COMP-GATE-JEV-1

**Date:** 2026-10-11
**Feature:** `COMP-GATE-JEV-1`

## What happened

The question was whether Jev (TypeSafe's typed decision API) should pick the review gate's Enter default instead of a one-line keyword regex. Its first home, Stratum's `stakes: cheap` judged tier, turned out to have zero callers anywhere, so we parked it and pointed Jev at the gate default, a live call site.

We pre-registered a value spike on 51 real gate summaries. Jev crushed the regex on accuracy (46/51 vs 30/51) but failed the latency bar, p95 1602 ms against < 1 s, so by our own rule we killed it. Then we looked at why it was slow: every call opened a fresh TLS connection through the local proxy, and the direct route returns HTTP 451. A second pre-registered spike held one connection open: warm p95 532 ms, and the connection survived a 300 s idle. The kill was reversed on evidence, and the owner asked for it on by default whenever `JEV_API_KEY` is set.

The build needed its own proxy tunnel, because Node 22's built-in fetch ignores `HTTPS_PROXY`. Codex review round 1 found two real bugs: the gate awaited Jev before its readline existed, so a fast typed answer could vanish, and a proxy that never answered CONNECT kept the process alive after the gate had already fallen back. Meanwhile a tripwire run, with the key exported and every proxy pointed at a loopback trap, passed 843/843 tests and still logged 66 CONNECT attempts to api.typesafe.ai. In the owner's real shell that is 66 billed calls per suite run. Jev now switches itself off under a test runner (`NODE_TEST_CONTEXT`/`VITEST`) unless a test injects its own env or transport. The tripwire went to 0 and review round 2 came back CLEAN.

## What we built

- `lib/gate-jev.js` (new): `jevGateDefault`, CONNECT-tunnel transport with one kept-alive unref'd connection, 1.5 s budget, every handle destroyed on abort/timeout, test-runner guard.
- `lib/gate-prompt.js`: readline created before any await; Jev answer feeds `buildRecommendation()`, which says whether `jev` or `keyword` picked the default.
- `test/gate-jev.test.js` + `test/fixtures/gate-jev/`: table-driven rows for each failure kind, lost-input regression, stalled-proxy exit, Python-exact `state`, test-runner guard.
- `docs/features/COMP-GATE-JEV-1/design.md`: two pre-registered spikes with results, kill and reversal.

## What we learned

1. A latency kill can be measuring the plumbing, not the service. Look at what the timer actually wraps before accepting the number; then re-time as a new pre-registered spike, never by editing the old bar.
2. On-by-default plus an ambient credential means the test suite is a paying customer. `NODE_ENV=test` was set during the leak and did nothing; the runner's own marker (`NODE_TEST_CONTEXT`) is the signal compose already trusts.
3. A tripwire beats a review for this class: 843 green tests and a clean-looking diff coexisted with 66 outbound calls. Point every proxy at a trap and count.
4. `ClientRequest.unref` does not exist on Node 22, so `req.unref?.()` silently does nothing. Unref the socket.

## Open threads

- [ ] `test/build-model-route-outcomes.test.js` hangs (8 pass, file never exits) even at 57f80424, before any Jev code; diagnose the open handle.
- [ ] The keyword regex is wrong on 21/51 real summaries; it is still the default for everyone without a Jev key.
- [ ] Other Jev candidates (tool-error labels, security-lens trigger, lane triage) await an owner pick, each needing its own spike.
- [ ] Idle gaps over 300 s untested; the client reconnects once inside the budget if the socket died.

---

*We killed it by the rules, then found the rules had been timing the wrong thing.*

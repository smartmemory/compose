---
date: 2026-07-23
session_number: 96
slug: dispatch-scorekeeping
summary: COMP-TRIAGE-6 COMPLETE @b6ecbd5d — dispatch ledger, ACRR pairing, compose metrics; measurement half of routing shipped
feature_code: COMP-TRIAGE-6
closing_line: The scoreboard is up; now the games have to be played.
---

# Session 96 — COMP-TRIAGE-6

**Date:** 2026-07-23
**Feature:** `COMP-TRIAGE-6`

## What happened

The owner's directive was blunt: "we don't know till we have adequate measurement over time." Routing across model×effort had been guess-based since TRIAGE-5 shipped the estimate half and deferred the measurement half. This session built it end to end: design (3 codex sol/high gate rounds — round 1 killed four architecture-level assumptions including a ledger schema that couldn't represent its own ACRR events; round 3 was adjudicated under the ~3-round budget rule), blueprint (codex verified 122 file:line refs and overturned 10 stale design anchors, including applyFrontTriage living in lane-gate.js, not triage.js), then four codex implementation phases, each verified locally and committed separately. The implementation review found real scorekeeping bugs twice: round 1 caught failed repairs being credited as accepted work and invented ensure-retry settlements; round 2 caught the fix itself leaving accumulator creation side-effects before the start verdict, so a concurrent --fresh could clobber a live build's sidecar. The final fix made accumulator selection side-effect-free with one post-verdict ownership point. The first real `compose metrics` run then immediately demonstrated its own value: 345 unattributed fixture rows from test runs had polluted the live ledger through the process.cwd() fallback — the coverage gauge caught it, exactly as designed. The session also fixed two carried-over bugs first: stratum#26 (MCP swallowed SpecValidationError.errors[]; surface 10→11) and the pre-push hook's EAGAIN echo failures (O_NONBLOCK cleared at hook start).

## What we built

lib/dispatch-ledger.js (new) — closed 4-kind discriminated event union (dispatch/settlement/triage-estimate/build-actuals), envelope stamping, file-seeded _seq, tolerant reader. lib/dispatch-metrics.js (new) — pure aggregator: model×effort_executed buckets, completion vs acceptance split, ACRR with attrition/escalated cohorts, realized-lane rules. bin/compose.js — `compose metrics [--since|--feature|--json]`. lib/stratum-mcp-client.js — shared dispatch helper under agentRun/runAgentText, fail-open capture, non-enumerable dispatchId carrier. lib/local-claude-connector.js — local-route capture. lib/result-normalizer.js + lib/review-normalize.js — context threading, carrier through every error wrapper, repair credited only when its output survived (onRepairUsed seam). lib/build.js — atomic build-accumulator sidecar, post-verdict ownership point, estimates on all three triage paths, terminal actuals on every exit incl. abort, settlement seams. lib/lane-gate.js + feature-writer + schema — triageConfidence persistence. 6 new/extended test files; full suite 4928 node + 581 UI + 100 tracker green. Commits 7e1da89, 4dc5d09, b061518, 1a92695, a165961, b6ecbd5.

## What we learned

1. Attempt identity must be owned, not assumed: any persistence before the start/resume/refuse verdict is a race with the live build — the two-round review arc (disown on refuse → side-effect-free selection with one ownership point) is the general shape for sidecar lifecycles. 2. Credit follows adjudication, not dispatch: three separate review findings (repair credit, fixer settlements, ensure-retry reissues) were all the same mistake — writing an outcome for work the engine never judged. 3. Coverage gauges pay for themselves on day one: the unattributed count caught test pollution of the live ledger within minutes of the CLI existing. 4. Executed-vs-intended is a real axis: effort only executes where it rides the wire (codex model strings); recording the intended label as if executed would have made the whole curve a lie. 5. The blueprint corrections table earned its cost — 10 design anchors were stale against the checkout; implementing from the design alone would have wired capture into a usage recorder that runs after dispatch.

## Open threads

- [ ] COMP-TRIAGE-6-1: instrument GSD stepDone settlements (acceptance shows n/a)
- [ ] COMP-TRIAGE-6-2: execute effort on claude routes + keep test runs out of the live ledger (NODE_TEST_CONTEXT fallback redirect)
- [ ] COMP-TRIAGE-6-3 (PARKED): feed the measured curve into resolveAgentConfig once data volume exists
- [ ] stratum#27: accept + execute effort on the agent_run wire, report in telemetry
- [ ] Two distinct single-test flakes observed in consecutive full-suite runs (SSE replay smoke, hung-retry timing) — both pass in isolation; watch for recurrence

---

*The scoreboard is up; now the games have to be played.*

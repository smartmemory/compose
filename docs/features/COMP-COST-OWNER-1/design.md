# <Feature Name>: Design


## Why

Traced 2026-09-14 (evidence/step-envelope-usage-2026-09-14.md): ordinary step-completion envelopes still carry no usage (lib/build.js:5466); spend reaches stratum's BudgetLedger only because recordBuildUsage receipts each dispatch first via stratum_usage_report. Three residual leaks: (1) lib/new.js:139 destructures only { result } from runAndNormalize, so kickoff usage is never receipted nor carried; (2) a failed receipt is warned and swallowed at build.js:2360 and the envelope has no fallback, so that dispatch is absent from the per-flow cap; (3) legacy no-receipt mode carries usage only on fanout/GSD envelopes. Smallest correct change: never send a bare completion after usage was consumed but not acknowledged. Falsifiers: lib/new.js still destructures only { result }; build.js receipt catch still warns-and-continues with stepDoneResult carrying no usage.

**Status:** DESIGN
**Date:** <date>

## Related Documents

<!-- Link to roadmap, dependencies, and related features -->

---

## Problem

<!-- Describe the problem this feature solves -->

## Goal

<!-- What does success look like? Scope and non-scope. -->

---

## Decision 1: <Title>

<!-- Describe the decision, options considered, and rationale -->

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| | | |

## Open Questions

<!-- List unresolved questions -->

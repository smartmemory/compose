# Session 27 — COMP-OBS-STEPDETAIL: Step Detail Extensions

**Date:** 2026-04-24
**Feature:** COMP-OBS-STEPDETAIL (Wave 6 final)

## What happened

Wave 6's final feature: extending `ContextStepDetail.jsx` with three operationally important signal sections, adding `GET /api/lifecycle/budget`, and appending a compact budget pill to `OpsStrip`.

The design was clear — all data sources were already shipped. The key implementation decisions were:

1. **Self-fetch removal**: `ContextStepDetail` previously fetched `/api/build/state` itself on every `stepId` change. We replaced this with a `useVisionStore` subscription (`activeBuild` + `iterationStates`), letting the existing 5s poller drive updates. This eliminates redundant HTTP traffic and makes the panel reactive to store changes.

2. **`readBudget` helper**: `checkCumulativeBudget` throws on quota — we needed a snapshot read. Added `readBudget(composeDir, featureCode, settings)` to `budget-ledger.js` that assembles the endpoint response shape without side effects. The v1 limitation (feature-wide iteration count proxied for each loopType) is documented in the code.

3. **`findLoopForStep` graceful degradation**: The blueprint noted that shipped `iterationStates` entries may not carry `stepId`. The helper walks the Map and returns null if no match — the live counters section simply doesn't appear, with no error.

4. **Violations section rename**: The old code rendered `step.violations` under a plain "Violations" heading. We promoted it to "Postcondition Violations" to make the connection to Stratum's `ensure` postconditions explicit, with no data-shape change.

5. **Budget pill in OpsStrip**: `formatBudgetCompact` from `stepDetailLogic.js` returns `""` when no loopType has a maxTotal, so the pill is self-gating — no conditional in OpsStrip needed beyond `{budgetPill && ...}`.

## What we built

**New files:**
- `/Users/ruze/reg/my/forge/compose/lib/budget-ledger.js` — extended with `readBudget()` helper
- `/Users/ruze/reg/my/forge/compose/server/vision-routes.js` — added `GET /api/lifecycle/budget`
- `/Users/ruze/reg/my/forge/compose/src/components/cockpit/stepDetailLogic.js` — new pure helpers module
- `/Users/ruze/reg/my/forge/compose/src/components/cockpit/ContextStepDetail.jsx` — rewritten: store subscription, 3 new sections
- `/Users/ruze/reg/my/forge/compose/src/components/cockpit/OpsStrip.jsx` — budget pill appended
- `/Users/ruze/reg/my/forge/compose/test/budget-route.test.js` — 7 tests for GET /api/lifecycle/budget
- `/Users/ruze/reg/my/forge/compose/test/step-detail-logic.test.js` — 27 tests for pure helpers
- `/Users/ruze/reg/my/forge/compose/test/ui/context-step-detail.test.jsx` — 17 UI tests (jsdom)
- `/Users/ruze/reg/my/forge/compose/test/ui/ops-strip-budget.test.jsx` — 5 UI tests for budget pill
- `/Users/ruze/reg/my/forge/compose/test/wave-6-integration.test.js` — extended: +5 STEPDETAIL integration tests

## What we learned

1. **vi.mock hoisting in Vitest requires dynamic import after the mock.** The `useVisionStore` mock had to be set up before the `await import(...)` of ContextStepDetail, otherwise the module resolved the real store. The `_storeState` mutable object pattern (update by reference, no re-mock) works cleanly for stateful mocked stores across tests.

2. **Budget pill is naturally self-gating.** `formatBudgetCompact` returns `""` when no loopType has maxTotal, so conditional render in OpsStrip is just `{budgetPill && <span>...}` — no complex logic needed.

3. **The `iterCountRef` pattern for budget refetch.** Rather than listening for a specific WS message, OpsStrip tracks the sum of all iteration counts and refetches budget when that number changes — a simple heuristic that avoids coupling to message types while catching all iteration completions.

## Open threads

- [ ] v2: `readBudget` could break out per-loopType iterations when the ledger records loopType on each session entry
- [ ] Live counters would benefit from a `loopId`-based join once Stratum emits `stepId` on iteration events
- [ ] Wave 6 integration review: now that all features are shipped, run end-to-end integration review checklist

Wave 6 complete. The session that finished what was started.

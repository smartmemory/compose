# COMP-GSD-4: Implementation Plan

**Status:** PLAN (Phase 6) · **Blueprint:** [blueprint.md](./blueprint.md) (slices S1–S6)
**Execution:** TDD per task — test first, watch fail, implement, watch pass. Independent tasks (T1–T3) first, then dependents (T4–T6).

## Tasks (ordered by dependency)

- [ ] **T1 — Contract (S5)** `contracts/gsd-stuck.json`
  - [ ] Test first: legacy kind-less stuck pause validates; `kind:"stuck"` validates; `kind:"budget"` requires `budget` block; budget pause missing the block fails.
  - [ ] `kind` optional; base `required` minus stuck-only fields; `if(kind=="budget")/then require budget /else require stuck fields`; add `budget` def `{axis, consumed, caps}`; keep `additionalProperties:false`.

- [ ] **T2 — Ledger (S2)** `lib/budget-ledger.js`
  - [ ] Test first (`test/budget-ledger.test.js` extend): `recordGsdUsage` adds `totalTokens`/`totalCostUsd`, back-compat; `checkGsdCumulativeBudget` exceeded/not for tokens & cost; wall-clock/dispatch NOT cumulative-checked.
  - [ ] `recordGsdUsage(composeDir, feature, {tokens,costUsd,dispatches,timeMs})`; `checkGsdCumulativeBudget(composeDir, feature, {maxTotalTokens,maxTotalCostUsd})`.

- [ ] **T3 — gsd-budget helpers (S1)** `lib/gsd-budget.js` (new)
  - [ ] Test first (`test/gsd-budget.test.js` new): `injectBudget(spec,{})===spec` (exact identity, no round-trip); block + `execute.timeout` injection when configured; `buildBudgetBlock` maps snake_case; `composeBudgetDiagnostic` axis detection + `{json,md}` shape.
  - [ ] `readGsdBudgetConfig`, `buildBudgetBlock`, `injectBudget`, `composeBudgetDiagnostic`.

- [ ] **T4 — build.js short-circuit (S4)** `lib/build.js`
  - [ ] Guarded `outcome.status==='budget_exhausted'` short-circuit in `executeParallelDispatchServer` (after poll loop + after each `parallelAdvance`); return envelope verbatim (carries `budget_state`). No-op for build mode.

- [ ] **T5 — gsd.js wiring (S3)** `lib/gsd.js`
  - [ ] `injectBudget` after spec load; cumulative pre-check before plan + on resume; add `budget_exhausted` to terminal set; terminal `budget` branch (`writeBudgetArtifacts` + `recordGsdUsage`); `recordGsdUsage` on clean finish; **widen `try` to cover the `loadResumeTaskGraph` claim**; `releasePauseLock` in `finally`; `writeBudgetArtifacts` + `releasePauseLock` helpers.
  - [ ] Tests (`test/gsd-budget.test.js` + `test/gsd-resume.test.js`): byte-identical un-budgeted plan; budget terminal writes artifacts + `pause.json kind:budget`; ledger recorded; `pause.lock` released on re-halt/refusal; cumulative refusal returns `{status:'budget', axis:'cumulative'}` without dispatch.

- [ ] **T6 — CLI (S6)** `bin/compose.js`
  - [ ] `result.status==='budget'` branch (print `budget.md` path + resume/raise-cap hint); `--reset-budget` flag → clear cumulative ledger entry; thread into `runGsd` opts.

## Exit criteria (Phase 7)
- [ ] All task tests pass (TDD).
- [ ] Full `npm test` green (the byte-identical guarantee is load-bearing).
- [ ] Codex review loop → REVIEW CLEAN.
- [ ] Coverage sweep → TESTS PASSING.

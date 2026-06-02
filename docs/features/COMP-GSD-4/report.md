# COMP-GSD-4: Implementation Report

**Status:** SHIPPED
**Date:** 2026-06-03
**Design:** [design.md](./design.md) · **Blueprint:** [blueprint.md](./blueprint.md) · **Plan:** [plan.md](./plan.md)

## Summary

Budget ceilings for autonomous `compose gsd` runs — implemented by **adopting the
shipped stratum flow budget (STRAT-WORKFLOW-BUDGET)**, not rebuilding it. A gsd run
now declares a `budget:` block (injected from `.compose/compose.json` `gsd.budget.*`,
opt-in) so stratum enforces `max_tokens`/`max_agent_dispatches`/wall-clock/`usd`,
halts with terminal `budget_exhausted`, and compose turns that into a clean halt with
`budget.{md,json}` diagnostics + a `pause.json` (`kind:"budget"`) that `--resume`
consumes exactly like a stuck halt. Cumulative cross-session token/cost is tracked in
`budget-ledger.js`; a spent ceiling refuses the run pre-dispatch.

## Delivered vs Planned

| Planned (blueprint slice) | Status | Notes |
|---|---|---|
| S1 `lib/gsd-budget.js` — config→block, identity injection, diagnostic | ✅ | + `trippedAxis` helper |
| S2 `budget-ledger.js` — `recordGsdUsage`/`checkGsdCumulativeBudget` | ✅ | + `resetGsdUsage` for `--reset-budget` |
| S3 `lib/gsd.js` — inject, terminal branch, cumulative pre-check, lock release | ✅ | claim split from read (`claimResumeLock`); ownership-aware release |
| S4 `lib/build.js` — guarded `budget_exhausted` short-circuit | ✅ | poll-carried; advance-carried returns naturally |
| S5 `contracts/gsd-stuck.json` — `kind` + budget block + if/then/else | ✅ | `kind` optional; legacy kind-less pauses validate via `else` |
| S6 `bin/compose.js` — `budget` branch + `--reset-budget` | ✅ | |
| Live OpsStrip burn pill | ⛔ **deferred** | `COMP-GSD-4-OPSSTRIP-LIVE` — gsd runs a no-op streamWriter; needs a gsd-telemetry surface first (design Decision 6). |
| Per-task token hard cutoff | ⛔ **deferred** | `COMP-GSD-4-PERTASK-TOKENS` — flow budget is aggregate; per-task wall-clock (`task_timeout`) + stuck detector cover the runaway case (design Decision 5). |

## Architecture Deviations

1. **`task_timeout`, not `timeout`** (blueprint correction): the per-task wall-clock on a
   `parallel_dispatch` step is `task_timeout` in **seconds** (`spec.py:145`), not `timeout`
   (that's the gate timeout). `per_task_ms` config → `task_timeout: ceil(ms/1000)`.
2. **`usd` is enforced, not recorded-only** (Codex design-gate F1): STRAT-WORKFLOW-BUDGET-DOLLARS
   shipped after the base; `gsd.budget.usd` is a real cost cap (unpriced models under-count →
   `max_tokens` is the reliable backstop).
3. **Diagnostic sourced from `budget_state`, not build-stream** (Codex design-gate F2): gsd runs a
   no-op streamWriter, so the consumed-vs-cap data comes from the terminal envelope's `budget_state`.
4. **Claim split from read** (Codex blueprint-gate F1): `loadResumeTaskGraph(..., {claim:false})` reads+guards;
   the atomic `pause.lock` claim moved to the first statement inside runGsd's `try`, released by an
   **ownership-aware** `finally` (Codex impl-review High) — no strand on re-halt/refusal, no clobber of a
   concurrent claim.

## Key Decisions

- **Adopt, don't rebuild** — the enforcement engine ships in stratum; GSD-4 is glue + surface (verify-first).
- **Fully opt-in, no default caps** (Phase-1 gate) — un-budgeted runs are byte-identical (asserted: `injectBudget(spec,{}) === spec`).
- **Cumulative tokens/cost persist & block resume; per-run wall-clock/dispatch reset** each invocation.
- **`pause.json` `kind` optional** so existing GSD-5 pause files keep validating.

## Test Coverage

- `test/gsd-budget.test.js` (20): config read, block mapping, identity injection, `task_timeout` conversion, `trippedAxis`, diagnostic shape, ledger record/back-compat/check/reset.
- `test/gsd-budget-run.test.js` (5): byte-identical spec, budget block injection, budget terminal (artifacts + `pause.json kind:budget` + ledger record + lock released), ownership-aware non-clobber, cumulative refusal-before-plan.
- `test/contracts-gsd-stuck.test.js` (+5): budget pause validates, missing block fails, stuck-fields not required for budget, legacy kind-less still validates.
- Full suite: **3110 lib + 146 UI + 100 tracker green**; the byte-identical guarantee (no regression in any existing gsd/build path) is the load-bearing check.

## Files Changed

| File | Action | Purpose |
|------|--------|---------|
| `lib/gsd-budget.js` | new | config→budget block, identity injection, diagnostic compositor |
| `lib/budget-ledger.js` | edit | `recordGsdUsage`, `checkGsdCumulativeBudget`, `resetGsdUsage` |
| `lib/gsd.js` | edit | inject, cumulative pre-check, `budget_exhausted` terminal branch, `writeBudgetArtifacts`, `claimResumeLock`/`releasePauseLock` (ownership-aware), `recordGsdUsageFromState` |
| `lib/build.js` | edit | guarded `budget_exhausted` short-circuit in `executeParallelDispatchServer` |
| `contracts/gsd-stuck.json` | edit | `kind` discriminator + `budget` block + if/then/else |
| `bin/compose.js` | edit | `budget` result branch + `--reset-budget` |
| `test/{gsd-budget,gsd-budget-run}.test.js`, `test/contracts-gsd-stuck.test.js` | new/edit | coverage |

## Known Issues / Follow-ups

- `COMP-GSD-4-OPSSTRIP-LIVE` — live cockpit burn pill (needs gsd build-stream telemetry).
- `COMP-GSD-4-PERTASK-TOKENS` — per-task token hard cutoff (needs a stratum-side change).
- Both are documented scope cuts, not gaps.

## Lessons Learned

- **Verify-first turned a "build" into an "adopt."** The enforcement engine, per-task usage accounting, terminal propagation, and even the `budget_state` envelope all already shipped in stratum/compose — the same pattern as COMP-GSD-3. Re-reading the substrate (and the *current* source, not the stale 2026-05-29 report) saved rebuilding all of it.
- **The Codex gate earned its keep at every phase**: design (usd-enforced, telemetry overclaim), blueprint (pause.lock strand + `kind`-default validation trap), impl (unconditional lock release = concurrency clobber). None were caught by tests first.

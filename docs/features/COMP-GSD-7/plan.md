# COMP-GSD-7 — Milestone Report Generator: Implementation Plan

**Status:** PLAN (Phase 6 — derived from verified blueprint)
**Date:** 2026-06-03
**Blueprint:** [blueprint.md](blueprint.md)

TDD throughout: write the test, watch it fail, implement, watch it pass.

---

## Task Order

S1 → S2 (core, fully unit-testable) → S3 → S4 (instrumentation + wiring) → S5 (CLI) → S6 (docs).

## S1: timing sidecar I/O — `lib/gsd-timing.js` (new)

- **File:** `lib/gsd-timing.js` (new)
- **What:**
  - [ ] `writeTimingSidecar(cwd, featureCode, timingMap)` — atomic tmp+rename to
    `.compose/gsd/<f>/timing.json`; `mkdirSync` recursive (pattern from `gsd-state.js:44`)
  - [ ] `readTimingSidecar(cwd, featureCode)` — returns the map or `{}` (pattern from
    `gsd-blackboard.read`)
  - [ ] `recordTaskStates(timingMap, pollTasks, nowIso)` — **pure** accumulator: first sight of a
    task → `startedAt`; first terminal state (`complete|failed|cancelled`) → `completedAt` +
    `durationMs`. Returns the mutated map. (Extracted so the poll-loop logic is unit-testable.)
- **Pattern:** `lib/gsd-state.js:44-63` (atomic write/read), `lib/gsd-blackboard.js:98` (read-or-{})
- **Test:** `test/gsd-timing.test.js` — round-trip write/read; `recordTaskStates` start→complete
  transition sets all three fields; second call doesn't overwrite an existing `startedAt`;
  durations non-negative; missing/absent file → `{}`.
- **Depends on:** none

## S2: report generator — `lib/gsd-milestone-report.js` (new)

- **File:** `lib/gsd-milestone-report.js` (new)
- **What:**
  - [ ] `assembleReportModel(featureCode, cwd, opts={})` → `{ feature, status, phase, startedAt,
    completedAt, tasks[], budget, timeline[], totals }`. Reads `readGsdState`,
    `gsd-blackboard.read`, `readTimingSidecar` (S1), `diffs/<taskId>.diff` files; budget via
    precedence `opts.budgetState → budget-final.json → budget.json → null`. `tasks[]` joins
    blackboard ⨝ timing ⨝ diff-presence by `taskId`. `timeline[]` from state fields +
    `pause/stuck/budget.json` presence. `totals` = task count, completed, completion-rate,
    total wall-clock (`completedAt − startedAt`).
  - [ ] `renderReportHtml(model)` → self-contained HTML string (template literal, inline `<style>`,
    `JSON.stringify` data; diffs in `<details><pre>`, 200 KB cap with pointer). HTML-escape all
    interpolated text. Pattern: `server/graph-export.js:120`.
  - [ ] `writeGsdReport(cwd, featureCode, html)` → atomic write to
    `docs/gsd-reports/<feature>.html`, return path.
  - [ ] `generateGsdMilestoneReport(featureCode, cwd, opts={})` → orchestrate; return
    `{ ok, path, model, html }` or `{ ok:false, error }` (e.g. no state.json).
- **Pattern:** atomic write `gsd-state.js:44`; budget `gsd-budget.js:composeBudgetDiagnostic`
- **Test:** `test/gsd-milestone-report.test.js` — fixture a `.compose/gsd/<f>/` tree (state.json,
  blackboard.json, timing.json, diffs/*.diff, budget-final.json) under a tmp cwd; assert model
  fields; assert HTML contains task ids, budget caps/consumed, completion-rate, diff text; assert
  file written under `docs/gsd-reports/`; **degrade paths**: no timing → "—" elapsed; no diff →
  "no diff captured" + files_changed; no budget → "unbudgeted"; no state.json → `ok:false`;
  diff > 200 KB truncated; HTML-escaping of `<`/`&` in summaries.
- **Depends on:** S1

## S3: build.js instrumentation — `lib/build.js` (existing)

- **File:** `lib/build.js` (existing)
- **What:**
  - [ ] In `executeParallelDispatchServer` poll loop (`~3026-3069`): maintain `taskTiming = {}`;
    call `recordTaskStates(taskTiming, pollResult.tasks, new Date().toISOString())` each poll.
    After the loop resolves, if `context.gsd === true` →
    `writeTimingSidecar(context.cwd, context.featureCode, taskTiming)`.
  - [ ] In `applyServerDispatchDiffsCore` (`~3352`): when `ts.diff != null` and
    `context?.gsd === true` → atomic-write `ts.diff` to
    `.compose/gsd/<featureCode>/diffs/<taskId>.diff` (`mkdirSync` recursive) before/alongside
    `diffMap.set`.
- **Pattern:** existing atomic writes; gate on `context.gsd` (build mode unaffected — byte-identical)
- **Test:** `test/gsd-milestone-report.test.js` (or a build-targeted test) — call
  `applyServerDispatchDiffsCore` with synthetic `pollTasks` (one `complete` + diff) and
  `context={cwd,featureCode,gsd:true}`; assert `diffs/<id>.diff` written; assert NO write when
  `context.gsd` absent (build-mode invariant).
- **Depends on:** S1

## S4: gsd.js completion wiring — `lib/gsd.js` (existing)

- **File:** `lib/gsd.js` (existing)
- **What:**
  - [ ] `gsd.js:341` — pass `context = { cwd, featureCode, gsd: true }` to
    `executeParallelDispatchServer` (currently `{ cwd, featureCode }`).
  - [ ] `gsd.js:267-272` complete branch — when `response.budget_state` present, write
    `budget-final.json` (`composeBudgetDiagnostic(...).json`, atomic) to `.compose/gsd/<f>/`.
  - [ ] `gsd.js:278` — add `completedAt: new Date().toISOString()` to the terminal `flushState` patch.
  - [ ] After `gsd.js:278`, before return — `if (terminalStatus === 'complete')` best-effort
    `await generateGsdMilestoneReport(featureCode, cwd)` wrapped in try/catch → warn (never fail
    the run).
- **Pattern:** `writeBudgetArtifacts` (`gsd.js:1036`) for the budget-final writer shape
- **Test:** focused test — drive the complete branch (or a thin extracted `finalizeGsdComplete`
  helper) with a fake `budget_state`; assert `state.json.completedAt` set, `budget-final.json`
  written, report generated under `docs/gsd-reports/`. Confirm a report-gen throw does NOT throw
  out of the completion path.
- **Depends on:** S2, S3

## S5: CLI — `bin/compose.js` (existing)

- **File:** `bin/compose.js` (existing)
- **What:**
  - [ ] Insert `gsd report <feature>` sub-route after `bin/compose.js:1987` (mirror `gsd query`):
    resolve cwd, `import generateGsdMilestoneReport`, print path / error, exit 0/1.
  - [ ] Add usage line at `bin/compose.js:1995`.
- **Pattern:** `bin/compose.js:1974-1987` (`gsd query`)
- **Test:** invoke `node bin/compose.js gsd report <code> --cwd <tmp>` against an S2 fixture; assert
  exit 0 + file written; assert exit 1 + message when no run state.
- **Depends on:** S2

## S6: docs + roadmap — (existing)

- **What:**
  - [ ] `CHANGELOG.md` entry
  - [ ] `feature.json` → COMPLETE; `ROADMAP.md` regen (path corrected to `docs/gsd-reports/`)
  - [ ] File follow-up `COMP-GSD-7-EVENTLOG` (append-only GSD run-event log) — scaffold + ROADMAP row
  - [ ] `report.md` (Phase 8) + journal entry (Phase 9)
- **Depends on:** S1-S5 green + review/sweep clean

## Files Summary

| File | Tasks |
|------|-------|
| `lib/gsd-timing.js` (new) | S1 |
| `lib/gsd-milestone-report.js` (new) | S2 |
| `lib/build.js` | S3 |
| `lib/gsd.js` | S4 |
| `bin/compose.js` | S5 |
| `test/gsd-timing.test.js` (new) | S1 |
| `test/gsd-milestone-report.test.js` (new) | S2, S3 |
| docs (`CHANGELOG`/`ROADMAP`/`feature.json`/`report.md`/journal) | S6 |

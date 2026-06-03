# COMP-GSD-7 — Milestone Report Generator: Implementation Report

**Status:** COMPLETE
**Date:** 2026-06-03

## Summary

Shipped an auto-generated, self-contained HTML milestone report for completed GSD
(autonomous long-run) features. On a clean `compose gsd` completion the run now writes
`docs/gsd-reports/<feature>.html` — per-task summary (status / attempts / files / elapsed),
budget actuals-vs-caps, a snapshot-derived run timeline, and inline per-task diffs. A
`compose gsd report <feature>` CLI regenerates it retroactively. The report rides the existing
cockpit `DocsView` discovery — zero server changes.

## Delivered vs Planned

| Planned (plan.md) | Delivered | Notes |
|---|---|---|
| S1 timing sidecar + pure accumulator | ✅ `lib/gsd-timing.js` | `recordTaskStates` extracted as pure fn |
| S2 report generator | ✅ `lib/gsd-milestone-report.js` | assemble/render/write/orchestrate |
| S3 build.js instrumentation | ✅ `lib/build.js` + `lib/gsd-diff-capture.js` | diff persist factored into its own helper |
| S4 gsd.js completion wiring | ✅ `lib/gsd.js` | context.gsd marker, budget-final, completedAt, report hook |
| S5 `gsd report` CLI | ✅ `bin/compose.js` | fixed `--cwd`-value-as-code arg edge |
| S6 review/sweep/docs/ship | ✅ | this report + below |

## Architecture Deviations

- **Diff persistence factored out.** The blueprint folded diff persistence into build.js; in
  practice it became `lib/gsd-diff-capture.js` so the path helper (`gsdTaskDiffPath`) is the single
  source of truth shared by the writer (build.js) and the reader (report) — no duplicated path math.
- **No `contracts/task-result.json` change** (as the blueprint predicted): timing rides the
  `timing.json` sidecar, keeping the agent-written TaskResult contract untouched.

## Key Implementation Decisions

1. **`context.gsd === true` gate.** Both instrumentation writes (timing + diff) are gated on an
   explicit `gsd:true` marker that only `gsd.js` sets — `featureCode` alone couldn't distinguish
   gsd from build mode (build context also carries it). Build mode stays byte-identical (proved by
   `test/gsd-dispatch-instrumentation.test.js` + the unchanged dispatch-server suite).
2. **Everything report-side is best-effort.** Timing sidecar, diff snapshot, budget-final snapshot,
   and report generation are all try/catch-wrapped so a derived-artifact failure can never fail or
   demote a successful GSD run. (Codex review caught the one place — `writeBudgetFinalSnapshot` —
   that wasn't, and it was fixed.)
3. **Budget source precedence** `opts.budgetState → budget-final.json → budget.json → unbudgeted`.
   A clean complete writes no `budget.json` (only halts do), so S4 added a `budget-final.json`
   snapshot (distinct filename from the halt artifact) for the retroactive path.
4. **`completedAt` persisted to `state.json`** on the terminal flush so `gsd report` can recover
   total wall-clock for runs completed after this feature.

## Test Coverage

- `test/gsd-timing.test.js` (11) — sidecar round-trip + `recordTaskStates` transitions/idempotency.
- `test/gsd-diff-capture.test.js` (4) — diff snapshot path + atomic write.
- `test/gsd-milestone-report.test.js` (16) — model assembly, HTML render, escaping, 200 KB diff
  truncation, atomic write, and every degrade path (no timing / diff / budget / state).
- `test/gsd-report-wiring.test.js` (4) — `writeBudgetFinalSnapshot` shape + report join.
- `test/gsd-dispatch-instrumentation.test.js` (2) — real-git integration: gsd path persists
  timing + diffs; build mode persists nothing.
- Full suite: **3192/3192** green.

## Files Changed

| File | Action | Purpose |
|---|---|---|
| `lib/gsd-timing.js` | new | timing sidecar I/O + `recordTaskStates` |
| `lib/gsd-diff-capture.js` | new | per-task diff snapshot persistence |
| `lib/gsd-milestone-report.js` | new | assemble + render + write + orchestrate |
| `lib/build.js` | edit | poll-loop timing capture + diff persist (gsd-gated) |
| `lib/gsd.js` | edit | context.gsd marker, budget-final, completedAt, report hook |
| `bin/compose.js` | edit | `compose gsd report <feature>` CLI |
| 5 × `test/gsd-*.test.js` | new | 37 tests |

## Known Issues & Tech Debt

- **Per-task elapsed is poll-granularity-approximate** (bounded by the dispatch poll interval) —
  documented in the report footer. Acceptable for a milestone report.
- **Run timeline is snapshot-derived**, not a true event stream — there is no append-only GSD
  run-event log. Filed as follow-up **COMP-GSD-7-EVENTLOG**.
- Diffs require `isolation:worktree` + `capture_diff:true` on the GSD dispatch (the gsd pipeline
  sets both); a task without worktree isolation degrades to "no diff captured" + files-changed list.

## Lessons Learned

- The Codex implementation gate again earned its keep: it found the one non-best-effort write
  (`writeBudgetFinalSnapshot`) that would have silently turned successful runs into failures — a
  wiring bug no unit test would have surfaced.
- "Full v1" sounded cross-cutting but both missing inputs (timing, diffs) turned out to be
  compose-side data already in hand — the Stratum boundary never had to move.

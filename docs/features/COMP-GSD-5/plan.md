# COMP-GSD-5: Stuck Detection — Implementation Plan

**Status:** PLAN
**Date:** 2026-06-02
**Blueprint:** [blueprint.md](blueprint.md)

TDD throughout: write the test, watch it fail, implement, watch it pass. Contract shapes from `contracts/gsd-stuck.json`.

## Task Order
1 → 2 → 3 → 4 → 5 (each depends on the prior). Task 2 (detector) is the core and is independently testable.

## Task 1: Diagnostic + pause-state contract
- **File:** `contracts/gsd-stuck.json` (new)
- **What:** JSON Schema with two definitions — `stuck` (diagnostic: `{feature, taskId, signal: enum[same_file,error_recurrence,no_progress,wall_clock], detail, attemptCounts, partialDiff?, ts}`) and `pause` (`{flowId, stepId, stuckTaskId, signal, detail, decomposedTasks, completedTaskIds, pid, mode, ts}`). Follow `contracts/*.json` house style (`_source`, `_roadmap`).
- **Acceptance:**
  - [ ] Schema validates a sample `stuck.json` and `pause.json`
  - [ ] `_source` = COMP-GSD-5, `_roadmap` set

## Task 2: GsdStuckDetector
- **File:** `lib/gsd-stuck.js` (new); test `test/gsd-stuck.test.js` (new)
- **What:** class per blueprint API. Reuse `FixChainDetector` (`lib/debug-discipline.js:28`) for same-file; add error-recurrence (normalize+hash `tool_result.output` where `ok:false`) and no-progress (consecutive non-file-changing `tool_use_summary`); `startTask`/`check`/`reset`/`toJSON`/`fromJSON`.
- **Pattern:** `debug-discipline.js` per-key `byBug`→`byTask` Map + `toJSON/fromJSON`.
- **Acceptance:**
  - [ ] same-file fires at `sameFileEdits` hits of one `file_path`, not below
  - [ ] error-recurrence fires at `errorRepeats` of a normalized error hash; cosmetic differences (paths/line-nums/whitespace) collapse to the same hash
  - [ ] no-progress fires at `noProgressCalls` consecutive non-file-changing calls; a file-changing tool resets the counter
  - [ ] wall-clock fires when `nowMs - startedAt ≥ wallClockMs`
  - [ ] `check` returns `{stuck, signal, detail}`; per-task isolation (one task's events don't trip another)
  - [ ] `toJSON`→`fromJSON` round-trips detector state
  - [ ] thresholds read from constructor opts; documented defaults 3/3/8/600000

## Task 3: Wire detector into the dispatch loop (opt-in)
- **File:** `lib/build.js` (`executeParallelDispatchServer` :2943); extend its tests
- **What:** add optional `opts.stuckDetector`. In `onEvent` (:2986) route `tool_use_summary`/`tool_result` to `stuckDetector.record(event)`. In poll loop after `emitPerTaskProgress` (:3009): `check(taskId, Date.now())`; on stuck → cancel via `stratum.parallelAdvance(flowId, stepId, 'conflict')`, break, return `{...outcome, stuck}`. `startTask` when a task enters `running`.
- **Acceptance:**
  - [ ] with NO `stuckDetector`, behavior is byte-identical (existing build tests green)
  - [ ] with a detector, a stuck verdict cancels + returns a `stuck` outcome (fake-stratum unit test)
  - [ ] events are recorded keyed by `event.task_id`

## Task 4: gsd run-loop integration + resume
- **File:** `lib/gsd.js`; test `test/gsd-resume.test.js` (new)
- **What:** construct `GsdStuckDetector` from `.compose/compose.json` `gsd.stuck.*` (fallback defaults); pass to `executeParallelDispatchServer`. On stuck outcome: write `.compose/gsd/<feature>/stuck.{md,json}` + `pause.json` (per contract; `completedTaskIds` from blackboard, `decomposedTasks` persisted); return `{status:'stuck'}`. `--resume` branch: read `pause.json`, guard (no live `pid`, `mode==='gsd'`), re-dispatch `decomposedTasks` minus `completedTaskIds`; delete `pause.json` on clean finish.
- **Pattern:** `compose fix --resume` guard (`bin/compose.js:1933`); blackboard read (`lib/gsd-blackboard.js`).
- **Acceptance:**
  - [ ] stuck outcome writes `stuck.md` + `stuck.json` (schema-valid) + `pause.json`
  - [ ] `--resume` skips `completedTaskIds`, re-dispatches the remainder
  - [ ] resume refused if another live `pid` owns it or `mode` mismatches
  - [ ] clean resume removes `pause.json`

## Task 5: CLI flag
- **File:** `bin/compose.js` (`cmd === 'gsd'` :1967)
- **What:** parse `--resume`; pass `{ resume }` to `runGsd`; update the gsd usage/help line.
- **Acceptance:**
  - [ ] `compose gsd <feature> --resume` routes to the resume path
  - [ ] help text documents `--resume`

## Files Summary
| File | Tasks |
|------|-------|
| `contracts/gsd-stuck.json` | 1 |
| `lib/gsd-stuck.js` + `test/gsd-stuck.test.js` | 2 |
| `lib/build.js` | 3 |
| `lib/gsd.js` + `test/gsd-resume.test.js` | 4 |
| `bin/compose.js` | 5 |

## Exit (Phase 7)
- [ ] all tasks' tests green; full `npm test` green
- [ ] Codex review loop → REVIEW CLEAN
- [ ] coverage sweep → TESTS PASSING

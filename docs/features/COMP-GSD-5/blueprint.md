# COMP-GSD-5: Stuck Detection — Implementation Blueprint

**Status:** BLUEPRINT (verified against current source 2026-06-02)
**Date:** 2026-06-02
**Design:** [design.md](design.md)
**Prereq:** STRAT-PAR-STREAM-TOOLDETAIL — SHIPPED (stratum `aa19650`, compose `082c778`); the `tool_use_summary.input` + `tool_result` telemetry this consumes is live at schema 0.2.7.

---

## Telemetry contract consumed (now live)

Per-task events arrive via `stratum.onEvent(flowId, stepId, handler)` inside `executeParallelDispatchServer`; envelope carries `task_id` (`parallel_exec.py:_mint`). Relevant kinds:
- `tool_use_summary`: `metadata = {tool, summary, ok, duration_ms, input, tool_use_id}` — `input` is the raw (≤2048-char) tool input; `input.file_path` present for `Edit`/`Write`/`MultiEdit`/`Read`.
- `tool_result`: `metadata = {tool_use_id, ok, output}` — `ok:false` + `output` (≤2048 chars) is the per-call error.

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| `lib/gsd-stuck.js` | new | `GsdStuckDetector` — consume events keyed by `task_id`, 3 signals + wall-clock, verdict, `toJSON/fromJSON` |
| `contracts/gsd-stuck.json` | new | schema for `stuck.json` (diagnostic) + `pause.json` (resume state) |
| `lib/build.js` | existing | `executeParallelDispatchServer` gains **optional** `stuckDetector` param; route `tool_use_summary`/`tool_result` to it in the `onEvent` handler (`:2986`); wall-clock + verdict check in the poll loop (`:3009`); on stuck → cancel + return `{outcome, stuck}`. Build mode passes nothing → **byte-identical**. |
| `lib/gsd.js` | existing | construct detector from `gsd.stuck.*` config; pass to dispatch; on stuck outcome write `stuck.md`/`stuck.json` + `pause.json`; return status `stuck`. `--resume` branch: read `pause.json`, ownership/mode guard, re-dispatch the non-completed task subset. |
| `bin/compose.js` | existing | `cmd === 'gsd'` block (`:1967`): parse `--resume` (pattern from bug mode `:1874`), pass `{resume}` to `runGsd`. |
| `lib/gsd-blackboard.js` | existing (read) | source of `completedTaskIds` (validated results) for the resume skip |
| `test/gsd-stuck.test.js` | new | each signal, thresholds, reset, serialization, diagnostic shape |
| `test/gsd-resume.test.js` | new | pause.json persistence, ownership/mode guard, completed-task skip on resume |

## GsdStuckDetector API (`lib/gsd-stuck.js`)

```
new GsdStuckDetector({ sameFileEdits=3, errorRepeats=3, noProgressCalls=8, wallClockMs=600000 })
  .record(event)            // BuildStreamEvent; routes by kind, keyed by event.task_id
  .check(taskId, nowMs)     // -> { stuck:boolean, signal, detail } | { stuck:false }
  .startTask(taskId, nowMs) // mark dispatch start (wall-clock baseline)
  .reset(taskId)
  .toJSON() / static fromJSON(obj)   // resume serialization
```
- **same-file:** reuse `FixChainDetector` (debug-discipline.js:28) per `taskId`; feed `input.file_path` on each `tool_use_summary` whose `tool ∈ {Edit, Write, MultiEdit}`; fire when a file's hit count ≥ `sameFileEdits`.
- **error-recurrence:** on `tool_result` with `ok:false`, normalize `output` (trim, collapse whitespace, strip volatile paths/line-numbers) → hash; per-task `Map<hash,count>`; fire at ≥ `errorRepeats`.
- **no-progress:** per-task counter of consecutive `tool_use_summary` with a non-file-changing tool; reset to 0 on a file-changing tool; fire at ≥ `noProgressCalls`.
- **wall-clock:** `nowMs - startedAt(taskId) ≥ wallClockMs` (coarse backstop; checked in the poll loop where `nowMs` is available).

## Wiring (`lib/build.js`)

`executeParallelDispatchServer(..., opts)` gains `opts.stuckDetector` (optional). In the `onEvent` handler (`:2986`), after the existing forward: `if (stuckDetector && (event.kind==='tool_use_summary'||event.kind==='tool_result')) { stuckDetector.record(event); }`. In the poll loop after `emitPerTaskProgress` (`:3009`): for each running task, `const v = stuckDetector?.check(taskId, Date.now()); if (v?.stuck) { /* cancel + break with stuck outcome */ }`. Cancel via the existing cascade path (`stratum.parallelAdvance(flowId, stepId, 'conflict')` reaches a terminal envelope — same primitive T2-F5 uses). Return `{ ...outcome, stuck: v }`. **All guarded by `stuckDetector` presence** so build mode is unchanged.

## Resume (`lib/gsd.js` + `bin/compose.js`) — blackboard-driven, no mid-task re-entry

- On stuck: `runGsd` writes `.compose/gsd/<feature>/stuck.{md,json}` and `pause.json = { flowId, stepId, stuckTaskId, signal, detail, decomposedTasks:[...], completedTaskIds:[...], pid, mode:"gsd", ts }`. `completedTaskIds` = blackboard entries that VALIDATED; `decomposedTasks` = the full task list (persisted so resume does NOT re-decompose → stable task IDs). Return `{ status:'stuck', ... }`.
- `compose gsd <feature> --resume`: read `pause.json`; guard (no live `pid` owns it; `mode==='gsd'`) — same shape as `compose fix --resume` (`bin/compose.js:1933`). Re-dispatch only `decomposedTasks` minus `completedTaskIds` into fresh worktrees (completed results already in the blackboard); on clean completion delete `pause.json`. **GSD-6 reuses this `pause.json` shape** for auto crash-recovery.

---

## Corrections Table

| Spec / design assumption | Reality (verified) | Resolution |
|----------------|---------|------------|
| Existing telemetry carries per-call file/error | It did NOT (claude `tool_use_summary` was call-only, `ok` hardcoded, no raw input) | Shipped STRAT-PAR-STREAM-TOOLDETAIL first; now live at 0.2.7 |
| `stratum.resume(flowId)` re-enters the cancelled task | Unsupported — lands in wrong step (T2-F5 design.md:27) | Resume = blackboard-driven re-dispatch of the non-completed subset; persist `decomposedTasks` to avoid re-decompose ID drift |
| Detector hooks `executeParallelDispatchServer` for gsd | That fn is **shared with build mode** (build.js:2943) | Detector is an **optional** param; only the gsd path passes it → build mode byte-identical |
| Signal "no progress across N turns" | No stable "turn" in the stream | `noProgressCalls` = consecutive non-file-changing `tool_use_summary` count |
| `tool_use_summary` is a closed metadata kind | It's an **open catch-all** in both schemas | Consuming `input`/`tool_result` needs no schema change beyond the 0.2.7 version gate (shipped) |

## Verification (Phase 5)

All file:line refs confirmed against current source 2026-06-02: `executeParallelDispatchServer` (build.js:2943), `onEvent` (build.js:2986), poll loop + `emitPerTaskProgress` (build.js:3003-3010), `FixChainDetector` (debug-discipline.js:28), gsd subcommand (bin/compose.js:1967), bug-mode `--resume` guard (bin/compose.js:1933). Telemetry contract live (stratum `aa19650`/compose `082c778`). No Boundary-Map symbols missing. Zero stale refs.

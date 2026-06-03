# COMP-GSD-7-EVENTLOG — Implementation Report

**Status:** COMPLETE · **Date:** 2026-06-03

## Summary

GSD runs now write an append-only **`.compose/gsd/<feature>/events.jsonl`** at their lifecycle
points, and the COMP-GSD-7 milestone report renders its timeline from that real event stream
(snapshot-derived timeline becomes the fallback). GSD previously persisted only snapshots, so the
report's timeline was reconstructed from whatever artifacts happened to be on disk — task
completions, phase transitions, and cross-session resumes were invisible.

## Delivered vs Planned

| Planned | Delivered | Notes |
|---|---|---|
| E1 `lib/gsd-events.js` | ✅ | append/read/clear, best-effort, object-only reader |
| E2 `clearGsdHaltArtifacts` | ✅ `lib/gsd-state.js` | fresh-start halt-artifact clear |
| E3 `lib/gsd.js` emission | ✅ | run_started / phase / task_completed / paused / completed / failed |
| E4 report timeline | ✅ `lib/gsd-milestone-report.js` | events-first, snapshot fallback on zero events |
| E5 review/docs/ship | ✅ | this report + below |

## Key Decisions

1. **One JSONL line per event, append-only, best-effort.** `{ts, kind, ...detail}`; an event-log
   failure never affects the run; the reader skips torn/corrupt lines **and parseable non-objects**.
2. **Truncate at the planning checkpoint, after preconditions.** A fresh run clears the log there
   (not at the early `state.json` clear), so a fresh invocation that fails a precondition never
   destroys a prior run's history; a resume appends (cross-session history).
3. **Completion deltas fire at execute-merge AND both halts.** The stuck/budget paths return before
   the normal merge checkpoint, so a single emit-point would miss pre-halt completions. A shared
   `emitCompletionDeltas` dedupes via `ctx.emittedCompletions`, seeded from the initial completed
   snapshot so a resume never re-fires prior-session completions.
4. **Phase emission via a dedupe set, not `runState.phase`.** `runState.phase` is set to `'execute'`
   *before* the merge checkpoint, so it can't gate the emission — `emitPhaseOnce` + `ctx.emittedPhases`
   fires each phase exactly once. (Codex impl finding.)
5. **`pauseKind`, not `kind`.** A `paused` event's stuck/budget discriminator must not use `kind` —
   the `{ts, kind, ...detail}` spread would clobber the event kind. (Caught at blueprint.)
6. **Fresh start clears stale halt artifacts** (`stuck`/`budget` `.json`/`.md`) so both the event log
   and the snapshot fallback reflect only the current run. (Codex design finding.)
7. **Fallback on ZERO usable events**, not just file-absent — a freshly-truncated / torn / corrupt /
   non-object-only file falls back to the snapshot timeline rather than rendering empty. (Codex.)

## Test Coverage

- `test/gsd-events.test.js` (10) — append/read/clear, `{ts,kind,...detail}`, `pauseKind` not clobbered,
  torn-line + non-object-line tolerance, best-effort append.
- `test/gsd-milestone-report.test.js` (+2) — timeline from events; fallback on empty/torn file.
- `test/gsd-budget-run.test.js` (+1 assertion) — real `runGsd` emits `run_started` + `phase` +
  `paused(budget)` with `pauseKind` intact.
- Full suite **3228/3228**.

## Files Changed

| File | Action |
|---|---|
| `lib/gsd-events.js` | new — append-only event log I/O |
| `lib/gsd-state.js` | `clearGsdHaltArtifacts` |
| `lib/gsd.js` | seed dedupe sets; emit at lifecycle points; `emitCompletionDeltas`/`emitPhaseOnce` |
| `lib/gsd-milestone-report.js` | timeline from events; snapshot fallback |
| 3 × `test/gsd-*.test.js` | 13 tests + 1 integration assertion |

## Known Issues & Tech Debt

- The event log is best-effort and not fsync'd — a hard crash can lose the last buffered append. The
  report tolerates this (snapshot fallback + torn-line skip). Acceptable for a timeline artifact.
- `phase: execute` is verified by inspection + the shared `emitPhaseOnce` (decompose path is
  integration-asserted); no test drives a clean complete through the execute-merge to assert the
  execute-phase event specifically (that path needs the real `ship_gsd` git commit).

## Lessons Learned

- The Codex design gate (5 findings) and impl gate (2 findings) again caught issues no test surfaced
  first: the early-truncate history-loss, the stuck-path completion miss, the resume re-emit, the
  zero-event fallback gap, stale halt markers — and at impl, the `runState.phase`-can't-gate bug and
  the non-object-line crash. The `{ts, kind, ...detail}` spread clobber was caught at blueprint by
  reading the helper's own write shape.

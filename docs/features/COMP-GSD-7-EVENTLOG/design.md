# COMP-GSD-7-EVENTLOG — Append-Only GSD Run-Event Log: Design

**Status:** DESIGN (Phase 1 — intent, not yet implemented)
**Date:** 2026-06-03
**Parent:** COMP-GSD · **Depends on:** COMP-GSD-7 (milestone report — the consumer)

## Problem

GSD persists only **snapshots** (`state.json`, `pause.json`, `stuck.json`, `budget.json`). So the
COMP-GSD-7 milestone report's "Timeline" is reconstructed from whatever snapshots happen to exist on
disk — start, completion, and any pause markers present — not a real record of *what happened in
order*. Task completions, phase transitions, and resumes across sessions are invisible. There is no
append-only event stream.

## Goal

A small append-only **`.compose/gsd/<feature>/events.jsonl`** written at the GSD run's lifecycle
points, and consumed by the milestone report to render a real ordered timeline. Captures the run's
story across resume sessions.

**Non-goals:** not a metrics/telemetry pipeline; not a build-stream (that's the deferred
OPSSTRIP-LIVE surface); no schema versioning ceremony — one flat `{ts, kind, ...}` line per event.

## Decision 1: One JSONL line per event, append-only

`events.jsonl`, one JSON object per line: `{ ts, kind, ... }`. Append-only — never rewritten — so it
costs an `appendFileSync` per event and is crash-safe (a torn final line is tolerated by the reader,
which skips unparseable lines). Event kinds (v1):

| kind | detail | emitted when |
|------|--------|--------------|
| `run_started` | `{ mode: 'fresh'\|'resume', attempt }` | planning checkpoint (after preconditions) |
| `phase` | `{ phase }` | decompose / execute transitions |
| `task_completed` | `{ taskId }` | each newly-completed task — at execute-merge **and stuck/budget halts** |
| `paused` | `{ kind: 'stuck'\|'budget', detail }` | stuck / budget halt |
| `completed` | `{ }` | clean terminal |
| `failed` | `{ reason }` | catch / non-complete terminal |

(`resumed` folds into `run_started` `{mode:'resume'}` — no separate kind.)

## Decision 2: Fresh truncates, resume appends — but AFTER preconditions (Codex gate)

Mirrors `state.json` semantics, with the Codex-flagged correction: `runGsd` clears `state.json`
**early** (`gsd.js:~54`, before blueprint validation / dirty-tree refusal / cumulative-budget
refusal). Truncating `events.jsonl` there would **erase the prior run's timeline on a fresh
invocation that fails a precondition** without starting a new run. So the truncate moves to the
**planning checkpoint** — after all preconditions pass, immediately before the first `run_started`
event. A **fresh** run truncates there; a **resume** appends (accumulating cross-session history).

## Decision 3: The report consumes events; snapshot timeline is the fallback on ZERO events (Codex gate)

`assembleReportModel` reads `events.jsonl` and maps it to the timeline (`{label, ts}` per event),
replacing the snapshot-derived timeline — **only when `readGsdEvents` returns ≥ 1 usable event**.
When the file is absent OR present-but-yields-zero-events (a freshly-truncated file, a single torn
line, a corrupt file), it falls back to today's snapshot-derived `buildTimeline` rather than
rendering an empty timeline. Unknown future `kind`s render their `kind` verbatim as the label. Zero
change to the report's output contract.

## Decision 4: Emission is best-effort; completion deltas fire on every terminal path (Codex gate)

A new `lib/gsd-events.js` exports `appendGsdEvent(cwd, feature, kind, detail?)` (append, swallow
errors — an event-log failure must never affect the run), `readGsdEvents(cwd, feature)` (parse, skip
bad lines), and `clearGsdEvents(cwd, feature)` (fresh truncate).

**Completion deltas (Codex gate).** The stuck-halt path returns early from `runOneStep`
(`gsd.js:~411`) *before* the normal post-dispatch completion checkpoint, and the stuck/budget
writers recompute `completedTaskIds` for `pause.json` separately. So a single emit-point at the
execute merge would miss tasks that finished before a halt. Factor the delta logic into a helper
`emitCompletionDeltas(ctx)` (compares the freshly-recomputed `completedTaskIds` against
`ctx.emittedCompletions`, fires `task_completed` for each new id, adds it to the set) and call it at
**all three** points: the normal execute-merge checkpoint, and immediately before the `paused` event
on the stuck and budget halts.

**Dedupe across resume (Codex gate).** A resume starts with prior completions already loaded into
`completedTaskIds` (`gsd.js:~203` / `loadResumeTaskGraph`). If `ctx.emittedCompletions` started
empty, the first delta would re-emit every already-done task into the appended log. So
`ctx.emittedCompletions` is **seeded from the initial `completedTaskIds` snapshot** at run start —
those are treated as already-emitted; only genuinely-new completions in this session fire.

## Decision 5: Fresh start clears stale halt artifacts so the timeline is current-run only (Codex gate)

`buildTimeline` (the snapshot fallback) blindly includes any `stuck.json`/`budget.json`/`pause.json`
present in the feature dir, and a clean completion clears only `pause.json` — so a fresh run after a
prior halt, falling through to the snapshot fallback (zero events), would render a **previous run's
stale halt markers**. Fix: at the **planning checkpoint** on a fresh run (co-located with the events
truncate, after preconditions — so a failed precondition doesn't wipe a prior halt the user might
still resume), clear the stale halt artifacts (`stuck.json`, `budget.json`). `state.json` is already
cleared early by GSD-6. This keeps both the event log and the snapshot fallback scoped to the
current run. A **resume** clears nothing (it legitimately continues from those artifacts). Safe vs
the cumulative-budget refusal: that refusal is a *precondition* (runs before the planning
checkpoint), so reaching the checkpoint means it didn't fire.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `lib/gsd-events.js` | new | `appendGsdEvent` / `readGsdEvents` / `clearGsdEvents` (fresh truncate) |
| `lib/gsd.js` | edit | seed `ctx.emittedCompletions`; at planning checkpoint (fresh): truncate events + clear stale halt artifacts; emit at lifecycle points; `emitCompletionDeltas` at execute-merge + stuck/budget halts |
| `lib/gsd-milestone-report.js` | edit | timeline from `readGsdEvents` when present, else snapshot fallback |
| `test/gsd-events.test.js` | new | append/read/clear; bad-line tolerance |
| `test/gsd-milestone-report.test.js` | edit | timeline-from-events; fallback when absent |

## Open Questions

1. **`ts` source.** `new Date().toISOString()` at emit time (wall-clock order). Fine — events are
   sequential within a process; cross-session ordering is by append order + ts.
2. **Should `task_completed` carry status (passed/failed)?** v1: just `taskId` (the blackboard
   already has per-task status). Keep events thin. (Resolve in blueprint.)
3. **Report timeline label mapping** — confirm the report renders unknown future kinds gracefully
   (render `kind` verbatim). Resolve in blueprint.

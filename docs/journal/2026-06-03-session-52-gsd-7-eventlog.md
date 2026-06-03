---
date: 2026-06-03
session_number: 52
slug: gsd-7-eventlog
summary: "COMP-GSD-7-EVENTLOG: append-only run-event log + real report timeline"
feature_code: COMP-GSD-7-EVENTLOG
closing_line: A timeline is just events in order — so we finally wrote the events down.
---

# Session 52 — COMP-GSD-7-EVENTLOG

**Date:** 2026-06-03
**Feature:** `COMP-GSD-7-EVENTLOG`

## What happened

Second of the two back-to-back follow-ups. COMP-GSD-7's milestone report had a 'Timeline' section, but GSD only ever persisted *snapshots* (state/pause/stuck/budget.json) — so the timeline was reconstructed from whatever halt artifacts happened to be on disk, never a real ordered record. This feature gives GSD an append-only `events.jsonl` and points the report at it.

The plumbing is simple; the subtlety was all in *where* and *how* to emit, and the Codex gates did the heavy lifting. The design gate found five issues in one pass: truncating the log where `state.json` clears (early, before preconditions) would destroy a prior run's history on a failed fresh start; `task_completed` tied only to the execute-merge would miss completions on the stuck path (which returns *before* that checkpoint); a `ctx`-local emitted-set would re-fire prior completions on resume (which preloads them); the report fallback was too narrow (a torn/empty file parses to zero events); and the snapshot fallback itself would render stale halt markers from an older run. All five folded in. The impl gate then caught two more: `phase: execute` never fired because `runState.phase` was *already* `'execute'` before the merge checkpoint (so the `wasExecute` gate was always true), and `readGsdEvents` accepted parseable non-objects — a `null` line would have thrown in the report's label mapping. And at blueprint time, reading the helper's own write shape (`{ts, kind, ...detail}`) surfaced that a `paused` event with a `kind` detail field would clobber the event kind — hence `pauseKind`.

## What we built

- `lib/gsd-events.js` (new) — `appendGsdEvent`/`readGsdEvents`/`clearGsdEvents`; JSONL, best-effort append, reader skips torn lines AND parseable non-objects.
- `lib/gsd.js` — emit `run_started` (planning checkpoint; fresh truncates + clears halt artifacts after preconditions, resume appends), `phase` (via `emitPhaseOnce` + `ctx.emittedPhases`), `task_completed` (`emitCompletionDeltas` at execute-merge + stuck + budget, deduped via a set seeded from the initial completed snapshot), `paused` (`pauseKind`), `completed`, `failed`.
- `lib/gsd-state.js` — `clearGsdHaltArtifacts` (fresh-start stale-halt clear).
- `lib/gsd-milestone-report.js` — `buildTimeline` prefers the event stream, falls back to the snapshot timeline on zero usable events; `eventLabel` renders unknown kinds verbatim.
- Tests: `test/gsd-events.test.js` (10), `test/gsd-milestone-report.test.js` (+2), `test/gsd-budget-run.test.js` (+1 real-runGsd assertion). Full suite 3228/3228.

## What we learned

1. **Emit where the path actually goes, not where it 'should'.** Two of the worst findings (stuck-path completion miss, phase:execute never firing) came from assuming a single happy-path emission point. The early-return halt paths and the pre-set `runState.phase` both broke that assumption — only tracing the real branches caught it.
2. **Dedupe state must be seeded, not assumed empty.** A resume starts mid-story with prior completions already loaded; an empty emitted-set would have replayed them into the appended log. Seeding from the initial snapshot is the whole trick.
3. **A serializer's own shape is a contract.** `{ts, kind, ...detail}` means `detail` may not contain `ts`/`kind` — reading that one line of the helper at blueprint time prevented a silent kind-clobber footgun (`pauseKind`).
4. **'Present' is not 'usable'.** The fallback had to trigger on *zero usable events*, not file-absence — and 'usable' had to exclude parseable-but-non-object lines, or a single `null` would crash the report.
5. **Truncation timing is history policy.** Clearing the log early (with state) vs late (at the planning checkpoint, after preconditions) is the difference between 'a failed fresh run erases your history' and 'history survives until a real new run starts.'

## Open threads

- [ ] The log is best-effort and not fsync'd — a hard crash can lose the last buffered append; the report tolerates it (snapshot fallback + torn-line skip).
- [ ] No test drives a clean complete through the execute-merge to assert the `phase: execute` event specifically (needs the real `ship_gsd` git commit); it's verified by inspection + the shared `emitPhaseOnce` whose decompose path is integration-asserted.
- [ ] COMP-GSD umbrella now fully wrapped: both requested follow-ups (WATCHDOG, EVENTLOG) shipped; remaining trackers are COMP-GSD-4-OPSSTRIP-LIVE and COMP-GSD-4-PERTASK-TOKENS.

---

*A timeline is just events in order — so we finally wrote the events down.*

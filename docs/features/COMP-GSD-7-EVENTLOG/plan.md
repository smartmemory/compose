# COMP-GSD-7-EVENTLOG — Plan

**Status:** PLAN (Phase 6) · **Blueprint:** [blueprint.md](blueprint.md)

TDD. E1 → E2 → E3 → E4.

- **E1** `lib/gsd-events.js` — `appendGsdEvent`/`readGsdEvents`/`clearGsdEvents`. Test (`test/gsd-events.test.js`): append+read round-trip, `{ts,kind,...detail}` shape, detail never clobbers `kind`/`ts`, skip torn/corrupt lines, clear truncates, absent→[].
- **E2** `lib/gsd-state.js` — `clearGsdHaltArtifacts` (rm stuck/budget .json+.md). Test in gsd-events or gsd-watchdog: clears present, no-throw absent.
- **E3** `lib/gsd.js` — seed `emittedCompletions` from initial snapshot; at planning checkpoint (fresh) truncate events + `clearGsdHaltArtifacts` then `run_started`; `phase` decompose/execute; `emitCompletionDeltas(ctx, ids?)` at execute-merge + stuck + budget; `completed`/`failed`. Verify via gsd integration suite (no regression) + a focused emittedCompletions/dedupe unit if extractable.
- **E4** `lib/gsd-milestone-report.js` — `buildTimeline` events-first (`eventLabel`), snapshot fallback on zero events. Test (`test/gsd-milestone-report.test.js`): timeline from seeded events.jsonl; fallback when absent/empty/corrupt.
- **E5** review loop → CLEAN; full suite; docs/ROADMAP/feature.json COMPLETE; report.md; journal; ship.

# COMP-GATE-REENTRY-RESUME: gate re-entry cap and same-failure kill switch reset on `--resume`, so a merge conflict that never converges can burn unbounded paid rounds across restarts

## Steps to reproduce

1. Start a `compose build` whose spec has a consumer-merge fan-out gate (`execute_merge`-style: N parallel lanes, each individually succeeding, merged by a single gate) where at least one file is edited by more than one lane in a way that never converges — e.g. two lanes both regenerate the same generated token file (`tokens.json` / `tokens.ts` / `tokens.css`) each round with content that differs from round to round.
2. Let the build run. Each round: lanes succeed individually, `applyMerge` throws `MERGE_APPLY_FAILED` on the conflicting file(s), `decideMergeRepairOutcome` (`lib/build.js:7782`) picks `revise` (the failure text is not byte-identical round to round — it embeds diffs/content — so the same-failure kill switch never trips), and the gate re-enters.
3. After 20 rounds, `assertGateReentryWithinCap` (`lib/build.js:7797`, `MAX_GATE_REENTRIES = 20` at `lib/build.js:7766`) throws and aborts the process. Its own error message reads: *"the Stratum flow state is preserved... resolve the gate... and re-run with `--resume` to continue."*
4. Re-run `compose build <code> --resume` **without actually resolving the underlying conflict** (this is the realistic failure mode: an unattended wrapper/agent loop that treats the cap-trip as a transient error and just retries, rather than a human reading the message and fixing the conflict first).
5. Observe: the new process gets a fresh 20-round budget on the exact same unresolved conflict, because `gateReentries` and `consumerMergeFailures` are declared as local `Map`s inside `runBuild()` (`lib/build.js:4885-4890`) and are never written to or read from any durable store. Repeat step 4 indefinitely.

## Expected behavior

The 20-round cap and the same-failure kill switch exist specifically to bound total paid spend on a gate that cannot converge (see `COMP-PLAN-GATE-LOOP`, 2026-06-24 CHANGELOG entry, added after an observed 52-round loop). That bound should hold for the life of the *build*, not the life of one OS process — a `--resume` after a cap trip on an unresolved conflict should not reset the counter to zero.

## Actual behavior

Confirmed in a live external report (not reproduced locally, but the counters and their scope are read directly off `main`): a build looped through **61 generations of an 18-lane fan-out over ~5h20m, spending $176.57 (2,786,776 output tokens, 282M cache-read tokens), and landed zero files** — the merge gate failed identically on `src/ds/tokens.json`, `tokens.ts`, `tokens.test.ts`, `src/styles/tokens.css` every round, and `src/ds/` never reached the working tree. 61 rounds is consistent with roughly three ~20-round batches, i.e. the 20-cap tripping and then being reset by resume two or three times, rather than one continuous ungoverned loop (which the 20-cap would have stopped at round 21).

Root cause, with citations:
- `const gateReentries = new Map()` — `lib/build.js:4885` (comment above it explicitly calls this "the backstop" for exactly this failure shape).
- `const consumerMergeFailures = new Map()` — `lib/build.js:4886` (same-failure kill switch state).
- Both are read/written only within the single `runBuild()` call: `gateReentries.get(stepId)` / `.set(...)` at `lib/build.js:6160-6161`; `consumerMergeFailures.get(stepId)` at `lib/build.js:6019` inside `repairFor()`.
- Neither Map is persisted anywhere durable. The merge journal (`ConsumerFanoutArtifacts`, `lib/consumer-fanout.js`) already persists `journal.mergeTransactions` to disk per run and is reloaded across process boundaries (`this.journal = this.#reload()`, used throughout `lib/consumer-fanout.js`), so a durable store already exists in the right place — this counter just isn't in it. The Stratum flow's own persisted state (`~/.stratum/flows/<flowId>.json`) is also already read across resumes elsewhere in this file via `readFlowRound()` (`lib/flow-state.js`), giving a second plausible anchor.

## Environment / Notes

- Not locally reproduced end-to-end (would require constructing a fan-out spec with a deliberately non-convergent merge conflict and driving it through 20+ real rounds, or a unit test against `runBuild`'s reentry-map lifecycle directly — the existing `test/gate-round-reentry.test.js` from `COMP-PLAN-GATE-LOOP` is the right place to extend, since it already exercises this exact counter's mechanics within one process).
- Suggested fix shape: key a durable counter (round count + last-failure fingerprint) per `gateStepId` in the merge journal or the Stratum flow state, read it back at the top of `runBuild()` instead of starting `gateReentries`/`consumerMergeFailures` from empty `Map`s, and increment/check against the persisted value. The within-process fast path can stay as-is; only the initial value needs to come from disk.
- This does not affect a single continuous run — the existing 20-cap and same-failure kill switch both work correctly within one process lifetime, per their existing test coverage. The gap is specifically resume-across-process-boundary.
- Related: `COMP-PLAN-GATE-LOOP` (CHANGELOG.md, 2026-06-24) — this bug is the resume gap left behind by that fix; the original 52-round incident and this one are the same failure shape (unbounded paid re-dispatch on a gate that can't converge), one process-restart away from recurring.
- Source of the reproduction numbers: an external build report (`WEB-DS`), not this repo — forwarded by the user, not independently reproduced here. Treat the 61-generations/$176.57/61≈3×20 figures as reported, not measured against this codebase's test suite.

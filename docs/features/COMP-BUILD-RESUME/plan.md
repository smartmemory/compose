# COMP-BUILD-RESUME — Implementation Plan

**Design:** `docs/features/COMP-BUILD-RESUME/design.md` (approved). Read it first.
**Implementer:** Codex. **Reviewer:** Claude (Opus). **Mode:** build (single-feature only).

Reuse existing machinery — do NOT build new resume/fresh mechanics. The `opts.resumeFlowId`
resume path (`lib/build.js:1042`), `startFresh` (`lib/build.js:4748`), `readActiveBuild`/
`writeActiveBuild`/`isProcessAlive`/`isTerminalFlow`, `restoreRolesFromActive`, and the
graceful terminal-write block already exist. This feature only adds a decision gate, two CLI
flags, and a crash `catch`.

## Task 1 — `decideBuildStart` pure helper + unit tests

- [ ] Add an exported pure function `decideBuildStart({ active, opts, pidAlive, flowTerminal, sameMode })` to `lib/build.js` (existing) returning `{ action: 'resume'|'fresh'|'refuse'|'error', flowId?, reason }`.
- [ ] No I/O, no side effects inside it — only branches on the passed-in data.
- [ ] Implement exactly the decision table in design.md §"Behavior spec" (4 active-states × {no-flag, `--resume`, `--fresh`}).
- [ ] `resume` verdict carries `flowId` (from `opts.resumeFlowId` when set, else `active.flowId`).
- [ ] `refuse`/`error` verdicts carry a `reason` string suitable for a thrown-error message.
- [ ] Add table-driven unit tests `test/build-decide-start.test.js` (new) covering every matrix cell; assert `action` and that `flowId` is present on every `resume`. Follow the existing `node --test` style in `test/`.

## Task 2 — CLI flags `--resume` / `--fresh`

- [ ] In `bin/compose.js` (existing) build branch (~2080-2131 parse, ~2225-2231 dispatch), parse `--resume` → `singleOpts.resume = true` and `--fresh` → `singleOpts.fresh = true`. Mirror the existing `compose fix` resume block at `bin/compose.js:2318-2344`.
- [ ] `--resume` + `--fresh` together → `console.error("--resume and --fresh are mutually exclusive")` + `process.exit(1)`.
- [ ] `--resume`: resolve `readActiveBuild(featureCode)`; if absent or its flow is terminal → `process.exit(1)` with `Nothing to resume for <code> (no in-progress or failed build found)`; else `singleOpts.resumeFlowId = active.flowId`.
- [ ] `--fresh` does NOT set `resumeFlowId`; it flows through as `singleOpts.fresh` for `runBuild` to honor.
- [ ] Update `compose build --help`/usage text (wherever build flags are documented in `bin/compose.js`) to list `--resume` and `--fresh`.

## Task 3 — Wire `runBuild` to the verdict

- [ ] In `runBuild` (`lib/build.js:683`), replace the inline fresh-vs-resume branching (`1042-1137`) with: gather `active`, compute `pidAlive` (`isProcessAlive`), `flowTerminal` (`isTerminalFlow` / server probe as today), `sameMode`; call `decideBuildStart`; dispatch on `verdict.action`:
  - [ ] `resume` → existing `opts.resumeFlowId` resume path using `verdict.flowId`; keep `restoreRolesFromActive` gated to this branch only.
  - [ ] `fresh` → `startFresh(...)`.
  - [ ] `refuse` / `error` → `throw new Error(verdict.reason)`.
- [ ] Set `isFreshStart` from `verdict.action === 'fresh'`; preserve the existing stream-truncate-vs-append + `clearPreCoverageTests` + `build_start`/`build_resume` event behavior (`1194-1201`).
- [ ] Behind no flag, behavior must match the table (auto-resume failed/crashed-dead-pid; fresh when nothing resumable; refuse on live foreign pid).

## Task 4 — Crash-gap catch

- [ ] Add a `catch` to the main `try` at `lib/build.js:1006` that terminalizes a thrown build into the SAME state as a graceful failure: `active-build.json.status='failed'` + `failureReason` (flowId preserved), `feature.json`→PLANNED, append one `build-history.jsonl` record; then **re-throw** (CLI still exits 1).
- [ ] Reuse the existing terminal-write helpers (the graceful-failure block ~`2262-2402`); do not duplicate their bodies.
- [ ] Idempotency: if the loop already wrote a terminal record before throwing, the catch must NOT double-write history or clobber a more-specific `failureReason`. Guard on whether a terminal record was already emitted.
- [ ] Leave the existing `finally` (stream close, `2473`) intact.

## Task 5 — Golden integration test

- [ ] Add `test/build-resume.test.js` (new) using the existing build test harness/fixtures:
  - [ ] mid-loop throw ⇒ `active-build.json.status==='failed'`, `flowId` preserved, exactly one new `build-history` record, process/exit signals failure.
  - [ ] subsequent `--resume` re-attaches the SAME `flowId`; `--fresh` produces a NEW `flowId`.
  - [ ] `--resume` + `--fresh` ⇒ error; `--resume` with nothing resumable ⇒ error.
  - [ ] live foreign pid ⇒ refuse, no clobber of the active build.

## Acceptance gates (Codex must self-verify before handoff)

- [ ] `node --test test/build-decide-start.test.js test/build-resume.test.js` green.
- [ ] No behavior change for the default no-flag path on a *gracefully*-failed build (still starts fresh) and on a healthy completed build.
- [ ] `decideBuildStart` is pure (grep: no `fs`/`writeActiveBuild`/`stratum.` inside it).
- [ ] Report exactly which files changed and a one-paragraph summary of the diff for review.

## Out of scope — do not touch

- `lib/gsd*.js`, `lib/checkpoint/**`, `server/compose_resume`/`write_checkpoint`, `lib/build-all.js`.

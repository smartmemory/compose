# Build brief: COMP-SETUP-PREFLIGHT-1 (cheap setup failures found before expensive verification and review)

hard: changes the build dispatch order and the pre-push gate of Compose, with two incident replays
Model: opus. Repo: `/Users/ruze/reg/my/forge/compose`. Tier: logic change, one per-unit post-land review.

## Owner words (verbatim, 2026-11-17, to s1-chat)
"agree all" (to the ranked list in `smart-memory-ops/units/OPS-VERIFY-CONFORM-1/report-significance.md`,
where C3 is BUILD NOW). Everything else in this brief is by the pass-3 author, not owner-set.

## Current state (written 2026-11-17; step 1 re-confirms each line)
- Feature filed PLANNED: `docs/features/COMP-SETUP-PREFLIGHT-1/feature.json`, ROADMAP section "COMP-VERIFY".
- Preflight precedent: `lib/codex-preflight.js` (cached per-repo probe, `COMPOSE_SKIP_CODEX_PROBE`),
  imported by `lib/build.js:30`.
- Engine resolution: `lib/stratum-engine.js` `probeStratumBin` :41, `resolveStratumBin` :213,
  `checkStratumWiring` :302. Nothing checks the engine before a gate or re-checks it after.
- Tiers: `lib/gate-tiers.js` `GATE_TIERS` :20, `classifyStepAsTier` :129, `evaluateTiers` :152;
  `lib/build.js` fills `tierResults` (:4112, :5905-5908) and calls `evaluateTiers` only at build end
  (:6917 region). Whether dispatch already skips T3/T4 after a T1/T2 failure is **unknown**: step 2 measures.
- Pre-push: `bin/git-hooks/pre-push.template` runs the full `npm test` (:160).
- Locks: `lib/dir-lock.js` `acquireDirLock` :84, `withDirLock` :163.
- The leak-gate repair from COMP-GOLDEN-LEAK-RACE-1 is in `test/suppress-expected-drift.js` and stays.

## Read first
1. `docs/features/COMP-SETUP-PREFLIGHT-1/real-use-notes.md`: the frozen cases and right answers. **This is
   the definition of done.** Do not edit a case to fit the code; if one is wrong, stop and report it.
2. `docs/features/COMP-SETUP-PREFLIGHT-1/plan.md`: decisions, files, acceptance criteria, what is out.
3. `lib/codex-preflight.js` (the pattern to follow).

## Do
1. Re-confirm "Current state" (paste the greps into `report.md`).
2. Measure plan Decision 6 first: build a throwaway feature whose lint step fails and read the dispatch
   log. Record DISPATCHED or SKIPPED for T3/T4 in `report.md` before changing dispatch code.
3. `lib/preflight.js` (new) and the `verify.preflight` part of `contracts/verify-config.schema.json`
   (create it, or extend it if COMP-VERIFY-FLOW-1 landed it first).
4. Wire `lib/build.js` (preflight before first dispatch, end-of-run engine re-check, `setup:<id>` failure
   class with no fix iteration, and cheap-first dispatch only if step 2 found it missing).
5. `bin/git-hooks/pre-push.template` and `compose preflight` in `bin/compose.js`.
6. Replays by hand on throwaway copies, never on main's working tree: Case 1a, Case 1b (I19: rebuild the
   engine mid-run), Case 2 (I13: two runs, `exclusive_runs: true`, then a killed holder).
7. `docs/configuration.md`, `docs/cli.md`, `CHANGELOG.md`.
8. Tests: one table-driven real-process file (under 30 rows). Run only it and the existing tests of the
   files you touched (`ls test | grep -i -E 'gate-tier|preflight|stratum-engine|pre-push'`), concurrency
   at most 4. Not the full suite.

## Reviewer checklist (given to the author up front)
- Is any setup failure reported with the same wording or exit path as a product test failure?
- Can a setup failure start a fix iteration or charge the iteration budget?
- Is "skipped T3/T4" proven from the dispatch log, not from `evaluateTiers` output?
- Does a project with no `verify.preflight` get only the engine check, and does the skip switch log a WARNING?
- Is a stale lock (dead pid) taken over, and can a live holder never be overridden?
- Was anything retried automatically? (It must not be.)
- Were real-use cases 1-7 run by hand and pasted with output, including both incident replays?

## Rules
No push, no merge to main: commit on a branch `comp-setup-preflight-1` in a `.worktrees/` checkout; the
coordinator lands. No `--no-verify`, no `git stash`, no `pkill`, no sudo. Never print an environment or a
token. Before any server or database a case starts: `~/.claude/scripts/port_check.py <port>` (test
containers use `--reserve-test`, range 19000-19999). Sealed list:
`smart-memory-ops/claude/rules/files-and-docs.md` ("Sealed list"), nothing more. Small tool output
(`> run.log 2>&1; tail -n 30 run.log`). Scratch under
`/Users/ruze/reg/my/SmartMemory/scratch/<date>-comp-setup-preflight/`, deleted at the end.

## Report
`docs/features/COMP-SETUP-PREFLIGHT-1/report.md`: plain-words TLDR, the step-2 measurement, each real-use
case with command and output, the two replays, files changed, tests run with counts. Last line, exactly:
`COMP-SETUP-PREFLIGHT-1 cases_right=<n>/7 replays=<n>/2 dispatch_before=<DISPATCHED|SKIPPED> tests=<pass>/<total> branch=<name> sha=<short> pushed=no`

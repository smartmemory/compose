# COMP-SETUP-PREFLIGHT-1: plan

**Ruling:** C3 in `smart-memory-ops/units/OPS-VERIFY-CONFORM-1/report-significance.md` (row 17, BUILD NOW),
owner "agree all" 2026-11-17. Everything below is by the pass-3 author, not owner-set.
**Real-use notes (frozen first):** [real-use-notes.md](real-use-notes.md). Done = every case gives its
right answer by hand.
**Value spike:** WAIVED (owner-ruled build on two own-use incidents, I13 and I19).
**Build brief:** [brief-build.md](brief-build.md).

## Goal

Before Compose spends on a full test gate or an LLM review, it checks the cheap things that run depends
on, and says so in seconds as a setup result, never as a product red. Expensive stages wait for cheaper
tiers to pass.

## Decisions (default by the pass-3 author, not owner-set)

1. **One preflight module, three callers:** `lib/preflight.js` (new) is called by `compose build` before
   the first dispatch (`lib/build.js`, next to the existing `preflightCodexWorktreeProbe` call imported at
   :30), by the pre-push hook template before `npm test` (`bin/git-hooks/pre-push.template`), and by
   `compose preflight` (new CLI).
2. **Built-in check, on by default:** the Stratum engine Compose will run is resolved
   (`lib/stratum-engine.js` `resolveStratumBin` :213, `probeStratumBin` :41) and its file hash recorded.
   It is on by default because it only moves an unavoidable failure earlier; `COMPOSE_SKIP_PREFLIGHT=1`
   turns it off with one WARNING.
3. **Project checks and the run lock are opt-in:** `.compose/compose.json` `verify.preflight`
   (`checks[]` with `id`, `command` argv, `expect` substring, `timeout_s`; `exclusive_runs` boolean;
   `busy_wait_s`, default 0). Shape in `contracts/verify-config.schema.json`, shared with
   COMP-VERIFY-FLOW-1 (whichever lands first creates it; the other extends it).
4. **The run lock** reuses `lib/dir-lock.js` `acquireDirLock` (already used by the completion gate) under
   `.compose/data/verify-run.lock`, holding pid, start time and command; a dead pid is a stale lock.
5. **End-of-run engine re-check:** the pre-push gate and `compose build` re-hash the engine at the end; a
   change marks failures whose output names the engine path as `SETUP-INVALID` and prints a rerun command
   for only those files. No automatic retry.
6. **Cheap-first dispatch:** first measure whether `lib/build.js` already skips T3/T4 dispatch after a T1/T2
   failure (`classifyStepAsTier` at :5905, `tierResults` at :4112). If it does, pin it with a test. If not,
   make the dispatch loop consult tier results before starting a T3/T4 step. `lib/gate-tiers.js`
   `evaluateTiers` stays a summary; it is never cited as proof that work was skipped.
7. **Setup results are their own class:** `failureReason: setup:<id>` in build history; no fix iteration and
   no iteration-budget charge for a setup failure.
8. **Leak gate:** the COMP-GOLDEN-LEAK-RACE-1 repair (`test/suppress-expected-drift.js`
   `withoutForeignProbeWorktrees`) stays unchanged; the opt-in run lock prevents the concurrent case
   rather than rewriting the gate.

## Files

- `lib/preflight.js` (new): built-in engine check, project checks with timeout, run lock, result lines.
- `lib/build.js` (existing): call preflight before the first dispatch; end-of-run engine re-check;
  setup failure class; cheap-first dispatch if Decision 6 finds it missing.
- `lib/gate-tiers.js` (existing): only if Decision 6 needs a "may this tier dispatch" helper.
- `lib/stratum-engine.js` (existing): reuse, export a hash helper only if needed.
- `bin/git-hooks/pre-push.template` (existing): `compose preflight` before `npm test`; engine re-check and
  setup-invalid summary after.
- `bin/compose.js` (existing): `compose preflight`.
- `contracts/verify-config.schema.json` (new or existing, see Decision 3).
- `docs/configuration.md`, `docs/cli.md`, `CHANGELOG.md` (existing).

## Acceptance criteria

- [ ] Case 1a by hand: engine path renamed away in a throwaway copy, `git push --dry-run` through the hook
  (or `compose preflight`) prints `SETUP-FAIL stratum-engine` in under 10 s and no test starts.
- [ ] Case 1b by hand (replays I19): during a gate run on a throwaway copy, rebuild the engine; the summary
  shows `SETUP-INVALID` with before/after hashes and a rerun command for only the affected files.
- [ ] Case 2 by hand (replays I13): with `exclusive_runs: true`, a second run while the first holds the lock
  prints `SETUP-BUSY` with the holder's pid; after the first ends, the second proceeds; a killed holder's
  stale lock is taken over.
- [ ] Case 3: a failing project check stops `compose build` before any agent dispatch, `failureReason:
  setup:<id>` in history, zero agent processes started (dispatch log shows none).
- [ ] Case 4: a T1 or T2 failure leaves no T3/T4 agent dispatched, proven from the dispatch log.
- [ ] Case 5: iteration budget unchanged after a setup failure.
- [ ] Case 6: a project without `verify.preflight` gets the built-in check only; `COMPOSE_SKIP_PREFLIGHT=1`
  logs one WARNING naming the skipped check.
- [ ] Case 7: `compose preflight` under 2 s on Compose's own repo.
- [ ] Real-backend tests (real child processes and a real lock dir; no mocked `spawn`): one table-driven
  file, under 30 rows.
- [ ] Docs and CHANGELOG in the same commit as the code.

## Explicitly out

- No new daemon, watcher or background qualifier. Preflight runs only when a run starts.
- No rewrite of the leak gate or its COMP-GOLDEN-LEAK-RACE-1 repair.
- Project checks and the run lock are opt-in per project; only the engine check is built in.
- No automatic retry of anything. Setup-invalid results print a rerun command; a person or agent runs it.
- No resource-fit qualification of remote runners (that is SmartMemory ops tooling, U4, not Compose).
- No `flake diagnosis` records (COMP-FLAKE-DISPOSITION-1, parked).

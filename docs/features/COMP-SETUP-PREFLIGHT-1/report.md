# COMP-SETUP-PREFLIGHT-1: build report

Branch `comp-setup-preflight-1`, worktree `.worktrees/comp-setup-preflight-1`, base `6815c7f7`. Code commit `a6ec333e`. This report and the case 4 dispatch row are in the follow-up commit. Not pushed, not merged.

## TLDR

**When the setup is broken, Compose now says "setup" before anything expensive starts, and never makes it look like the product failed.**

- A missing Stratum engine stops `git push` in 8.5 s, before any test starts.
- An engine that gets rebuilt in the middle of a run marks the reds it caused as setup reds and prints one command that reruns only those files.
- When two runs collide on the same repository, the second one is refused and told who holds the lock. A lock whose holder has died is taken over.
- A failing project check (for example "is the test database up") stops `compose build` before any agent is dispatched. It costs nothing and does not start a fix round.
- One thing needed no new code: once a cheap step fails, the expensive reviews are already never dispatched. The new part is the line that says so, plus a test that pins it.
- One finding was left alone because it is out of scope: the shipped build pipeline runs the cheap test tier after the expensive reviews.

## Step 2 measurement (does a T1 failure dispatch T3/T4 today?)

Run with the real `runBuild`, the real TS Stratum engine, and faked agent inference only. The dispatch log is every agent start.

| Variant | Command | dispatched |
|---|---|---|
| step reports `outcome: failed` | `node measure-d6.mjs <wt> report` | `["lint(claude)"]` |
| same, with `ensure: result.outcome == 'complete'` | `node measure-d6.mjs <wt> ensure` | `["lint(claude)"]` |

Why: `lib/build.js:5731` sends a step whose outcome is `failed` to the engine as `{failure}`, and that fails the flow. **dispatch_before = SKIPPED**: T3/T4 were already not dispatched, so no dispatch code was changed. Case 4's new part is the `skipped T3,T4: T1 failed` line, and the real-build row `test/setup-preflight.test.js` "case 4: a failed T1 step dispatches no T3/T4 agent" pins it. Negative control: with lint forced to `complete`, that row fails (0/1, "only the T1 step was dispatched").

**Finding (not changed, out of scope):** `pipelines/build.stratum.yaml` runs `review_merge` (T3) and then `codex_review` (T4), and only after them `coverage` and `run_tests` (T2). So the cheap T2 tier runs after the two expensive reviews, and no step maps to T1. Worth its own unit if the owner wants T2 before T3/T4.

## Real-use cases (run by hand)

The rig used for cases 1 and 2 was a scratch clone of this branch (origin removed, a local bare remote `rig`), a private copy of the Stratum TS engine pointed to by the env override, and the v2 pre-push hook installed. The rig ran a narrowed test slice: 71 tests, with one deliberate product red (baseline `# tests 71 / # pass 70 / # fail 1`). The scratch folder has been deleted. The paths below are as printed at the time.

### Case 1a: engine missing before the run. RIGHT

Command: move `stratum-ts/dist/cli/stratum.js` away, then `git push rig`.

```
pre-push: running full test suite (npm test)…
SETUP-FAIL stratum-engine: /Users/ruze/reg/my/SmartMemory/scratch/2026-11-17-comp-setup-preflight/stratum-ts/dist/cli/stratum.js not found (0.00s)
  fix: cd /Users/ruze/reg/my/SmartMemory/scratch/2026-11-17-comp-setup-preflight/stratum-ts && npm run build (wait for any build already running to finish)
SETUP-FAIL: a setup check failed; the run did not start (this is not a test failure).
pre-push: SETUP-FAIL — a setup check failed before any test ran (not a test failure). Fix it as shown above and push again.
```

The push was refused, `git push` exit 1, 8.5 s total, 0 tests started. `compose preflight` alone exits 78. (The first banner line is the pre-fix wording. The v2 banner reads "pre-push: setup checks, then the full test suite (npm test)…".)

Deviation in wording, recorded for the reviewer: the note's fix text says "or unset `COMPOSE_STRATUM_ENGINE`". The override the resolver actually reads is `COMPOSE_STRATUM_TS_CLI_BIN` / `COMPOSE_STRATUM_TS_MCP_BIN` (`lib/stratum-engine.js`). When an override points at a missing file, the fix line names that variable. This is pinned by the row "an env override pointing nowhere fails and names the variable".

### Case 1b replay (I19): engine rebuilt during the run. RIGHT (after a producer fix)

Command: `git push rig`, then `npm run build` in the rig's `stratum-ts` while the gate was running.

- **First run** (`case1b-push`): SETUP-INVALID was detected, but only 1 of the engine-caused reds was attributed (`# tests 51 / # pass 44 / # fail 7`). The cause: `resolveStratumBin` and the test helper `resolveTestBin` said "Cannot resolve…" without naming a path, so the output gave the classifier nothing to match. **Fixed at the producer:** both errors now name the paths they tried.
- **Run r2** (with the deliberate product red):

```
SETUP-OK   stratum-engine (1.62s): …/stratum-ts/dist/cli/stratum.js sha256 f6419a1efa18
SETUP-INVALID stratum-engine changed during the run (cli hash f6419a1efa18 -> f6419a1efa18, rewritten with the same content; mcp hash 77519f051568 -> 77519f051568, rewritten with the same content)
  setup-invalid (their output names the engine; not product reds): test/build-integration.test.js test/learn-summary-golden.test.js test/retry-cap-enforcement.test.js test/ts-cutover-build-golden.test.js test/ts-cutover-golden.test.js
  rerun only those: node --import ./test/suppress-expected-drift.js --test --test-concurrency=4 --test-timeout=900000 test/build-integration.test.js test/learn-summary-golden.test.js test/retry-cap-enforcement.test.js test/ts-cutover-build-golden.test.js test/ts-cutover-golden.test.js
not ok 36 - rig: a real product red unrelated to the engine
```

5 of 5 engine files were attributed. The deliberate red stayed a product red, so the gate kept `npm test`'s own exit code and the push failed through the normal "npm test failed" path. The printed rerun command, run by hand: `# tests 28 / # pass 28 / # fail 0`. Nothing was retried automatically.

- **Run r3** (deliberate red dropped, so every red names the engine): exit 79, and the hook printed `pre-push: SETUP-INVALID — the engine changed during the run; every red named it (not product failures). Run the rerun command above, then push again.`

Note: the build rewrote the engine with byte-identical content. It still counts as a change because the fingerprint is sha256 plus mtime plus inode. Hashing alone would have missed this rebuild.

### Case 2 replay (I13): two verification runs on one repository. RIGHT

The rig had `"verify": {"preflight": {"exclusive_runs": true}}`. Run 1 was a gate from the main rig checkout. Run 2 was `compose preflight --gate -- npm test` from a second worktree of the same repository.

```
SETUP-OK   run-lock: holding …/compose/.compose/data/verify-run.lock                    (run 1)
SETUP-BUSY: another verification run holds …/compose (pid 39807, started 2026-11-17T04:43:50.626Z, npm test)   (run 2)
```

- Run 2 exited 75 after 1.0 s, with 0 tests started.
- After run 1 ended, run 2 ran: `# tests 70 / # pass 70 / # fail 0`. The lock was released.
- Stale lock: the holder's process group was SIGKILLed, then the next run printed `SETUP-OK   run-lock: taking over a stale lock (pid 80157 is not running, started 2026-11-17T04:44:27.226Z)` and ran to `70/70`.
- `busy_wait_s: 60`: run 2 waited for the live holder, then ran (`70/70`).
- With no opt-in there is no lock. The lock code runs only under `pre.config.exclusive_runs` (`lib/preflight.js:565`).

### Case 3: a project check fails. RIGHT

Port deviation: the note's `19123` is registered to `land-vr-falkor` (`port_check.py`), so the case ran on the reserved test port 19146, with nothing listening on it. Command: `node cases-build.mjs <wt> <proj> case3 19146`, which calls the real `runBuild` (only agent inference is faked).

```
SETUP-OK   stratum-engine (0.00s): /Users/ruze/reg/my/forge/stratum/ts/dist/cli/stratum.js sha256 f6419a1efa18
SETUP-FAIL falkordb-up: expected "PONG", got "Could not connect to Redis at 127.0.0.1:19146: setsockopt(TCP_NODELAY): Invalid argument" (0.01s)
SETUP-FAIL: build stopped before any agent was dispatched (failureReason setup:falkordb-up); not a product failure.
"thrown": "setup:falkordb-up", "dispatched": [], history status "failed", failureReason "setup:falkordb-up", stepCount 0, cost_usd 0,
"featureStatusAfter": "PLANNED", "budgetLedgerUnchanged": true, "ms": 885
```

### Case 4: cheap tier fails, reviews not dispatched. RIGHT

Command: `node cases-build.mjs <wt> <proj> case4-lint-fails`.

```
  skipped T3,T4: T1 failed
"dispatched": ["lint(claude)"], tiersSkipped ["T2","T3","T4"], skippedLine "skipped T3,T4: T1 failed"
```

The proof comes from the dispatch log. `tiersSkipped` from `evaluateTiers` still includes T2, which this spec never declared. `skippedLine` lists only the tiers that were declared but never dispatched (`lib/gate-tiers.js` `declaredTiers`, `tierSkipLine`). Side note, existing behaviour and not changed: history `failureReason` reads `Step "lint" did not produce structured output` for a step that reported `outcome: failed`.

### Case 5: setup failures are not product failures. RIGHT

After case 3, the budget ledger was unchanged, no fix iteration had started, and the failure was labelled `setup:falkordb-up`. Then redis was started on 19146 and the case was rerun (`case5`):

```
SETUP-OK   falkordb-up (0.01s): got "PONG"
"dispatched": ["lint(claude)", "review(claude)", "codex_review(codex)"], status "complete", "budgetLedgerUnchanged": true
```

### Case 6: a project with no preflight config. RIGHT

- `compose preflight` on compose (no `verify` block) printed only the `stratum-engine` line, with no lock and no project checks.
- `compose build` with no `verify` block (`case6-build`) printed only `SETUP-OK   stratum-engine (0.00s): …`.
- `COMPOSE_SKIP_PREFLIGHT=1` (`case6-build-skip`) printed one line: `WARNING: COMPOSE_SKIP_PREFLIGHT is set: skipped setup checks stratum-engine; a broken setup will now surface as test or step failures, and the end-of-run engine re-check is off`.
- In a plain repository that depends on neither `@smartmemory/stratum` nor `@smartmemory/compose`, the gate prints `SETUP-OK   stratum-engine (0.00s): not checked: this repository does not depend on @smartmemory/stratum or @smartmemory/compose`. Its tests never load the engine, so a missing engine there would be a false refusal. Default by build agent, not owner-set.

### Case 7: preflight is cheap. RIGHT

`time compose preflight` on compose's own worktree, warm, across four runs: real 0.26 s, 0.29 s, 0.33 s and 0.49 s. Output: `SETUP-OK   stratum-engine (0.20s): /Users/ruze/reg/my/forge/stratum/ts/dist/cli/stratum.js sha256 f6419a1efa18`. The cold first probe measured 1.36 s.

## Decisions (default by build agent, not owner-set)

1. **The engine check targets the preferred path and never falls through.** `expectedStratumBin` picks the env override, then the installed package's `dist/`, then the sibling checkout. `resolveStratumBin` silently falls from a missing `dist/` to the sibling `src/`, while tests import `dist/` directly. That gap is the I19 blind spot.
2. **What the engine check does depends on the mode.** Build mode checks existence and fingerprint only, because the engine already answered the plan. Gate and CLI mode also run the identity probe (about 0.2 s warm). Gate mode checks the engine only in repositories that use it.
3. **The fingerprint is sha256 plus mtimeMs plus inode**, so a byte-identical rebuild counts as a change (the case 1b replay proves it).
4. **Exit codes:** SETUP-FAIL 78, SETUP-BUSY 75, SETUP-INVALID 79. The gate returns 79 only when every red is setup-invalid. When product reds are mixed in, it keeps the command's own code and lists both groups.
5. **There is one run lock per repository, in the main checkout** (`<git common dir parent>/.compose/data/verify-run.lock`), because I13 involved a second worktree. Plan Decision 4 ("reuse dir-lock as-is") could not hold: dir-lock judges staleness by an mtime older than 20 s, which a long suite with an in-process heartbeat would break. So `lib/dir-lock.js` gained the options `owner`, `isStale` and `heartbeat`, and its default behaviour is unchanged. Stale means the pid is dead on the same host. An unreadable token, or one from another host, is never judged stale. Residual: a recycled pid gives a false BUSY, which is the safe direction.
6. **`COMPOSE_SKIP_PREFLIGHT=1`** skips every check with one WARNING. The lock is not a check and is unaffected.
7. **The build preflight runs before the Codex worktree probe**, because that probe spends a Codex run. Its failure throws `SetupFailure("setup:<id>")` into the existing thrown-build path. That path writes the history `failureReason`, active-build `failed` and feature `PLANNED`. There is no stream event, because `streamWriter` is created later. The local triage (no agent) runs earlier and writes `triage-estimate` and `build-actuals` rows (usd 0) to the dispatch ledger. Neither row is an agent dispatch.
8. **End-of-run engine re-check in build:** a console line plus a `setup_invalid` stream event. `server/build-stream-bridge.js` renders it and passes `skippedLine` through.
9. **Pre-push hook v2** (`HOOK_VERSION` 2 in the template and in `lib/hooks-status.js`). Existing installs need `compose hooks install --pre-push`.

## Reviewer checklist

- **Does a setup failure share wording or an exit path with a product failure?** No. All setup output starts `SETUP-` and uses exit 78, 75 or 79. The hook has a separate `case` for each, with its own words. Mixed runs list setup-invalid files apart from product reds and keep the command's exit code (row "case 1b: a product red alongside keeps the command exit code").
- **Can a setup failure start a fix iteration or charge the budget?** No. It throws before the first dispatch. Case 3 shows `dispatched: []`, `stepCount 0`, the budget ledger unchanged, and the feature still `PLANNED`. The "cases 3+5" row pins this.
- **Is "skipped T3/T4" proven from the dispatch log?** Yes: the measurement table, case 4 `dispatched: ["lint(claude)"]`, and the new real-build row with a negative control.
- **Does a project with no config get only the engine check, and does the skip switch WARN?** Yes (case 6).
- **Is a stale lock taken over, and is a live holder never overridden?** Yes (case 2). Negative control: forcing `runLockIsStale` to return true made the live-holder row fail (0/1).
- **Was anything auto-retried?** No. SETUP-INVALID prints a rerun command and stops (row "…exit 79, rerun line, no retry").
- **Were cases 1-7 run by hand with output, both replays included?** Yes, above.

## Merge note (sibling COMP-VERIFY-FLOW-1)

`.worktrees/comp-verify-flow-1` has an uncommitted `contracts/verify-config.schema.json` with `required: ["flows"]` and `additionalProperties: false`. Whichever unit lands second must add `preflight` to its properties and drop `flows` from `required`. Its `lib/verify-flows.js` must also accept a verify block that holds only `preflight`.

## Files changed

New: `lib/preflight.js`, `contracts/verify-config.schema.json`, `test/setup-preflight.test.js` (23 rows).
Modified: `lib/build.js`, `lib/gate-tiers.js`, `lib/stratum-engine.js`, `lib/dir-lock.js`, `lib/hooks-status.js`, `lib/cli-commands.js`, `bin/compose.js`, `bin/git-hooks/pre-push.template`, `server/build-stream-bridge.js`, `test/helpers/stratum-test-bin.js`, `docs/cli.md`, `docs/configuration.md`, `CHANGELOG.md`.
`feature.json` was left at `PLANNED`, for the coordinator's land.

## Tests run

- `test/setup-preflight.test.js`: 23/23.
- The brief's grep set plus `cli-commands` (6 files: `cli-commands`, `gate-tiers`, `pre-push-guard-template`, `pre-push-hook`, `profile-preflight`, `setup-preflight`): `# tests 101 / # pass 101 / # fail 0`.
- Earlier, before the docs and banner fixes, a run of the touched files' tests (24 files) gave 455/460. All 5 failures were in `cli-commands` (the docs index was missing `compose preflight`) and `pre-push-hook` (the banner phrase). Both files are 100% in the 6-file run above.
- Not run: the full suite (by the brief).

COMP-SETUP-PREFLIGHT-1 cases_right=7/7 replays=2/2 dispatch_before=SKIPPED tests=101/101 branch=comp-setup-preflight-1 sha=a6ec333e pushed=no

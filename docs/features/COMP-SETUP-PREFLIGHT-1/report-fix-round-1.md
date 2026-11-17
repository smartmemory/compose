# COMP-SETUP-PREFLIGHT-1 + COMP-VERIFY-FLOW-1: fix round 1 report

Brief: `brief-fix-round-1.md`. Review fixed: `review-merged.md` (`VERDICT: FINDINGS HIGH=0 MEDIUM=4 LOW=4`).
Owner words (2026-11-17, to s1-chat): "agree all". Everything else is by s1-chat, not owner-set.
Branch `comp-verify-fix-1` (worktree `.worktrees/comp-verify-fix-1`), off local `main` `52b5f7fd`.

## TLDR

- **All four MEDIUMs were reproduced on main, then fixed at the code that made them.** Each has tests
  that fail on the old code and pass now.
- **Build order:** the shipped build now runs your tests before it pays for any Claude or Codex review.
  Before, it paid for all four reviews and only then ran the tests.
- **A broken `.compose/compose.json`** (bad JSON) now stops the gates loudly. Before, they all treated it as "no config" and carried on.
- **Flow file patterns** like `./src/**`, `src/` or a bare folder name now match. A pattern that can never match prints a warning.
- **A missing Playwright browser** now reads "could not start, install it". Before, it was reported as a failed product test.
- **Real use found one more gap, now fixed:** the git hook here runs Node 26, which writes test results in
  a different format ("spec"). The setup-invalid split only read the older format (TAP), so a real
  `git push` named no file and printed no rerun command. It now reads both formats, and warns when it can read neither.
- 16/16 real-use cases right; 859/859 tests over 51 related files (one test fixed in a single-file rerun, see Tests).
  Merged into local `main`, not pushed.

## Commits

| sha | what |
|---|---|
| `fe73e0a5` | P-1: tests before paid review in `build` and `build-quick`; tier pass means a real pass; a warning for project copies with the old order |
| `990e0254` | P-2: `lib/compose-json.js`; an unparseable compose.json refuses on preflight, verify and the completion gate |
| `553fc23d`, `408c550f` | F-1: `covers` cleaned up when loaded; never-matching forms refused; a warning for a flow that covers no tracked file |
| `cc683fb4` | F-2: `e2e/flow-setup.mjs` launches the browser first; failure is exit 3 = FLOW_SETUP_ERROR |
| `30341c87` | found by case 1b: the engine-changed split reads the spec reporter; an empty split warns |
| `81bffe3a` | the F-2 test row writes logs and receipts to scratch (the leak guard refused a write into the checkout) |

Each fix has its line under `## [Unreleased]` in `CHANGELOG.md`.

## P-1 (MEDIUM): the shipped build paid for reviews before running tests. Reproduced, fixed

**Before** (main, shipped `build.stratum.yaml`, a fake agent, tests failing; dispatch log in order):

```
execute/0(claude)
review_triage(claude)
review_lenses/0(claude)
review_merge(claude)
codex_review/review(codex)
coverage/run_tests(claude)   x3
```

**After:** `execute_merge` approves into `coverage`. `review_triage` runs `after: [coverage]`, and
`test_review` runs `after: [codex_review]`. A tier counts as passed only when the step's result is not
`failed` and does not ask for the step again (`lib/build.js`); before, a `{passing:false}` result counted
as a pass. Fallback by path segment in `lib/gate-tiers.js`, so `coverage/run_tests` is T2 and
`codex_review/review` is T4. build-quick with failing tests, after:

```
explore_design(claude)
decompose(claude)
execute/0(claude)
coverage/run_tests(claude)   x3
```

No review was dispatched, and the build printed `skipped T3,T4: T2 failed`. With the tests passing
(control), the order is tests < triage < codex < docs, and the build completes. Rows are in
`test/setup-preflight.test.js` (P-1 rows), `test/gate-tiers.test.js` 16/16 and `test/build-quick.test.js` 17/17.

**Who it reaches:** users of the bundled pipelines get the new order with no config change. This machine
has 26 project-local copies of `build.stratum.yaml` (lens, trustflow, SmartMemory, ScaleMate, discord-bot,
stratum, and others) that keep the old order. Those repos were not edited. At build start they now print
`WARNING: <spec> runs the paid review step "X" before the tests step "Y"…`. To fix, delete the copy or
reorder its steps. Compose's own `pipeline-roundtrip` flow still passes 5/5 after the reorder.

## P-2 (MEDIUM): an unparseable compose.json read as "no config". Reproduced, fixed

**Before** (main, rig with a trailing comma in `.compose/compose.json`, `compose preflight --gate`):

```
SETUP-OK   stratum-engine (0.00s): not checked: this repository does not depend on @smartmemory/stratum or @smartmemory/compose
tests ran
exit=0
```

All three readers (preflight, verify, completion guard) returned not-configured, null or false.

**After** (fix branch, same rig):

```
SETUP-FAIL config: <scratch>/rig-p2/.compose/compose.json is not valid JSON: Expected double-quoted property name in JSON at position 48 (line 1 column 49) (0.00s)
  fix: fix the JSON syntax in .compose/compose.json
SETUP-FAIL: a setup check failed; the run did not start (this is not a test failure).
exit=78
```

`readComposeJson` returns null only when the file is missing (ENOENT), and throws `COMPOSE_CONFIG_UNREADABLE` on any other error.
The verify loader raises `VERIFY_CONFIG_INVALID`. The completion and backfill gates refuse with
`refusedAt: 'config'`. Tests: completion-gate, build-completion-gate, verify-flows and setup-preflight, 102/102.

**Same class, not changed (not gates):** `lib/judgment-writer.js:175 guardEnabled` and
`server/vision-routes.js guardEnabled()` still read a broken file as "guard off". Both only change what
is displayed or written to the journal. Neither lets a completion through.

## F-1 (MEDIUM): ordinary `covers` spellings never matched. Reproduced, fixed

**Before** (main `matchGlob` against `src/a.js`):

```
"./src/**" false
"src/" false
"src" false
"/src/**" false
"src/**" true
```

and the real CLI on rig `rig-f1`: `verify: no declared flow covers the 1 changed file`, exit 0.

**After** (fix branch, same rig):

```
WARNING: flow "typo" covers no file in the repository (covers: "srcs/**"); it can never run on a changed-file list
verify: 2 of 3 declared flows cover the 1 changed file: dotslash, folder
PASS dotslash (1 of 1 expected lines)
PASS folder (1 of 1 expected lines)
exit=0
```

Loading drops a leading `./` or `/`. A trailing `/` becomes `/**`. A plain path covers itself and everything
under it. A `..` segment, a backslash or an empty pattern is refused, naming
`verify.flows[i].covers[j]`. The schema description is updated. verify-flows 30/30.

## F-2 (MEDIUM): a missing browser read as a product failure. Reproduced, fixed

**Before** (`PLAYWRIGHT_BROWSERS_PATH=<empty>`, `compose verify --flow builder-save-blur`):

```
FAIL builder-save-blur: FLOW_FAILED, missing expected line "RELOADED id=renamed-step", exit 1
```

**After:**

```
SETUP-ERROR builder-save-blur: FLOW_SETUP_ERROR, nothing was tested: the flow could not start (exit 3): SETUP: the Playwright browser (chromium-headless-shell) cannot start: browserType.launch: Executable doesn't exist at <scratch>/…
```

The message names `npx playwright install <channel>`. Control with the real browser: `PASS`, exit 0.

## Found by real use: case 1b named no file through a real `git push`. Fixed

The case 1b replay through the installed pre-push hook: the hook pins
`/opt/homebrew/Cellar/node/26.13.0_2/bin/node`, and Node 26's `node --test` writes the spec reporter even
into the log file (`ℹ tests 3`, `✖ failing tests:`, `test at test/eng.test.js:2:1`). The same suite under
Node 22 into a file writes TAP. **Before** (fix branch before `30341c87`):

```
SETUP-INVALID stratum-engine changed during the run (cli hash f6419a1efa18 -> f6419a1efa18, rewritten with the same content; …)
  nothing was retried automatically.
npm test failed — push aborted
```

**After** (r2b: engine rebuilt mid-run plus a product red; r3b: the same with no product red):

```
r2b:
  setup-invalid (their output names the engine; not product reds): test/eng.test.js
  rerun only those: node --test --test-concurrency=4 test/eng.test.js
  test failures (reported as usual): test/plain.test.js
  nothing was retried automatically.
npm test failed — push aborted
r3b:
  setup-invalid (their output names the engine; not product reds): test/eng.test.js
  rerun only those: node --test --test-concurrency=4 test/eng.test.js
  nothing was retried automatically.
pre-push: SETUP-INVALID — the engine changed during the run; every red named it (not product failures). Run the rerun command above, then push again.
```

The printed rerun command, run in the rig with the engine back: exit 0, `# pass 1`. Two new rows in
`test/setup-preflight.test.js`: spec attribution, and a WARNING when the log names no failing file.
Both fail on the old code (0/2) and pass now (2/2).

## Real-use cases: 16/16 right

| # | case | result |
|---|---|---|
| F1 | broken `adaba422` FAIL and refused (IN_PROGRESS); fixed `5f1e119d` PASS 5/5, COMPLETE | RIGHT |
| F2 | broken `b64d1d0d` FAIL (draft-step); fixed `b8b761d7` PASS | RIGHT |
| F3 | main vs fix twins: identical stdout (171 B), stderr (3129 B), feature.json, tree | RIGHT |
| F4–F9 | flow cases 4 to 9 (`cases-flow.sh`) | RIGHT 6/6 |
| P1a | engine missing: SETUP-FAIL, push blocked, `compose preflight` exit 78 | RIGHT |
| P1b | engine rebuilt mid-run (r2b, r3b above) | RIGHT (after `30341c87`) |
| P2 | run lock: second run exit 75 in 0 s; runs after the holder (exit 0); stale lock taken over (exit 0); `busy_wait_s` waited, then exit 0 after 6 s | RIGHT |
| P3 | `compose build` with `redis-cli -p 19149 ping` and nothing listening: `SETUP-FAIL falkordb-up`, thrown `setup:falkordb-up`, 0 dispatched, stepCount 0, no budget ledger, 1.0 s | RIGHT |
| P4 | tests and lint gate the paid tiers: P-1 rows (shipped pipeline, T2 failed, no T3/T4 dispatch) plus the T1 row | RIGHT |
| P5 | same build with a real `redis-server --port 19149`: `SETUP-OK falkordb-up (0.01s): got "PONG"`, 1 dispatched, status complete | RIGHT |
| P6 | no config: one engine line; SKIP prints its WARNING; Compose's own repo creates no lock (0 before, 0 after); plain repo "not checked" | RIGHT |

An earlier P2 stale-takeover run printed `exit 1`. That was the rig's own `PIPESTATUS` capture inside a piped
subshell, not the product. With the exit captured directly, it reads `exit 0` on two runs.
Port 19149 was reserved with `port_check.py --reserve-test` and released after. The redis-server was stopped by its pid.

## Tests

One run of 51 related files (the features' files plus the tests of every touched file), not the full suite:
`node --import ./test/suppress-expected-drift.js --test --test-concurrency=4 --test-reporter=tap <51 files>`,
134 s: `# tests 859 / # pass 858 / # fail 1`. The one red was the F-2 row: the golden-leak guard refused its
verify log under the checkout's `.compose/data`. Fixed in `81bffe3a` (logs and receipts go to scratch),
then only that file was rerun: verify-flows `# tests 30 / # pass 30`. Total 859/859.

## Side effects and notes

- **Four PASS receipts in the real evidence store** `~/.compose/evidence.jsonl`, from manual CLI runs
  made before `COMPOSE_EVIDENCE_STORE` was pointed at scratch: rig-f1 `dotslash` and `folder`, plus
  `pipeline-roundtrip` and `builder-save-blur` on the fix worktree. The store only appends, so they were left in place.
- **Worktree `node_modules`:** a real folder holding only symlinks to `.worktrees/comp-verify-flow-1/node_modules`
  `{@playwright,playwright,playwright-core}` and `.bin/playwright`. Everything else resolves up to main's.
  Main's `node_modules` was not touched (F-3 belongs to the coordinator).
- The worktree `.worktrees/comp-verify-fix-1` is kept for the post-land review.

## LOWs, deferred (not fixed, per the brief)

- P-3: a product red whose output happens to name the engine path can be labelled setup-invalid.
- P-4: lock takeover is judged on the wrapper's pid only, not its child process group.
- P-5: the hook treats a test command's own exit 75/78/79 as a setup result.
- F-3: main's checkout has no `@playwright/test` installed; the coordinator owns that install.

FIX-1 reproduced=4/4 fixed=4 redesign_needed=0 cases=16/16 tests=859/859 merged_to_main=<yes|no> main=<sha> pushed=no

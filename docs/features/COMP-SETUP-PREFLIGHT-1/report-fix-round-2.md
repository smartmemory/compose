# COMP-SETUP-PREFLIGHT-1: fix round 2 report

Brief: `brief-fix-round-2.md`. Review fixed: `review-fix-round-1.md` (`VERDICT: FINDINGS HIGH=0 MEDIUM=1 LOW=4`).
Owner words (2026-11-17, to s1-chat): "agree all". Everything else is by s1-chat or this session, not owner-set.
Branch `comp-verify-fix-2` (worktree `.worktrees/comp-verify-fix-2`), off local `main` `76e9235b`, merged `--no-ff` as `d07aed4f`. Not pushed.

## TLDR

- **The gap was real and reproduced.** With the old code, a review fixer could break a test after the
  tests had passed, and the build still finished, made its commit and marked the feature COMPLETE.
  No tests ran after the fix.
- **Now the tests run a second time, after the last review, and a red there stops the build** before
  docs and ship. Same step as the first test run, reused, not a new mechanism.
- **A clean review costs nothing extra:** if no code changed since the tests passed, the second run
  is skipped and the build log says why.
- **A build that had a review fix is held to a real pass at ship** in every project: if ship's own test
  run times out or prints something unreadable, the feature is not marked COMPLETE, and the message says
  which of the two happened.
- **Found on the way, not fixed:** a project's own pipeline copy in the old order dies with "no runnable
  steps remain" whenever a review comes back dirty. Same on the old code. It needs its own unit.
- 6/6 cases pass, 559/560 related tests (1 skip: no Playwright here). Merged into local `main`, not pushed.

## Commits

| sha | what |
|---|---|
| `89c6a000` | MEDIUM-1: `retest` step in both pipelines; Compose skips it on an unchanged tree; review-fixed builds need a real ship-time pass; pipeline comment corrected; CHANGELOG |
| `3a6e4013` | LOW-4: `covers: ["."]` refusal now ends `use "**" for every file` |
| `d07aed4f` | merge into local `main` |

## What changed (at the producer)

- `pipelines/build.stratum.yaml`, `pipelines/build-quick.stratum.yaml`: a second `run: coverage_check`
  step, `retest`, after `codex_review`; `test_review` now follows it. Its `ensure: result.passing == true`
  and Compose's fixer between attempts are the same as `coverage`'s. The comment that said ship re-tests
  review changes now says what does.
- `lib/review-retest.js` (new, 50 lines): `codeFingerprint` (git tree of tracked + untracked, non-ignored
  files in a temporary index, `.compose/` dropped), `isTestsStep`, `isReviewStep`.
- `lib/build.js`:
  - when a `*/run_tests` step passes, Compose records the tree it passed on;
  - a later `*/run_tests` first attempt on the same tree is answered with that pass, no agent dispatched,
    logged as `<step>: skipped, no code changed since the tests passed at coverage/run_tests (tree …)` and
    a `build_step_skipped` stream event. No tree (no git) means the tests run;
  - both review fixers (review_gate, and the scoped fixer when the step is a T3/T4 review) set `reviewFixed`;
  - ship records why a run gave no signal (`` `<cmd>` timed out after N s``, ``the output of `<cmd>` could not be read (…)``, `could not be run (…)`);
  - completion: a review-fixed build is held to `testsAttested === 'passed'` like a guarded one; `no-signal`
    and (unguarded) `failed` are refused with the cause named.
  - Test seam: `COMPOSE_SHIP_TEST_TIMEOUT_MS`, read only under `NODE_ENV=test`.

**Choice made here, by this session, not owner-set:** for case 5, "not complete" is read as the feature is
NOT marked COMPLETE, which is what a guarded project already did on `no-signal`. The build's own status
stays `complete` (exit 0) with the refusal message, as in guarded projects today. Failing the whole build
instead would be a one-line change in the completion block.

## Cases

Harness: `test/review-retest.test.js`. Throwaway git project, the bundled pipeline file copied verbatim,
live TS engine, real `runBuild`; only agent replies are faked. A fake fixer that "breaks a test" writes
`broken.flag`; every later tests step and the fake `pytest` that ship runs read it. Before = merge base
`76e9235b` (same harness, logs under scratch, since removed). Result on the old code: 3/13 rows passed
(case 6 row added after).

### Case 1: tests fail before any review, no paid review. Holds (round 1).

Before and after, both pipelines: `… execute/0(claude) coverage/run_tests(claude) x3`, then the build
fails. No `review_*`, no `codex_review`, no `test_review`. `ok:false`.

### Case 2: a review fixer breaks a test. Reproduced, fixed.

Before (build):
```
coverage/run_tests(claude)
review_triage … review_merge(claude)
review_fix(claude)
review_triage … review_merge(claude)
codex_review/review(codex)
test_review(codex)
docs(claude)
result: {"ok":true,"status":"complete",…}
feature status: COMPLETE
```
After (build; build-quick the same):
```
… review_fix(claude) … codex_review/review(codex)
retest/run_tests(claude)
retest/run_tests(claude)
retest/run_tests(claude)
result: {"ok":false,"status":"failed","failureReason":"ensure \"result.passing == true\" failed: predicate evaluated to false (no retry: identical evidence)"}
feature status: PLANNED
```
Ship is never started (no `build_step_start` for `ship` in the stream).

### Case 3: reviews change nothing, no second test run.

Before: one tests run (there was no second step at all). After: still one dispatched tests run, and the
`retest` step is answered from the first pass:
```
coverage/run_tests(claude)
review_triage … codex_review/review(codex)
test_review(codex)
docs(claude)
build_step_skipped retest/run_tests: no code changed since the tests passed at coverage/run_tests (tree <12 hex chars>)
result: {"ok":true,"status":"complete",…}
```

### Case 4: a harmless review fix, tests still pass, build completes.

Before: completes with no test run after the fix. After: `review_fix(claude) … codex_review/review(codex)
retest/run_tests(claude) test_review(codex) docs(claude)`, `ok:true`, feature `COMPLETE` (build). In this
bare fixture build-quick has no feature.json to mark, before and after (`completion refused at preflight —
feature "F2-C4-Q" not found`), so that row checks `ok:true` only.

### Case 5: review fix, then ship's test run times out or is unreadable. Reproduced (unreadable), fixed.

Before, unguarded, unreadable ship output: `ok:true`, feature status `COMPLETE`. (The timeout rows have no
true "before": the timeout seam is new, so the old code waited out the 5 s fake and read a pass.)
After, all four rows (unguarded and guarded, unreadable and timeout), feature not COMPLETE:
```
[completion-gate] F2-C5-HANG-U: tests could not be attested: `pytest` timed out after 1 s. A review fixer changed code in this build, so ship's test run must pass. … Build is complete; the feature is NOT marked COMPLETE.
[completion-gate] F2-C5-GARBAGE-U: tests could not be attested: the output of `pytest` could not be read (no pytest summary found). A review fixer changed code in this build, so ship's test run must pass. … the feature is NOT marked COMPLETE.
```
Control: unguarded, no review fix, unreadable ship output: still `COMPLETE` (the old degrade contract is
unchanged where no review fix happened).

### Case 6: both pipelines; project-local copies.

Cases 1-4 run on `build` and `build-quick`. A project-local copy in the old order (built from today's
bundled text: early `coverage` removed, `retest` renamed back to `coverage`; it differs from the
pre-round-1 file `52b5f7fd` in comments only): one tests run after `codex_review`, no skip event, the
build completes, and exactly one `WARNING: … runs the paid review step "review_triage" before the tests
step "coverage" …`.

## Found on the way (not fixed, needs its own unit)

**An old-order pipeline with a dirty review fails `no runnable steps remain`.** Same harness, old-order
copy, review dirty once then clean, run against a throwaway checkout of `76e9235b` (no change of mine):
```
review_triage(claude) review_lenses/0(claude) review_merge(claude) review_fix(claude)
result: {"ok":false,"status":"failed","failureReason":"no runnable steps remain"}
```
The new order does not hit it (cases 2, 4, 5 go round the revise loop). The visible difference is that
`review_triage` has no `after:` in the old order; the cause in the engine is unverified. This reaches every
project-local copy in the old order (26 on this machine per round 1) and, before round 1, the bundled
pipeline itself, whenever a review came back dirty. Case 6 is therefore pinned on a clean review.

## Residuals

- `reviewFixed` is process-local. A build resumed after a codex_review fix falls back to the persisted
  `review_iterations` (the review_gate fixer's counter), so a resumed build whose only fix was Codex's
  loses the stricter ship rule. The `retest` step still runs on resume (the recorded tree is process-local
  too, so it never skips on resume). The build accumulator's schema is closed, so persisting a new field
  needs a schema change; not done here.
- The skip compares trees, so anything a review step writes outside `.compose/` (a doc under
  `docs/features/`, say) makes `retest` run. That is a cost, never a missed run.

## Deferred (per the brief, not fixed)

- LOW-1: a `compose.json` that breaks mid-build ends the build as a thrown failure after the commit (`lib/build.js` `guardEnabled` outside a try).
- LOW-2: the WARNING's "delete the local copy" fix works from the CLI only; server/MCP builds then fail `Lifecycle spec not found`.
- LOW-3: a build started before round 1 and resumed after it keeps the old order; Compose labels one gate from the new file (cosmetic).

## Tests

Related files only, once, not the full suite: the feature's files plus the tests of every touched file and
every test file naming `review_gate`, `coverage/run_tests` or the pipelines (36 files).
`node --import ./test/suppress-expected-drift.js --test --test-concurrency=4 --test-reporter=tap <36 files>`,
88 s: `# tests 560 / # pass 558 / # fail 1 / # skipped 1`. The red was `test/build-quick.test.js`
"main build flow is the trimmed design → implement → ship sequence", whose exact step list now includes
`retest`; list updated, that file rerun alone: `# tests 17 / # pass 17`. Total 559/560, the 1 a skip
(`F-2 … # SKIP node_modules/.bin/playwright absent`). Case file alone after the last edit: `# tests 14 / # pass 14`.

## Side effects

- Scratch `scratch/2026-11-17-fix2/` (logs, fixtures) removed at the end.
- A throwaway worktree `.worktrees/fix2-baseline` (detached at `76e9235b`) was made for the baseline run
  above and removed. `.worktrees/comp-verify-fix-2` is kept for the post-land review.
- No push, no restart of any Compose process.

FIX-2 reproduced=yes cases=6/6 redesign_needed=no tests=559/560 merged_to_main=yes main=d07aed4f pushed=no

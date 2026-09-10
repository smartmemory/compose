# COMP-BUILD-CANCEL S04 report

Implemented S04 on the landed S01/S02/S03-1/S06/S03 code. No commit or staging was performed in this repository.

## Files changed

- `lib/build.js`: unique active-build temp names, optional pid stamping, exported writer for the real child-process race, structured abort results, cancellation outcome handling, retries/re-sweep, registry-first driver selection, foreign-driver signalling, bounded terminal-owner wait, identity-claimed cleanup, and return propagation through `runBuild`.
- `bin/compose.js`: build/fix/plan abort results select exit 0/1 while retaining all S06 teardown joins.
- `test/abort-build-cancel.test.js`: table-driven cancellation outcomes and persisted side effects; early refusals; transport/connect failures; identity changes; pid preservation; same-process and foreign drivers; wait completion/expiry; pre-plan abort; actual `runBuild` cancellation during the real Codex preflight with a never-settling fake agent; six child-CLI exit checks.
- `test/active-build-tmp-race.test.js`: default/disabled pid stamping and five synchronized child writers, each publishing 250 large records while the parent checks JSON and complete identities.
- `test/abort-build-engine.test.js`: only added a settled `flowCancel` to the existing fake.
- `CHANGELOG.md`: S04 entry under `Unreleased`.
- `docs/features/COMP-BUILD-CANCEL/s04-report.md`: this report.

Unrelated changes to `progress.md`, `impl-review1.md`, and `docs/features/COMP-GUARD-CLAIM-1/audit.json` were left untouched. `server/build-routes.js`, the S03 registry, and the S06 teardown implementation were not edited.

## Verification

Required final command:

```sh
node --test --test-timeout=90000 test/abort-build-cancel.test.js test/active-build-tmp-race.test.js test/abort-build-engine.test.js test/build-signal-teardown.test.js test/build-cancel-unit.test.js > /tmp/s04.log 2>&1; echo $?
```

Exact printed exit code: **0**. TAP counts: **85 tests, 85 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo; 8 suites**. Test processes and the real writer race could run in this sandbox.

TDD evidence:

- Both new test files were written before production edits. `node --test --test-timeout=90000 test/abort-build-cancel.test.js test/active-build-tmp-race.test.js > /tmp/s04-red.log 2>&1; echo $?` printed **1**, with **0 passed / 45 failed**. This initial run also exposed an incomplete accumulator fixture, subsequently corrected to include the existing required nullable fields.
- Before changing the writer, the actual old shared-temp implementation was exercised with the race test. A temporary, in-memory Node `registerHooks` preload appended only `export { writeActiveBuild }` to the old module, making its private function callable without changing its implementation or any repository file. `node --test --test-name-pattern='concurrent processes' test/active-build-tmp-race.test.js > /tmp/s04-race-red.log 2>&1; echo $?` (with that `NODE_OPTIONS` preload inherited by its children) printed **1**, **0 passed / 1 failed**. Multiple children failed with `ENOENT: no such file or directory, rename '.../active-build.json.tmp' -> '.../active-build.json'`. The final unmodified test imports the exported production writer and passes.
- After implementation and fixture correction, the focused three-file run printed **0**, **48 passed / 0 failed** (`/tmp/s04-green.log`). Further ownership and preflight cases are included in the final 85-test run above.
- `node --test --test-timeout=90000 --test-name-pattern='real Codex preflight' test/abort-build-cancel.test.js > /tmp/s04-preflight.log 2>&1; echo $?` printed **0**, **1 passed / 0 failed**. This uses a disposable temporary git repository for the real worktree probe, an injected fake Stratum client, and no model calls.

Additional boundary command:

```sh
node --test --test-timeout=90000 test/build-routes.test.js test/build-flow-tag.test.js > /tmp/s04-boundaries.log 2>&1; echo $?
```

Exact printed exit code: **1**. TAP counts: **23 tests, 11 passed, 12 failed, 0 cancelled, 0 skipped, 0 todo**. The 11 build-flow-tag checks passed. HTTP route verification **could not run: `listen EPERM: operation not permitted 0.0.0.0`**, raised at `test/build-routes.test.js:38` for all 12 route tests. These are sandbox listener failures; the HTTP assertions did not execute and are not claimed to pass.

`git diff --check` completed with exit code **0**.

## Deviations

- `lib/build.js:1499`: reused the strict `claimActiveBuild` already landed by S06, including C48 presence checks; no duplicate helper was introduced.
- `lib/build.js:1517`: exported `writeActiveBuild` so the required race calls the production function from real child processes; the sketch left it private despite requiring that receipt.
- `lib/build.js:5948`: validate numeric abort settings as finite, nonnegative integers and fall back to documented defaults on invalid input so an invalid driver-wait value cannot create an unbounded poll.
- `lib/build.js:5953`: the existing injected-client seam can throw raw errors, so S04 also classifies its unknown-flow/transport errors rather than assuming every fake has passed through S02's wrapper.
- `lib/build.js:5988`: preserve the prior settled status and counters if the one-shot re-sweep encounters a transport or other pre-settle failure; report the second failure separately rather than erase durable settlement evidence.
- `lib/build.js:5979`: `attempts` is the actual call count, including zero for pre-connect/early/no-flow paths and the additional re-sweep after lock retries; the §3.3 comment omits these combinations.
- `lib/build.js:6055`: engine resolution remains outside transport normalization so the existing retired-Python-pin rejection still throws before `connect`, as required by the unchanged engine test.
- `lib/build.js:6078`: claim before local handle cancellation/SIGTERM, re-claim during/after the driver wait, and re-claim after asynchronous vision discovery; a single claim only at step 6 would allow earlier driver mutation or an intervening ownership change.
- `lib/build.js:6095`: a driver that writes `complete` or `failed` is reported as `ok:false` with its `already_<status>` reason, without rewriting its terminal state; S05's conversion of ordinary cancellation failures to aborted remains outside S04.
- `lib/build.js:6106`: preserve a terminal record that appears during the bounded wait even if its in-process handle has not yet unregistered; expiry is not permission to overwrite a completed build.
- `lib/build.js:6036`: preserve factual `driverSignalled:true` if ownership is lost or a non-aborted driver terminal appears after SIGTERM was already delivered; §3.3's blanket `ok:false` implies `driverSignalled:false` is impossible for this post-signal race without falsifying the result. Pre-cancel refusals and ownership loss detected before signalling still report false and make no local mutations; the post-signal ownership race is pinned in `test/abort-build-cancel.test.js:320`.
- `bin/compose.js:2862`: kept S06's async `pendingTeardown()` joins in all three success callbacks while adding the S04 exit predicate; replacing them with the synchronous sketch would regress signal teardown.
- `lib/build.js:6122`: close the abort client in `finally` and report close errors without replacing an already established cancellation result with a cleanup exception.

## Remaining boundary

S04 does not implement S05's cancelled-agent classification or no-merge fence. The real preflight test proves handle registration, cancellation delivery, and probe interruption; it does not claim the pending S05 terminalizer already exists. HTTP route execution remains unverified under this sandbox because listening sockets are denied.

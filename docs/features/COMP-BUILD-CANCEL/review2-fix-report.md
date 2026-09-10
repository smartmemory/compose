# COMP-BUILD-CANCEL review-2 fix report

Implemented against HEAD `7014c13ef884bd3452406f73f05c3ed5653ba4ef`. No commit created. Read `impl-review2.md` first, then blueprint §3 Contracts (including teardown ownership, identity claims and the S05 merge fence) and `review1-fix-report.md`.

Production changes are confined to `lib/build.js` and `lib/build-cancel.js`. Added `test/build-cancel-review2.test.js` and the requested single CHANGELOG line under Unreleased. Preserved the pre-existing staged `impl-review2.md`, modified `progress.md`, and untracked `docs/features/COMP-GUARD-CLAIM-1/audit.json`.

## 1. Cancellation during the audit or first confirmed at gateResolve

- **Changed:** `lib/build.js:4392` shares the existing cancellation reversal, including its separate `rollback_failed` journal mutation, between both fences. `lib/build.js:4463` awaits the audit and then re-reads the local cancellation flag. `lib/build.js:4487` catches a gate-resolution cancellation and reverses the applied transaction before acceptance; `lib/build.js:4507` also rechecks after the post-resolution hook.
- **Tests:** `test/build-cancel-review2.test.js:37`, both `R2-1: cancellation at audit-await restores the applied merge before acceptance` and `R2-1: cancellation at gateResolve restores the applied merge before acceptance`.
- **Reproduction:** Use the existing real git merge fixture and fake client. The first case cancels during the audit await while returning its earlier `running` snapshot. The second first confirms cancellation after `gateResolve` throws. Both assert the captured file is absent, the tree equals the merge baseline, `rollbackReason` is `cancelled`, the transaction is `rolled_back`, issuances are accepted/superseded, and active state is aborted.
- **Observed red:** Both left the captured file in the tree. Both fail in `/tmp/r2-red-final.log`.
- **Observed green:** Command below exited **0**; exact TAP lines: `# tests 2`, `# pass 2`, `# fail 0`.

```sh
node --test --test-timeout=90000 --test-name-pattern='R2-1:' test/build-cancel-review2.test.js > /tmp/r2-green-1-final.log 2>&1
```

## 2. Ownership expires during vision cleanup

- **Changed:** `lib/build.js:2243` guards the actual direct/REST vision mutation after the writer's asynchronous probe, using a per-call receiver without changing `VisionWriter` or its shared instance. The guard is used by the cancelled driver at `lib/build.js:2264`, signal teardown at `lib/build.js:3070`, and abort fallback at `lib/build.js:6281`. `lib/build-cancel.js:198` re-claims after the bounded vision await before terminal writing. `lib/build.js:6287` re-claims after the aborter's update await; lost ownership returns the existing structured refusal with `reason: 'ownership_lost'` before state/actuals writes.
- **Tests:** Four cases at `test/build-cancel-review2.test.js:189`: CLI `signal-replacement` and `abort-replacement`, each during vision `probe` and `return` awaits.
- **Reproduction:** Actual child `bin/compose.js build` processes, using `makeFakeCodexProject` and prototype fake-client patterns from review 1. Signal cases receive SIGINT; abort cases execute `compose build --abort`. Probe cases install a replacement while the real writer's server check awaits, before its mutation. Return cases allow the old update to succeed, then install the replacement and its in-progress vision before the update promise returns. These independently protect both the vision boundary and the terminal re-claim. Assertions cover replacement flow, status, pid, vision, signal exit 130, abort exit 1, the `ownership_lost` refusal, and absence of aborter actuals.
- **Observed red:** Probe cases killed replacement vision; return cases overwrote replacement identity. All four fail in `/tmp/r2-red-final.log`.
- **Observed green:** Command below exited **0**; exact TAP lines: `# tests 4`, `# pass 4`, `# fail 0`.

```sh
node --test --test-timeout=90000 --test-name-pattern='R2-2:' test/build-cancel-review2.test.js > /tmp/r2-green-2-final.log 2>&1
```

## 3. Same-process abort leaves a web gate polling

- **Changed:** `lib/build.js:4729` passes the build signal to polling and routes rejection through `confirmCancellation`. `lib/build.js:5971` exports the existing poll seam, checks the signal before/after gate reads, and uses an abortable `node:timers/promises` sleep at `lib/build.js:5994`.
- **Tests:** `R2-3: abortBuild releases a pending web-gate driver and its registry handle promptly` at `test/build-cancel-review2.test.js:204`; `R2-3: pollGateResolution interrupts sleep and releases the signal listener` at `test/build-cancel-review2.test.js:240`.
- **Reproduction:** The first runs the real driver into the web-gate branch, with a fake successful server probe and pending gate response, then invokes real `abortBuild`. A 500ms driver wait must complete despite the normal 2000ms poll interval. It asserts driver-owned cleanup, registry removal, closed client, aborted/killed state, and no second poll or gate decision. The unit test aborts during a 1000ms sleep and requires rejection within 200ms with the abort listener released.
- **Observed red:** The aborter exhausted its driver wait, and the unit seam was still polling after abort. Both fail in `/tmp/r2-red-final.log`.
- **Observed green:** Command below exited **0**; exact TAP lines: `# tests 2`, `# pass 2`, `# fail 0`.

```sh
node --test --test-timeout=90000 --test-name-pattern='R2-3:' test/build-cancel-review2.test.js > /tmp/r2-green-3-final.log 2>&1
```

No route-level test or route change was necessary: the production driver/abort boundary and poll seam are both exercised without binding a port.

## 4. Health finalization downgrades the teardown owner's status

- **Changed:** `lib/build.js:4903` checks both teardown ownership and cancellation on entry, then rechecks before health mutations at `lib/build.js:4909`, `:4924`, `:4937`, `:4957`, `:4962`, `:4972`, `:4983`, and `:4990`. Completion is guarded at `lib/build.js:5015`. Final history restores aborted status at `lib/build.js:5103`; the common actuals finalizer rechecks at `lib/build.js:2414`.
- **Tests:** `test/build-cancel-review2.test.js:255`, both `R2-4: CLI SIGINT at health-await cannot downgrade aborted history or actuals` and the `health-emission` variant.
- **Reproduction:** Actual CLI child, rejecting health threshold 101. The first emits SIGINT in a microtask while finalization awaits its lineage import; the second emits it from the health-score emission seam, before persistence and downgrade. Both assert exit 130, aborted active/history/actuals, exactly one history and actuals row, no later persisted health score, and no failed-downgrade announcement.
- **Observed red:** Both history rows were `failed` despite aborted active state. Both fail in `/tmp/r2-red-final.log`.
- **Observed green:** Command below exited **0**; exact TAP lines: `# tests 2`, `# pass 2`, `# fail 0`.

```sh
node --test --test-timeout=90000 --test-name-pattern='R2-4:' test/build-cancel-review2.test.js > /tmp/r2-green-4-final.log 2>&1
```

## Red/green verification

The original eight cases were run before implementation: **0 passed / 8 failed**, `/tmp/r2-red.log`. After independent review identified missing coverage of the aborter's successful vision-return await, two CLI cases were added. The final ten-case file was rerun against HEAD's original production contents, with only the existing poll function exported to expose its unit seam. The fixed contents were restored in a `finally` block; no git index or HEAD mutation was used.

```sh
node --test --test-timeout=90000 test/build-cancel-review2.test.js > /tmp/r2-red-final.log 2>&1
```

Baseline exit **1**, exact TAP totals:

```text
# tests 10
# suites 0
# pass 0
# fail 10
# cancelled 0
# skipped 0
# todo 0
```

The four green commands above all exited **0**, totaling **10 passed / 0 failed**. Independent review confirmed the added return-timing variants close its coverage finding; no findings remained in the reviewed scope.

## Requested suites

```sh
node --test --test-timeout=90000 test/build-cancel-review2.test.js test/build-cancel-detect.test.js test/merge-cancel-fence.test.js test/build-cancel-review1.test.js test/abort-build-cancel.test.js test/build-signal-teardown.test.js test/build-flow-tag.test.js test/execution-runtime.test.js test/review-fixes-runtime.test.js > /tmp/r2-required-final.log 2>&1
```

Exit **1**, exact TAP totals:

```text
# tests 152
# suites 9
# pass 151
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

The sole failure is the unchanged `a refused group signal is stamped with who is actually in the group`, `test/review-fixes-runtime.test.js:213`. Its real `ps` invocation at line 222 fails before the production assertion:

```text
error: 'spawnSync ps EPERM'
code: 'EPERM'
```

```sh
node --test --test-timeout=180000 test/ts-cutover-consumer-fanout-golden.test.js > /tmp/r2-golden.log 2>&1
```

Exit **0**, exact TAP totals:

```text
# tests 43
# suites 3
# pass 43
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

`git diff --check` exited **0**. No GUI was launched.

## Deviations

- The requested all-pass result for the first combined command could not be achieved in this restricted sandbox: it denies the existing test's process-table query with `spawnSync ps EPERM`. No test was weakened, mocked, skipped, or changed to hide that failure. The exact command must be rerun locally with permission to launch `ps`; the current environment does not allow approval escalation. All 151 other tests in that command passed, including all ten new regressions, and the golden command passed all 43 tests.
- No other deviations from the requested implementation/file scope, regression requirements, changelog text, or no-commit restriction.

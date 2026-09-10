# COMP-BUILD-CANCEL S05 report

Implemented against HEAD `e2ac599a82a9aba43e9c9d565dce423b9acfe938`. No commit created. The finished slice is in the working tree.

Read blueprint §3, §8 (S05-1 through S05-4, acceptance criteria, tests and CHANGELOG), S05's §11/§12 rows, and corrections C2, C15, C24, C34, C35, C38, C39, C40, C42, C47 and C50. Checked `git log --oneline 052345a..HEAD`, the landed S01/S02/S03-1/S06/S03/S04/review-1 implementations, the progress ledger's Deviations, and `review1-fix-report.md`. Relocated the cited boundaries against current Compose and Stratum source.

Pre-existing changes to `docs/features/COMP-BUILD-CANCEL/progress.md` and the untracked `docs/features/COMP-GUARD-CLAIM-1/audit.json` were preserved.

## Files changed

| File | Change |
|---|---|
| `lib/build-cancel.js` | Adds `looksCancelled` and the shared `confirmCancellation` boundary; reuses the existing audit authority and cancel handle. |
| `lib/result-normalizer.js` | Confirms any failed flow-tagged agent call before error flattening, including the internal review-format repair dispatch; prevents the tolerant repair parser from swallowing confirmed cancellation. |
| `lib/build.js` | Threads the handle and flow id through dispatches and Q&A; detects engine-write cancellation; stops pending consumers/retries and receipt writes; adds both merge fences, cancelled terminalization and registry-first cancelled-resume refusal; treats `cancelled` as terminal while retaining teardown ownership. |
| `lib/consumer-fanout.js` | Exports `MergeAfterCancelError`, records optional rollback reason, and persists rollback failure through a separate guarded mutation. |
| `lib/gate-prompt.js` | Accepts the build signal, releases readline waits on cancellation, and propagates a cancelled Q&A error instead of asking for more input. |
| `test/build-cancel-detect.test.js` | Adds 41 detection, dispatch, terminal-state, receipt, resume, capture, queue, pre-apply, rollback-failure and interactive-gate tests. |
| `test/merge-cancel-fence.test.js` | Adds 2 post-apply race tests using real tree application, rollback and durable journals. |
| `test/helpers/build-cancel-s05.js` | Shared temporary Git fixtures and scripted injected client; merge fixture seeds accepted captured evidence using the existing golden's journal pattern. |
| `CHANGELOG.md` | Adds the blueprint's S05 entry under `Unreleased`. |
| `docs/features/COMP-BUILD-CANCEL/s05-report.md` | This report. |

## TDD evidence

Both requested test files were written and executed before production edits.

```sh
node --test --test-timeout=90000 test/build-cancel-detect.test.js test/merge-cancel-fence.test.js > /tmp/s05-red.log 2>&1; echo $?
```

Observed exit **1**: **35 tests, 1 passed, 34 failed**. The passing case preserved the running-flow consumer failure envelope. Failures included absent detection helpers, missed uncoded/code-143 cancellation, `failed` instead of `aborted`, `blocked` vision state, receipt continuation, unsafe resume, entry into `applyMerge` after cancellation, and missing post-apply rejection/rollback. An initial fixture revision-pin mismatch was corrected before this recorded baseline, so the merge tests reached the intended boundaries.

The first implementation run (`/tmp/s05-green-1.log`) had **34 passed, 1 failed**. The remaining whole-tree comparison included `.compose/build-stream.jsonl`, which shutdown legitimately updates; the fixture now ignores that runtime stream, while retaining the exact baseline-tree equality assertion.

The additional interactive Q&A reproduction failed before the prompt fix: `/tmp/s05-qa-red.log`, exit **1**, **0 passed, 1 failed**, `Q&A cancellation did not unwind`. The existing prompt caught the confirmed agent error and waited for another answer. The signal-aware prompt now unwinds and releases its listener.

The two-file green run (`/tmp/s05-green.log`) exited **0**, **39 passed, 0 failed**. Four subsequent resume/identity/explicit-fresh cases are included in the final regression below, bringing the new S05 tests to **43**.

### Fence mutation checks

Temporarily deleted each complete production fence block independently, ran its named test, and restored `lib/build.js` exactly in a `finally` block before regression testing.

```sh
node --test --test-timeout=90000 --test-name-pattern='pre-apply fence' test/build-cancel-detect.test.js > /tmp/s05-mutation-pre.log 2>&1
node --test --test-timeout=90000 --test-name-pattern='post-apply fence reverses a cancellation' test/merge-cancel-fence.test.js > /tmp/s05-mutation-post.log 2>&1
```

- Deleted pre-apply fence: exit **1**, **0 passed, 1 failed**; the `applyMerge` spy was entered after cancellation.
- Deleted post-apply fence: exit **1**, **0 passed, 1 failed**; `Missing expected rejection`.
- Restored both fences: final regression passes.

The named post-apply test is `post-apply fence reverses a cancellation between applyMerge return and isRunCancelled`. The `applyMerge` spy awaits the real apply and verifies that the file landed and its issuance is `merged`. Only then does the client's audit spy return `cancelled` to the real `isRunCancelled`. Assertions verify one confirmation, exact `snapshotWorkingTree(...) === tx.baselineTree`, `rollbackReason: 'cancelled'`, no issuance still `merged`, preserved captured diff, `MergeAfterCancelError` rather than `ConsumerMergeDecisionError`, and no gate resolve/revise.

The failed-restore test corrupts the durable transaction's baseline reference after a real apply, making the real restore callback throw. It then reloads the on-disk journal and verifies `state: 'rollback_failed'`, `failureCode: 'merge_revert_failed'`, and the failure text. This exercises C40's separate mutation rather than a fake successful journal write.

## Final verification

Exact requested command:

```sh
node --test --test-timeout=90000 test/build-cancel-detect.test.js test/merge-cancel-fence.test.js test/build-cancel-review1.test.js test/abort-build-cancel.test.js test/build-signal-teardown.test.js test/build-flow-tag.test.js test/execution-runtime.test.js > /tmp/s05.log 2>&1; echo $?
```

Exact echoed exit code: **0**.

```text
# tests 126
# suites 9
# pass 126
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

`rg -l 'applyMerge|restoreMergeBaseline|repairFor|consumer-fanout.js' test/` identified `test/ts-cutover-consumer-fanout-golden.test.js` as the existing direct importer/merge caller. Ran that complete file plus the existing build merge/gate/resume, receipt, readline, ship-gate and completion-gate tests:

```sh
node --test --test-timeout=600000 test/ts-cutover-consumer-fanout-golden.test.js test/ts-cutover-build-gate-golden.test.js test/ts-cutover-build-gate-human-golden.test.js test/ts-cutover-review-gate-golden.test.js test/ts-cutover-build-resume-golden.test.js test/usage-receipts.test.js test/gate-prompt.test.js test/gate-input-guard.test.js test/build-ship-gate.test.js test/build-completion-gate.test.js > /tmp/s05-extra-full.log 2>&1; echo $?
```

Exact echoed exit code: **0**.

```text
# tests 101
# suites 10
# pass 101
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

The first broader command used `--test-timeout=90000` and `/tmp/s05-extra.log`. It exited **1** with **79 tests, 78 passed, 0 failed, 1 cancelled** because the consumer golden file exceeded the file timeout while progressing. The complete rerun above finished in **96,786 ms**. All requested verification ran in the sandbox; no GUI launch was used. Across the two final commands: **227 passed, 0 failed, 0 cancelled, 0 skipped**. `git diff --check` exited **0**.

## Deviations

- `lib/build-cancel.js:102`: reused the landed `isRunCancelled(stratum, flowId)` rather than creating another audit authority; the registry, deadlines and teardown state remain the landed implementations.
- `lib/build.js:705`: ordinary/ship `stepDone` and `gateResolve` use one small invocation wrapper around the shared confirmation boundary, while consumer reporting retains its existing stale-report recovery catch.
- `lib/build.js:2241`: a dedicated claimed cancelled writer is shared by clean pump exit and the existing thrown-build history terminalizer, avoiding duplication of history accounting and preserving the pending teardown owner's priority.
- `lib/build.js:2873`: audit also covers bare `resumeFlowId`, automatic recovery and a live recorded pid; `--fresh` explicitly bypasses cancelled-resume refusal, and refusal carries code `FLOW_CANCELLED` plus reason `flow_cancelled`.
- `lib/result-normalizer.js:785`: the internal review-format repair has its own dispatch catch, so it calls the same confirmation function there and propagates cancellation past the tolerant parser.
- `lib/gate-prompt.js:142`: added this file beyond the S05 file-plan rows because its existing Q&A catch swallowed the confirmed error and hung the driver; signal-aware input and error propagation are required for S05's Q&A terminalization criterion.
- `test/helpers/build-cancel-s05.js:39`: added a shared fixture helper to keep the two requested test files on identical scripted-client, temporary-worktree and durable-journal seams.
- `test/merge-cancel-fence.test.js:24`: spies on the injected client's `audit` beneath the real `isRunCancelled`, since ESM namespace function exports cannot be replaced by `mock.method`; no production-only testing hook was added.
- `test/merge-cancel-fence.test.js:10`: seeds accepted captured issuances and starts the scripted client at its waiting merge gate, matching existing artifact unit-test patterns; separate consumer-pump cases exercise real capture and pending-item suppression.

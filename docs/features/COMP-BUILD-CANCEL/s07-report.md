# COMP-BUILD-CANCEL S07 report

Implemented both real-server goldens, extended the existing S06 fake-Codex helper, and added the exact §10 CHANGELOG entry under Unreleased. No production code, dependency files, or Stratum source changed. No install, staging, or repository commit was performed. The pre-existing `progress.md` modification and `COMP-GUARD-CLAIM-1/audit.json` were preserved.

Read §10 in full, §3 contracts, C50, progress Deviations, S04/S05 reports, the existing signal/review fixtures, and the TS-cutover build/consumer goldens. Verified `node_modules/@smartmemory/stratum` points to the sibling `stratum/ts`. Both tests explicitly use the source bin resolved by `test/helpers/stratum-test-bin.js`; the child CLI receives the same MCP/CLI bin overrides.

## Acceptance criteria

Test names used below:

- **Flow** — `S07-1: second real MCP client cancels a registered exec group and pins the wire contract`, in `test/integration/flow-cancel-golden.test.js`.
- **Build** — `S07-2: real build --abort preserves captured lane A evidence without merging (C50)`, in `test/integration/build-abort-golden.test.js`.

All 19 §10 checklist rows, in blueprint order:

| # | Acceptance criterion | Test and receipt |
|---|---|---|
| 1 | Real MCP server; two clients share isolated state and foreground roots | Flow: two independent `StratumMcpClient.connect` calls with the same fixture env and real source bin. No client/server mocks or agent harness. |
| 2 | Cancel resolves; pending agent rejects | Flow: await B's `flowCancel`, then `assert.rejects` on A's original pending promise. |
| 3 | Real build aborted by second child; cancelled audit | Build: two actual `node bin/compose.js build` children; abort exits 0; an independent real MCP audit reads `cancelled`. |
| 4 | Build agent group gone | Build: lane B's recorded real group is live before abort and gone afterward. |
| 5 | Aborted record preserves BUILD pid | Build: final status is `aborted`, pid equals build pid and differs from aborter pid. |
| 6 | Lane A captured diff retained | Build: waits for accepted item 0 issuance with marker diff before abort; afterward matches the same dispatch token and byte-identical diff. |
| 7 | Lane A marker absent from target | Build: marker path does not exist in the canonical target tree after abort. |
| 8 | No merge transaction | Build: journal `mergeTransactions` equals `[]`. |
| 9 | Build exits non-zero | Build: numeric code must be non-zero, or termination must be SIGTERM (shell exit 143); emits observed exit as TAP diagnostic. |
| 10 | Running foreground entry with group | Flow: polls for matching flow id, running state and non-empty groups; also asserts exact flow tag including step and item index. |
| 11 | SECOND client settles run | Flow: B's resolved ack has `flowSettled:true` and `acknowledged:true`. |
| 12 | Group gone when cancel returns | Flow: immediate post-ack group probe, with no cleanup signal until the after hook. |
| 13 | Audit cancelled | Flow: B's real audit status equals `cancelled`. |
| 14 | Further tagged dispatch refused | Flow: new cancellation id and same flow tag reject with `flow_not_running`; executable invocation count remains one. |
| 15 | Literal ack keys including status | Flow: sorted keys equal `['acknowledged','agents','flowSettled','ledger','runId','status']`; status equals `cancelled`. |
| 16 | Unknown-run C4 shape and classifier exclusions | Flow: real raw SDK call has absent data, numeric RPC code, ENOENT message and classifier true. Public wrapper separately pins `FLOW_NOT_FOUND`; resolved success and both synthetic cancellation envelopes classify false. See Deviations. |
| 17 | Exec transport observed | Flow: fake PATH executable's recorded pid equals the foreground registry's actual child group pid. No transport override forces exec. |
| 18 | No spawned process survives | Flow and Build: after hooks SIGKILL every tracked group, including groups recovered from registry and fake pid log; close real MCP clients; Build awaits child closure. Final group probes verify cleanup; fixture and external journal roots are removed. |
| 19 | Windows skip reason | Both: explicit `t.skip('win32 refuses cancellationId dispatch before spawn: CANCELLATION_UNSUPPORTED_PLATFORM')` before creating fixtures or children. Branch is present; this macOS run did not execute Windows. |

## Verification

Working directory for both requested commands: `/Users/ruze/reg/my/forge/compose`.

```sh
node --test --test-timeout=180000 test/integration/flow-cancel-golden.test.js test/integration/build-abort-golden.test.js > /tmp/s07.log 2>&1; echo $?
```

Printed exit: **0**. Final TAP totals:

```text
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Final passing run: 2756.552208 ms. Build diagnostic: `{"code":1,"signal":null}`. Both goldens executed in this sandbox over stdio. Neither needs a bound port or a local-only rerun. No model or GUI was launched.

```sh
node --test --test-timeout=90000 test/build-cancel-review2.test.js test/build-cancel-detect.test.js test/merge-cancel-fence.test.js test/build-cancel-review1.test.js test/abort-build-cancel.test.js test/build-signal-teardown.test.js test/build-flow-tag.test.js test/execution-runtime.test.js test/review-fixes-runtime.test.js > /tmp/s07-regression.log 2>&1; echo $?
```

Printed exit: **1**. TAP totals:

```text
# tests 152
# suites 9
# pass 151
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

The only failure is the user-identified sandbox restriction: `a refused group signal is stamped with who is actually in the group`, `test/review-fixes-runtime.test.js:213`, fails at line 222 with `spawnSync ps EPERM`. Its process-table assertion could not run; the test was not changed. Run this same regression command outside the sandbox to verify that remaining assertion.

`git diff --check` passes.

Development runs of the same golden command preceded the passing run: four runs each reported 2 tests / 0 pass / 2 fail / 0 cancelled / 0 skipped / 0 todo. They exposed fixture construction and overly narrow test assumptions: CLI prefix selection, `fanout.over` requiring a full reference rather than a literal array/expression, unsupported array literals in `set`, the required `max_rounds` for a revise gate, `stepDone` taking its token as a positional string, and Node's separate signal-exit representation. The fixture was corrected to the shipped dialect and methods; no production implementation was changed. Real `validate` calls were used while checking the fixture, ending with `status:valid`.

## Deviations

1. **Unknown-run wrapper versus wire shape.** §10's request that public `flowCancel(unknown)` itself yield the raw C4 error and classifier true is unreachable. Shipped `lib/stratum-mcp-client.js:941` replaces it with `FLOW_NOT_FOUND` and retains the ENOENT message, but not the original error object; `isUnknownFlowError` at line 976 rejects all string-coded errors. This agrees with §3.2. The test pins the public normalized shape and classifier false, then opens one additional real SDK stdio connection solely to pin the original wire error and classifier true. The cancellation scenario still uses the two required independent `StratumMcpClient` servers with shared roots. No interception or mocking is used.
2. **Contradictory cancellation-error checklist wording.** The checklist refers to a `CANCELLATION_*` error raised earlier, but flow step 4 must resolve. Followed §10 flow step 7 / C43: classifier false is asserted on the actual success and on synthetic envelopes for both cancellation codes. A failed cancel is not fabricated.
3. **Shared helper already exists.** Extended S06's existing `test/helpers/fake-codex-project.js` rather than creating another executable. Added optional disposable Git initialization, cwd in its pid receipt, registry reads, bounded receipt polling, and the purpose-written fanout spec. Its optional Git setup uses `write-tree` / `commit-tree` / `update-ref` only inside the disposable fixture to supply HEAD for real worktrees; it does not commit in Compose or Stratum.
4. **Executable and fixture details.** The existing fake is a Node executable speaking Codex JSONL, rather than the sketch's sleeping shell script. A preliminary Codex enumeration step emits a Batch used by `fanout.over`; the two work lanes remain A (marker plus normal exit) and B (sleeper). Flow reports enumeration through the real `stepDone` token contract; Build executes enumeration through the fake Codex as well. All agent-bearing steps explicitly select Codex. The build feature code ends in `-1` to select a single CLI build without a pre-existing `feature.json`.
5. **Journal location.** The CLI exposes no `consumerArtifactsRoot` option. The Build golden derives the existing default outside the canonical target (`lib/consumer-fanout.js:226`), polls and reads its actual journal without constructing a mutating artifact manager, and removes that unique fixture root afterward.
6. **Unsuccessful child exit has two Node shapes.** One development run terminated the build via SIGTERM (`code:null`), while the final passing run returned numeric code 1. Both are unsuccessful exits; the test admits numeric non-zero or specifically SIGTERM (shell status 143), and logs which occurred. It does not require the additional numeric-only restriction absent from C50.
7. **C50 boundary and CHANGELOG timing.** The captured marker is written before cancel, once lane A completes. The requested CHANGELOG text was copied verbatim, including its phrase “after the cancel”; that phrase is not the fixture timeline. No post-apply reversal or `rollbackReason` assertion is made: killing lane B leaves the fanout incomplete and the merge gate unreachable. `test/merge-cancel-fence.test.js` remains the direct race coverage and passes in the requested regression set.

## Defects found

No production defect was exposed by the completed goldens. The one regression failure is the sandbox's denied `ps` execution described above, not a changed-code failure. No production workaround was introduced.

## Local verification (Fable, after the sandbox run)

The sandbox run passed 2/2, but the build golden failed deterministically on the host (3/3 runs):
`Build failed: MCP error -32603: could not capture process start time; agent would be uncancellable`.
Root cause, confirmed with a direct probe of `stratum/ts/dist/connectors/proc_identity.js`: a
child that exits within ~40ms is gone before the darwin libproc probe returns (`startTime=undefined`
at 0ms lifetime; captured at 30ms+). Stratum 0.5.0 (`src/mcp/server.ts:340`) registers a tagged
agent in `onSpawn` and fails the whole run with `REGISTRY_WRITE_FAILED` when the probe comes back
empty — even though the agent already exited successfully. The fixture's enumerate lane exited the
instant stdin closed; the sandbox only passed because spawn is slower under seatbelt.

Ruling: fixture made realistic (`test/helpers/fake-codex-project.js`: non-sleeping lanes live
150ms before exit, comment cites the defect); the stratum defect is a follow-up
(STRAT: an agent that exited before registration is *finished*, not uncancellable — resolve the
spawn result before treating a missing start time as a registration failure). Not fixed here:
it is stratum-side, needs a 0.5.1, and no real agent exits inside 40ms.

Host run after the fixture change: both goldens 2/2 (`--test-timeout=180000`); no stray
`compose-fakecodex-*` process after the suite.

# COMP-BUILD-CANCEL review-1 fix report

Implemented on HEAD `d0a07c17a273a83ad3cf07354f1e53daa63dd378`, after S04. No commit created. Re-read `impl-review1.md` and blueprint §§3.6–3.7, inspected `git show d0a07c1 --stat`, and relocated the review sites against all six commits from `git log --oneline 052345a..HEAD`.

The pre-existing changes to `docs/features/COMP-BUILD-CANCEL/progress.md` and untracked `docs/features/COMP-GUARD-CLAIM-1/audit.json` were preserved.

## 1. SIGINT during Codex preflight

- **Test:** `R1-1: CLI SIGINT during a never-settling Codex preflight exits 130 and aborts the record` — `test/build-cancel-review1.test.js:123`.
- **Reproduction:** Spawn the actual `bin/compose.js build --codex` command with a fake client. Wait until the real worktree preflight enters a fake agent that never settles, even after abort; send the child SIGINT. Assert exit 130, active state `aborted`, probe signal aborted, and flow cancellation called.
- **Observed red:** Exit code was `null` instead of 130 (default OS signal termination). The original four-case run exited 1 with 0 passed / 4 failed; `/tmp/r1-red-1-4.log`.
- **Root cause:** At HEAD, registration happened at `lib/build.js:2972`, but the preflight await at `:2986` preceded signal listener installation at `:3086`.
- **Fix:** Install handlers immediately after registration, before preflight and vision awaits (`lib/build.js:2980`, `lib/build.js:3015`). A rejected preflight yields terminal ownership to a pending teardown instead of running its separate rollback (`lib/build.js:3042`).
- **Observed green:** Targeted `--test-name-pattern='R1-1:'` run exited 0, 1 passed / 0 failed; `/tmp/r1-green-1.log`.

## 2. CLI exits while vision teardown is pending

- **Test:** `R1-2: CLI with a 5s vision update and 50ms budgets terminalizes before exit` — `test/build-cancel-review1.test.js:131`.
- **Reproduction:** Actual CLI child; fake agent rejects when SIGINT aborts its signal, while the vision kill takes 5000ms. Both configured cancellation/drain budgets are 50ms. Assert exit 130, terminal `aborted` state, and signal-to-exit time below 2000ms.
- **Observed red:** CLI exited 1 with the active record still `running`; `/tmp/r1-red-1-4.log`.
- **Root cause:** `lib/build-cancel.js:177` awaited vision without a deadline. The outer join at HEAD `lib/build.js:5133` swallowed expiry and then unregistered at `:5137`, hiding the pending teardown from the CLI.
- **Fix:** Bound vision to `min(timeoutMs, 1000)` within the existing derived join allowance (`lib/build-cancel.js:183`). Unregister only after the teardown settles, even if the outer join expires (`lib/build.js:5145`). The join remains `cancelMs + drainMs + 1000`; terminal write, listener removal, and signal exit remain owned by teardown. Vision remains best-effort if its deadline expires.
- **Observed green:** Targeted `--test-name-pattern='R1-2:'` run exited 0, 1 passed / 0 failed; `/tmp/r1-green-2.log`. The final regression also passed the elapsed-time assertion.

## 3. Replacement build loses its vision item

- **Test:** `R1-3: SIGINT does not kill the replacement build vision item for the same feature` — `test/build-cancel-review1.test.js:139`.
- **Reproduction:** While the CLI agent is running, replace active-build.json with a different flow/pid/start identity for the same feature, then send SIGINT. Assert no vision-kill invocation, vision still `in_progress`, and replacement active record still `running` with its flow id.
- **Observed red:** Replacement vision status became `killed`; `/tmp/r1-red-1-4.log`.
- **Root cause:** At HEAD, the vision mutation at `lib/build.js:3065` preceded the claim inside the terminal writer at `:3069`.
- **Fix:** Capture this driver's identity at registration (`lib/build.js:2973`), reuse S04's `claimActiveBuild` through the teardown dependency (`lib/build.js:2995`), and claim once after cancellation/drain waits before either mutation (`lib/build-cancel.js:179`). Both mutations are skipped on a failed claim; the terminal writer uses the claimed record (`lib/build.js:2998`).
- **Observed green:** Targeted `--test-name-pattern='R1-3:'` run exited 0, 1 passed / 0 failed; `/tmp/r1-green-3.log`.

## 4. Final successful stepDone overrides cancellation

- **Test:** `R1-4: SIGINT just before final successful stepDone keeps history and active state aborted` — `test/build-cancel-review1.test.js:148`.
- **Reproduction:** The CLI fake client's final `stepDone` emits SIGINT through the installed production signal listener immediately before returning `completed`. Assert exit 130, active state `aborted`, and exactly one history row with the same status.
- **Observed red:** History was `complete`, while active state was `aborted`; `/tmp/r1-red-1-4.log`.
- **Root cause:** HEAD `lib/build.js:4692` assigned successful completion unconditionally; only the exception path respected pending teardown ownership.
- **Fix:** Guard post-pump terminal decisions and preserve `aborted` when teardown owns the build (`lib/build.js:4694`, `lib/build.js:4699`). Skip health finalization for this already-cancelled path so it cannot downgrade the cancellation status (`lib/build.js:4768`). History, stream closure, and actuals retain the aborted status; teardown remains the active-record writer.
- **Observed green:** Targeted `--test-name-pattern='R1-4:'` run exited 0, 1 passed / 0 failed; `/tmp/r1-green-4.log`.

## 5. Listener-leak test was vacuous

- **Test:** `the buildSignal listener is released when the run settles` — `test/build-cancel-signal-chain.test.js:107`.
- **Root cause:** Optional `AbortSignal.listenerCount` calls returned `undefined` on both sides, so the old assertion passed even with leaked listeners.
- **Fix:** Import `getEventListeners` from `node:events` and compare real abort-listener counts before/after five runs (`test/build-cancel-signal-chain.test.js:14`, `:113`, `:121`).
- **Observed red mutation check:** Temporarily removed the production `buildSignal?.removeEventListener('abort', stopRun)` at `lib/result-normalizer.js:873`. The corrected test exited 1 with 0 passed / 1 failed and `5 !== 0`; `/tmp/r1-red-5-mutation.log`.
- **Observed green:** Restored production cleanup exactly; no final change to `lib/result-normalizer.js`. The combined targeted listener/transport run exited 0 with 3 passed / 0 failed; `/tmp/r1-green-5-6.log`.

## 6. Untagged Codex transport falsely recorded as sdk

- **Tests:** `an untagged, signal-less codex dispatch derives unknown (env=undefined)` and `an untagged, signal-less codex dispatch derives unknown (env=exec)` — table at `test/dispatch-ledger-transport.test.js:67`.
- **Reproduction:** Make real client `runAgentText` calls through the fake MCP transport and read persisted dispatch-ledger rows. Verify no cancellation id was sent and transport is `unknown`, including with `STRATUM_CODEX_TRANSPORT=exec`. Restore the environment after each case.
- **Observed red:** Both persisted rows contained `sdk`; targeted run exited 1, 0 passed / 2 failed; `/tmp/r1-red-6.log`.
- **Root cause:** HEAD `lib/stratum-mcp-client.js:178` inferred SDK from the absence of a cancellation id, although the server's transport selection was unknown.
- **Fix:** Derive `exec` only when cancellation id guarantees it; derive `unknown` for other Codex dispatches and retain null for other providers (`lib/stratum-mcp-client.js:179`).
- **Observed green:** Combined targeted listener/transport run exited 0, 3 passed / 0 failed; `/tmp/r1-green-5-6.log`.

## Final verification

Exact requested command:

```sh
node --test --test-timeout=90000 test/build-cancel-review1.test.js test/build-signal-teardown.test.js test/build-cancel-signal-chain.test.js test/build-cancel-unit.test.js test/abort-build-cancel.test.js test/build-flow-tag.test.js test/dispatch-ledger-transport.test.js test/execution-runtime.test.js > /tmp/r1fix.log 2>&1; echo $?
```

Exact echoed exit code: **0**. TAP totals:

```text
# tests 109
# suites 15
# pass 109
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

The requested regression set ran successfully in the sandbox, including the existing real child/Stratum process-group cancellation test. No GUI launch was needed. `git diff --check` exited 0. Added the requested `COMP-BUILD-CANCEL review-1 fixes: ...` line under `CHANGELOG.md`'s current `Unreleased` heading.

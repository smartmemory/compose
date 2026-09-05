# Round-2 fix brief (after Codex's fix pass, 2026-09-05)

Context: `2026-09-05-wiring-repair-review.md` was the round-1 review. Codex fixed it, then ran out
of quota before writing its report. Two independent round-2 reviews audited the fixes. Verdict:
every directed fix landed and is real (tests spawn real processes / real Express routing, no
weakened assertions), EXCEPT the items below. Suite state after the fix pass:
stratum 1044 pass / 3 skipped, typecheck + build clean; compose backend 6069 pass / 4 FAIL
(all four are fix-pass regressions; Codex's own pre-fix run was 6063/0), UI 611 pass, tracker 100 pass.

Rules for this round: no commits, no publish, no npm install, never edit package-lock.json,
never touch `node_modules/@smartmemory/stratum` (symlink stays until the user decides),
always `CI=1`, never `STRATUM_LIVE_CODEX=1`, never weaken an assertion, add a test per fix.
Ignore `docs/features/**` and `docs/context/**` (pre-existing dirt).

## STRATUM (ts/) — owner: stratum fixer

| ID | Sev | Where | Defect | Required fix |
|---|---|---|---|---|
| S1 | HIGH | `src/connectors/claude.ts:46-47`, `src/mcp/server.ts:204` | Claude still gates process-group ownership on `signal` presence; MCP `extra.signal` is always present, so every MCP Claude run gets the custom spawn hook and `requireProcessGroups()` runs pre-try → on Windows EVERY MCP Claude dispatch throws `CANCELLATION_UNSUPPORTED_PLATFORM`. Codex got `ownProcessGroup`, Claude did not. | Add `ownProcessGroup` to `ClaudeConnectorOptions`/`AgentRunOptions`; server sets it ONLY when `cancellationId` was supplied (same as Codex); custom spawn hook and `requireProcessGroups()` only when `ownProcessGroup`. A non-cancellable Windows Claude run must launch. Test both. |
| S2 | MED | `src/mcp/server.ts:289-294`, `contracts/mcp-surface.json` | New `agent_run_failed` envelope undeclared; emits undeclared `usage`, `split`, `usdSource`, `stderr`, `telemetry` keys; skips the `errors[code]` registry check the SpecValidationError branch does. | Declare `agent_run_failed` and its optional keys in the contract; route through the registry check; extend contracts-grammar test. |
| S3 | MED | `src/mcp/server.ts:289` | Contract-validation `McpError`s on `stratum_agent_run` are rewrapped as `agent_run_failed`, losing the code. Own test asserts `cancellationId: 42` → `agent_run_failed`. | Let `McpError` propagate unchanged; fix that test to assert the contract error. |
| S4 | MED | `src/connectors/codex.ts:374` | Exec guard changed from `exitCode !== 0 && text.length === 0` to `exitCode !== 0`; a child that emits a complete agent_message then exits 3 now throws. Codex exits nonzero on some sandbox denials after usable output. | Restore the original guard; add a probe test (nonzero exit with text → success). |
| S5 | MED | `src/connectors/runner.ts:66,115-119` | `validateAgentSettings` runs before the background branch and hard-rejects Codex tool filters, making the deliberate forwarding at `runner.ts:80` (D5 / BG-WRITE-A) unreachable. | Only reject Claude-only options for FOREGROUND codex, or make the background forwarding honest (check what background codex actually does with allowedTools and pick the consistent one). Test. |
| S6 | LOW | `CHANGELOG.md` | No 0.4.0 entry for a breaking release. | Add: surface 17, strict entry-input validation, `input_validation_failed`, provider-settings rejection, cancellation contract, `agent_run_failed`. |
| S7 | LOW | `README.md:418-423` | Says cancellable Codex uses "the SDK's pinned CLI"; now PATH is preferred. Omits Windows limitation. | Fix prose. |
| S8 | LOW | `src/connectors/codex.ts:358-361` | Spawn `error` records `spawnError` instead of rejecting; any path emitting `error` without `close` hangs. | Reject on `error` if `close` has not fired within a short bound, or resolve the promise from either event. |
| S9 | LOW | `src/connectors/cancellation.ts:44-45` | After SIGKILL only the leader's `close` is awaited; group members not reaped before ack. | After SIGKILL, poll `process.kill(-pgid, 0)` until ESRCH with a bound; document the bound. |
| S10 | LOW | `src/connectors/claude.ts:70-79` | `SpawnedProcess` wrapper omits `stderr`; `kill()` ignores the requested signal. | Expose stderr if the SDK contract allows; pass the requested signal through (grace path owns escalation). |
| S12 | LOW | `src/connectors/codex.ts:332` | Stdout-overrun kill now takes the 5s graceful path. | Overrun should SIGKILL the group immediately. |
| S11 | note | `src/engine/engine.ts:404-420` | `revisionDigest` now digests the normalized spec; differs from 0.3.4 for the same spec. Persisted runs stay self-consistent. | Mention in CHANGELOG only. |

Verify: `npm run typecheck`, targeted vitest files, then `npm run build` at the very end.

## COMPOSE — owner: compose fixer

Fix-pass test regressions (all must go green):

| ID | Test | Defect |
|---|---|---|
| F1 | `test/stratum-softfail.test.js:64` "with stratum:false, _stratumSync is null" | suspend/resume rework now creates a Stratum sync service even when `stratum: false`. |
| F2 | `test/ts-cutover-e3-round5.test.js:195,214` "H2 late-resolving run bills usage on timeout" (2 tests) | Normalizer timeout branch rework dropped `lateUsage` from `AgentTimeoutError` and the consumer timeout envelope. Restore; keep the new interrupt-usage behaviour. |
| F3 | `test/workspace-switch-runtime.test.js:81` | Test expects raw tmp path; `createAgentApp` now realpaths (`/private/var` vs `/var`). Test-side: compare against `fs.realpathSync`. ALSO make `WorkspaceRuntime` key on realpath so its cap counts match the agent server's. |

Round-2 findings:

| ID | Sev | Where | Defect | Required fix |
|---|---|---|---|---|
| C2 | HIGH | `lib/local-claude-connector.js:130` | `runAndNormalize` always builds an AbortController, so `requireProcessGroups()` throws `CANCELLATION_UNSUPPORTED_PLATFORM` on every local run on Windows → total loss of review fanout there. | On win32 skip the spawn hook / process group and fall back to the SDK's own abort (document as weaker). Never throw pre-spawn for a non-cancel path. Test with a platform stub. |
| C3 | MED | `server/workspace-runtime.js:29`, `server/agent-workspace.js:243` | Retention is a hard cap of 8 with refusal ("restart"), not eviction. | LRU-evict SUSPENDED workspaces with no active work (no running sessions/builds/agents/streams) when the cap is hit; keep the cap as a backstop only when nothing is evictable. Test: 9th project evicts an idle one, refuses when all busy. |
| C4 | MED | `server/vision-server.js:485-491` | Config refresh works only because `VisionServer._config` aliases `binding.config`; `switch(root, cfg)` with an aliased cfg empties it. | Replace explicitly (assign a fresh object into both holders through one setter); guard the alias case; test reads through a different path than the writer. |
| C5 | MED | `server/cc-session-watcher.js:275,298` | fs.watch-throws fallback sets `_pollTimer` unconditionally → one interval leaked per resume. Same class as the WorktreeGC bug Codex fixed. | Guard on existing timer; test resume-twice leaves one timer. |
| C6 | MED | `server/workspace-runtime.js:135` | Router call wrapped in the workspace-preparation try → sync throws become `400 {error: internal text}`. | Only wrap preparation; hand router errors to `next(err)`. Test. |
| C7 | MED | `lib/process-termination.js` | Copied compiled TypeScript from stratum; 3 of 5 exports unused; reads `STRATUM_CANCEL_GRACE_MS`. | Rewrite as idiomatic compose JS with only the used exports; env `COMPOSE_CANCEL_GRACE_MS`. Same behaviour. |
| C8 | MED | `server/workspace-runtime.js:83` | Same-workspace switch does suspend()+resume(), dropping every vision WebSocket (code 1000). | Same-root switch = no-op (config refresh only). Test. |
| C9 | MED | `lib/build.js:3513` | `resolveStepProfile(...)` replaced by `fixAgent`, dropping the sidecar's tool restrictions and model tier; sibling site `:4368` still uses `resolveStepProfile`. | Keep the fix-agent identity but merge the sidecar profile, same as `:4368`. |
| C10 | LOW | `server/project-root.js:124-131` | Malformed `compose.json` now rethrows (bricks workspace), undeclared, untested. | Keep failing loudly but with an error naming the file and "fix or delete"; test it. |
| C11 | LOW | `lib/stratum-mcp-client.js:536-539` | `#callTool` overwrites the JSON-RPC numeric `code` with `error.data.code`. | Keep string `code` (callers depend on it) but preserve the numeric one as `error.rpcCode`. |
| C12 | nit | `server/agent-workspace.js:46,236`; `server/model-tiers.js:24` | `/api/health` registered twice; codex `fast` tier effort `low` vs `medium` convention. | Dedupe; set `medium`. |

Verify: targeted `CI=1 node --import ./test/suppress-expected-drift.js --test <files>` for every touched
suite plus the three regression suites. Do NOT rebuild stratum; the controller rebuilds and runs
both full suites once at the end.

Deliverable per fixer: append a "Round-2 fixes" section to this file (own repo only): one row per
ID → files → proving test → status.

## Round-2 fixes (stratum)

Verification: `cd ts && CI=1 npm run typecheck` clean; `CI=1 npx vitest run tests/connectors/ tests/mcp/`
= 195 passed / 1 skipped (the opt-in live-Codex test); `CI=1 npx vitest run tests/parity tests/engine`
= 206 passed. `npm run build` clean. No commits, no publish, no install.

| ID | Files | Proving test | Status |
|---|---|---|---|
| S1 | `ts/src/connectors/claude.ts`, `ts/src/connectors/runner.ts` | `tests/connectors/review-fixes.test.ts` — "Claude launches on Windows without ownership and refuses only the cancellable path" + "the MCP surface claims Claude process-group ownership only for cancellable runs" | fixed. `ClaudeConnectorOptions.ownProcessGroup` added and forwarded by `runAgent`; both the custom spawn hook and `requireProcessGroups()` now gate on it, not on `signal`. `server.ts` already set it only for a supplied `cancellationId`, and the second test pins that. Negative control confirmed: reverting the gate to `signal !== undefined` fails the test. |
| S2 | `ts/contracts/mcp-surface.json`, `ts/src/mcp/server.ts`, `ts/tests/mcp/contracts-grammar.test.ts` | "declares agent_run_failed and every optional key the server attaches" | fixed. `agent_run_failed` declared with `code` plus optional `usage`/`split`/`usdSource`/`stderr`/`telemetry`. A single `registryError()` helper now performs the registry lookup + `assertShape` for the SpecValidationError branch and the agent-run branch alike. The envelope name is always `agent_run_failed`; `data.code` carries the connector's own code (`CANCELLATION_TEARDOWN_TIMEOUT`) when it has one, which is why `code` is declared as `string`. |
| S3 | `ts/src/mcp/server.ts`, `ts/tests/mcp/agent-run.test.ts` | "invalid and duplicate cancellation IDs stay structured and leave prior completion intact" | fixed. `McpError` now propagates unchanged out of the agent-run catch. The three pre-contract `cancellationId` checks (they must run before any awaited contract I/O so a cancellation cannot overtake startup) now raise a declared `input_validation_failed` `McpError` instead of a bare `Error`. The test asserts `code: -32602` and the `input_validation_failed` payload rather than `agent_run_failed`. |
| S4 | `ts/src/connectors/codex.ts` | "keeps Codex output when the child emits a complete message and then exits nonzero" | fixed. Guard restored to `exitCode !== 0 && text.length === 0`, with a comment naming the sandbox-denial case. The test covers both directions: nonzero exit with text succeeds, nonzero exit without text still throws the stderr. Negative control confirmed. |
| S5 | `ts/src/connectors/runner.ts` | "rejects Claude tool filters for codex on both paths, and its argv carries none" | fixed differently, deliberately. The brief allowed either direction; I checked what background codex does with `allowedTools` and the answer is nothing — `startBackgroundRun`'s codex branch builds argv from `codexCommand(model, cwd, sandboxMode)` and records `CodexRunMeta`, neither of which has a tool-filter or thinking surface. So forwarding would have advertised a guarantee the durable wrapper cannot keep. Rejection is now the consistent behaviour on both paths and the background spread is `agent === "claude"`-gated, so the D5 / BG-WRITE-A forwarding is honest rather than unreachable. The test asserts the rejection on both paths and that the background codex argv carries no tool surface. |
| S6 | `CHANGELOG.md` | n/a (docs) | fixed. `[0.4.0]` section added above `[Unreleased]` covering surface 17, strict entry-input validation, `input_validation_failed`, provider-settings rejection, the cancellation contract, `agent_run_failed`, and (S11) the `revisionDigest` change. |
| S7 | `README.md` | n/a (docs) | fixed. The `stratum_agent_run` prose now says the PATH CLI is preferred with the SDK's bundled CLI as fallback, states that ownership is claimed only for a supplied `cancellationId`, and names the Windows limitation (`CANCELLATION_UNSUPPORTED_PLATFORM`) plus the fact that non-cancellable runs are unaffected there. |
| S8 | `ts/src/connectors/codex.ts` | "settles a Codex run whose child reports an error and never closes" | fixed. The exit promise settles from either event: a `close` resolves immediately, and an `error` starts a 250 ms bound (`SPAWN_ERROR_CLOSE_MS`) so a child that never started cannot hang the run, while a post-spawn `error` still gets its matching `close` and real exit code. Negative control confirmed (the test times out without the bound). |
| S9 | `ts/src/connectors/cancellation.ts` | "reaps the whole process group before a cancelled run settles" | fixed, with a caveat on the test. After the leader's `close`, `processTermination` now polls `process.kill(-pgid, 0)` every 10 ms until ESRCH, bounded by `REAP_TIMEOUT_MS` (2 s, exported and injectable) and documented at the constant. The test asserts the postcondition: at the moment the cancelled run settles, the group is gone. **It is not a discriminating control** — reverting the reap loop still passes, because SIGKILL delivery to the group is effectively synchronous on darwin, so the pre-fix code wins the race in practice. The fix converts that race into a guarantee; I could not build a portable test that loses the race on demand. Flagging rather than claiming a proof I do not have. |
| S10 | `ts/src/connectors/claude.ts`, `ts/src/connectors/cancellation.ts` | "passes the SDK-requested kill signal through and exposes child stderr" | fixed. `processTermination.terminate()` now takes the initial signal (default `SIGTERM`); a `SIGKILL` request skips the grace window while the escalation and group reaping still run, and teardown stays memoised. The wrapper forwards the SDK's requested signal and exposes `stderr` (the SDK's `SpawnedProcess` interface does not declare `stderr`, but the hook is not contextually typed by it and extra properties are ignored at runtime, so this is additive). The test uses a child that IGNORES SIGTERM with a 30 s grace window, so a downgraded signal leaves it alive; negative control confirmed. |
| S11 | `CHANGELOG.md` | n/a (note) | fixed as directed — mentioned in the 0.4.0 entry only, no code change. |
| S12 | `ts/src/connectors/codex.ts` | "SIGKILLs the Codex group immediately on a stdout overrun" | fixed. `declareOverrun` now calls `terminate("SIGKILL")` rather than the graceful path. The test uses a child that records SIGTERM to a file and asserts both that the file is absent and that the run settles well inside the 5 s grace window. Negative control confirmed. |

## Round-2 fixes (compose)

All fixes are in the working tree (no commits). Verification used
`CI=1 node --import ./test/suppress-expected-drift.js --test --test-timeout=300000 <files>`.

| ID | Files | Proving test | Status |
|---|---|---|---|
| F1 | `server/vision-server.js` (`_ensureStratumSync`, lazy `sync` getter, `resume`) | `test/stratum-softfail.test.js` "with stratum: false, _stratumSync is null" | fixed — the poller is now created on first use, never while `capabilities.stratum` is false |
| F2 | `lib/local-claude-connector.js` (removed the pre-result `throwIfAborted`) | `test/ts-cutover-e3-round5.test.js` H2 (both tests) | fixed — the abort throw was swallowing the late-resolved run's usage; the normalizer's late-resolve branch is again the single billing channel. Interrupt-usage behaviour (G3/UserInterruptError) untouched |
| F3 | `test/workspace-switch-runtime.test.js` (3 assertions), `server/workspace-runtime.js` (`key()`/`get()`), `server/index.js` (WS upgrade lookup) | `test/workspace-switch-runtime.test.js` | fixed — test compares against `fs.realpathSync`; `WorkspaceRuntime` keys its context map on the real path so its cap count matches the agent server's |
| C2 | `lib/local-claude-connector.js` (`ownProcessGroup`, `opts.platform`) | `test/review-fixes-runtime.test.js` "local Claude on win32/linux …" | fixed — win32 skips the spawn hook and falls back to the SDK abort (weaker, documented); no pre-spawn throw on a non-cancel path |
| C3 | `server/workspace-runtime.js` (`touch`/`busy`/`evictIdle`) | `test/workspace-review-fixes.test.js` "workspace retention evicts the least-recently-used idle workspace …" | fixed — LRU eviction of idle SUSPENDED workspaces; busy = active, live vision/file sockets, open session, `active-build.json`, a running agent in `agents.json`, or the optional `isBusy` hook. Cap still refuses when nothing is evictable. The pre-existing capacity assertion now pins its idle workspace busy first |
| C4 | `server/vision-server.js` (`refreshConfig` snapshot + `config` getter), `server/workspace-runtime.js` | `test/workspace-review-fixes.test.js` "switching with a workspace's own config object preserves it" | fixed — the incoming config is snapshotted before the holder is cleared, so an aliased config survives; both holders are re-pointed at the one live object |
| C5 | `server/cc-session-watcher.js` | `test/comp-obs-branch/cc-session-watcher.test.js` "a poll-fallback watcher started twice keeps exactly one interval" | fixed — `start()` guards on `_pollTimer` too, and `_startPolling` is idempotent |
| C6 | `server/workspace-runtime.js` (`handle`) | `test/workspace-review-fixes.test.js` "a throwing route reaches the error handler …" | fixed — only preparation is wrapped; router errors go to `next(err)` |
| C7 | `lib/process-termination.js` (rewritten) | `test/review-fixes-runtime.test.js` "process-termination exports only processTermination …" plus the two existing cancel tests | fixed — idiomatic compose JS, single export, `COMPOSE_CANCEL_GRACE_MS`, same TERM→grace→KILL behaviour |
| C8 | `server/workspace-runtime.js` (`switch`), `server/stratum-sync.js` (`start` idempotent) | `test/workspace-review-fixes.test.js` "re-switching to the active workspace keeps its vision sockets open" | fixed — same-root switch refreshes config and re-arms watchers/services without `suspend()`, so no socket is closed |
| C9 | `lib/build.js:~3513` | `test/usage-receipts.test.js` "the review-repair fixer runs under the sidecar fix profile" | fixed — profile resolves from the sidecar's `fix` key (falling back to the step id), identity still `agent: fixAgent`, mirroring the `review_merge` repair site |
| C10 | `server/project-root.js` (`readProjectConfig`) | `test/workspace-review-fixes.test.js` "a malformed compose.json fails with the file name and a remedy" | fixed — still fatal, now `InvalidProjectConfig` naming the file and the remedy; a MISSING config still falls back to defaults |
| C11 | `lib/stratum-mcp-client.js` (`#callTool`) | `test/review-fixes-runtime.test.js` "an engine error code does not destroy the JSON-RPC code" | fixed — string `code` preserved for callers, numeric one kept as `error.rpcCode` |
| C12 | `server/agent-workspace.js`, `server/model-tiers.js` | `test/model-tiers.test.js` "codex tiers run high effort, and fast runs medium — never low"; the duplicate `/api/health` has no bespoke test (the surviving app-level route is exercised by `test/workspace-switch-runtime.test.js`'s startup probe) | fixed — per-workspace `/api/health` removed (it was unreachable behind the app-level route); codex `fast` effort is now `medium` |

Not done: no CHANGELOG entry was added (the compose round-2 brief did not request one, and
the working tree is uncommitted). No `npm install`, no stratum rebuild, no commits.

Targeted verification (all green, no assertion weakened): 26 + 242 + 185 + 46 + 44 tests across
the three regression suites and every suite importing a touched module, including the consumer /
review-gate / build / pipeline-fanout golden suites.

## Round-2 outcome (controller, 2026-09-05)

Full suites after both fixers, run once each with `CI=1`:

| Suite | Result |
|---|---|
| stratum typecheck + build | clean |
| stratum full | 1052 pass, 3 skipped, 1 flake (`tests/mcp/agent-run.test.ts` ENOTEMPTY teardown race; 3/3 green in isolation; same flake in Aug 30 logs) |
| compose backend | 6084 pass, 1 flake (`test/build-stream-smoke.test.js` Bridge-to-SSE, 35s under contention; 3/3 green in isolation) |
| compose UI | 611 pass |
| compose tracker | 100 pass |

All round-1 and round-2 findings are closed except by design: workspace retention is LRU
eviction of idle workspaces with a busy-backstop cap; Windows falls back to the SDK's own abort
without process-group ownership (documented weaker); S9 reap loop has no discriminating test
(SIGKILL to a group is effectively synchronous on darwin).

Still the user's call, untouched by any pass: publish stratum 0.4.0 (surface 17), then bump
compose's dependency for real; restore or keep the `node_modules/@smartmemory/stratum` symlink.
Commit slicing per the round-1 review still applies (A: stratum hygiene, B: execution/cancellation,
C: compose workspace + test runners).

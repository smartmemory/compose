# Wiring repair — independent round-3 review

Reviewed the current dirty trees in `compose` and `stratum/ts`, including tracked diffs and untracked implementation/tests. Read the round-1 review and the entire round-2 brief, fixer tables, and outcome before examining implementation. Excluded `docs/features/**`, `docs/context/**`, `.codex-out/**`, and `node_modules` from review. Locations below refer to the current working trees; `stratum/ts/` paths are in the sibling repository. All findings below are behavioral defects, not style changes.

No commits, installs, publishing, version changes, lockfile edits, or changes to the installed Stratum symlink were made in this round. Existing version/dependency changes belong to earlier rounds. Every test command used `CI=1`; no live model was invoked and `STRATUM_LIVE_CODEX` was never set. Stratum was typechecked and rebuilt before subsequent Compose runtime probes.

## A. Directed review checklist

### Round-2 fixes (target 1)

| Item | Verdict | End-to-end check / evidence |
|---|---|---|
| S1: Claude ownership gating | holds | MCP sets `ownProcessGroup` only for a supplied foreground cancellation ID; runner forwards it; Claude gates both the custom spawn hook and POSIX requirement on ownership. An ordinary request signal alone does not trigger it. Existing Windows-stub and real-process tests pass. |
| S2: `agent_run_failed` contract | holds | Contract declares code, usage, split, USD provenance, stderr, and telemetry; `registryError` looks up and validates its declaration before creating `McpError`. Grammar and actual MCP error tests pass. |
| S3: `McpError` passthrough | holds | Agent/cancel catch preserves existing `McpError`; invalid/duplicate cancellation IDs remain declared `input_validation_failed` errors and do not erase prior completion. |
| S4: Codex nonzero exit with text | holds | `runExec` accepts a nonzero exit only if completed agent text exists and no explicit provider/event/spawn/overrun/abort error exists. Paired positive/negative exit-code tests pass. |
| S5: background tool filters | holds | Both foreground and background Codex reject Claude-only filters/thinking before dispatch. Background Codex has no filter-enforcement surface; only Claude receives these options. Reviewed runner and actual background argv construction. |
| S6 / S11: changelog and normalized revision digest | holds | Existing 0.4.0 notes describe surface 17, strict entry validation, both new error envelopes, settings rejection, cancellation, and normalized-spec digest compatibility. No publishing/version edits in this round. |
| S7: PATH preference / Windows docs | holds | Constructor does not resolve the CLI; execution prefers PATH and lazily falls back to bundled CLI. README documents ownership opt-in and POSIX limitation. |
| S8: spawn error without close | holds | Codex records the error and bounds the exit-event wait at 250 ms. Existing injected no-close test passes. |
| S9: reap loop | defect found → fixed | A deadline previously returned success while the group still existed; the MCP cancel handler separately converted teardown failures to successful cancellation. R3-1 fixes both and adds deterministic controls. |
| S10: SDK kill signal / stderr | holds | Claude wrapper exposes stderr and forwards requested signal; ownership still gates the wrapper. Signal test passes. Emergency escalation while another teardown is already pending is covered by R3-2. |
| S12: immediate overrun kill | defect found → fixed | The overrun call requested SIGKILL, but memoization ignored that request if graceful teardown had started first. R3-2. |
| F1: `stratum:false` | holds | Lazy sync creation and resume honor the capability. `stratum-softfail.test.js` passes; no poller is created for a disabled workspace. |
| F2: removed local post-result abort throw | defect found → fixed | Removing the throw correctly preserves late result usage. The remaining defect was downstream: timeout/interrupt receipts lost provenance/identity on raw late-success usage. R3-8. |
| F3: realpath capacity keys | holds | Runtime `key/get` canonicalize paths; WS lookup uses `get`; SDK app canonicalizes its target. Real HTTP/WS probe is sandbox-blocked, not claimed green. |
| C2: local Claude Windows fallback | holds | Windows skips the custom hook and uses SDK abort; POSIX controlled runs own their process group. Existing platform-stub and actual parent/child teardown tests pass. |
| C3: workspace LRU / complete busy signals | defect found → fixed | Agent server still had a hard wall. Vision busy checks missed active work and permanently pinned terminal build history; eviction also left design MCP connections cached. R3-3 through R3-7. |
| C4: config aliasing | holds | Snapshot precedes mutation; binding and server share the live object; captured capabilities update in place. Existing switch/write-through versus route/read-through test passes. Path consumers were separately checked; R3-9 fixes a stale artifact-path capture. |
| C5: CC watcher fallback interval | holds | `start` guards both watcher and polling timer; fallback start is idempotent. Poll-fallback regression test passes. |
| C6: route error handling | holds | Only preparation maps to workspace errors; synchronous router throws go to `next(error)`. Real Express route/error-handler test passes without requiring TCP. |
| C7: Compose termination rewrite | defect found → fixed | Single-export JS helper and `COMPOSE_CANCEL_GRACE_MS` are correct. It still acknowledged leader close without checking descendant disappearance. R3-1 adds bounded group reaping here too. |
| C8: same-root switch | holds | Existing context refreshes config and re-arms watchers/services without suspending/closing vision sockets. Actual socket-object assertion passes. |
| C9: repair sidecar profile | holds | Both repair sites resolve the `fix` sidecar profile while preserving the selected agent identity and explicit workspace-write intent. Usage/sidecar integration tests pass. |
| C10: malformed config diagnosis | holds | Strict preparation names the file and says to fix or delete it; missing config still receives defaults. Invalid-target eviction ordering was an additional defect, R3-7. |
| C11: numeric JSON-RPC code | holds | Client preserves numeric code in `rpcCode` before exposing the engine's string code. Actual stdio error test passes. |
| C12: health route / fast effort | holds | One app-level health route remains; Codex fast tier uses medium effort. No provider call needed to verify either. |

### Round-1 closure audit (target 2)

| Round-1 item | Verdict | End-to-end disposition |
|---|---|---|
| #1 unpublished surface / installed symlink | holds within authorized code scope | Client probes advertised fields and refuses unsupported execution controls before dispatch. Existing trees already declare Stratum/Compose dependency 0.4.0. Publication and installed-symlink decisions remain unresolved external work explicitly excluded by the user; this is not a clean-install release certification. |
| #2 transport failure relabeled cancellation | holds | Only explicit abort starts cancel; dead-pipe/provider RPC failure preserves its original error and remains a retryable item failure. Actual crashing stdio fixture passes. |
| #3 optional policy revision abort kills build | holds | `policyRevisionMustStop` recognizes user control and teardown uncertainty; ordinary stuck-detector abort retains the draft. Repair-control and build tests pass. |
| #4 signal silently changes Codex transport/binary | holds | Signal alone preserves SDK/exec selection; only ownership selects exec. Both paths prefer explicit PATH CLI; process-boundary tests pass. |
| #5 eager bundled CLI resolution | holds | CLI resolution is deferred to execution, with PATH preference/fallback; constructor no longer resolves an optional package. |
| #6 SIGKILL-only cancellation | holds | TERM/grace/KILL with configurable default five-second grace; real TERM-cleanup and escalation tests pass. R3-2 preserves immediate emergency escalation. |
| #7 unbounded acknowledged cancellation | defect found → fixed | Both MCP acknowledgement and original RPC waits have deadlines. The additional false-success case after teardown failure is R3-1. Existing ack-plus-hung-agent probe passes. |
| #8 suspended service leaks / unbounded retention | defect found → fixed | Health/coalescing/CC watcher/GC/sync suspension is real; remaining LRU and cached-client leaks are R3-3 through R3-6. |
| #9 config frozen forever | defect found → fixed | Switch reloads disk config and refreshes routes/services, but artifact routes retained their old feature root. R3-9. |
| #10 unvisited workspace / null active | holds | Header-resolved unvisited workspace is prepared suspended; unset workspace produces structured 409 instead of dereferencing null. Real Express tests pass. |
| #11 binding precedence documentation | holds | Session binding wins over boot `COMPOSE_TARGET`; resolver comment matches. Actual stdio rebind and interleaved-binding tests pass. |
| #12 arbitrary writable header roots / unbounded map | defect found → fixed | Token and existing config checks prevent an arbitrary header from creating a new writable workspace. SDK retention is now actual LRU with busy protection, R3-3. |
| #13 sandbox default / explicit override | holds | Codex defaults read-only; explicit caller sandbox wins. Implementation worktrees and both fix passes request workspace-write. Claude restrictions use SDK tools/denylist, not an unsupported sandbox promise. |
| #14 detached on all exec spawns | holds | Codex detaches only with ownership. Signal/transport-only runs preserve ordinary process grouping. |
| #15 Windows child-only kill falsely promises tree cancellation | holds | Strong MCP cancellation refuses Windows before spawn; local Compose fallback is explicitly weaker and tested by platform stub. No claim of native Windows validation. |
| #16 cancellation validation / late disconnect bookkeeping | holds | Declared validation errors and unregister-before-late-disconnect behavior remain covered. R3-1 additionally retains teardown failure in completion bookkeeping. |
| #17 caller input mislabeled broken spec | holds | `InputValidationError` is mapped separately; strict normalized input is validated before persistence or dispatch. |
| #18 stderr lost / SDK kill overwritten | holds | Bounded stderr is attached to provider errors; wrapper owns teardown without replacing the actual child object's kill method. |
| #19 mock-only contract test | holds | Small request-builder test is correctly limited; actual stdio/OS-boundary execution tests supply the stronger evidence. |
| #20 dead VITE agent-port config | holds | Interactive URLs use the workspace-aware API proxy in desktop and mobile paths; supervisor no longer exports VITE_AGENT_PORT. UI checks are reported below. |
| Self-review: local fanout cancellation gap | defect found → fixed | POSIX local connector owns the process group and waits for teardown. Descendant reaping still needed R3-1; Windows fallback is intentionally weaker. |
| Self-review: provider failure usage | defect found → fixed | Claude/Codex failure results carry usage/split/provenance through the declared MCP envelope, and the client normalizes ordinary failure usage. Raw late-success cancellation still lost price provenance downstream: R3-8. |
| Self-review: primary interrupt drops usage | defect found → fixed | Raw usage survives; R3-8 also preserves a receipt record, identity, split, and provenance on timeout/interrupt/error paths. |
| Self-review: stalled initial capability probe | holds | Probe runs under abort/deadline before dispatch; no cancellation is needed when no agent was launched. Real stalled-listTools fixture passes. |

Additional diff checks: entry-input normalization and durable polling order; terminal-stream append without file recreation; stdout/stderr separation; provider tier/settings propagation; process-boundary failure handling; workspace-bound hooks/MCP policy state; per-root pipeline drafts; file/WS routing; desktop/mobile proxy consumers; test discovery and changed assertions. No assertion was weakened in this round. The old SDK capacity assertion remains and now pins an actual running build, because refusal is the busy backstop rather than the expected result for idle history.

## B. Confirmed findings and fixes

| ID / severity | Current location | Concrete defect and fix | Proving test |
|---|---|---|---|
| R3-1 / P1 | `stratum/ts/src/connectors/cancellation.ts:29`, `stratum/ts/src/mcp/server.ts:120`, `compose/lib/process-termination.js:81` | A leader closes while a descendant group remains alive. Stratum's reap deadline returned normally; Compose did not reap at all. Even a connector teardown error was recorded/acknowledged as cancelled by MCP. Both helpers now reject surviving groups after a two-second reap bound; MCP remembers and rethrows teardown failure on current and repeated cancel requests. | `stratum/ts/tests/connectors/round3.test.ts`: surviving-group rejection, delayed ESRCH, repeated MCP cancel failure; `compose/test/round3-execution.test.js:8`. Pre-fix controls failed. Existing real descendant-writer tests also pass. |
| R3-2 / P1 | `stratum/ts/src/connectors/cancellation.ts:58` | A cancellation starts TERM grace; stdout then overruns and requests SIGKILL. Memoization ignored the stronger request, allowing flooding through the grace period. A force-kill wakeup now interrupts the pending grace while callers share one teardown promise. | `stratum/ts/tests/connectors/round3.test.ts`, “an emergency SIGKILL escalates an already-running graceful teardown immediately”; failed before fix. Existing actual Codex overrun/process test passes. |
| R3-3 / P1 | `compose/server/agent-workspace.js:205`, `:213`, `:246`, `:273` | After the cap's worth of distinct SDK workspaces, all later agent requests returned 409 even when prior contexts were idle. Added access-ordered LRU, busy checks for SSE, persisted work and all outstanding iterators, including replaced queries still draining. Async iterator-return rejection is contained instead of becoming unhandled. Eviction closes bridge/watchers/buffer/history. | `test/workspace-review-fixes.test.js:232`, `:333`, `:355`: live query versus idle eviction, draining replaced iterator whose return rejects, SSE refusal until disconnect. Idle-cap test failed before fix. |
| R3-4 / P1 | `compose/server/workspace-runtime.js:42`, `:218`; `server/project-root.js:54`; `server/build-routes.js:35`; `server/design-routes.js:69`, `:393`; `server/agent-health.js:122` | A suspended workspace could be evicted during a build before its state file existed, during fire-and-forget design dispatch, after a long-operation HTTP disconnect, or while a monitored process was absent from the persisted registry. Added request/SSE counts, asynchronous work leases for build launchers and design completion, design-dispatch/listener state, and live monitor state. | `test/workspace-review-fixes.test.js:257`, `:305` (two cases). Tests use real Express handlers with deferred fake execution, including response-close before completion. Pre-fix and mutation controls fail. |
| R3-5 / P2 | `compose/server/workspace-activity.js:6` | `active-build.json` persists after completion, so existence alone permanently marked an idle workspace busy. Shared disk check treats terminal statuses as history, retains nonterminal builds/running agents, and conservatively refuses eviction for unreadable state. | `test/workspace-review-fixes.test.js:257`, terminal history with the current live PID is evictable; restoring existence-only behavior fails. |
| R3-6 / P2 | `compose/server/workspace-runtime.js:70`, `:238`; `server/design-routes.js:54` | Evicting a design workspace closed its router/store timers but retained its cached MCP client and subprocess. Repeated evictions therefore left a second unbounded cache. Eviction now removes/closes only that root's idle client; shutdown closes retained roots' clients. | `test/workspace-review-fixes.test.js:385`, “workspace eviction closes only its own idle design MCP connection”; failed before fix. |
| R3-7 / P2 | `compose/server/workspace-runtime.js:90`; `server/agent-workspace.js:272` | At capacity, an invalid destination caused LRU eviction before `prepareProject` rejected the path, destroying retained session state despite a failed switch. Destination validation now precedes eviction in both runtimes. | `test/workspace-review-fixes.test.js:372`, nonexistent destination leaves both retained contexts and active selection intact; failed before fix. |
| R3-8 / P1 | `compose/lib/result-normalizer.js:425`, `:592`, `:635`, `:757`, `:772`; `lib/build.js:1221` | A provider resolves with billable usage after cancellation. MCP's cancel conversion carries raw `usage` with sibling `split`/`usdSource`, but normalizer errors copied only `usage`; the receipt funnel dropped unlabelled USD and identity/split. Local late-resolve usage similarly lacked a receipt provenance label. Primary terminal errors now carry a normalized single-dispatch receipt record. Review-repair success and failure records also retain sibling USD provenance and split. Original raw aggregate usage remains intact for legacy accounting. | `test/review-fixes-runtime.test.js:56`: real stdio MCP → acknowledged late result → timeout → receipt; `test/round3-execution.test.js`: failure/late-timeout/interrupt/uncertain-teardown matrix plus repair success/cancellation provenance tests. Both repair tests failed before their fix. Mutation control removes record propagation and fails the real MCP receipt assertion. |
| R3-9 / P2 | `compose/server/vision-routes.js:268`, `:846`, `:860` | Editing `paths.features` and switching back refreshed config but artifact assessment/scaffolding continued using the root captured during router construction. Resolve the configured root per artifact request. | `test/workspace-review-fixes.test.js:287`: creates a real design artifact only at the new path, refreshes the workspace, and reads it through the actual artifact route. Captured-path mutation fails. |

## C. Deliberately not changed

- Publishing, dependency versions, lockfile, and the installed package symlink remain the user's decision. Local surface compatibility is verified; a published clean install is not certified.
- S5's rejection of Codex tool filters is correct. Forwarding filters unsupported by the durable Codex launcher would advertise a restriction it cannot enforce.
- Kept config/capability object identity rather than rewriting the setter merely to match a suggested implementation. The alias regression test and route read-through establish the required behavior.
- Kept the documented Windows local fallback. Native Windows process-tree parity requires a separate implementation; this review validates the platform branch with a stub, not a live Windows provider.
- Kept the capacity backstop for genuinely busy or unreadable workspaces. Did not invent PID-based eviction of uncertain work; the sandbox cannot verify process identity reliably.
- Same-root switches re-arm watchers and services without closing sockets. This is needed for refreshed paths and is not itself a defect. Idle watchers are resources to close on eviction, not reasons to retain every workspace forever.
- Did not rename variables, reformat the large contract JSON, remove historical review notes, change provider-tier conventions beyond the existing fixes, or repair excluded documentation whitespace.
- Sandbox `listen EPERM`, denied `/bin/ps`, and denied out-of-root guard/outbox writes are verification limitations, not code regressions. Assertions and security checks remain intact. No GUI launch was attempted.

## D. Verification

Final targeted checks before full suites: Stratum **66 passed** across connector cancellation/review/round-3 and MCP contract/agent tests; Compose **74 passed** across round-3 workspace/execution, stdio error, usage-receipt, and repair-control files. Earlier broader Compose targeted run: **99 passed, 1 skipped** (100 total). Counts overlap and must not be added. Stratum `CI=1 npm run typecheck` and `CI=1 npm run build` passed.

Negative controls recorded failures for reap timeout, false MCP cancellation acknowledgement, SIGKILL during grace, SDK idle-cap behavior, unfinished HTTP/design work, terminal-build retention, cached design-client eviction, invalid-switch eviction, artifact-path capture, and late-success receipt propagation. Tests were restored to the fixed code after each control.

### Single full-suite runs

| Runner / exact command and working directory | Passed | Failed | Cancelled | Skipped | Total | File/suite count | Result / log |
|---|---:|---:|---:|---:|---:|---|---|
| Stratum: `cd /Users/ruze/reg/my/forge/stratum/ts && CI=1 npm test` | 1040 | 17 | 0 | 3 | 1060 | 70 files passed, 1 failed, 2 skipped; 73 total | exit 1; `/tmp/round3-stratum-full.log` |
| Compose backend: `cd /Users/ruze/reg/my/forge/compose && CI=1 npm test` | 5234 | 404 | 450 | 8 | 6096 | 1171 suites | exit 1; `/tmp/round3-compose-full.log`; backend failure prevented the chained UI/tracker commands |
| Compose UI: `cd /Users/ruze/reg/my/forge/compose && CI=1 npm run test:ui` | 611 | 0 | 0 | 0 | 611 | 50 files passed | exit 0; `/tmp/round3-compose-ui.log` |
| Compose tracker: `cd /Users/ruze/reg/my/forge/compose && CI=1 npm run test:tracker` | 100 | 0 | 0 | 0 | 100 | 11 files passed | exit 0; `/tmp/round3-compose-tracker.log` |

Each full runner ran once. No full suite was repeated. The backend counts are the actual Node summary; cancellations are not passes. **This environment did not produce a green full backend or Stratum suite.**

### Failures, isolated checks, and verification limits

- All 17 Stratum failures are in unchanged `tests/learn/apply.test.ts`: `ProcessIdentityUnverifiableError` while acquiring resource locks. A direct `/bin/ps -o lstart= -p $$` probe was denied by the sandbox. The guard intentionally fails closed; it was not weakened. The full `tests/mcp/agent-run.test.ts` run passed all 17 tests; the historical ENOTEMPTY flake did not occur.
- Compose HTTP/WS tests encounter `listen EPERM` on loopback/wildcard listeners. Setup failures also produce missing-URL errors and cancelled dependent tests. `test/settings-e2e.test.js` reached its 300-second timeout after listener failure. These runs cannot certify network integration in this sandbox.
- Native filesystem watching is independently unavailable here: a fresh Node process watching one fresh temporary directory emits `EMFILE: too many open files, watch`. `test/pipeline-specwatch.test.js` reproduces this in isolation. The bridge tests receive no append notifications, with 16 assertion failures across their three groups. Related watcher-driven lane/projection tests also fail. This is stronger evidence than assuming the historical Bridge-to-SSE timing flake, but it is not a per-failure diagnosis of every backend assertion.
- Out-of-root writes are denied: GSD flow fixtures under `~/.stratum/ts/flows`, hook read-cache fixtures under `~/.claude/read-cache`, and init's skill synchronization into `~/.claude/skills`. A captured `compose init --no-stratum --no-lifecycle` probe confirms the latter `copyfile EPERM` after both default and quick pipelines were successfully created. Packaging's `npm pack --dry-run` check also fails with npm log/cache access outside the writable roots; a clean package check remains unverified.
- Required named-file rerun: `CI=1 node --import ./test/suppress-expected-drift.js --test --test-timeout=300000 test/build-stream-smoke.test.js` (Compose cwd), exit 1: **0 passed, 0 failed, 4 cancelled, 0 skipped; 4 tests, 1 suite**. Its listener cannot start (`EPERM`), so the known Bridge-to-SSE timing flake cannot be adjudicated. Log: `/tmp/round3-compose-bridge-isolated.log`.
- Supplemental isolated environment check: `CI=1 node --import ./test/suppress-expected-drift.js --test --test-timeout=300000 test/build-stream-bridge.test.js test/pipeline-specwatch.test.js test/build-quick.test.js` (Compose cwd), exit 1: **33 passed, 18 failed, 0 cancelled, 0 skipped; 51 tests, 9 suites**. Failures: 16 bridge notifications, 1 native watcher, 1 init skill-copy permission failure. Log: `/tmp/round3-environment-isolated.log`.
- The full backend run is **not** claimed to prove all unrelated behavior. Listener, process-identity, watcher and external-write restrictions require a rerun in an environment that supports those facilities; remaining cascading assertions have not each been independently classified. No fixture/security assertion was relaxed to manufacture green results.

### Post-suite repair-usage follow-up

A final call-path check after the full backend run found the repair variants of R3-8. Two new negative-control tests failed, then passed after preserving sibling provenance on repair success and provenance/split on repair error. This narrow follow-up changed only `lib/result-normalizer.js` and its regression test. Therefore the full backend counts above describe the snapshot **before** that follow-up, and are not represented as full-suite validation of its final code. The once-only full-suite instruction was preserved.

Final targeted command in Compose:

```sh
CI=1 node --import ./test/suppress-expected-drift.js --test test/round3-execution.test.js test/review-fixes-runtime.test.js test/usage-receipts.test.js test/review-repair-control.test.js test/ts-cutover-e3-round5.test.js
```

Result: **69 passed, 0 failed, 0 cancelled, 0 skipped; 69 tests, 3 suites**. Log: `/tmp/round3-postsuite-target.log`. This includes all seven round-3 execution tests, actual stdio late-usage accounting, existing receipt controls, and repair cancellation behavior. No Stratum source changed after its final build/full run.


## Round-3 outcome (controller, unsandboxed rerun, 2026-09-05)

Codex's full-suite counts above are sandbox artifacts (`listen EPERM`, denied `/bin/ps`,
watcher `EMFILE`). Rerun outside the sandbox, once per runner, `CI=1`:

| Suite | Result |
|---|---|
| stratum typecheck + build | clean |
| stratum full | 1057 pass, 3 skipped, 0 fail |
| compose backend | 6101 pass, 1 fail (`test/build-stream-smoke.test.js` "late-connecting client", 30s wait for fs.watch delivery) |
| compose UI | 611 pass |
| compose tracker | 100 pass |

The single backend failure is the fs.watch-under-load class the test's own comments describe
(`server/build-stream-bridge.js` has no periodic re-check once the directory exists). It passed
2/2 isolated and 3/3 under synthetic load (five heavy suites in parallel); the bridge is untouched
by all three rounds. It has now failed in two consecutive full runs where it passed before the
round-2 changes, most plausibly because the suite now holds more concurrent real watchers/servers.
Classified as flake, not regression. Follow-up worth filing (out of scope here): give the bridge a
slow polling re-check of the stream file so its liveness does not depend solely on fs.watch.

Still the user's call: publish stratum 0.4.0; the `node_modules/@smartmemory/stratum` symlink;
commit slicing (A stratum hygiene, B execution/cancellation, C compose workspace + runners).

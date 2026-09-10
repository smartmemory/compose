# COMP-BUILD-CANCEL: Implementation Blueprint

**Date:** 2026-09-10
**Status:** BLUEPRINT — Phase 4. Grounded against the compose working tree and
`@smartmemory/stratum` @ `6e4a68c` (tag `v0.5.0`), both read 2026-09-10.
**Decisions:** `docs/features/COMP-BUILD-CANCEL/decisions.md` — D-A..D-G are LOCKED. This
blueprint implements them; where the code contradicts a decision's *stated reason* or makes a
step impossible as written, §2 records it and states the minimal alternative. No decision is
re-opened.

Every `path:line` below was re-read in the file before it was written here. Paths are
repo-relative to `/Users/ruze/reg/my/forge/compose` unless they begin with `stratum/`, which
are relative to `/Users/ruze/reg/my/forge/stratum`.

## Related Documents

- `docs/features/COMP-BUILD-CANCEL/decisions.md` — the seven locked decisions (D-A..D-G)
- `docs/features/COMP-FABLE-ASTRA/design.md` §"The loop, and what it depends on" — D1 (the
  loop-carried flow value that makes consumer fanout re-enterable) and D5 (`real cancellation`,
  the parent of this feature): `design.md:139-171`, `design.md:214-222`
- `docs/features/COMP-BUILD-CANCEL/explore-compose.md` — compose-side trace (974 lines)
- `docs/features/COMP-BUILD-CANCEL/explore-stratum-full.md` — the first stratum explorer's
  complete report (842 lines): §1 the `flow` / `cancellationId` schema and admission, §2 the
  `stratum_flow_cancel` request, responses, error envelopes and the unknown-run shape. It
  supersedes the truncated `explore-stratum-s1s2.md`, which no longer exists
- `docs/features/COMP-BUILD-CANCEL/explore-stratum.md` — the second stratum explorer's report
  (547 lines): §3-7, the cross-process story, the registry, the surface pins and the CLI
- `../../../stratum/docs/features/STRAT-FLOW-CANCEL-FG/blueprint.md` §11 "The contract compose
  will call" (`:2813-2840`) and §12 "Out of scope" (`:2841-2890`) — the shipped stratum half
- `CHANGELOG.md` — one entry per slice, in the slice's own commit
- ROADMAP.md row **COMP-BUILD-CANCEL** (position 152, IN_PROGRESS, parent COMP-FABLE-ASTRA) —
  `docs/features/COMP-BUILD-CANCEL/feature.json`
- `.claude/rules/versioning.md` — the version-train constraint S01 obeys, enforced by
  `test/version-sync.test.js`
- `.claude/skills/compose/templates/boundary-map.md` — the grammar §11 obeys

---

## 1. Summary, and the v1 boundary

Compose drives its team builds as **foreground consumer-dispatch flows**: compose itself calls
`stratum_plan` and every `stratum_step_done` (`lib/build.js:5568`, `:701`, `:3482`, `:3945`),
and each fanout item's agent goes out as a `stratum_agent_run` from compose's own MCP client
(`lib/build.js:933` → `lib/result-normalizer.js:581`). Today nothing can stop that. Ctrl-C
sets one variable and closes a stream (`lib/build.js:2976-2981`). `compose build --abort`
issues no cancel of any kind — it audits the run inside a bare `catch {}`
(`lib/build.js:5817-5827`) and then writes local terminal state as if the build had stopped.

Stratum 0.5.0 ships the missing half: `stratum_flow_cancel({runId})` settles the run under the
per-run file lock, burns every outstanding issuance, and terminates the agent process groups it
spawned for that flow. It can only reach an agent that was dispatched with **both**
`cancellationId` and `flow: {runId, ...}` — the flow tag is what writes the durable foreground
registry record carrying the child pid and start time
(`stratum/ts/src/mcp/server.ts:199-222`). Compose sends neither today. So the tagging is a
prerequisite, not an enhancement, and the first failure mode of skipping it is the worst one on
this surface: an all-zero agents summary and `acknowledged: true` with every worker still alive.

This feature wires seven things, in order: the version train and guard (S01), the client's
`flow` field and `flowCancel()` (S02), the build-level abort chain (S03), an honest `--abort`
(S04), driver-side cancel detection and the no-merge rule (S05), a real signal teardown (S06),
and a golden against the real stratum server (S07).

### What a cross-process abort can and cannot reach

`compose build --abort` runs in a **different process** from the build and opens its **own**
stratum MCP server (`lib/build.js:5815-5818` via `resolveStratumMcpConnection`,
`lib/stratum-engine.js:248`). That server holds none of the driver's in-memory abort
controllers, so `abortLocal` finds nothing (`stratum/ts/src/mcp/server.ts:291-302`) and
everything must travel through on-disk state. Concretely:

| Thing | Reached by a cross-process `--abort`? | How |
|---|---|---|
| The run record (status, issuances, gate tokens) | **Yes** | `stratum_flow_cancel` settles it under the run lock |
| A tagged `stratum_agent_run` agent (codex / claude via the connector tier) | **Yes** | the foreground registry sweep SIGTERMs its process group |
| An **untagged** `stratum_agent_run` agent | **No** | no registry record exists; it keeps running against a cancelled flow. After the R1 ruling the build driver issues none — the remaining untagged callers all run outside a flow (S03-4) |
| A compose `isolation: none` local Claude agent | **Only** via SIGTERM to the driver pid | it never enters stratum at all (`lib/local-claude-connector.js`, dispatched at `lib/result-normalizer.js:559`); the driver's own signal handler (D-E) aborts the build-level controller (D-F) |
| A gate-time agent (gate `askAgent`, the review-repair fixer at `lib/build.js:4374`) | **Yes** (R1 ruling) | a gate pause leaves the run `running`, so admission succeeds; these are tagged too — see C1 |
| The driver process itself | **Yes**, best-effort | SIGTERM to `active-build.json`'s `pid`, only when the flow is settled and the pid is alive |

The single sentence a reviewer should hold onto: **a refusal sweeps nothing.** When
`stratum_flow_cancel` comes back unconfirmed with `flowSettled: false`, nothing was mutated and
no agent was signalled, so compose must not write `aborted` and must not kill the vision item.
The discriminator for "did the build stop" is `flowSettled`, never the error code
(explore-stratum surprise 6).

---

## 2. Corrections

Every row is a place where `decisions.md` or an exploration report said something the code does
not say. "Resolution" is what this blueprint does instead, staying inside the locked decision
wherever the decision itself survives.

| # | Assumption | Reality (`path:line`) | Resolution |
|---|---|---|---|
| C1 | D-A: gate-time agents "are NOT tagged (admission would fail `flow_not_running`)"; the same reason is repeated in decisions.md §Out of scope | **The reason is false.** `admitFlowAgent` refuses on `run.status !== "running" \|\| run.cancelRequested === true` (`stratum/ts/src/engine/engine.ts:1143-1145`). A gate pause never touches `run.status`: the only writers are `stratum/ts/src/engine/engine.ts:1399` and `:1621` (`completed`), `:3391` (`budget_exhausted`), `:3410` (`cancelled`), `:3423` (`failed`). A gate-paused run is still `running`, so a gate-time agent **is** admitted and tags successfully | **Superseded by the R1 ruling (2026-09-10): v1 DOES tag gate-time agents.** The exclusion existed only to dodge a refusal that does not happen, so with the premise gone nothing justifies it — and leaving those two untagged would leave a cross-process abort unable to reach the agents most likely to be running at the moment a human reaches for `--abort`. Both sites take `flow: {runId, stepId}` whenever the build has a `flowId` (S03-4). `COMP-BUILD-CANCEL-GATE-TAG` is **withdrawn, not deferred** |
| C2 | D-D: "the merge site (explore-compose §2 'Where captured patches are merged') checks the flag before applying" | That section names `artifacts.prepareIssuance` (`lib/consumer-fanout.js:742`), which only **captures** a cumulative worktree diff into the journal (`:786`, `cumulativeDiff(worktree.path, worktree.baseCommit)`). The diff is **applied** by `applyMerge`, called at `lib/build.js:4224` and `lib/gsd.js:689` | The no-merge-after-cancel guard goes at the **apply** site (`lib/build.js:4224`), not at capture. Capture is left alone: a captured-but-unmerged diff is evidence, and discarding it at capture would destroy the record the journal exists to keep |
| C3 | D-C step 5: "the CLI prints one line per field that matters and exits 0/1" | `runBuild` discards `abortBuild`'s return value and returns `undefined` (`lib/build.js:2252-2253`), and all three CLI entry points exit 0 unconditionally on resolve: `bin/compose.js:2860-2861` (build), `:2977-2978` (fix), `:3088-3089` (plan) | S04 threads the result: `runBuild` returns `await abortBuild(...)`, and each of the three `.then()` callbacks exits `1` when `opts.abort` is set and `result?.ok === false`. Non-abort runs are unaffected — `result` is `undefined` there |
| C4 | D-C step 2: "`flow_not_found` / unknown run" is an outcome class compose can key on | There is no such code on the MCP surface. An unknown runId makes `flowCancel` throw `ENOENT` out of `this.store.load(runId)` (`stratum/ts/src/engine/engine.ts:1167`); it is not a `CANCELLATION_*` code, so the `flow_cancel_unacknowledged` branch (`stratum/ts/src/mcp/server.ts:477-485`) does not apply and it falls through the raw rethrow at `:510`. **The resulting shape is already observed and pinned by stratum's own test** (`stratum/ts/tests/mcp/flow_cancel_edges.test.ts:36-60`): an `McpError` with `data === undefined` — no `code`, no `runId` — whose `message` matches `/ENOENT\|no such run\|not found/i`. The CLI's `{conflict:true, detail:"flow_not_found"}` exists only on the CLI path, not the MCP one | `isUnknownFlowError` is written against that pinned shape now (S02-3), not discovered later: absent `data` **and** an ENOENT-shaped message. S07 confirms it end to end rather than defining it. Do not key on a `flow_not_found` code — on the MCP surface there is none |
| C5 | D-C: `flowCancel` unwraps the envelope "into a `StratumError` whose `code` is `data.code` ... with `reason`, `holderPid`, `flowSettled`, `agents` attached" | Half of that is already free and half is wrong. `#callTool`'s catch copies `error.data.code` onto `error.code` (`lib/stratum-mcp-client.js:541-544`), so `error.code` is already `CANCELLATION_UNCONFIRMED` / `CANCELLATION_TEARDOWN_TIMEOUT` and **never** `flow_cancel_unacknowledged`. But the copied key list is exactly `['code','usage','split','usdSource','stderr','telemetry']` — `status`, `flowSettled`, `reason`, `holderPid` and `agents` are **not** copied and remain only on `error.data` | `flowCancel()` reads the remaining fields off `error.data` and re-throws a `StratumError` carrying them as own properties, so no caller has to know about `error.data`. `error.rpcCode` (the numeric JSON-RPC code, preserved at `lib/stratum-mcp-client.js:540`) is left intact |
| C6 | D-B: the guard message and floor live in one template literal | Confirmed, and it is the only site: `lib/stratum-mcp-client.js:286-288`. There is no surface constant anywhere in `lib/`. Three places hardcode the old values in tests: the modern fixture field list (`test/review-fixes-runtime.test.js:25`), the assertion regex `/Installed Stratum 0.3.4.*allowedTools.*surface: 17.*0.4.0/` (`test/review-fixes-runtime.test.js:73`), and the second old-server fixture schema (`test/execution-runtime.test.js:163-164`) | S01 introduces `REQUIRED_STRATUM_SURFACE = 19` and `REQUIRED_STRATUM_RANGE = '>=0.5.0'`, exported from `lib/stratum-mcp-client.js` and interpolated into the message. Both tests import them and build their expectations from the constants; no version literal is retyped in a test |
| C7 | D-A: "when `flow` is set, `cancellationId` is ALWAYS minted (UUID, never reused) even without a signal" | Today it is minted only under a signal: `const cancellationId = opts.cancellationId ?? (signal ? randomUUID() : undefined)` (`lib/stratum-mcp-client.js:272`). Minting one without a signal is inert on the compose side — the whole cancel path is armed by `signal?.addEventListener('abort', cancel, {once:true})` (`:320`) — but it is **required** by the server, which refuses `flow` without it before any contract I/O (`stratum/ts/src/mcp/server.ts:182-186`) | The mint condition becomes `(signal \|\| opts.flow)`. Stated in S02 so nobody later "simplifies" it back on the grounds that an unsignalled cancellationId does nothing locally |
| C8 | D-G: the `abortBuild` harness uses "an injected client" | The seam already exists — `opts.stratum ?? new StratumMcpClient()` (`lib/build.js:5815`) — so no new seam is needed. But the existing fake exposes only `connect` / `audit` / `close` (`test/abort-build-engine.test.js:28-33`), so the moment `abortBuild` calls `flowCancel` that suite throws `TypeError` | `test/abort-build-engine.test.js`'s `fakeStratum` gains a `flowCancel` returning a settled ack. That file's two existing assertions (engine resolution from the project root, no `connect` on a retired pin) are unchanged |
| C9 | D-G: the golden can reuse the existing real-server test pattern | `test/ts-cutover-build-golden.test.js:154-160` does spawn the real TS MCP binary with an explicit env, but then calls `installAgentHarness(client, ...)`, which **replaces `stratum.agentRun` wholesale** (`test/helpers/ts-agent-harness.js:79`). No `stratum_agent_run` ever reaches the server, so that golden cannot prove flow tagging, registry registration, or a sweep | S07 uses the real server **without** the harness. See C10 |
| C10 | D-G: reuse "the same trick" stratum's own tests use for a slow agent | Stratum fakes a slow agent by **dependency-injecting `runAgent`** (`stratum/ts/tests/mcp/flow_cancel.test.ts:106-123`, `spawningAgent`). That is in-process only and unreachable from compose, which spawns `stratum mcp` as a subprocess | There is a reachable equivalent, and it is more honest: put a **fake executable named `codex`** first on the server's `PATH`. `resolveCodexCommand` prefers a PATH `codex` over the bundled SDK CLI (`stratum/ts/src/connectors/codex.ts:565-568`, `pathCodex` at `:556-563`); the connector's env is the MCP server's own `process.env` (`codex.ts:188`; `server.ts:324-326` passes no `env`); `ownProcessGroup` forces the exec transport and `detached: true` (`codex.ts:199-200`, `:281-285`); and compose's `connect()` accepts an explicit `env` (`lib/stratum-mcp-client.js:460`). The result is a **real** detached process group that sleeps, with no network and no real model call |
| C11 | decisions.md §Out of scope: "the blueprint verifies compose sets none today" (per-build `STRATUM_STATE_ROOT`) | **Verified true.** No `STRATUM_STATE_ROOT` or `STRATUM_AGENT_FG_ROOT` is set anywhere in `lib/`, `server/` or `bin/`; the only production mention is a **read** at `lib/flow-state.js:32`. Both clients spawn with `{...process.env, ...policyEnv}` (`lib/stratum-mcp-client.js:460`), and `resolveStratumPolicyEnv` returns only the three SmartMemory keys or `{}` (`lib/smartmemory-config.js:99-103`) | The build's server and `abortBuild`'s server see the same state root and the same foreground registry root. No change; S07 pins it by pointing both roots at a tmpdir through `connect({env})` and asserting the abort client finds the run |
| C12 | D-C step 4: "use the identity-guarded downgrade pattern at `build.js:2939-2950`" to avoid restamping `pid` | The pattern at `lib/build.js:2943-2949` guards *identity*, not the pid — `writeActiveBuild` restamps `state.pid = process.pid` **unconditionally** (`lib/build.js:1471`). That pid is load-bearing: it is read for the concurrent-build refusal message (`lib/build.js:1849`) and for the liveness decision at `lib/build.js:2764-2766`. **Narrowed by R2 findings 1 and 2**: preserving the pid is necessary but not sufficient, because the aborter is not always a different process and is not always the right writer at all | `writeActiveBuild(dataDir, state, { stampPid = true } = {})`, with only `abortBuild` passing `false`; every other one of the nine call sites is byte-identical. But **who** writes the terminal record is now decided by C23, not by this row alone |
| C13 | D-F: chain the build-level signal "via `executionOptions` (`result-normalizer.js:367-377`) → `AbortSignal.any([...])`" | `executionOptions` (`lib/result-normalizer.js:367-377`) is spread into the `stratum.agentRun` options that become the MCP wire request; an `AbortSignal` does not belong there. And the local branch takes an `abortController`, not a signal (`lib/result-normalizer.js:566`, `lib/local-claude-connector.js`), so `AbortSignal.any` would cover the MCP branch only | Minimal alternative, one branch-agnostic hook: a new `opts.buildSignal` on `runAndNormalize` that forwards `stopRun` — `if (opts.buildSignal?.aborted) stopRun(); else opts.buildSignal?.addEventListener('abort', stopRun, {once:true})`, removed in the existing `finally`. It reaches the local SDK agent, the primary MCP dispatch (`:583`) and the review-repair dispatch (`:749`) through the single existing `abortController` (`:433-434`) |
| C14 | D-C step 3: SIGTERM the driver pid "only if `status==='running'` and the pid is alive" | The liveness helper exists and handles EPERM correctly (`isProcessAlive`, `lib/build.js:1937-1949`). **But the premise that the aborter is a separate process is false on the HTTP path** — see C22. Signalling the recorded pid there kills the compose server | Reuse `isProcessAlive` in-module, but only on the branch C22 establishes: a recorded pid that is **not** `process.pid` and has no in-process handle. Never signal `process.pid` |
| C15 | D-D: detect a cancel "when `step_done`/`gate_resolve` throws an error whose ... code is `PERSIST_ON_CANCELLED_RUN` / `flow_cancelled`" | Those two codes exist but are on **other** calls. `stepDone` and `gateResolve` throw bare uncoded `Error("run <id> is cancelled; ...")` (`stratum/ts/src/engine/engine.ts:748`, `:1306`); `PERSIST_ON_CANCELLED_RUN` comes from `usageReport` / receipt writes (`:873-877`, `:524-528`), and `flow_cancelled` is the `commit`/`revert` checkpoint envelope (`:3346-3349`) | The message match `/is cancelled/` is the primary signal on `stepDone`/`gateResolve`; the two codes stay in the predicate as secondary signals for the calls that really carry them. Either way the predicate is only a **trigger** — the authority is `isRunCancelled()`, which asks the engine (`stratum_audit` succeeds on a cancelled run, `stratum/ts/src/engine/engine.ts:1057-1061`) |
| C16 | explore-compose surprise 5 / decisions.md adjudication: a resumed build may hold a driver lease and be refused `engine_dispatch_active` | Re-verified on the shipped code, and the adjudication is right. `retainRun` is the only lease writer (`stratum/ts/src/engine/engine.ts:416-431`), and its four call sites are all bg-driven, gate-re-kick, or `scheduleFanout` — which returns before pinning for consumer dispatch. `prepareLease` writes nothing | `engine_dispatch_active` is handled as a generic unconfirmed refusal (no retry, report and stop) and is **not** designed for. Not a special case in S04's table |
| C17 | The `flow_cancel` response shape "does not include `status`" (the contract's response block lists six keys) | `status` is the **variant discriminant** and it is on the wire: `cancelFlow`'s ack is spread into the response minus only `settledByThisCall` (`stratum/ts/src/mcp/server.ts:307-309`) | §3 documents `status` as present; S07's golden asserts the exact key set returned by the real server rather than trusting either reading |
| C18 | (my own R1 claim) Tagging flips codex from the SDK transport to exec across the board, a large undeclared blast radius | **I overstated this, and the R2-ruling-12 verification is what caught it.** The transport flip is driven by `cancellationId`, not by `flow` — and compose **already** sends a `cancellationId` on every `runAndNormalize` MCP dispatch today, because `lib/result-normalizer.js:583` and `:749` always pass `signal: abortController.signal`, and `lib/stratum-mcp-client.js:272` mints one whenever a signal is present. So consumer fanout items, ordinary step agents, the step fixer, the policy revision and the review-repair gate fixer are **all already `ownProcessGroup: true`, already exec for codex** (`stratum/ts/src/connectors/codex.ts:199-200`) and already detached (`:284`, `stratum/ts/src/connectors/claude.ts:80-92`). The only dispatch that is NOT is `runAgentText`, which passes no signal — and of its callers only the gate Q&A agent is tagged here | The real blast radius is **one call site**: the gate Q&A agent (`lib/build.js:1974`), which is `claude`, so the change there is the detached `spawnClaudeCodeProcess` hook, **not** a codex transport switch (no codex dispatch changes transport at all). Ruling 12's kill switch and transport journalling are still adopted (C33), because they are cheap and the derived value is worth showing — but the risk they hedge is one claude Q&A dispatch, not the team-build path. **R12 is rewritten accordingly** |
| C19 | D-C treats `CANCELLATION_TEARDOWN_TIMEOUT` as an edge case, and leaves "was this pre- or post-settle?" to be inferred from the code | Two facts sharpen it. (a) The code is chosen by `agents.unreachable > 0 && agents.unresolved === 0 && agents.unreaped === 0 ? "CANCELLATION_UNCONFIRMED" : "CANCELLATION_TEARDOWN_TIMEOUT"` (`stratum/ts/src/engine/flow_cancel.ts:198-208`), and a **pre**-settle refusal always carries an all-zero `agents` (`flow_cancel.ts:138-152`). So `agents.unreachable > 0` is an exact discriminator for post-settle. (b) A timeout is the **likely** outcome of a healthy cross-process abort, not a rarity: the sweeping process may not stamp another LIVE server's entry `settled` (`stratum/ts/src/connectors/foreground_registry.ts:635-661`), so if the driver's dispatcher needs more than `STRATUM_CANCEL_TIMEOUT_MS` (15s) to reach its `finally`, the cancel raises `CANCELLATION_TEARDOWN_TIMEOUT` with every group already reaped | S04's table gains the discriminator explicitly, and the one-shot re-sweep is documented as the **expected** path rather than a rare recovery — so nobody later deletes it as dead code. Carried as **R13** |
| C20 | D-C: retry `run_lock_held` "up to `COMPOSE_ABORT_RETRIES` (default 2) with a short pause" | Each attempt can itself block for `STRATUM_CANCEL_LOCK_WAIT_MS`, default **120000** (`stratum/ts/src/engine/run_lock.ts:16`, applied at `stratum/ts/src/engine/engine.ts:1188`). Three attempts is therefore up to **six minutes** of a hung terminal before `--abort` says anything. The knob is read per call from `process.env` (`run_lock.ts:49-51`), and compose's `connect()` already accepts an explicit spawn env (`lib/stratum-mcp-client.js:460`) | The abort client spawns its server with `STRATUM_CANCEL_LOCK_WAIT_MS` set to `COMPOSE_ABORT_LOCK_WAIT_MS` (default **10000**), so a lock-held refusal is reported in seconds and the retry loop is what waits, visibly, instead of one opaque two-minute block. The build's own server is untouched and keeps the 120s default |
| C21 | (my own R1 claim) Tagging detaches agents out of compose's process group, so the group-delivered Ctrl-C kill that works today disappears, making S06 a prerequisite for S03 | **Also overstated, same root cause as C18.** Every `runAndNormalize` dispatch is already detached today (C18), so the terminal's SIGINT already fails to reach those agents by group delivery. What remains true: the MCP SDK spawns the stratum server with no `detached` (`node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js:65-75`), so compose and the server do share a group, and the **gate Q&A agent** is genuinely attached today and genuinely loses that free kill when tagged | The ordering constraint survives but shrinks to one dispatch: between S03 and S06, a Ctrl-C at a gate can orphan the Q&A agent. Landing S06 first is still the cheap answer and is still recommended, but it is no longer a broad regression across the build. Neither `lib/local-claude-connector.js` (never enters stratum) nor any codex dispatch is affected |
| C22 | D-C and my §1 boundary table both assume `--abort` runs in a **different process** from the build | False on the HTTP path. `server/build-routes.js:134` calls `runBuild` and `:151` calls `abortBuild` **in the same express process**, so `active-build.json`'s `pid` is the compose server's own pid. A SIGTERM to it (C14) kills the server, and a `pid === process.pid` guard alone would instead leave every local agent alive, because nothing would reach the build-level controller | **R2 ruling 1.** A module-level `activeBuildCancels: Map<flowId, BuildCancel>` in `lib/build-cancel.js`, registered by `runBuild` and deleted in its `finally`. `abortBuild` consults it **first**: a hit means same-process, so it calls `buildCancel.cancel('abort')` directly and signals nothing. Only a recorded pid that is neither `process.pid` nor absent nor dead is SIGTERMed |
| C23 | `writeActiveBuild` is safe for two writers because it writes tmp-then-rename | The tmp name is shared: `const tmp = target + '.tmp'` (`lib/build.js:1472`), one path for every writer. Two processes writing concurrently interleave in the same file and rename a torn document into place. Preserving the driver pid (C12) does not help — it makes the aborter's write *more* likely to be the one that loses | **R2 ruling 2**, two parts. (a) Unique tmp: `` `${target}.${process.pid}.${randomUUID().slice(0,8)}.tmp` ``. (b) **One terminal owner.** When a live driver exists (an in-process handle, or a foreign pid that is alive), `abortBuild` does **not** write the terminal record at all; it waits, bounded by `COMPOSE_ABORT_DRIVER_WAIT_MS` (default 20000), for the driver to settle, then re-reads. It writes `aborted` itself only when there is no live driver, or when the wait expires — and then under the identity guard, returning `driverExited: false` |
| C24 | R2 ruling 3 proposes reversing a post-cancel merge with `git apply -R` of the journaled cumulative diff | **The mechanism does not fit, and the ruling asked me to check.** `applyMerge` is **tree-based, not patch-based**: it computes a merged tree (`mergeDiffIntoWorkingTree`, `lib/consumer-fanout.js:1085`) and checks out the delta against a witness chain (`checkoutTreeDelta`, `:1092`), verifying the landed tree against `witnessChain[orderedIndex + 1]` (`:1094-1100`). Reverse-applying one item's patch would leave the working tree at a state no witness describes, and the next rollback would transition from a tree it does not recognise — the exact hazard the `trackedTree` comment at `:1088-1091` was written about. The TOCTOU itself is real and **already documented** as a known cross-process window at `lib/consumer-fanout.js:1070-1079` | **Ruling 3 accepted, mechanism substituted.** The reversal is the one the repo already owns: `restoreMergeBaseline(transaction, audit)` (`lib/consumer-fanout.js:1168`), which restores `tx.baselineTree` wholesale (`:1177`) and flips each `merged` issuance back to `accepted` or `superseded` against the audit (`:1191-1210`). It is already the non-approve path at `lib/build.js:4251-4253`, so the cancel path reuses a tested primitive instead of inventing one. It reverses the **whole transaction**, which is what a cancel wants: nothing from this round should land. It gains one optional `reason` argument so the journal records `rollbackReason: 'cancelled'` |
| C25 | D-D's detection points cover the build | They cover the consumer catch (`lib/build.js:958-973`) and the `stepDone`/`gateResolve` throws, but the **ordinary step agent** (`lib/build.js:3601-3618`), the **step fixer** (`:3508`) and the **gate fixer** (`:4374-4392`) all reject out of `runAndNormalize` and rethrow before any `stepDone` is reached, so a cancel that kills one of those is classified as an ordinary agent failure | **R2 ruling 4.** One shared boundary, `confirmCancellation(error, ctx)` in `lib/build-cancel.js`, called from `runAndNormalize`'s error path — which covers the consumer item, the ordinary step, the step fixer and the gate fixer in one place — plus from the gate Q&A caller, which does not go through `runAndNormalize` |
| C26 | A confirmed cancel ends the build `aborted` | Only if it escapes the outer catch, and it does not. `lib/build.js:4931-4932` sets `buildStatus = 'failed'` unconditionally on **any** throw and calls `terminalizeThrownBuild`, which writes `status: 'failed'` (`:2088-2094`) and flips the vision item to `blocked` (`:2106`). The `aborted` branch is keyed on `killedByGate` alone (`:4598-4614`) | **R2 ruling 5.** The outer catch tests `buildCancel.cancelled` first and routes to the aborted terminalizer; the existing aborted branch's condition generalises to `killedByGate \|\| buildCancel.cancelled`; the vision item goes to `killed`, never `blocked` |
| C27 | §3.4's `cancel()` returning `true` once is enough to express "second signal forces exit" | It conflates two states. S05's detector calls `cancel()` on a cross-process cancel, so by the time the user presses Ctrl-C the handle is already `cancelled` and the **first** signal would take the second-signal branch and exit immediately, skipping the teardown entirely | **R2 ruling 6.** Two independent states on the handle: `cancelled` (idempotent, carries the reason, set by anyone) and `teardownStarted` (set **only** by `runCancelTeardown`). The handler's force-exit branch keys on `teardownStarted` |
| C28 | D-C: an unknown run means "settled, nothing to cancel", so local cleanup may proceed | The opposite. The ENOENT is thrown **before any sweep** — `cancelFlow` rethrows every non-`RUN_LOCK_TIMEOUT`, non-`CANCELLATION_UNCONFIRMED` error untouched (`stratum/ts/src/engine/flow_cancel.ts:128-141`, and the comment at `:126-129` names ENOENT explicitly). So "unknown flow" means *we never found the run*, not *nothing is running*: the agents, if any, are untouched | **R2 ruling 7.** Unknown flow → `{ok: false, reason: 'flow_not_found'}`, **no** terminal write and **no** vision kill. One exception: an active record with no `flowId` at all (a build aborted before `plan` returned) has nothing to cancel in stratum, and proceeds to the driver handling of C22/C23 |
| C29 | The seven outcome classes cover what `flowCancel` can do | A raw transport failure — the server died, the pipe broke, the connect failed — is none of them, and would fall out of the table into an unhandled throw | **R2 ruling 8.** `flowCancel()` normalises any error that is neither the `flow_cancel_unacknowledged` envelope nor an unknown-flow ENOENT into `StratumError('CANCELLATION_UNCONFIRMED')` with `reason: 'transport'`, `flowSettled: false` and zeroed `agents`, and S04's table gains an explicit catch-all refusal row |
| C30 | `isTerminalFlow` describes the terminal statuses | It predates `cancelled` and lists only `['completed','failed','budget_exhausted']` (`lib/build.js:2012-2014`). The live hole is the resume decision: at `lib/build.js:2770` a local status of `complete`/`aborted`/`killed` short-circuits, and at `:2772-2775` the audit is consulted **only when the recorded pid is not alive** — so a cancelled flow whose driver is still up keeps `flowTerminal === false`, `decideBuildStart` returns `resume`, and `stratum.resume` (`:2802`) throws the uncoded `run <id> is cancelled; resume is not permitted` | **R2 ruling 9.** Add `cancelled`. It widens **seven** call sites (`:2775`, `:2834`, `:3334`, `:4274`, `:4565`, `:5820`, and the definition), and each is beneficial or inert: the step loop and gate advance can never see `cancelled` on a response (those calls throw instead), while the resume probe, the bare-flow-resume refusal, the consumer-artifact cleanup and `abortBuild`'s own probe all become correct. Belt and braces for the pid-alive path: an audited `cancelled` run refuses the resume with a named reason and writes the local record `aborted` under the identity guard — this process **is** the driver, so it is the rightful writer (C23) |
| C31 | S04 refuses on "no active build" and "feature mismatch" | It does not refuse an active record that is **already terminal**. Today's `abortBuild` would connect, cancel, kill the vision item and rewrite a `complete` record — and the record is retained on disk after a successful build precisely so it can be read (`lib/build.js:4593-4596`, and the comment at `:4929`) | **R2 ruling 10.** Early refusal: `{ok: false, reason: 'already_<status>'}` with no writes of any kind, for any `active.status` in `complete` / `aborted` / `killed` / `failed` |
| C32 | S07's golden proves the loop | Two defects. It exercises **no real compose call site** — it drives the client directly, so nothing proves `lib/build.js` tags anything. And two assertions contradict the design: step 4 was written expecting a resolved ack while step 5 asserts the pending run **rejects**, and S06's child case was specified against a local agent while C21's receipt needs a **tagged** one | **R2 ruling 11.** S07 gains a **second** test that spawns a real child `compose build` and aborts it from a second process. Step 4 asserts the success shape explicitly. S06's child case uses a tagged stratum agent; a separate unit case covers the local-agent abort through the handle |
| C33 | R2 ruling 12: record the transport per agent run "from the returned telemetry if stratum reports it" | **Stratum reports no transport.** `ConnectorTelemetry` is exactly `{durationMs, model, effort?}` (`stratum/ts/src/connectors/base.ts:29-33`) and `ConnectorResult` adds only `usdSource`, `split`, `text`, `usage`, `telemetry` (`:35-54`). There is no transport field anywhere on the connector surface | The journal records a **derived** value, labelled as derived, because the rule is deterministic and compose knows its own inputs: provider `codex` **and** a `cancellationId` was sent ⟹ exec. The field is `transport_derived`, never `transport`, so nobody mistakes it for an observation. An authoritative value needs a stratum change, filed as **STRAT-CONNECTOR-TRANSPORT-TELEMETRY** in §13 |
| C34 | C25's `looksCancelled` trigger reaches the ordinary-step and fixer sites | It cannot see anything to trigger on. `runAndNormalize`'s catch converts the rejection to a bare `AgentError(err?.message)` at `lib/result-normalizer.js:617-619`, dropping `err.code` entirely; and on the cross-process path the message is `codex exited with code 143`, which matches no `/is cancelled/` pattern. Only the two `CANCELLATION_*` codes survive, and they are rethrown one line earlier (`:592`) | **R2-2 ruling 1.** The trigger is no longer the error's shape but the **call's**: any failure of a **flow-tagged** dispatch is suspicious, checked **inside** that catch at `lib/result-normalizer.js:591`, before the `AgentError` conversion. `looksCancelled` stays as a cheap secondary signal for the `stepDone` / `gateResolve` sites, which do carry a matching message |
| C35 | `makeAskAgent` can reach the cancel handle | It cannot. Its only inputs are `(stratum, context, gateDispatch, gateExtras)` (`lib/build.js:1960`, called at `:4469`), and the build context assembled at `lib/build.js:3020-3047` carries no cancel handle | **R2-2 ruling 2.** `buildCancel` goes on the build context beside `flowId` (`lib/build.js:3022`), and `makeAskAgent` reads `context.buildCancel`. That one route also supplies the gate Q&A agent's `confirmCancellation` call (C25) and its `flowTag` (S03-4) |
| C36 | Registering the in-process handle "immediately after `plan` / `resume` settles, beside `context.flowId`" is early enough | It is up to **three minutes** too late. `startFresh` writes `active-build.json` with the flow id and pid at `lib/build.js:5570-5588`, called at `:2845` / `:2880`; the Codex worktree preflight then runs at `:2917` with its own `PROBE_AGENT_TIMEOUT_MS = 180_000` budget (`lib/codex-preflight.js:33`, controller at `:127-128`); and the context is not built until `:3020`. For that whole window an abort finds a record with a flow id and a pid but **no handle**, so a same-process abort falls through to the foreign-pid branch and signals the compose server | **R2-2 ruling 3.** Register the handle the moment `response.runId` exists — inside `startFresh` and the resume branch, before the preflight — and chain `buildCancel.signal` into the preflight's own controller (`lib/codex-preflight.js:127`, which already forwards a `signal` at `:134`) so an abort during the probe stops it too |
| C37 | S06's teardown and the outer catch cannot both terminalize | They can, and the S06 sketch makes it likely. The signal handler fires `runCancelTeardown` **fire-and-forget** (`void runCancelTeardown(...)`), while the aborted agents make the build throw into the outer catch at `lib/build.js:4931-4971`, which terminalizes on its own. Two writers, one record, no ordering between them | **R2-2 ruling 4.** One shared promise and a strict division of duties. §3.6 writes the handshake out in full: who sets it, who awaits it, the two bounds, why it cannot deadlock, and the single caller of `process.exit` |
| C38 | S02's `flowCancel` sketch normalises the transport case | The sketch ends in `throw error`, so anything that is neither a `CANCELLATION_*` envelope nor an unknown flow escapes unnormalised — C29 was stated in the contract and never reached the code. Worse, `abortBuild`'s `connect()` (`lib/stratum-mcp-client.js:435-471`) runs **outside** `flowCancel` entirely, so a spawn or handshake failure bypasses the outcome table altogether | **R2-2 ruling 5.** `flowCancel`'s final branch becomes the normalisation rather than a rethrow, and `abortBuild` wraps its own `connect()` in the same normalisation. S04's catch-all row is now actually reachable |
| C39 | The post-merge fence can throw `ConsumerMergeDecisionError` | That class is precisely what `lib/build.js:4223-4240` catches and routes into `repairFor`, which converts the cancel into a merge-repair **revise** and keeps the build running — the opposite of the intent | **R2-2 ruling 6.** A distinct `MergeAfterCancelError` (code `MERGE_AFTER_CANCEL`) exported from `lib/consumer-fanout.js` beside the two existing error classes, with the fence placed **outside** the `try` whose catch calls `repairFor`, so it unwinds straight to the cancelled terminalizer |
| C40 | A failed reversal can journal `merge_revert_failed` | Not from inside the same mutation. `#mutate` (`lib/consumer-fanout.js:339-356`) calls `durableWriteJson` only **after** `fn()` returns (`:352-353`); a throw inside the callback reaches the `finally` at `:355`, which releases the writer lock and writes nothing. The failure note would be lost exactly when it matters most | **R2-2 ruling 7.** A separate, guarded mutation **after** the failed restore returns: `state: 'rollback_failed'` plus `failureCode` and `failure`, in its own `#mutate` so the first one's throw cannot take it down with it |
| C41 | S04's terminal write is identity-guarded | The guard covers only the `active-build.json` write. The **vision kill** runs before it (`lib/build.js:5829-5835`) and the actuals after, so a stale aborter kills a live build's vision item and emits its actuals even when it then declines to write the record. And the guard's `!cur?.flowId \| !active.flowId` disjunction lets a **missing** flow id match anything | **R2-2 ruling 8.** One identity **claim**, re-read before **any** mutation and covering vision, state and actuals as a unit, with strict matching: flow id when both sides have one, otherwise `pid` **and** `startedAt` must both be equal — never "missing matches anything". A mismatch returns `{ok:false, reason:'ownership_lost'}` having written nothing. §3.7 has the shape |
| C42 | C30's resume handling is covered by adding `cancelled` to `isTerminalFlow` | That makes `flowTerminal` true, and `decideBuildStart` then falls into `if (!active \| !flowId \| flowTerminal)` (`lib/build.js:1832-1836`) and returns **`fresh`** — so a cancelled run silently starts a brand-new build instead of telling the user what became of the old one. Terminality is necessary; it is not the behaviour | **R2-2 ruling 9.** An explicit audited-`cancelled` branch in the resume probe (`lib/build.js:2772-2805`): write the local record `aborted` with `failureReason: 'flow_cancelled'` under the identity claim (this process is the driver, so it is the rightful writer), refuse with a named reason, and do **not** fall through to a fresh plan |
| C43 | S07-2's marker file proves no merge happened after the cancel | The marker is never captured. The fake agent sleeps until it is killed, so its `runAndNormalize` rejects, the item never reaches `prepareIssuance` (`lib/build.js:1068`, `lib/consumer-fanout.js:742-810`), and no diff is journaled — the assertion would pass against a build that merged nothing for the ordinary reason. Step 7 also still cited a `CANCELLATION_*` error at step 4, which C32 had already corrected to a resolved success | **R2-2 ruling 10.** Two lanes in the fanout. **Lane A** completes normally and writes its marker, so a real captured diff exists in the journal. **Lane B** sleeps. The abort lands during lane B. Assert lane A's marker is **absent** from the target tree (the baseline was restored) and that the journal records `rollbackReason: 'cancelled'`. Step 7's wording is corrected |
| C44 | `transport_derived` can be journaled as written | The dispatch ledger is **default-deny**: `if (!allowed.has(field)) invalid(...)` (`lib/dispatch-ledger.js:120-124`), with the allow-list built from `EVENT_FIELDS.dispatch` (`:55-62`). An unknown field throws — and `#recordAgentDispatch` swallows it (`lib/stratum-mcp-client.js:234-237`, "Dispatch capture is fail-open by contract"), so adding the field naively **silently drops the whole dispatch event**, losing its usage record too. Separately my S03 text overstated the gate fixer: it dispatches through `runAndNormalize` (`lib/result-normalizer.js:581-586`, `:747-751`), so it already sends a signal and a `cancellationId` and its transport does not change | **R2-2 ruling 11.** Add `transport_derived` to `EVENT_FIELDS.dispatch.optional` **and** to the `case 'dispatch'` validator (`lib/dispatch-ledger.js:132-148`) as an optional nullable string, in the same commit that populates it; assert the **persisted** row, not merely the call. S03's gate-fixer claim is corrected to name the gate Q&A agent as the only dispatch whose behaviour changes |
| C45 | The S05-4 and S06-2 code sketches implement §3.6's handshake | They contradict it. S06-2 still shows `void runCancelTeardown(...)` — fire-and-forget, never assigning `buildCancel.teardown`, so the outer catch has nothing to see and stands down for nobody. `runCancelTeardown`'s own sketch never awaits `drained`, and it lists `emitActuals` among its duties while `finalizeBuildAttempt` (`lib/build.js:2295-2301`) already emits them from the inner finally — two emitters for one accumulator | **R3 ruling 1.** Every sketch in S04, S05 and S06 is rewritten to match §3.6 and §3.7 exactly, because a reviewer implements from the sketch, not from the prose above it. `finalizeBuildAttempt` is the **only** actuals emitter, and it stays where it is: it is already idempotent through `attemptFinalized` (`:2296`) |
| C46 | The outermost join bound of 5000 ms is enough to let a teardown finish | It is shorter than the teardown's own worst case: `flowCancel` may take `COMPOSE_CANCEL_TIMEOUT_MS` (15000) and the `drained` wait a further `COMPOSE_TEARDOWN_DRAIN_MS` (10000). The join would expire first, `runBuild` would return, and the CLI's `.catch` would `process.exit(1)` (`bin/compose.js:2860-2861`) straight through a teardown that had not yet written the record | **R3 ruling 2.** The join bound is **derived, not chosen**: `COMPOSE_CANCEL_TIMEOUT_MS + COMPOSE_TEARDOWN_DRAIN_MS + 1000`. And the CLI itself awaits a pending teardown before exiting, through a `pendingTeardown()` accessor exported from `lib/build-cancel.js`, so the last exit path is closed too |
| C47 | The post-apply fence's sketch throws the class the prose specifies | The prose says `MergeAfterCancelError`; the sketch two paragraphs below still throws `ConsumerMergeDecisionError('MERGE_AFTER_CANCEL', ...)` — the exact class `lib/build.js:4223-4240` catches into `repairFor`, which is what C39 exists to prevent | **R3 ruling 3.** The sketch throws `MergeAfterCancelError`, and both fences sit outside that `try`, as the prose already said |
| C48 | §3.7's `claimActiveBuild` fallback is strict | Its fallback compares `cur.pid === active.pid && cur.startedAt === active.startedAt` **without checking either is present**, so two records that both lack a `pid` and a `startedAt` compare equal via `undefined === undefined` — the same "missing matches anything" defect C41 was written to remove, moved one level down. And S04's write sketch still carries the original `!cur?.flowId \| !active.flowId` disjunction | **R3 ruling 4.** The fallback validates **presence** before equality: both `pid` and `startedAt` must exist on both records, else the claim refuses with `ownership_unverifiable`. S04's write sketch drops the disjunction and calls `claimActiveBuild` |
| C49 | The audited-cancelled resume branch may write the local record because "this process is the driver" | Not in the compose server. `server/build-routes.js:130-134` runs `runBuild` inside the express process, so the resume probe can execute while a **different** in-process build owns that record — the same premise C22 already demolished for `abortBuild`, left standing here | **R3 ruling 5.** The branch consults `activeBuildCancels` first: when a handle exists, hand the write to it (`handle.cancel('flow_cancelled')`) and refuse the resume without writing; write locally only when there is no handle **and** the identity claim succeeds |
| C50 | S07-2's two lanes prove the post-apply reversal | They cannot reach it. A consumer fanout settles only when **every** item is terminal (`stratum/ts/src/engine/engine.ts:2076`), and the merge runs only after the gate is ready (`lib/build.js:4219`). Lane B is killed mid-flight, so the fanout never settles, the gate is never reached, and no merge transaction is ever created — the `rollbackReason: 'cancelled'` assertion is unreachable by construction | **R3 ruling 6.** The child golden asserts what a **mid-fanout** abort can actually prove, and the reversal path moves to a unit test that can inject the race directly. Lane A stays: it is what proves the captured diff is **kept as evidence and not merged**, which is the real invariant |
| C51 | `transport_derived` reaches the dispatch ledger row | It cannot. `#recordAgentDispatch` builds the event from the **caller's** `opts` (`lib/stratum-mcp-client.js:194-196`), while the `cancellationId` that determines the transport is minted later and locally, inside `#invokeAgentRun` (`:272`). The event builder never sees it. Separately, the preflight cancel has no end-to-end assertion — its controller is its own (`lib/codex-preflight.js:127`) | **R3 ruling 7.** The derived fact is computed where the `cancellationId` is minted and passed forward to the dispatch record, so the event carries it; the test asserts a **persisted row from a real tagged dispatch through the client**, not a hand-built event. `preflightCodexWorktreeProbe` takes a `signal` and chains it into its own controller, pinned by a never-settling probe that a cancel must reject |

### Slice ordering constraint (from C21)

The slices are independently committable, but they are **not** independently releasable in the
listed order. Between S03 and S06 there is a real regression: S03 detaches every tagged agent
out of compose's process group, and S06 is what replaces the group-delivered Ctrl-C kill that
detachment removes. Ship S03 without S06 and a Ctrl-C leaves tagged agents orphaned where today
they die.

**Recommendation: land S06 before S03, or push them together.** S06 has no dependency on S03 —
its teardown calls `flowCancel` (S02) and `createBuildCancel`, and both exist without any
tagging — so the swap costs nothing. This is flagged rather than applied unilaterally, because
the slice numbering is the lead's; if the numbers must hold, the constraint is that S03's commit
must not reach a release without S06's.

---

## 3. Contracts

No new file under `contracts/`. That directory holds JSON Schemas for two things only: **agent
output contracts** the model must satisfy (`contracts/review-result.json:3-9`,
`task-result.json`, `goal-result.json`) and **persisted document schemas** loaded by validators
(`contracts/feature-json.schema.json`, read at `lib/feature-validator.js:71`). Everything below
is an in-process JavaScript return shape crossing no model and no disk, so it lives here in
prose and is pinned by tests, not by a schema file.

### 3.1 `StratumMcpClient.flowCancel(runId)` — resolved value

```js
// Resolves ONLY on a success envelope. Two success shapes exist and they mean
// different things; `flowSettled` is the discriminator, never `acknowledged`.
{
  runId: string,
  status: 'cancelled' | 'completed' | 'failed' | 'budget_exhausted',
  flowSettled: boolean,      // true  => the run is durably `cancelled`
  acknowledged: boolean,     // true  => every claimed agent group reached a resolved state
  reason?: string,           // 'already_cancelled' | 'already_completed' | 'already_failed' | ...
  ledger: { spent: object, budget?: object },
  agents: {
    signalled: number, reaped: number, gone: number, unreachable: number,
    alreadySettled: number, unresolved: number, unsettled: number, unreaped: number,
  },
}
```

Two success cases, both delivered as a resolved promise:

- a fresh cancel: `flowSettled: true`, `acknowledged: true`, `status: 'cancelled'`;
- an already-terminal run: `acknowledged: false` with `reason: 'already_<status>'`.
  `already_cancelled` carries `flowSettled: true` and **does** re-sweep the agents;
  `already_completed` / `already_failed` / `already_budget_exhausted` carry
  `flowSettled: false` and sweep nothing (`stratum/ts/src/engine/engine.ts:1167-1175`).

An incomplete sweep is **thrown, not returned** (`stratum/ts/src/engine/flow_cancel.ts` raises;
the dispatcher converts at `stratum/ts/src/mcp/server.ts:477-494`). So no caller may read
`acknowledged === false` off a resolved value and expect to see failures there.

### 3.2 `flowCancel()`'s thrown `StratumError`

```js
error instanceof StratumError
error.name        === 'StratumError'
error.code        === 'CANCELLATION_UNCONFIRMED' | 'CANCELLATION_TEARDOWN_TIMEOUT'
error.status      // engine run status as READ, not assumed: 'running' | 'cancelled' | ...
error.flowSettled // boolean — THE discriminator for "did the build stop"
error.reason      // 'run_lock_held' | 'engine_dispatch_active' | 'local_teardown_timeout' | undefined
error.holderPid   // number | undefined
error.agents      // the eight-counter summary above
error.rpcCode     // numeric JSON-RPC code, preserved by #callTool (lib/stratum-mcp-client.js:540)
```

`code` arrives already correct because `#callTool` copies `error.data.code` onto `error.code`
(`lib/stratum-mcp-client.js:541-544`); the other five fields must be lifted off `error.data` by
`flowCancel` itself (C5). The two codes mean **opposite things about whether the build stopped**:
`CANCELLATION_TEARDOWN_TIMEOUT` always carries `flowSettled: true` (settle happened, a group
outlived the deadline), while `CANCELLATION_UNCONFIRMED` may carry either.

Two further shapes are normalised by `flowCancel()` so that **every** rejection it can produce
is one of a closed set, and S04's outcome table is total:

- **Unknown runId** (C4, C28) → `StratumError('FLOW_NOT_FOUND')`, `flowSettled: false`,
  `reason: 'flow_not_found'`, `agents: null`. This means *the run was never found*, **not**
  *nothing is running*: the ENOENT is raised before any sweep is attempted
  (`stratum/ts/src/engine/flow_cancel.ts:126-141`), so any agents are untouched.
- **Anything else** — a dead transport, a failed connect, a broken pipe (C29) →
  `StratumError('CANCELLATION_UNCONFIRMED')` with `reason: 'transport'`, `flowSettled: false`,
  `status: null`, `agents` zeroed. It is a refusal, and a refusal sweeps nothing.

So `flowCancel` rejects with exactly four codes: the two `CANCELLATION_*`, `FLOW_NOT_FOUND`, or
nothing else. A future fifth would fall into the `transport` bucket rather than escaping.

### 3.3 `abortBuild()`'s return value

```js
{
  ok: boolean,             // compose durably stopped this build AND wrote terminal state
  flowId: string | null,
  status: string | null,   // engine status as reported
  flowSettled: boolean,
  acknowledged: boolean,
  code: string | null,     // CANCELLATION_* on a refusal, FLOW_NOT_FOUND, else null
  reason: string | null,
  holderPid: number | null,
  agents: object | null,
  attempts: number,        // flowCancel calls made (1..1+COMPOSE_ABORT_RETRIES, or 2 on re-sweep)
  driverMode: 'in-process' | 'foreign-pid' | 'none',  // how the driver was reached (C22)
  driverSignalled: boolean,// SIGTERM delivered to a FOREIGN driver pid; never to process.pid
  driverExited: boolean,   // the live driver settled within COMPOSE_ABORT_DRIVER_WAIT_MS (C23)
  terminalWriter: 'driver' | 'abort' | 'none',        // who owns the terminal record (C23)
  localCleanup: boolean,   // vision killed + active-build 'aborted' + actuals emitted
}
```

`driverMode` is `'in-process'` when `lookupBuildCancel(active.flowId)` hits, `'foreign-pid'`
when a recorded pid that is not `process.pid` is alive, and `'none'` otherwise.
`terminalWriter` is `'driver'` whenever a live driver was found and settled — `abortBuild` then
writes nothing and reports what the driver wrote.

`ok: false` implies `localCleanup: false` and `driverSignalled: false`. The refusal reasons are
a closed set: `no_active_build` and `feature_mismatch` (today's two, `lib/build.js:5800-5809`,
keeping their console lines), `already_<status>` for an already-terminal record (C31),
`flow_not_found` (C28), `run_lock_held`, `engine_dispatch_active` and `transport` (C29). The
HTTP route already forwards whatever comes back (`server/build-routes.js:151-152`,
`res.json(result ?? {ok:true})`).

### 3.4 The build-level cancel handle

One symbol, created once per `runBuild`, named `buildCancel`, produced by
`createBuildCancel()` in the new `lib/build-cancel.js`:

```js
export function createBuildCancel() {
  const controller = new AbortController();
  // TWO independent states (C27). `cancelled` is set by anyone — the signal handler, the
  // cross-process detector, or a same-process abortBuild. `teardownStarted` is set ONLY by
  // runCancelTeardown. Collapsing them makes the FIRST Ctrl-C after a detected cross-process
  // cancel take the second-signal branch and skip the teardown entirely.
  const state = { cancelled: false, reason: null, at: null, teardownStarted: false };
  return {
    signal: controller.signal,                 // -> runAndNormalize opts.buildSignal (C13)
    get cancelled() { return state.cancelled; },
    get reason() { return state.reason; },
    get at() { return state.at; },
    get teardownStarted() { return state.teardownStarted; },
    /** Idempotent. Returns true only for the FIRST caller. */
    cancel(reason) {
      if (state.cancelled) return false;
      state.cancelled = true;
      state.reason = reason;
      state.at = new Date().toISOString();
      controller.abort(new Error(`build cancelled: ${reason}`));
      return true;
    },
    /** Returns true only for the FIRST teardown, which is what forces a second signal to exit. */
    beginTeardown() {
      if (state.teardownStarted) return false;
      state.teardownStarted = true;
      return true;
    },
    // C37/§3.6. `teardown` is set synchronously by runCancelTeardown before its first await, so
    // the outer catch can see it and stand down. `drained` is resolved by the build's inner
    // finally once its resources are closed, so the teardown's writes cannot race
    // finalizeBuildAttempt. Both are plain promises; both waits on them are bounded.
    teardown: null,
    drained: drained.promise,
    resolveDrained: drained.resolve,
  };
}
```

`drained` is a plain deferred (`Promise.withResolvers()`, or a two-line equivalent) created
alongside the controller.

`buildCancel.signal` is the D-F chain. `buildCancel.cancelled` is the D-D flag the merge guard
reads. `teardownStarted` is what the signal handler's force-exit branch keys on.

### 3.5 The in-process build registry

`abortBuild` is **not** always a separate process (C22): `server/build-routes.js:134` and `:151`
run `runBuild` and `abortBuild` in one express process. So the handle must be reachable by flow
id from inside the same process, and that is the only way an HTTP abort can reach the build's
local agents at all.

```js
/** flowId -> BuildCancel, for builds running in THIS process. A same-process abort must
 *  cancel through the handle, never by signalling a pid: on the HTTP path that pid is the
 *  compose server itself (server/build-routes.js:134 and :151). */
const activeBuildCancels = new Map();
export function registerBuildCancel(flowId, handle) { if (flowId) activeBuildCancels.set(flowId, handle); }
export function unregisterBuildCancel(flowId) { if (flowId) activeBuildCancels.delete(flowId); }
export function lookupBuildCancel(flowId) { return (flowId && activeBuildCancels.get(flowId)) ?? null; }
```

`runBuild` registers **the moment `response.runId` exists** — inside `startFresh` (beside the
`writeActiveBuild` at `lib/build.js:5570`) and in the resume branch (`:2805`) — and unregisters
in its existing `finally` (`lib/build.js:4975-4995`). Registering later, at the `context.flowId`
assignment (`:3022`), would leave a window of up to three minutes in which `active-build.json`
already advertises a flow id and a pid while no handle exists, because the Codex worktree
preflight sits between them (`:2917`, budget `PROBE_AGENT_TIMEOUT_MS = 180_000` at
`lib/codex-preflight.js:33`). An abort in that window would take the foreign-pid branch and
SIGTERM the compose server (C36). `preflightCodexWorktreeProbe` gains a `signal` parameter that
its own controller (`lib/codex-preflight.js:127`) treats as a second abort source alongside its
180s timer, so an abort during the probe stops it — pinned end-to-end by a never-settling probe
that a cancel must reject (C51), not merely by reading the wiring. The map is module-level and therefore per-process, which
is exactly its scope: a foreign build is unreachable through it by construction, and that
absence is the signal that the pid path applies.

### 3.6 The teardown handshake (C37, R2-2 ruling 4)

Three parties can terminalize a cancelled build: `runCancelTeardown`, the outer catch
(`lib/build.js:4931-4971`) and the build's inner `finally` (`:4955-4974`). Fire-and-forget plus
an unconditional outer catch means all three can run at once. The division below gives each
exactly one job.

**One promise on the handle.** `buildCancel.teardown` is `null` until `runCancelTeardown` sets
it — synchronously, before its first `await`, so any later reader sees it.

**One extra promise for draining.** `buildCancel.drained` is resolved by the build's inner
`finally` once its resources are closed. The teardown waits for it so its writes cannot race
`finalizeBuildAttempt`.

| Party | Does | Does NOT |
|---|---|---|
| `runCancelTeardown` | `flowCancel` (bounded by `COMPOSE_CANCEL_TIMEOUT_MS`, 15000); await `drained` (bounded by `COMPOSE_TEARDOWN_DRAIN_MS`, default 10000); vision kill; `active-build.json` `aborted`; remove the signal listeners; **call `process.exit`** | **emit actuals** — `finalizeBuildAttempt` (`lib/build.js:2295-2301`) is the one emitter and is already idempotent via `attemptFinalized` (`:2296`); await the pump |
| outer catch | see a pending `buildCancel.teardown`, set `buildStatus = 'aborted'`, **skip its own terminalization**, rethrow immediately | await the teardown (that would deadlock); write the terminal record |
| inner `finally` | its existing resource closes and `finalizeBuildAttempt()` (already idempotent via `attemptFinalized`); then resolve `drained` | remove the signal listeners while a teardown is pending; call `process.exit` |
| outermost `finally` | `await` the teardown, bounded by `COMPOSE_CANCEL_TIMEOUT_MS + COMPOSE_TEARDOWN_DRAIN_MS + 1000` — **derived, never a chosen constant**, because any smaller bound expires before the teardown's own worst case and hands the exit back to the CLI (C46) | anything else |
| the CLI | `await pendingTeardown()` before `process.exit`, in all three `.then`/`.catch` pairs (`bin/compose.js:2860-2861`, `:2977-2978`, `:3088-3089`) | exit while a teardown is pending |

```js
  // signal handler — sets the promise synchronously, never awaits it
  signalHandler = (signal) => {
    if (buildCancel.teardownStarted) { process.exit(signal === 'SIGINT' ? 130 : 143); return; }
    buildStatus = 'aborted';
    buildCancel.teardown = runCancelTeardown({ buildCancel, signal, flowId: response?.runId, /* ... */ });
  };
```

**Why it cannot deadlock.** The only wait-for edges are: teardown → `drained`, and outermost
finally → teardown. `drained` is resolved by the inner finally, which runs after the outer catch
rethrows — and the outer catch waits for nothing. So the chain is a line, not a cycle:
outer catch → inner finally → `drained` → teardown → `exit`. The outermost finally joins at the
end. Both waits are bounded, so a wedged pump (which never reaches the inner finally) simply
means the teardown proceeds on its deadline and writes anyway, which is D-E's "must not await
the pump" requirement expressed as a number.

**Why the teardown, not the catch, calls `exit`.** It is the last party in the chain, so it is
the only one that can know the resources are closed and the record is written. An `exit` from
the catch would truncate the inner finally; an `exit` from the CLI would race the teardown,
which is what the outermost bound prevents.

### 3.7 The abort's identity claim (C41, R2-2 ruling 8)

`abortBuild` reads `active` at its start and then does several awaits — `connect`, `flowCancel`,
retries, the driver wait — during which the driver may legitimately rewrite the record. Every
mutation must therefore sit behind **one** claim, taken immediately before the first of them and
covering the vision kill, the state write and the actuals as a unit.

```js
/** Re-read and CLAIM before ANY mutation. Strict on purpose: a missing flow id must never
 *  match anything, which is what `!cur?.flowId || !active.flowId` did — that reads "if either
 *  side lacks an id, call it the same build".
 *
 *  Returns the claimed record, or a REASON. C48: the fallback validates PRESENCE before
 *  equality, because `undefined === undefined` is true and two records that both lack a pid
 *  would otherwise claim each other — the same defect one level down. */
function claimActiveBuild(dataDir, active) {
  const cur = readActiveBuild(dataDir);
  if (!cur) return { ok: false, reason: 'ownership_lost' };
  if (cur.featureCode !== active.featureCode) return { ok: false, reason: 'ownership_lost' };
  if (cur.flowId && active.flowId) {
    return cur.flowId === active.flowId
      ? { ok: true, record: cur }
      : { ok: false, reason: 'ownership_lost' };
  }
  // No flow id on one side: fall back to pid + startedAt, but ONLY when all four are present.
  const present = Boolean(cur.pid) && Boolean(active.pid)
    && Boolean(cur.startedAt) && Boolean(active.startedAt);
  if (!present) return { ok: false, reason: 'ownership_unverifiable' };
  return (cur.pid === active.pid && cur.startedAt === active.startedAt)
    ? { ok: true, record: cur }
    : { ok: false, reason: 'ownership_lost' };
}
```

`abortBuild` calls it once, at the top of step 6, and on `ok: false` returns
`{ok: false, reason}` — either `ownership_lost` or `ownership_unverifiable` — having written
nothing at all: no vision kill, no state write, no actuals. Refusing an unverifiable claim is
deliberate: a record with neither a flow id nor a pid cannot be shown to be this build, and
guessing is what C41 and C48 both punish. The same helper guards the driver-side writes in S05-4
and the resume refusal in C42/C49, so there is one definition of "still my build" rather than
three hand-rolled disjunctions.

---

## 4. Slice S01 — version train and version guard (D-B)

Smallest and first, because every later slice's tests run against a client whose guard message
and fixture schemas must already name the new floor.

### S01-1 `lib/stratum-mcp-client.js` (existing)

Add two exported constants above `buildAgentRunRequest` (`:160`) and interpolate them into the
one guard message at `:286-288`:

```js
/** The stratum MCP surface version compose's request vocabulary requires.
 *  Pinned in stratum at ts/contracts/mcp-surface.json ("surface": 19) and asserted by
 *  ts/tests/mcp/contracts-grammar.test.ts. Bump this and the package floor together. */
export const REQUIRED_STRATUM_SURFACE = 19;
export const REQUIRED_STRATUM_RANGE = '>=0.5.0';
```

```js
        throw new StratumError('UNSUPPORTED_AGENT_OPTIONS',
          `Installed Stratum ${installed} does not support ${missing.join(', ')} required by this call; `
          + `required execution surface: ${REQUIRED_STRATUM_SURFACE} `
          + `(@smartmemory/stratum ${REQUIRED_STRATUM_RANGE}).`, '');
```

### S01-2 The version train (one commit)

Five sites, all to `0.5.0`, plus the stratum range:

| File | Line | From | To |
|---|---|---|---|
| `package.json` | `:3` | `0.4.2` | `0.5.0` |
| `package.json` | `:91` | `"@smartmemory/stratum": "^0.4.5"` | `"^0.5.0"` |
| `compose-mcp/package.json` | `:3` | `0.4.2` | `0.5.0` |
| `compose-mcp/package.json` | `:11` | `"@smartmemory/compose": "^0.4.2"` | `"^0.5.0"` |
| `compose-mcp/server.json` | `:6` | `0.4.2` | `0.5.0` |
| `compose-mcp/server.json` | `:11` | `0.4.2` | `0.5.0` |

`test/version-sync.test.js` is the control: its four assertions (`:32`, `:40-44`, `:47-52`,
`:54-63`) already encode both constraints, and `minorOf` (`:26-30`) is what forces compose to
`0.5.x` the moment the stratum range moves. The `node_modules/@smartmemory/stratum` symlink to
`../stratum/ts` is the documented local dev setup — do not touch it.

### S01-3 Fixture schemas (existing tests)

- `test/review-fixes-runtime.test.js:25` — append `'flow'` to the modern field list. The `old`
  branch (`['agent','prompt','cwd']`) is unchanged.
- `test/review-fixes-runtime.test.js:73` — build the regex from the imported constants instead
  of the literals `surface: 17` and `0.4.0`.
- `test/execution-runtime.test.js:163-164` — unchanged as a fixture (it is deliberately an old
  server), but its surrounding assertion at `:178` must keep passing once `flow` is a requested
  key; see S02-4.

### Acceptance criteria

- [ ] `REQUIRED_STRATUM_SURFACE` and `REQUIRED_STRATUM_RANGE` are exported from `lib/stratum-mcp-client.js` and are the only source of the guard message's surface/floor text (pinned by test/stratum-surface-guard.test.js)
- [ ] `grep -c 'surface: 17' lib/ test/` returns 0
- [ ] All six version strings read `0.5.0` and the stratum dep range reads `^0.5.0`
- [ ] `node --test test/version-sync.test.js` passes with no edit to that file
- [ ] `test/review-fixes-runtime.test.js` derives its expected surface/floor from the imported constants and contains no version literal for them (pinned by test/stratum-surface-guard.test.js)
- [ ] A server advertising no `flow` property yields `UNSUPPORTED_AGENT_OPTIONS` whose message names surface 19 and `>=0.5.0`, both derived from the constants (pinned by test/stratum-surface-guard.test.js)

### Tests

`test/stratum-surface-guard.test.js` (new). Two cases, both importing the constants:

1. a stdio fixture server advertising the 0.4-era field list receives a call carrying `flow`,
   and the rejection's message is asserted against a regex **built from**
   `REQUIRED_STRATUM_SURFACE` / `REQUIRED_STRATUM_RANGE`;
2. a source-level assertion that neither constant's value appears as a literal in
   `test/review-fixes-runtime.test.js` — the receipt that the derive-never-hardcode rule holds.

Existing suites touched: `test/review-fixes-runtime.test.js` (fixture + regex),
`test/version-sync.test.js` (run, not edited).

### CHANGELOG

```
- **COMP-BUILD-CANCEL S01**: version train to `0.5.0` (compose, compose-mcp, server.json) with
  `@smartmemory/stratum ^0.5.0`, and the agent-run version guard now names the real floor —
  execution surface 19, `@smartmemory/stratum >=0.5.0` — from `REQUIRED_STRATUM_SURFACE` /
  `REQUIRED_STRATUM_RANGE` rather than a literal buried in a template string.
```

---

## 5. Slice S02 — the client: `flow`, an unconditional `cancellationId`, and `flowCancel()` (D-A client half, D-C client half)

### S02-1 `buildAgentRunRequest` gains `flow` — `lib/stratum-mcp-client.js:160-174` (existing)

One more conditional key, last, matching the style of the ten already there:

```js
    ...(opts.cancellationId !== undefined ? { cancellationId: opts.cancellationId } : {}),
    ...(opts.flow !== undefined ? { flow: opts.flow } : {}),
```

The server validates `flow`'s shape default-deny (`assertToolRequest`), so compose must emit
exactly `{runId, stepId?, itemIndex?}` and nothing else. `stepId` and `itemIndex` are validated
against nothing and copied verbatim into the registry record
(`stratum/ts/src/mcp/server.ts:200-205`) — informational, but pass real values so the registry
and the audit agree about which item a swept group belonged to.

### S02-2 Mint `cancellationId` whenever `flow` is set — `lib/stratum-mcp-client.js:272` (existing)

```js
    // `flow` REQUIRES a cancellationId server-side (stratum/ts/src/mcp/server.ts:182-186):
    // without an owned process group there is nothing for a cross-process cancel to kill.
    // Minting one without a signal is inert locally — the abort path below is armed only by
    // `signal` — but it is what makes the run reachable from another process at all.
    const cancellationId = opts.cancellationId ?? ((signal || opts.flow) ? randomUUID() : undefined);
```

The UUID must be fresh per call: the server refuses a reused one
(`stratum/ts/src/mcp/server.ts:195`). `randomUUID()` per invocation already satisfies that;
what must not happen is a caller threading one `cancellationId` through a retry.

### S02-3 `flowCancel(runId)` — `lib/stratum-mcp-client.js` (existing, new method beside `cancelAgentRun` at `:878`)

```js
  /**
   * Cancel a running FOREGROUND flow by flow id (stratum >= 0.5.0). Settles the run and
   * sweeps the agent groups stratum spawned for it. Resolves on success (including an
   * already-terminal run); throws a StratumError on an incomplete sweep or a refusal.
   */
  async flowCancel(runId) {
    try {
      return await this.#callTool('stratum_flow_cancel', { runId });
    } catch (error) {
      const data = (error && typeof error.data === 'object' && error.data) || {};
      if (error?.code === 'CANCELLATION_UNCONFIRMED' || error?.code === 'CANCELLATION_TEARDOWN_TIMEOUT') {
        const wrapped = new StratumError(error.code, error.message, '');
        wrapped.status = data.status ?? null;
        wrapped.flowSettled = data.flowSettled === true;
        wrapped.reason = data.reason ?? null;
        wrapped.holderPid = data.holderPid ?? null;
        wrapped.agents = data.agents ?? null;
        if (error.rpcCode !== undefined) wrapped.rpcCode = error.rpcCode;
        throw wrapped;
      }
      if (isUnknownFlowError(error)) {
        const missing = new StratumError('FLOW_NOT_FOUND', `Stratum has no run ${runId}: ${error.message}`, '');
        missing.status = null; missing.flowSettled = false; missing.reason = 'flow_not_found';
        missing.holderPid = null; missing.agents = null;
        throw missing;
      }
      // C38: NORMALISE, never rethrow. A dead server, a broken pipe or an undeclared engine
      // error must still land in abortBuild's outcome table, and a refusal sweeps nothing —
      // so flowSettled is false and the counters are zero, which is the literal truth.
      throw asTransportRefusal(error);
    }
  }
```

```js
/** The one shape every unclassifiable cancel failure takes. Exported because abortBuild wraps
 *  its own connect() in it: connect happens OUTSIDE flowCancel, so a spawn or handshake failure
 *  would otherwise bypass the table entirely (C38). */
export function asTransportRefusal(error) {
  const refusal = new StratumError('CANCELLATION_UNCONFIRMED',
    `Stratum cancel could not be attempted: ${error?.message ?? String(error)}`, '');
  refusal.status = null; refusal.flowSettled = false; refusal.reason = 'transport';
  refusal.holderPid = null; refusal.agents = ZERO_AGENTS;
  return refusal;
}
```

`isUnknownFlowError` is a module-level predicate in the same file, written against the shape
stratum's own test already pins (C4, `stratum/ts/tests/mcp/flow_cancel_edges.test.ts:36-60`):

```js
/** An unknown run id has NO structured envelope on the MCP surface — the SDK wraps the raw
 *  ENOENT as a generic InternalError with no `data` at all. Both halves are required: `data`
 *  absent AND an ENOENT-shaped message. Over-matching here turns a LIVE build into "nothing to
 *  cancel", which is the one misclassification on this surface that loses work. */
function isUnknownFlowError(error) {
  if (!error || error.data !== undefined) return false;
  if (typeof error.code === 'string') return false;   // a coded failure is never this path
  return /ENOENT|no such run|not found/i.test(String(error.message ?? ''));
}
```

The `typeof error.code === 'string'` guard is what keeps a `CANCELLATION_*` error out: those
always arrive with both a string `code` and a populated `data` (§3.2).

### S02-4 The old-server interaction

Once `flow` is a requested key, `#agentFields` refuses it against any server below 0.5.0
(`lib/stratum-mcp-client.js:283-289`) — by design. The existing old-server test at
`test/execution-runtime.test.js:176-178` calls `runAndNormalize` with a plain `stepDispatch`
carrying no `flow_id`, so no tag is produced and its assertion (`/does not support.*allowedTools/`)
still describes the first missing key. Verify, do not assume: the assertion is `assert.rejects`
on a regex, and `missing.join(', ')` is ordered by `Object.keys(request)`, where `flow` is last.

### Acceptance criteria

- [ ] `buildAgentRunRequest` emits `flow` when and only when `opts.flow !== undefined`, positioned last (pinned by test/stratum-flow-cancel-client.test.js)
- [ ] A `cancellationId` is minted when `opts.flow` is set and no signal is passed (pinned by test/stratum-flow-cancel-client.test.js)
- [ ] Two calls with `flow` set produce two different `cancellationId`s (pinned by test/stratum-flow-cancel-client.test.js)
- [ ] `flowCancel(runId)` calls `stratum_flow_cancel` with exactly `{runId}` (pinned by test/stratum-flow-cancel-client.test.js)
- [ ] A `flow_cancel_unacknowledged` envelope becomes a `StratumError` whose `code` is `data.code` and which carries `status`, `flowSettled`, `reason`, `holderPid`, `agents` as own properties (pinned by test/stratum-flow-cancel-client.test.js)
- [ ] A resolved `flowCancel` returns the response unmodified, including `status` and the eight-counter `agents` (pinned by test/stratum-flow-cancel-client.test.js)
- [ ] `isUnknownFlowError` matches an `McpError` with absent `data` and an ENOENT-shaped message, and does NOT match a `CANCELLATION_*` error, a transport error, or a generic `InternalError` with an unrelated message (pinned by test/stratum-flow-cancel-client.test.js)
- [ ] `test/execution-runtime.test.js` still passes unedited

### Tests

`test/stratum-flow-cancel-client.test.js` (new), against an injected `_testClient` (the seam at
`lib/stratum-mcp-client.js:520-523`) plus a table over the error shapes: both `CANCELLATION_*`
codes with and without `holderPid`, an `ENOENT`-shaped unknown-run rejection, a transport
rejection with no `data`, and an already-terminal success envelope.

### CHANGELOG

```
- **COMP-BUILD-CANCEL S02**: `stratum_agent_run` requests can carry `flow: {runId, stepId?,
  itemIndex?}`, a `cancellationId` is minted whenever `flow` is set (stratum refuses `flow`
  without one), and a new `StratumMcpClient.flowCancel(runId)` calls `stratum_flow_cancel`,
  unwrapping the `flow_cancel_unacknowledged` envelope into a `StratumError` carrying
  `flowSettled`, `reason`, `holderPid` and the agent-sweep counters.
```

---

## 6. Slice S03 — driver tagging and the build-level abort chain (D-A build half, D-F)

### S03-1 `lib/build-cancel.js` (new)

Holds `createBuildCancel` (§3.4), `isRunCancelled`, `looksCancelled` and `runCancelTeardown`
(the last two land in S05 and S06 respectively; the file is created here because S03 is the
first slice that needs a symbol from it). Extracting them keeps `lib/build.js` from growing and
makes the teardown unit-testable with fakes, as D-G requires.

```js
/** The AUTHORITY on "was this run cancelled". stratum_audit succeeds on a cancelled run
 *  (stratum/ts/src/engine/engine.ts:1057-1061), unlike stepDone/gateResolve/resume, which
 *  refuse. Returns false on any audit failure: an unreachable engine is not evidence of a
 *  cancel, and treating it as one would abandon a live build. */
export async function isRunCancelled(stratum, flowId) {
  if (!stratum || !flowId) return false;
  try {
    const audit = await stratum.audit(flowId);
    return audit?.status === 'cancelled';
  } catch {
    return false;
  }
}
```

### S03-2 `opts.buildSignal` on `runAndNormalize` — `lib/result-normalizer.js` (existing)

Immediately after `stopRun` is declared (`:433-434`):

```js
  // D-F: the build-level cancel handle. One hook covers BOTH dispatch branches, because both
  // hang off this single controller — the local SDK agent (:567, via opts.abortController) and
  // the two MCP dispatches (:583, :749, via abortController.signal).
  const buildSignal = opts.buildSignal ?? null;
  if (buildSignal?.aborted) stopRun();
  else buildSignal?.addEventListener('abort', stopRun, { once: true });
```

and a matching `buildSignal?.removeEventListener('abort', stopRun)` in the function's existing
teardown path, so a long build does not accumulate listeners across hundreds of dispatches.

`executionOptions` (`:367-377`) is **not** touched (C13).

### S03-3 `opts.flow` on `runAndNormalize` — `lib/result-normalizer.js` (existing)

The tag is supplied by the call site, never inferred. `runAndNormalize` forwards it into the MCP
options at `:582-589` and at the review-repair dispatch `:747-751`:

```js
        runResult = await stratum.agentRun(agentType, actualPrompt, {
          ...executionOptions,
          signal: abortController.signal,
          ...(opts.flow ? { flow: opts.flow } : {}),
          correlationId,
          telemetry:        primaryTelemetry,
        });
```

The local branch ignores it: an `isolation: none` agent never reaches stratum
(explore-compose §4), which is exactly why D-F exists.

**Why opt-in and not inferred from `stepDispatch.flow_id`.** `flow_id` is present on the gate
fixer's dispatch too (`lib/build.js:4374`), and a gate-time run is admitted, not refused (C1).
Inference would therefore tag a site D-A deliberately excludes, silently. An explicit `opts.flow`
makes every tagged site greppable and reviewable.

### S03-4 The four tagged call sites — `lib/build.js` (existing)

| Site | Line | Tag | Flow id / step id in scope |
|---|---|---|---|
| consumer fanout item | `:933` | `{ runId: flowId, stepId: descriptor.step ?? descriptor.id, itemIndex: descriptor.itemIndex }` | `flowId` is the function parameter (`:751`); `descriptor.itemIndex` is already used as a number at `:907` |
| ordinary step agent | `:3601` | `{ runId: flowId, stepId }` | `flowId` at `:3356`, `stepId` at `:3355` |
| step fixer (scoped-id retry) | `:3508` | `{ runId: flowId, stepId }` | same scope as above |
| policy revision | `:3686` | `{ runId: flowId, stepId }` | same scope as above |
| **review-repair gate fixer** (R1) | `:4374` | `{ runId: flowId, stepId: gateStepId }` | `flowId` is already on that dispatch object (`:4374`); `gateStepId` is in scope at `:4363`. Tag with `gateStepId`, not the literal `'review_fix'` the dispatch carries as its `step_id` — the run's real step is the gate, and `flow.stepId` is audit decoration either way (it is validated against nothing, `stratum/ts/src/mcp/server.ts:200-205`) |
| **gate `askAgent`** (R1) | `:1974` | `{ runId: context.flowId, stepId: gateDispatch.step_id ?? gateDispatch.id }` | `context.flowId` is set at `:3022`; the same `step_id ?? id` expression is already used two lines below at `:1981` |

**`runAgentText` needs no new opts field.** It forwards `opts` unchanged into
`#dispatchAgentRun` (`lib/stratum-mcp-client.js:855-860`) → `#invokeAgentRun` →
`buildAgentRunRequest({ ...opts, cancellationId })` (`:273`), so once S02-1 adds the `flow` key
to `buildAgentRunRequest`, passing `flow` through `runAgentText`'s options object is enough.

**The `askAgent` tag must be conditional on `context.flowId`.** `makeAskAgent` is exported and
called with a bare context in `test/usage-receipts.test.js:995`
(`makeAskAgent(stratum, context, { step_id: 'approval' })`), which has no `flowId`. Emit the tag
only when one exists — that is also what the R1 ruling says ("when the build has a flowId") and
it keeps that suite passing unedited:

```js
      ...(context.flowId
        ? { flow: { runId: context.flowId, stepId: gateDispatch.step_id ?? gateDispatch.id } }
        : {}),
```

Untagged, deliberately, and each for a checked reason:

- `lib/import.js:217`, `lib/step-validator.js:42`, `lib/new.js:139` / `:159` / `:205` — no
  `flow_id` exists at those sites at all.
- `lib/bug-escalation.js:125` / `:321` (`tier1CodexReview`, `tier2FreshAgent`) — these run
  outside a flow, and the evidence is in compose's own stream writes for them, which pass
  `flowId: null` literally (`lib/build.js:332`, `:335`, `:358`).
- `lib/codex-preflight.js:131` — `preflightCodexWorktreeProbe` takes no flow id in its signature
  (`lib/codex-preflight.js:77-88`); threading one in is scope creep for a short read-only probe.
- `lib/experiment-judge.js:139`, `server/design-routes.js:462` — outside the build driver.

### S03-5b Where the handle is registered

Stated here as well as in §3.5, because this is the slice that writes the call and a criterion
below is graded on it. `registerBuildCancel(response.runId, buildCancel)` goes **inside**
`startFresh`, immediately after its `writeActiveBuild` (`lib/build.js:5570`), and in the resume
branch immediately after `stratum.resume` returns (`:2805`) — not at the `context.flowId`
assignment (`:3022`), which the Codex preflight (`:2917`, up to 180s) sits before.
`unregisterBuildCancel(flowId)` goes in `runBuild`'s existing outermost `finally`
(`lib/build.js:4975-4995`), so a crashed build leaves no stale handle behind.

### S03-6 The kill switch and the derived transport field (R2 ruling 12)

`COMPOSE_FLOW_TAGGING=0` (default on) drops the `flow` key at the single point that builds it,
and also suppresses the `flow`-driven `cancellationId` mint of S02-2 — so a build under the
switch is byte-identical on the wire to today's. It exists so an exec-transport or detachment
regression can be bypassed without a release, and it is one branch in one helper:

```js
/** One place decides whether a dispatch is tagged, so the kill switch has one seam. */
export function flowTag(runId, stepId, itemIndex) {
  if (process.env.COMPOSE_FLOW_TAGGING === '0' || !runId) return undefined;
  return { runId, ...(stepId ? { stepId } : {}), ...(typeof itemIndex === 'number' ? { itemIndex } : {}) };
}
```

**The ledger must learn the field in the same commit (C44).** `lib/dispatch-ledger.js` is
default-deny — `if (!allowed.has(field)) invalid(...)` (`:120-124`) against an allow-list built
from `EVENT_FIELDS.dispatch` (`:55-62`) — and `#recordAgentDispatch` swallows the resulting
throw (`lib/stratum-mcp-client.js:234-237`, "Dispatch capture is fail-open by contract"). So
populating an unregistered field does not produce a bad row, it produces **no row at all**, and
takes that dispatch's usage record down with it. Add `transport_derived` to the optional list
**and** to the `case 'dispatch'` validator (`:132-148`) as an optional nullable string, in the
same commit that starts writing it, and assert the **persisted** row.

**And the value has to reach the event builder (C51).** `#recordAgentDispatch` builds the row
from the **caller's** `opts` (`lib/stratum-mcp-client.js:194-196`), while the `cancellationId`
that determines the transport is minted later and locally inside `#invokeAgentRun` (`:272`), so
the builder cannot see it. Derive the fact where the id is minted and pass it forward with the
dispatch record, rather than recomputing it in the builder from inputs it does not have.

The transport is journalled per agent run as **`transport_derived`**, never `transport` (C33):
stratum reports no transport on `ConnectorResult` (`stratum/ts/src/connectors/base.ts:29-54`),
so this is compose deriving a deterministic rule from its own inputs — provider `codex` and a
`cancellationId` sent ⟹ `exec` — not an observation. The name carries that distinction so a
future reader does not treat it as ground truth. An authoritative value needs a stratum change,
filed in §13.

**What tagging these two costs (C21).** Both gain `ownProcessGroup: true` and are therefore
detached. Neither relied on staying attached: `askAgent` reads only the returned text
(`lib/build.js:1974`, `:1994`), and the gate fixer reads only usage (`lib/build.js:4386-4392`).
**Corrected (C44):** the gate fixer is **not** newly affected. It dispatches through
`runAndNormalize` (`lib/result-normalizer.js:581-586`), so it already passes a signal and
already carries a minted `cancellationId` today — its transport and its detachment are unchanged
by this feature. The gate Q&A agent is the only dispatch whose behaviour changes, because
`runAgentText` passes no signal.

`itemIndex` must be a number; `descriptor.itemIndex` is one at `lib/build.js:907` where it is
already used to build `` `∥${descriptor.itemIndex}` ``. Omit the key rather than sending `null`
when it is not a number — the server's default-deny shape check rejects a `null`.

### S03-5 Threading `buildCancel` — `lib/build.js` (existing)

`const buildCancel = createBuildCancel();` beside `let buildStatus = 'failed';`
(`lib/build.js:2267`). `buildSignal: buildCancel.signal` is added to the four tagged
`runAndNormalize` calls above plus the gate fixer at `:4374` (untagged, but it must still die
with the build). `runConsumerIssuance` gains a `buildCancel` parameter in its destructured
signature (`:747-760`) and forwards `buildSignal: buildCancel?.signal` at `:933`;
`runConsumerDescriptor` (`:3198`) passes it. `lib/gsd.js:510` passes nothing and is unchanged.

### Acceptance criteria

- [ ] `createBuildCancel().cancel()` returns `true` once and `false` on every later call, and aborts the signal exactly once (pinned by test/build-cancel-unit.test.js)
- [ ] `isRunCancelled` returns `true` only for `audit.status === 'cancelled'`, and `false` when `audit` throws (pinned by test/build-cancel-unit.test.js)
- [ ] Aborting `buildCancel.signal` aborts an in-flight `runAndNormalize` on the MCP branch (pinned by test/build-cancel-signal-chain.test.js)
- [ ] Aborting `buildCancel.signal` aborts an in-flight `runAndNormalize` on the `localExecution: true` branch (pinned by test/build-cancel-signal-chain.test.js)
- [ ] A signal already aborted before dispatch aborts the run without dispatching (pinned by test/build-cancel-signal-chain.test.js)
- [ ] `runAndNormalize` removes its `buildSignal` listener when the run settles, so N sequential runs leave N-N listeners (pinned by test/build-cancel-signal-chain.test.js)
- [ ] A consumer item's `stratum_agent_run` request carries `flow: {runId, stepId, itemIndex}` with the fanout step id and a numeric index (pinned by test/build-flow-tag.test.js)
- [ ] An ordinary step's request carries `flow: {runId, stepId}` and no `itemIndex` (pinned by test/build-flow-tag.test.js)
- [ ] The review-repair gate fixer's request at `lib/build.js:4374` carries `flow: {runId, stepId}` with the GATE's step id, not the literal `review_fix` (pinned by test/build-flow-tag.test.js)
- [ ] A gate `askAgent` question issued through `runAgentText` carries `flow: {runId, stepId}` and a `cancellationId` (pinned by test/build-flow-tag.test.js)
- [ ] `makeAskAgent` called with a context that has no `flowId` emits NO `flow` key, and `test/usage-receipts.test.js` passes unedited (pinned by test/build-flow-tag.test.js)
- [ ] `runAgentText` forwards a caller-supplied `flow` without any change to its own signature (pinned by test/stratum-flow-cancel-client.test.js)
- [ ] No `stratum_agent_run` issued from `lib/bug-escalation.js`, `lib/codex-preflight.js`, `lib/import.js`, `lib/step-validator.js` or `lib/new.js` carries a `flow` key (pinned by test/build-flow-tag.test.js)
- [ ] `COMPOSE_FLOW_TAGGING=0` drops both the `flow` key and the flow-driven `cancellationId`, producing a request byte-identical to today's (pinned by test/build-flow-tag.test.js)
- [ ] A dispatch ledger row carrying `transport_derived` VALIDATES and is readable back from disk — the field is in both the optional list and the `dispatch` validator, so no event is silently dropped (pinned by test/dispatch-ledger-transport.test.js)
- [ ] Every dispatch that previously produced a ledger row still produces one after the field is added (pinned by test/dispatch-ledger-transport.test.js)
- [ ] The in-process handle is registered inside `startFresh`/resume, before the Codex preflight runs (pinned by test/build-flow-tag.test.js)
- [ ] A never-settling Codex preflight probe is rejected when `buildCancel` is cancelled — the signal really is chained, not merely passed (pinned by test/build-flow-tag.test.js)
- [ ] `transport_derived` on a persisted ledger row comes from a REAL tagged dispatch through the client, not a hand-built event (pinned by test/dispatch-ledger-transport.test.js)
- [ ] Every tagged request also carries a `cancellationId` (pinned by test/build-flow-tag.test.js)
- [ ] A tagged codex dispatch against a real server takes the `exec` transport, and the resulting `ConnectorResult` still carries `usage` and `telemetry` — the C18 blast radius, asserted rather than assumed (pinned by test/integration/flow-cancel-golden.test.js)

### Tests

- `test/build-cancel-unit.test.js` (new) — `createBuildCancel` and `isRunCancelled` in isolation.
- `test/build-cancel-signal-chain.test.js` (new) — `runAndNormalize` with an injected stratum
  and an injected `localQuery` (the seam at `lib/result-normalizer.js:557-558`), asserting the
  abort reaches both branches and the listener is released.
- `test/build-flow-tag.test.js` (new) — a recording `_testClient` captures every
  `stratum_agent_run` request through one scripted consumer-fanout build that also reaches a
  gate, and the test asserts the tag on each of the six tagged sites plus the absence of a tag
  on the flow-less callers. Two dedicated cases drive `makeAskAgent` directly, with and without
  `context.flowId`, since that is the conditional the R1 ruling turns on.

### CHANGELOG

```
- **COMP-BUILD-CANCEL S03**: every agent a build dispatches while its flow is running is now
  flow-tagged — including the two gate-time ones, the gate Q&A agent and the review-repair
  fixer, since a gate pause leaves the run `running` and admission succeeds — so
  `stratum_flow_cancel` can find and kill any of them from another process. A build-level
  `AbortController` (`lib/build-cancel.js`) chains into every `runAndNormalize` dispatch, so
  compose's own `isolation: none` local agents, which never enter Stratum, die with the build.
  Note that tagging detaches each agent into its own process group, so a terminal Ctrl-C no
  longer reaches them by group delivery — the S06 teardown is what replaces that.
```

---

## 7. Slice S04 — `abortBuild`: cancel first, honestly (D-C)

### S04-1 `writeActiveBuild` gains `stampPid` — `lib/build.js:1469-1477` (existing)

```js
function writeActiveBuild(dataDir, state, { stampPid = true } = {}) {
  mkdirSync(dataDir, { recursive: true });
  // Always stamp PID so concurrent processes can detect each other — EXCEPT when an
  // out-of-process aborter writes the terminal record. Restamping there would replace the
  // driver's pid with the aborter's, and the driver pid is what `lib/build.js:2764-2766`
  // probes for liveness and what `:1849` names in the concurrent-build refusal.
  if (stampPid) state.pid = process.pid;
  const target = activeBuildPath(dataDir);
  // C23: the tmp name must be unique per writer. `target + '.tmp'` is ONE path shared by
  // every process, so two concurrent writers interleave into the same file and rename a torn
  // document into place. Rename itself is atomic; the file being renamed was not.
  const tmp = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, target);
}
```

All nine existing call sites keep the default and are byte-identical. `randomUUID` is already
imported in `lib/build.js`. A stale `.tmp` from a crashed writer is now per-pid and harmless;
the old shared name could be renamed over a good record by a straggler.

### S04-2 `abortBuild` rewrite — `lib/build.js:5799-5844` (existing)

Sequence, unchanged in shape from D-C, with the corrections folded in:

1. **Read and refuse.** `readActiveBuild`; no active build → `{ok:false, reason:'no_active_build'}`;
   feature mismatch → `{ok:false, reason:'feature_mismatch'}`. Both keep today's console lines
   (`:5801`, `:5808`). **New (C31):** an already-terminal record — `active.status` in
   `complete` / `aborted` / `killed` / `failed` — refuses with
   `{ok:false, reason: `already_${active.status}`}` and performs **no writes of any kind**. The
   record is deliberately retained on disk after a successful build (`lib/build.js:4593-4596`,
   comment at `:4929`), so without this an abort issued after a build finished would kill the
   vision item and overwrite a `complete` record with `aborted`.

1b. **Resolve the driver (C22).** Before touching stratum, decide how the driver is reachable:

```js
  const handle = lookupBuildCancel(active.flowId);              // same process?
  const foreignPid = (!handle && active.pid && active.pid !== process.pid
    && active.status === 'running' && isProcessAlive(active.pid)) ? active.pid : null;
  const driverMode = handle ? 'in-process' : (foreignPid ? 'foreign-pid' : 'none');
```

   `process.pid` is **never** signalled. On the HTTP path the recorded pid IS this process
   (`server/build-routes.js:134` and `:151` share it), so a same-process abort must go through
   the handle or the build's local agents are never reached at all.
2. **Cancel, before anything local.** Fresh client (`opts.stratum ?? new StratumMcpClient()`,
   `:5815`), then connect with a **shortened lock wait** (C20) so a refusal is reported in
   seconds rather than after one opaque two-minute block:

```js
  const connection = resolveStratumMcpConnection(cwd);
  const lockWaitMs = Number(process.env.COMPOSE_ABORT_LOCK_WAIT_MS ?? 10000);
  // C38: connect() runs OUTSIDE flowCancel, so a spawn or handshake failure would bypass the
  // outcome table. Wrap it in the same normalisation the table already handles.
  try {
  await stratum.connect({
    ...connection,
    // Read per call from the server's process.env (stratum/ts/src/engine/run_lock.ts:49-51),
    // so this bounds THIS abort's lock wait only. The build's own server keeps the 120s
    // default; retrying visibly beats one silent two-minute block.
    env: { ...process.env, STRATUM_CANCEL_LOCK_WAIT_MS: String(lockWaitMs) },
  });
  } catch (error) { throw asTransportRefusal(error); }
```

   then `flowCancel(active.flowId)`. The bare `catch {}` at `:5823-5825` is deleted; only the
   classes below are tolerated. **Skip this step entirely when `active.flowId` is absent** — a
   build aborted before `plan` returned has nothing in stratum to cancel (C28's exception); go
   straight to step 3b with `flowSettled: true` treated as vacuously satisfied.
3. **Classify.** The table is the whole slice:

| Outcome | Detected by | Action |
|---|---|---|
| settled | resolved, `flowSettled: true` | proceed to 4 |
| already terminal, nothing to stop | resolved, `flowSettled: false`, `reason: 'already_<terminal>'` | proceed to 4, printing that the flow was already `<status>` |
| unknown run | `code: 'FLOW_NOT_FOUND'` | **stop**, `{ok:false, reason:'flow_not_found'}`, no terminal write and no vision kill. The ENOENT is raised before any sweep (C28), so this means *the run was not found*, not *nothing is running* |
| transport failure | `code: 'CANCELLATION_UNCONFIRMED'`, `reason: 'transport'` | **stop**, `{ok:false}`. Catch-all: any rejection `flowCancel` could not classify lands here (C29), so the table is total |
| teardown timeout | `code: 'CANCELLATION_TEARDOWN_TIMEOUT'` (always `flowSettled: true`) | call `flowCancel` **once** more (idempotent re-sweep, returns `already_cancelled`); on a second failure print `agents.unreaped` / `agents.unreachable` and proceed to 4 — **the flow is settled**. This is the EXPECTED path on a healthy build, not a rarity (C19) |
| lock held | `code: 'CANCELLATION_UNCONFIRMED'`, `reason: 'run_lock_held'`, `flowSettled: false`, all-zero `agents` | retry up to `COMPOSE_ABORT_RETRIES` (default 2) after a short pause, each attempt bounded by `COMPOSE_ABORT_LOCK_WAIT_MS`; if still unconfirmed → **stop**, `{ok:false}` |
| unreachable agents (post-settle) | `code: 'CANCELLATION_UNCONFIRMED'` with `agents.unreachable > 0` | **never retried** — it cannot clear. `flowSettled` is true on this path, so report the counters and proceed to 4 |
| anything else unconfirmed (`engine_dispatch_active`, transport) | `code: 'CANCELLATION_UNCONFIRMED'`, all-zero `agents`, `flowSettled: false` | **stop**, `{ok:false}`, printing `reason` and `holderPid` |

`agents.unreachable > 0` is the exact discriminator between a **post**-settle
`CANCELLATION_UNCONFIRMED` (the sweep ran, something was unreachable, the flow IS cancelled) and
a **pre**-settle one (nothing ran, all-zero counters, the flow is still running) — see C19 and
`stratum/ts/src/engine/flow_cancel.ts:198-208`. Do not infer it from `reason`, which is absent on
the post-settle path.

The read across the whole table is one rule: **proceed iff `flowSettled` is true or there was
nothing to settle.** `engine_dispatch_active` is not special-cased (C16).

4. **Stop the driver, by the mode resolved in 1b (C22).** Only when the flow is settled.

   - `in-process`: `handle.cancel('abort')`. No signal, no pid. This aborts the build-level
     controller, so the local `isolation: none` agents die and the driver's own detector (S05)
     takes it to an `aborted` terminal state. `driverSignalled: false`.
   - `foreign-pid`: `try { process.kill(foreignPid, 'SIGTERM'); driverSignalled = true; }
     catch { /* ESRCH: already gone */ }`. This is the only route a **second** process has to
     compose's local agents (D-F, §1).
   - `none`: nothing to stop.

5. **Decide who writes the terminal record (C23).** Two writers racing on one file is what
   ruling 2 forbids, and the driver is the better writer because it knows what the build did.

   - A **live driver** (`in-process` or `foreign-pid`): wait, bounded by
     `COMPOSE_ABORT_DRIVER_WAIT_MS` (default 20000), polling `readActiveBuild` for a terminal
     `status` — and for `in-process`, also for the handle to be unregistered. On success,
     `abortBuild` writes **nothing**: `terminalWriter: 'driver'`, `driverExited: true`, and it
     reports the status the driver wrote.
   - The wait **expiring**, or `driverMode === 'none'`: `abortBuild` is the writer.
     `terminalWriter: 'abort'`, `driverExited: false` if a driver was seen at all.

6. **Claim, then write — only when `terminalWriter === 'abort'`.** `claimActiveBuild` (§3.7)
   runs **first**, before the vision kill, because the vision flip and the actuals are mutations
   too and a stale aborter must make none of them (C41). On `null`, return
   `{ok:false, reason:'ownership_lost'}` having written nothing. Then, in today's order: vision
   kill (`:5829-5835`), the terminal `active-build.json` write, actuals (`:5839-5842`):

```js
  // ONE claim, before the first mutation, covering vision + state + actuals (§3.7, C41/C48).
  // No hand-rolled disjunction: `!cur?.flowId || !active.flowId` treated a missing id as a
  // match, which is the whole defect.
  const claim = claimActiveBuild(dataDir, active);
  if (!claim.ok) return { ok: false, reason: claim.reason, flowId: active.flowId ?? null, /* ... */ };

  if (itemId) await visionWriter.updateItemStatus(itemId, 'killed');
  writeActiveBuild(
    dataDir,
    { ...claim.record, status: 'aborted', completedAt: new Date().toISOString() },
    { stampPid: false },                       // preserve the driver's pid (C12)
  );
  const accumulator = readBuildAccumulator(cwd, active.featureCode);
  if (accumulator) emitBuildActuals(cwd, accumulator, 'aborted');
```

   When the driver wrote it, the vision kill and the actuals are the driver's too — S05's
   aborted terminalizer already owns both (C26), so doing them here would double-write.

7. **Return** the §3.3 object. `await stratum.close()` stays in a `finally`.

### S04-3 CLI and HTTP surface

- `lib/build.js:2252-2253` → `return await abortBuild(dataDir, featureCode, cwd);`
- `bin/compose.js:2860`, `:2977`, `:3088` → `.then((result) => { process.exit(abort && result && result.ok === false ? 1 : 0) })`
- `abortBuild` prints, in order: the flow's status; on a refusal, `reason` and `holderPid`; on a
  partial sweep, the non-zero `agents` counters; whether the driver was signalled; and one final
  line that is either `Build aborted.` (today's, `:5843`) or `Build NOT aborted — <reason>.`
- `server/build-routes.js:151-152` is unchanged: it already forwards the returned object, and
  `test/build-routes.test.js:221-235` already pins the three-argument call.

### Acceptance criteria

- [ ] `abortBuild` calls `flowCancel(active.flowId)` before any vision, active-build or actuals write (pinned by test/abort-build-cancel.test.js)
- [ ] Each of the seven outcome classes above produces the documented `{ok, ...}` and the documented set of local writes (pinned by test/abort-build-cancel.test.js)
- [ ] On `CANCELLATION_UNCONFIRMED` with `flowSettled: false`, `active-build.json` is unchanged and the vision item is NOT killed (pinned by test/abort-build-cancel.test.js)
- [ ] On `CANCELLATION_TEARDOWN_TIMEOUT`, `flowCancel` is called exactly twice and local cleanup proceeds (pinned by test/abort-build-cancel.test.js)
- [ ] `run_lock_held` is retried `COMPOSE_ABORT_RETRIES` times and no more; `agents.unreachable > 0` is retried zero times (pinned by test/abort-build-cancel.test.js)
- [ ] A post-settle `CANCELLATION_UNCONFIRMED` (`agents.unreachable > 0`, `flowSettled: true`) proceeds to local cleanup, while a pre-settle one (all-zero `agents`, `flowSettled: false`) stops (pinned by test/abort-build-cancel.test.js)
- [ ] The abort client spawns its server with `STRATUM_CANCEL_LOCK_WAIT_MS` set from `COMPOSE_ABORT_LOCK_WAIT_MS`, and the build's own client does not (pinned by test/abort-build-cancel.test.js)
- [ ] After an abort, `active-build.json`'s `pid` still names the driver, not the aborting process (pinned by test/abort-build-cancel.test.js)
- [ ] A same-process abort (an in-process handle exists for the flow id) cancels through the handle and issues NO signal — `process.pid` is never passed to `process.kill` on any path (pinned by test/abort-build-cancel.test.js)
- [ ] A foreign live driver pid is SIGTERMed only when the flow settled (pinned by test/abort-build-cancel.test.js)
- [ ] When a live driver exists and settles within `COMPOSE_ABORT_DRIVER_WAIT_MS`, `abortBuild` writes NOTHING and returns `terminalWriter: 'driver'`, `driverExited: true` (pinned by test/abort-build-cancel.test.js)
- [ ] When that wait expires, `abortBuild` writes the terminal record under the identity guard and returns `driverExited: false` (pinned by test/abort-build-cancel.test.js)
- [ ] `writeActiveBuild` uses a per-process unique tmp path, and two concurrent writers never produce a torn record (pinned by test/abort-build-cancel.test.js)
- [ ] An already-terminal active record refuses with `already_<status>` and performs zero writes (pinned by test/abort-build-cancel.test.js)
- [ ] An unknown flow returns `ok:false, reason:'flow_not_found'` with no terminal write and no vision kill (pinned by test/abort-build-cancel.test.js)
- [ ] A raw transport failure returns `ok:false, reason:'transport'` rather than throwing (pinned by test/abort-build-cancel.test.js)
- [ ] A failing `connect()` produces the same `transport` refusal as a failing `flowCancel` (pinned by test/abort-build-cancel.test.js)
- [ ] `claimActiveBuild` runs before the vision kill; a record changed under the aborter yields `ownership_lost` with NO vision flip, NO state write and NO actuals (pinned by test/abort-build-cancel.test.js)
- [ ] A record whose `flowId` is absent is matched on `pid` AND `startedAt`, never treated as matching anything (pinned by test/abort-build-cancel.test.js)
- [ ] The in-process handle is registered before the Codex preflight, so an abort during a 180s probe takes the in-process branch (pinned by test/abort-build-cancel.test.js)
- [ ] An active record with no `flowId` skips the cancel entirely and still handles the driver (pinned by test/abort-build-cancel.test.js)
- [ ] A concurrent build's `active-build.json` (different `flowId`) is never overwritten by an abort (pinned by test/abort-build-cancel.test.js)
- [ ] `compose build --abort` exits 1 when `ok` is false and 0 otherwise (pinned by test/abort-build-cancel.test.js)
- [ ] `test/build-routes.test.js` and `test/abort-build-engine.test.js` pass, the latter with only its `fakeStratum` extended

### Tests

`test/abort-build-cancel.test.js` (new) — one table-driven error harness over the **nine**
outcome classes with an injected `opts.stratum`, each row declaring the expected return object,
the expected on-disk `active-build.json`, the expected vision status, the expected `flowCancel`
call count, and whether a SIGTERM was issued (a fake `process.kill` sink, not a real signal).
Plus: a concurrent-identity row; a pid-preservation row; the three early refusals; a
same-process row that registers a real handle through `registerBuildCancel` and asserts the
handle was cancelled and the kill sink never called; a driver-wait row where a fake driver
writes the terminal record mid-wait; and a wait-expiry row. Exit-code assertions run the CLI as
a child process.

`test/active-build-tmp-race.test.js` (new) — the C23 receipt, and it needs to be a real race,
not a mocked one: N child processes each call `writeActiveBuild` on the same `dataDir` in a
tight loop while the parent repeatedly reads and `JSON.parse`s the file. Zero parse failures
and zero records with a mixed identity. Run it against the old shared-tmp implementation once,
by hand, to confirm it actually fires — a race test that has never failed is not evidence.

`test/abort-build-engine.test.js` (existing) gains `flowCancel` on its fake.

### CHANGELOG

```
- **COMP-BUILD-CANCEL S04**: `compose build --abort` now actually stops the build. It calls
  `stratum_flow_cancel` first and only acts locally when the flow is durably settled — a refusal
  (`run_lock_held`, `engine_dispatch_active`, a dead transport) no longer prints "Build aborted."
  over a build that is still running, and an unknown flow id is reported rather than treated as
  "nothing to cancel". A settled abort stops the driver through an in-process handle when the
  build is in this process (the HTTP route runs both in one process, where signalling the
  recorded pid would kill the compose server) and by SIGTERM only for a foreign live pid. The
  driver, when alive, remains the sole writer of the terminal record; `abortBuild` writes it
  only when no live driver exists or the wait expires. `active-build.json` now uses a
  per-process temp file, so two writers can no longer rename a torn record into place. Aborting
  an already-finished build is refused instead of overwriting its `complete` record.
```

---

## 8. Slice S05 — the driver notices, and stops merging (D-D)

After a cross-process cancel the driver learns nothing useful from the error it gets. The
in-flight `stratum_agent_run` rejects with the **generic** `agent_run_failed` envelope, message
`codex exited with code 143` or the child's stderr (`stratum/ts/src/mcp/server.ts:503-508`), and
the next `stratum_step_done` throws a bare uncoded `Error("run <id> is cancelled; ...")`
(`stratum/ts/src/engine/engine.ts:748`; `gateResolve` at `:1306`). So detection is a **trigger**
plus an **authority**: a cheap local predicate, then `isRunCancelled` asking the engine.

### S05-1 `looksCancelled(error)` — `lib/build-cancel.js` (new)

```js
/** A TRIGGER, not a verdict: it decides whether to spend one stratum_audit asking whether the
 *  run is really cancelled. Deliberately loose, because the honest signals are all indirect —
 *  stepDone/gateResolve throw an uncoded Error (engine.ts:748, :1306), and a cross-process
 *  cancel reaches the agent as a generic `agent_run_failed`. */
export function looksCancelled(error) {
  if (!error) return false;
  if (['PERSIST_ON_CANCELLED_RUN', 'flow_cancelled', 'flow_not_running', 'FLOW_NOT_RUNNING'].includes(error.code)) return true;
  return /is cancelled|flow cancelled/i.test(String(error.message ?? ''));
}
```

### S05-2 One shared detection boundary — `confirmCancellation` (C25)

D-D's two detection points miss three call sites. The **ordinary step agent**
(`lib/build.js:3601-3618`), the **step fixer** (`:3508`) and the **gate fixer** (`:4374-4392`)
all reject out of `runAndNormalize` and rethrow before any `stepDone` runs, so a cancel that
kills one of those is classified as an ordinary agent failure and the build dies `failed`.

One boundary covers all of them, because all of them funnel through `runAndNormalize`:

```js
/** The single place a suspicious failure becomes a CONFIRMED cancel. Trigger, then authority.
 *
 *  C34: the TRIGGER is the CALL, not the error. By the time a caller sees this rejection,
 *  runAndNormalize has already flattened it to `new AgentError(err?.message)`
 *  (lib/result-normalizer.js:617-619) — the code is gone, and on the cross-process path the
 *  message is `codex exited with code 143`, which matches nothing. So any failure of a
 *  FLOW-TAGGED dispatch is suspicious, and this must be called INSIDE that catch
 *  (lib/result-normalizer.js:591), before the conversion. `looksCancelled` remains the cheap
 *  trigger for the stepDone/gateResolve sites, whose messages do carry `is cancelled`. */
export async function confirmCancellation(error, { stratum, flowId, buildCancel, tagged = false }) {
  if (!buildCancel || !flowId) return false;
  if (buildCancel.cancelled) return true;              // already known; no second RPC
  if (!tagged && !looksCancelled(error)) return false;
  if (!await isRunCancelled(stratum, flowId)) return false;
  buildCancel.cancel('flow_cancelled');
  return true;
}
```

Called from:

- **`runAndNormalize`'s error path**, at the top of the catch at `lib/result-normalizer.js:591`
  — after the two `CANCELLATION_*` codes are rethrown at `:592`, before the `AgentError`
  conversion at `:617` destroys the evidence (C34). It is called with `tagged: true` whenever
  this dispatch carried a `flow`. This one call covers the consumer item, the ordinary step
  agent, the step fixer, the policy revision and the gate fixer. It needs `opts.flowId` and
  `opts.buildCancel`, which ride alongside the `opts.buildSignal` S03 already adds.
- **the gate Q&A caller** (`makeAskAgent`, `lib/build.js:1974`) — the one tagged dispatch that
  does not go through `runAndNormalize`. It reaches the handle through `context.buildCancel`,
  added to the build context beside `flowId` at `lib/build.js:3022` (C35); `makeAskAgent`'s own
  signature is unchanged, since it already receives that context (`:1960`, called at `:4469`).
- **the `stepDone` / `gateResolve` throws** (`lib/build.js:701`, `:3482`, `:3945`, `:4260`) —
  still worth keeping, because a cancel landing between two agent runs shows up only here.

On a confirmed cancel: `buildStatus = 'aborted'`, the pump stops (`consumerFatalError` +
`drainConsumersThenRethrow`, `lib/build.js:3275`, `:3325`), every pending item retry is skipped,
and the build unwinds through the terminal path S05-4 fixes.

### S05-3 No merge after a cancel — a two-part fence (C2, C24)

The guard goes at the **apply**, not the capture (C2). But a pre-apply check alone is a TOCTOU:
the cancel can settle while `applyMerge` is running. That window is not new — it is documented
in the code at `lib/consumer-fanout.js:1070-1079` ("Two truly concurrent PROCESSES retain an
inherent TOCTOU window here ... cross-process concurrent merge relies on the run's single-owner
assumption, not a lockfile in this slice") — but a cross-process cancel is exactly what makes it
reachable on purpose.

**Part 1, pre-apply.** Before the `try` whose catch calls `repairFor` (`lib/build.js:4238-4240`),
so the throw terminates the build rather than being read as a merge-repair signal:

```js
              if (buildCancel.cancelled) {
                // A diff captured after the cancel is evidence, not work to land. Keep the
                // journal entry, refuse the apply, and say so.
                streamWriter.write({ type: 'build_note', note: `merge skipped: build cancelled (${buildCancel.reason})`, flowId });
                throw new MergeAfterCancelError(
                  `merge refused: build was cancelled at ${buildCancel.at}`);
              }
              await consumerMergeArtifacts.applyMerge(consumerMergeTransaction);
```

**Not `ConsumerMergeDecisionError` (C39).** That class is exactly what `lib/build.js:4223-4240`
catches and hands to `repairFor`, which would turn the cancel into a merge-repair **revise** and
keep the build running. `MergeAfterCancelError` is a new class exported from
`lib/consumer-fanout.js` beside the two that already live there, carrying
`code = 'MERGE_AFTER_CANCEL'`, and **both** fences sit OUTSIDE the `try` whose catch calls
`repairFor`, so they unwind straight to the cancelled terminalizer.

**Part 2, post-apply.** After `applyMerge` returns, re-check — `buildCancel.cancelled` first
(free), then one `isRunCancelled(stratum, flowId)` RPC, which is cheap and runs at most once per
merge. If the run was cancelled during the apply, **reverse the whole transaction**:

```js
              if (buildCancel.cancelled
                  || await isRunCancelled(stratum, flowId)) {
                buildCancel.cancel('flow_cancelled');
                // NOT `git apply -R` of one item's diff (C24): applyMerge is tree-based, and a
                // patch-level reversal would leave the working tree at a state no witness in
                // the chain describes. restoreMergeBaseline is the reversal this repo already
                // owns — it restores tx.baselineTree wholesale and reconciles every `merged`
                // issuance back to `accepted`/`superseded` against the audit.
                consumerMergeArtifacts.restoreMergeBaseline(
                  consumerMergeTransaction, gateAudit, { reason: 'cancelled' });
                throw new MergeAfterCancelError(
                  'merge reversed: the run was cancelled while the merge was applying');
              }
```

Reversing the **whole** transaction rather than one item is what a cancel wants: nothing from
this round should land. `restoreMergeBaseline` (`lib/consumer-fanout.js:1168-1214`) is already
the non-approve path at `lib/build.js:4251-4253`, so this reuses a tested primitive.

Its one change is a third optional argument recording **why**, so the journal distinguishes a
cancel reversal from an ordinary gate rollback: `tx.rollbackReason = opts.reason ?? null`
beside the existing `tx.rolledBackAt` write at `lib/consumer-fanout.js:1179`.

**If the reversal itself fails**, do not swallow it — and do not try to journal it from inside
the failed mutation. `#mutate` writes only after its callback returns (`lib/consumer-fanout.js:352-353`);
a throw inside reaches the `finally` at `:355`, which releases the writer lock and writes
nothing, so the note would be lost exactly when it matters (C40). It takes a **second, guarded
mutation** after the failed restore:

```js
  try {
    artifacts.restoreMergeBaseline(tx, gateAudit, { reason: 'cancelled' });
  } catch (revertError) {
    // Its own #mutate: the failed one wrote nothing, so this is the only record that the tree
    // is now in an indeterminate state.
    artifacts.markRollbackFailed(tx, revertError);   // state:'rollback_failed', failureCode, failure
    throw new MergeAfterCancelError(
      `merge reversal FAILED after cancel; working tree is indeterminate: ${revertError.message}`);
  }
```

A half-reversed tree is a real state the user must be told about, and `--fresh` already owns
clean restart.

### S05-4 The build must actually END aborted — `lib/build.js` (existing)

Three edits, because today a confirmed cancel still terminalizes as **failed** (C26).

- **The outer catch** (`lib/build.js:4931-4932`) sets `buildStatus = 'failed'` on any throw and
  calls `terminalizeThrownBuild`, which writes `status: 'failed'` (`:2088-2094`) and flips the
  vision item to `blocked` (`:2106`). It gains a first test:

```js
  } catch (err) {
    // A cancelled build is not a failed build: it was stopped on purpose, and terminalizing it
    // `failed` also marks the vision item `blocked`, which reads as "this feature is broken".
    if (buildCancel.cancelled) {
      buildStatus = 'aborted';
      await terminalizeCancelledBuild({ /* same args, status 'aborted', vision 'killed' */ });
      throw err;
    }
    buildStatus = 'failed';
```

- **The aborted branch** at `:4598-4614` generalises its condition from `killedByGate` to
  `killedByGate || buildCancel.cancelled`, so a cancel that unwinds cleanly (rather than
  throwing) lands in the same place.
- **`isTerminalFlow`** (`:2012-2014`) gains `cancelled` (C30). Seven call sites widen and each
  is beneficial or inert; the one that closes a live hole is the resume probe at `:2775`, where
  a cancelled flow whose driver is still alive would otherwise reach `stratum.resume` (`:2802`)
  and throw the uncoded `run <id> is cancelled; resume is not permitted`.

  **Terminality alone is not the behaviour (C42).** With `cancelled` terminal,
  `decideBuildStart` falls into `if (!active || !flowId || flowTerminal)` (`:1832-1836`) and
  returns **`fresh`** — a cancelled build silently becomes a brand-new one, and the user is
  never told what happened to the old. So the resume probe gains an explicit branch: when the
  audit reports `cancelled`, refuse with a named reason and do **not** fall through to a fresh
  plan. The user re-runs with `--fresh` if a new build is what they want.

  **Who writes, though, is not "this process" (C49).** `server/build-routes.js:130-134` runs
  `runBuild` inside the express process, so a resume probe can execute while a *different*
  in-process build owns that record — the same premise C22 removed for `abortBuild`. So the
  branch consults the registry first:

```js
  if (audit?.status === 'cancelled') {
    const handle = lookupBuildCancel(activeForDecision.flowId);
    if (handle) {
      handle.cancel('flow_cancelled');       // its own teardown owns the record
    } else {
      const claim = claimActiveBuild(dataDir, activeForDecision);
      if (claim.ok) {
        writeActiveBuild(dataDir, { ...claim.record, status: 'aborted',
          failureReason: 'flow_cancelled', completedAt: new Date().toISOString() });
      }
    }
    throw new Error(`Flow ${activeForDecision.flowId} was cancelled; it cannot be resumed. `
      + 'Run with --fresh to start a new build.');
  }
```

Both terminal writes stay identity-guarded, and `{ stampPid: true }` is correct here because
the driver is writing its own record. No `usage_report` or receipt flush is attempted once
`buildCancel.cancelled` is true — a cancelled run refuses every receipt write with
`PERSIST_ON_CANCELLED_RUN` (`stratum/ts/src/engine/engine.ts:524-528`, `:873-877`).

### Acceptance criteria

- [ ] `looksCancelled` fires on the four codes and on an `/is cancelled/` message, and does not fire on an ordinary agent failure (pinned by test/build-cancel-detect.test.js)
- [ ] An injected client whose `agentRun` rejects `agent_run_failed` and whose `audit` returns `cancelled` ends the build `aborted` with no per-item retry (pinned by test/build-cancel-detect.test.js)
- [ ] An injected client whose `agentRun` rejects `agent_run_failed` and whose `audit` returns `running` keeps today's per-item failure behaviour exactly (pinned by test/build-cancel-detect.test.js)
- [ ] `applyMerge` is not called when `buildCancel.cancelled` is true (pinned by test/build-cancel-detect.test.js)
- [ ] The journal entry for an item that completed after the cancel still exists, with its captured diff, and is journaled unmerged (pinned by test/build-cancel-detect.test.js)
- [ ] No `stratum_usage_report` is issued after `buildCancel.cancelled` is true (pinned by test/build-cancel-detect.test.js)
- [ ] A cancelled build's terminal `active-build.json` write does not overwrite a record for a different `flowId` (pinned by test/build-cancel-detect.test.js)
- [ ] `confirmCancellation` fires for a cancelled ORDINARY step agent, step fixer and gate fixer — each of which rethrows before any `stepDone` — not only for a consumer item (pinned by test/build-cancel-detect.test.js)
- [ ] `confirmCancellation` issues at most one `stratum_audit` per failure and none once the handle is already cancelled (pinned by test/build-cancel-detect.test.js)
- [ ] A confirmed cancel that throws out of the build ends `aborted` with the vision item `killed`, NOT `failed`/`blocked` (pinned by test/build-cancel-detect.test.js)
- [ ] `isTerminalFlow('cancelled')` is true, and a resume probe against a cancelled flow does not call `stratum.resume` (pinned by test/build-cancel-detect.test.js)
- [ ] A cancel that lands DURING `applyMerge` is reversed via `restoreMergeBaseline`, the transaction records `rollbackReason: 'cancelled'`, and every issuance it had marked `merged` is back to `accepted` or `superseded` (pinned by test/merge-cancel-fence.test.js)
- [ ] The post-apply fence throws `MergeAfterCancelError`, so `repairFor` never sees it (pinned by test/merge-cancel-fence.test.js)
- [ ] A failed reversal records `state: 'rollback_failed'` through a SECOND mutation and surfaces a named finding rather than being swallowed (pinned by test/build-cancel-detect.test.js)
- [ ] Both merge fences throw `MergeAfterCancelError`, and neither is caught by the `repairFor` handler at `lib/build.js:4223-4240` — a cancel never becomes a merge-repair revise (pinned by test/build-cancel-detect.test.js)
- [ ] `confirmCancellation` fires for a flow-tagged dispatch whose rejection carries NO code and a `codex exited with code 143` message — the shape a real cross-process sweep produces (pinned by test/build-cancel-detect.test.js)
- [ ] A resume against an audited `cancelled` run refuses with a named reason and does NOT start a fresh build (pinned by test/build-cancel-detect.test.js)
- [ ] A gate Q&A agent killed by a cross-process cancel is detected through `context.buildCancel` and ends the build `aborted` (pinned by test/build-cancel-detect.test.js)

### Tests

`test/build-cancel-detect.test.js` (new). Table-driven over `(agentRun rejection, audit status)`
pairs and over the four dispatch sites that rethrow before `stepDone`. Plus: a pre-apply
merge-guard case that drives a scripted consumer fanout to the merge gate with the flag already
set and asserts `applyMerge` was never entered while the journal entry survives; a
revert-failure case; and a terminal-status case asserting `aborted`/`killed` rather than
`failed`/`blocked`.

`test/merge-cancel-fence.test.js` (new) — the post-apply fence, which **cannot** be reached from
an end-to-end abort (C50: a fanout settles only when every item is terminal,
`stratum/ts/src/engine/engine.ts:2076`, and the merge runs only after the gate is ready,
`lib/build.js:4219` — so a mid-fanout abort never gets there). The race is injected directly:
spy on `applyMerge` and make `isRunCancelled` flip to `true` between its resolution and the
fence. Asserts the working tree is back at `tx.baselineTree`, no issuance is still `merged`, the
transaction records `rollbackReason: 'cancelled'`, and the thrown class is
`MergeAfterCancelError`. This is the only place that path is exercised, which is why it gets its
own file rather than a case in a table.

### CHANGELOG

```
- **COMP-BUILD-CANCEL S05**: a build whose flow was cancelled from another process now notices,
  wherever the cancel lands. Stratum reports a swept agent as a generic `agent_run_failed` and a
  cancelled run's `step_done` as an uncoded error, so compose confirms with `stratum_audit`
  before acting, through one shared boundary that covers the consumer items, ordinary steps, the
  fixers and the gate Q&A agent alike. On a confirmed cancel it stops the pump, skips every
  pending retry, refuses to merge any patch captured after the cancel — and, if the cancel lands
  mid-merge, reverses the whole merge transaction back to its baseline tree. The build now ends
  `aborted` with its vision item `killed`, instead of being terminalized as `failed`/`blocked`
  by the outer catch. `isTerminalFlow` finally knows about `cancelled`, so recovery no longer
  tries to resume a cancelled run.
```

---

## 9. Slice S06 — SIGINT/SIGTERM does a real teardown (D-E)

Today's handler is three lines (`lib/build.js:2976-2981`): it sets `buildStatus = 'killed'` and
closes the stream. It kills no agent, cancels no flow, writes no state, and does not exit. It is
also untested — no test in the repo references `signalHandler`.

### S06-1 `runCancelTeardown(deps)` — `lib/build-cancel.js` (new)

Everything injected, so the whole sequence is unit-testable with fakes and no signals:

```js
/** Bounded, idempotent teardown. `deps` are all injected so this runs under test with a fake
 *  clock, a fake client and a fake process. Never awaits the build pump — it races it. */
export async function runCancelTeardown({
  buildCancel, signal, flowId, flowCancel, timeoutMs,
  killVision, writeTerminal, emitActuals, closeStream, removeListeners, exit, log,
}) {
  // C27: key the force-exit on teardownStarted, NOT on cancelled. By the time a user presses
  // Ctrl-C the handle may ALREADY be cancelled — S05's detector sets it on a cross-process
  // cancel — and keying on that would make the FIRST signal behave like a second and skip the
  // teardown entirely.
  if (!buildCancel.beginTeardown()) { exit(signal === 'SIGINT' ? 130 : 143); return; }
  buildCancel.cancel(`signal:${signal}`);   // idempotent; records the reason if it is first
  try {
    await withDeadline(flowCancel(flowId), timeoutMs);
  } catch (error) {
    // `already_cancelled` is success: abortBuild got here first. Anything else is reported
    // and does not stop the local teardown — the local record must not be left `running`.
    if (error?.reason !== 'already_cancelled') log(`flow cancel: ${error?.reason ?? error?.code ?? error?.message}`);
  }
  // §3.6: wait for the build's own finally to close its resources and emit actuals, so this
  // teardown's writes cannot race finalizeBuildAttempt. Bounded, because a wedged pump never
  // reaches that finally and D-E forbids awaiting the pump.
  await withDeadline(buildCancel.drained, drainMs).catch(() => undefined);
  try { await killVision(); } catch { /* best-effort */ }
  try { writeTerminal(); } catch { /* best-effort */ }   // identity-claimed, §3.7
  removeListeners();
  exit(signal === 'SIGINT' ? 130 : 143);                 // the ONLY exit on this path
}
```

Note what is **absent**: no `emitActuals` and no `closeStream`. Both belong to the build's inner
`finally` — `finalizeBuildAttempt` (`lib/build.js:2295-2301`) is the single actuals emitter and
is already idempotent through `attemptFinalized` (`:2296`), and the stream close sits beside it
at `:4962-4964`. A second emitter is exactly the duplicate §3.6 exists to remove (C45).

The deadline is `COMPOSE_CANCEL_TIMEOUT_MS` (default 15000), the variable already read at
`lib/stratum-mcp-client.js:291`. Reuse it rather than inventing a second knob.

### S06-2 The handler — `lib/build.js:2975-2981` (existing)

```js
    // SIGINT/SIGTERM: cancel the flow, tear down, exit. A SECOND signal during teardown
    // exits immediately — a user pressing Ctrl-C twice is asking to stop waiting, and the
    // durable state a bounded teardown would have written is worth less than obeying that.
    signalHandler = (signal) => {
      // No local `tearingDown` flag: the handle owns that state (C27), so a teardown started
      // by any other path is visible here too.
      if (buildCancel.teardownStarted) { process.exit(signal === 'SIGINT' ? 130 : 143); return; }
      buildStatus = 'aborted';
      // ASSIGN, do not fire and forget (C45). The promise is what the outer catch reads to
      // stand down and what the outermost finally and the CLI join on. `runCancelTeardown`
      // sets `teardownStarted` synchronously, so a second signal takes the branch above.
      buildCancel.teardown = runCancelTeardown({
        buildCancel, signal, flowId: response?.runId,
        flowCancel: (id) => stratum.flowCancel(id),
        timeoutMs: cancelTimeoutMs, drainMs: drainTimeoutMs,
        killVision: () => visionWriter.updateItemStatus(itemId, 'killed'),
        writeTerminal: () => { /* claimActiveBuild(...) then writeActiveBuild 'aborted' */ },
        removeListeners: () => { process.off('SIGINT', onSigint); process.off('SIGTERM', onSigterm); },
        exit: (code) => process.exit(code), log: (m) => console.warn(`[build] ${m}`),
      });
    };
    // Named wrappers so the two existing removeListener sites keep working (see below).
    const onSigint = () => signalHandler('SIGINT');
    const onSigterm = () => signalHandler('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
```

And the two counterpart edits §3.6 requires, stated as sketches so they are not lost in prose:

```js
  // outer catch (lib/build.js:4931) — stand down, do not await, do not terminalize
  } catch (err) {
    if (buildCancel.teardown) { buildStatus = 'aborted'; throw err; }
    if (buildCancel.cancelled) { buildStatus = 'aborted'; await terminalizeCancelledBuild({ /* ... */ }); throw err; }
    buildStatus = 'failed';
    // ... existing terminalizeThrownBuild path unchanged
```

```js
  // inner finally (lib/build.js:4955-4974), after its existing closes
    runtimeResourcesFinalized = true;
    buildCancel.resolveDrained();          // releases the teardown's bounded wait
```

```js
  // outermost finally — join, so the CLI cannot exit out from under the teardown
  } finally {
    if (buildCancel?.teardown) {
      await withDeadline(buildCancel.teardown, cancelTimeoutMs + drainTimeoutMs + 1000)
        .catch(() => undefined);
    }
  }
```

`buildStatus` becomes `'aborted'` rather than today's `'killed'`; both already map to the same
terminal actuals status (`lib/build.js:2297-2301`) and both are accepted by the build-history
gate (`:4832`), so nothing downstream changes shape. The named listener still has to be
removable — the two `process.removeListener` sites (`lib/build.js:4965-4968`, `:4980-4984`)
must remove the same function references that were registered, so keep two named wrappers rather
than the inline arrows sketched above.

`writeTerminal` goes through `claimActiveBuild` (§3.7) like every other mutation, and
`{ stampPid: false }` is **not** used here: this process *is* the driver, so stamping its own
pid is correct.

The listener removal also has to be conditional now. The two existing `process.removeListener`
sites (`lib/build.js:4965-4968`, `:4980-4984`) must **not** run while a teardown is pending —
the teardown removes them itself, after its writes — or a second Ctrl-C during teardown would
reach the default handler and kill the process mid-write.

### S06-3 The CLI stops exiting through a live teardown

The last exit path is the CLI's own. All three command paths resolve `runBuild` and immediately
`process.exit` (`bin/compose.js:2860-2861`, `:2977-2978`, `:3088-3089`), so a teardown still
writing its record loses the race (C46). `lib/build-cancel.js` exports an accessor for it:

```js
/** The teardown in flight for ANY build in this process, or null. The CLI awaits it before
 *  exiting; it is an accessor rather than an export of the handle so the CLI never needs to
 *  know which build it belongs to. */
export function pendingTeardown() {
  for (const handle of activeBuildCancels.values()) if (handle.teardown) return handle.teardown;
  return null;
}
```

```js
  runBuild(featureCode, singleOpts).then(async (result) => {
    await pendingTeardown();                 // resolves immediately when nothing is tearing down
    process.exit(abort && result && result.ok === false ? 1 : 0)
  }).catch(async (err) => {
    await pendingTeardown();                 // the teardown's own process.exit usually wins here
    console.error(`Build failed: ${err.message}`)
    process.exit(1)
  })
```

The `.catch` matters more than the `.then`: a cancelled build **throws**, so without this the
`catch` exits 1 straight through the teardown. In practice the teardown's own `process.exit`
(130 or 143) usually lands first, which is the intended exit code.

### Acceptance criteria

- [ ] `runCancelTeardown` calls `flowCancel` exactly once for the first signal and zero times for a second signal during teardown (pinned by test/build-signal-teardown.test.js)
- [ ] A signal arriving when the handle is ALREADY `cancelled` (S05 detected a cross-process cancel first) still runs the full teardown — the force-exit keys on `teardownStarted`, not `cancelled` (pinned by test/build-signal-teardown.test.js)
- [ ] When `buildCancel.teardown` is set, the outer catch performs NO terminalization and does not await it — the terminal record is written exactly once (pinned by test/build-signal-teardown.test.js)
- [ ] The teardown awaits `drained` and writes only after the build's inner finally has closed its resources (pinned by test/build-signal-teardown.test.js)
- [ ] A build whose pump never unwinds still terminalizes: `drained` times out at `COMPOSE_TEARDOWN_DRAIN_MS` and the teardown writes anyway (pinned by test/build-signal-teardown.test.js)
- [ ] `process.exit` is called exactly once, by the teardown, and never by the outer catch or the CLI while a teardown is pending (pinned by test/build-signal-teardown.test.js)
- [ ] A `flowCancel` that never resolves is abandoned after `COMPOSE_CANCEL_TIMEOUT_MS` and the local teardown still runs (pinned by test/build-signal-teardown.test.js)
- [ ] `reason: 'already_cancelled'` is treated as success and logs nothing (pinned by test/build-signal-teardown.test.js)
- [ ] The teardown kills the vision item then writes `active-build.json` `aborted`, and emits NO actuals — `finalizeBuildAttempt` remains the sole emitter and runs exactly once (pinned by test/build-signal-teardown.test.js)
- [ ] The CLI awaits `pendingTeardown()` before exiting, on all three command paths (pinned by test/build-signal-teardown.test.js)
- [ ] The outermost join bound is computed from `COMPOSE_CANCEL_TIMEOUT_MS + COMPOSE_TEARDOWN_DRAIN_MS + 1000`, not a literal (pinned by test/build-signal-teardown.test.js)
- [ ] Exit code is 130 for SIGINT and 143 for SIGTERM (pinned by test/build-signal-teardown.test.js)
- [ ] Both signal listeners are removed by the teardown and by the two existing shutdown paths, leaving zero listeners (pinned by test/build-signal-teardown.test.js)
- [ ] A SIGINT delivered to a real child-process build leaves `active-build.json` `aborted` and exits 130 (pinned by test/build-signal-teardown.test.js)
- [ ] That case uses a TAGGED agent and asserts its process group is gone afterwards — the receipt for C21, since a detached agent no longer dies from the terminal's own SIGINT (pinned by test/build-signal-teardown.test.js)

### Tests

`test/build-signal-teardown.test.js` (new). Most cases unit-test `runCancelTeardown` with a fake
client, a fake process object and a fake clock — including the C27 case above.

Two separate real cases, because R1 conflated them (C32):

1. **Tagged agent** — spawn a build in a child process whose agent is a tagged stratum dispatch
   (the fake `codex` of S07), send `SIGINT`, assert the exit code, the on-disk `aborted` record,
   that `flowCancel` was called once, **and that the agent's process group is gone**. That last
   assertion is the C21 receipt: a detached agent no longer dies from the terminal's own SIGINT.
2. **Local agent** — a unit case, not a child process: build the handle, dispatch a
   `localExecution: true` run through `runAndNormalize` with an injected `localQuery` that never
   settles, call `buildCancel.cancel()`, and assert the local run rejects. This is the D-F path
   and it needs no signal at all.

If the child-process harness proves unreachable, D-G's fallback applies — keep the unit cases
and say so in the test file's header rather than weakening an assertion.

### CHANGELOG

```
- **COMP-BUILD-CANCEL S06**: Ctrl-C on a running build now tears it down instead of setting a
  variable. The handler cancels the flow (bounded by `COMPOSE_CANCEL_TIMEOUT_MS`), aborts the
  build-level controller so local `isolation: none` agents die, kills the vision item, writes
  `active-build.json` `aborted` and exits 130 (SIGINT) / 143 (SIGTERM). A second signal during
  teardown exits immediately. The teardown, the outer catch and the build's own finally now have
  one ordering and one terminal owner between them, so a cancelled build cannot be terminalized
  twice or have the process exit out from under its own cleanup.
```

---

## 10. Slice S07 — the golden, against the real stratum server (D-G)

### The mechanism, and why it is this one

Stratum's own cancel tests fake a slow agent by dependency-injecting `runAgent`
(`stratum/ts/tests/mcp/flow_cancel.test.ts:106-123`). That is in-process and unreachable from
compose, which spawns `stratum mcp` as a subprocess (C10). Compose's existing "real TS MCP
server" golden looks like a fit but is not: it replaces `stratum.agentRun` wholesale
(`test/helpers/ts-agent-harness.js:79`), so no request ever reaches the server (C9).

**Chosen approach: a real server, a fake `codex` on its PATH.** Write an executable shell script
named `codex` into a tmpdir that prints a line and sleeps; put that dir first on the `PATH`
handed to `connect({ env })` (`lib/stratum-mcp-client.js:460`). `resolveCodexCommand` prefers a
PATH `codex` over the bundled SDK CLI (`stratum/ts/src/connectors/codex.ts:565-568`), the
connector reads the server's own `process.env` (`codex.ts:188`; `server.ts:324-326` passes no
`env`), and `ownProcessGroup` forces the exec transport with `detached: true`
(`codex.ts:199-200`, `:281-285`). The result is a genuine detached process group that the
registry can record and the sweep can SIGTERM — with no model call, no network and no cost.

`STRATUM_STATE_ROOT` and `STRATUM_AGENT_FG_ROOT` are pointed at the same tmpdir for **both**
clients, which is also how the test pins C11: the second client must find the first client's run.

### The flow

1. Client A connects to a real `stratum mcp` with the doctored env, and `stratum_plan`s a
   minimal consumer-fanout spec authored **for this test**. Never reuse a shipped preset as a
   dialect fixture.
2. Client A issues `stratum_agent_run` with `agent: 'codex'`, a fresh `cancellationId` and
   `flow: {runId, stepId, itemIndex: 0}`. Do not await it.
3. Poll the foreground registry directory until an entry for this `runId` reaches
   `state: 'running'` with a non-empty `groups` — the same wait stratum's own test uses
   (`stratum/ts/tests/mcp/flow_cancel.test.ts:127-139`). Cancelling before the pid is stamped is
   a different, legitimate scenario and is not what this asserts.
4. **Client B** — a second `StratumMcpClient` on its own server process, same env — calls
   `flowCancel(runId)`. It **resolves**; assert the success shape here (C32 — R1 wrote this step
   as if it might reject, contradicting step 5's assertion about client A's pending call).
5. Assert: the ack resolved with `flowSettled: true` and `acknowledged: true`; the fake `codex`
   process group is gone; client A's pending `stratum_agent_run` rejects; `stratum_audit(runId)`
   from client B reports `status: 'cancelled'`; and a **new** `stratum_agent_run` with `flow`
   against that run is refused `flow_not_running`.
6. Assert the exact key set of the resolved ack, settling C17 by observation.
7. Assert what an **unknown** runId does, confirming C4's pinned shape against the real server
   rather than trusting stratum's test transitively, and assert `isUnknownFlowError` returns
   false for the **resolved success** of step 4 and for a synthetic `CANCELLATION_*` envelope.
   (C43: step 4 resolves — it raises no error to compare against.)

**Both goldens skip on `win32`, with the reason printed.** A `cancellationId` makes an agent run
fail before spawn there (`requireProcessGroups`, `stratum/ts/src/connectors/cancellation.ts:17-19`,
`CANCELLATION_UNSUPPORTED_PLATFORM`), so every tagged dispatch these tests rely on is refused. A
silent skip would read as coverage; `t.skip('...')` with the platform reason does not.

The test must reap its own strays: track the fake `codex` pid and `process.kill(-pid, 'SIGKILL')`
in a `t.after`, exactly as `stratum/ts/tests/mcp/flow_cancel.test.ts` does with its `strays`
array. A leaked sleeper outliving the suite is a worse outcome than a skipped test.

### S07-2 The second golden: a real child `compose build`, aborted from a second process

The test above proves the **stratum contract**. It drives the client directly, so it proves
nothing about `lib/build.js` — no compose call site is exercised, and a blueprint whose entire
subject is compose wiring cannot rest there (C32).

**What exists to build on, verified:** no test in the repo spawns a full child `compose build`.
The two halves that must be combined are `test/ts-cutover-build-golden.test.js:133-160`, which
builds a real tmp project fixture (`.compose/compose.json` with `capabilities.stratum`, a
`pipelines/<name>.stratum.yaml`, a `docs/features/<CODE>/description.md`) and connects a real
stratum MCP server with an explicit env, and `test/judgment-trace.test.js:553`, which is the
repo's only `execFileSync('node', [join(REPO_ROOT, 'bin', 'compose.js'), ...])` child-CLI call.
Neither can be reused whole; the fixture shape from the first plus the child invocation from the
second is the pattern.

The test:

1. Build the ts-cutover-shaped project in a tmpdir, with a pipeline whose agents are **all
   codex**, so the fake `codex` on `PATH` serves every one of them.
2. `spawn('node', [bin/compose.js, 'build', '<CODE>'])` with the doctored env — the fake `codex`
   dir first on `PATH`, plus the shared `STRATUM_STATE_ROOT` and `STRATUM_AGENT_FG_ROOT`. Run
   headless (`gateOpts.nonInteractive` equivalent) so no gate blocks on a human.
3. **Two lanes in the fanout (C43).** A single sleeping agent proves nothing: it is killed
   before it returns, so its `runAndNormalize` rejects, `prepareIssuance` (`lib/build.js:1068`,
   `lib/consumer-fanout.js:742-810`) is never reached, and **no diff is ever captured** — the
   marker assertion would pass against a build that merged nothing for the ordinary reason.
   So the fake `codex` behaves by lane, keyed off its worktree or prompt:
   - **Lane A** writes its marker file and **exits normally**, so a real captured diff lands in
     the journal and is eligible to merge.
   - **Lane B** sleeps until it is killed.
   The abort lands while lane B is sleeping, with lane A already captured.
4. Wait until `active-build.json` reports `status: 'running'` with a `flowId` and the foreground
   registry has a recorded group.
5. From the **parent** process, run `compose build --abort` as a second child.
6. Assert what a **mid-fanout** abort can actually prove (C50):
   - `stratum_audit` reports `cancelled`;
   - lane B's process group is gone;
   - the build child exits non-zero;
   - `active-build.json` is `aborted` **with the build child's pid preserved**, not the aborter's;
   - **no merge transaction exists in the consumer journal** — the fanout never settled, so the
     gate was never reached;
   - **lane A's captured diff is still journaled** (the evidence is kept, per C2) **and its
     marker file is absent from the target tree** (the evidence was not landed).

The last pair is the end-to-end receipt for D5's actual requirement, "no patch captured after
the cancel is merged", and lane A is what makes it mean anything: without a completed lane there
is no captured diff, and the assertion would pass against a build that merged nothing for the
ordinary reason.

**What this test deliberately does not assert.** The post-apply reversal and its
`rollbackReason`. A fanout settles only when **every** item is terminal
(`stratum/ts/src/engine/engine.ts:2076`) and the merge runs only after the gate is ready
(`lib/build.js:4219`), so killing lane B mid-flight makes the merge unreachable by construction.
That path is pinned by `test/merge-cancel-fence.test.js` instead, which injects the race
directly. Asserting it here would be a test that can never fail.

### Acceptance criteria

- [ ] The contract test spawns a real `stratum mcp` (no `installAgentHarness`, no `_testClient`) and both clients share one `STRATUM_STATE_ROOT` and one `STRATUM_AGENT_FG_ROOT` under a tmpdir (pinned by test/integration/flow-cancel-golden.test.js)
- [ ] Step 4's cancel is asserted as a RESOLVED success, and step 5's pending agent call is asserted as a rejection — the two are not confused (pinned by test/integration/flow-cancel-golden.test.js)
- [ ] A real child `compose build` is aborted by a real `compose build --abort` from a second process, and the flow audits `cancelled` (pinned by test/integration/build-abort-golden.test.js)
- [ ] The child build's agent process group is gone after the abort (pinned by test/integration/build-abort-golden.test.js)
- [ ] `active-build.json` ends `aborted` with the BUILD child's pid, not the aborting child's (pinned by test/integration/build-abort-golden.test.js)
- [ ] Lane A's captured diff is still present in the consumer journal — a cancel keeps the evidence (pinned by test/integration/build-abort-golden.test.js)
- [ ] Lane A's marker file is absent from the target tree — nothing captured was merged (pinned by test/integration/build-abort-golden.test.js)
- [ ] No merge transaction exists in the journal, because a mid-fanout abort never reaches the gate (pinned by test/integration/build-abort-golden.test.js)
- [ ] The build child exits non-zero (pinned by test/integration/build-abort-golden.test.js)
- [ ] A tagged agent run produces a foreground registry entry reaching `state: 'running'` with a recorded group (pinned by test/integration/flow-cancel-golden.test.js)
- [ ] A cancel issued from a SECOND client settles the run: `flowSettled: true`, `acknowledged: true` (pinned by test/integration/flow-cancel-golden.test.js)
- [ ] The fake agent's process group is gone after the cancel returns (pinned by test/integration/flow-cancel-golden.test.js)
- [ ] `stratum_audit` reports `status: 'cancelled'` (pinned by test/integration/flow-cancel-golden.test.js)
- [ ] A subsequent `stratum_agent_run` carrying `flow` for that run is refused `flow_not_running` (pinned by test/integration/flow-cancel-golden.test.js)
- [ ] The resolved ack's key set is asserted literally, including `status` (pinned by test/integration/flow-cancel-golden.test.js)
- [ ] `flowCancel` against an unknown runId produces the C4 shape — absent `data`, ENOENT-shaped message — and `isUnknownFlowError` returns true for it and false for the `CANCELLATION_*` error raised earlier in the same test (pinned by test/integration/flow-cancel-golden.test.js)
- [ ] The tagged run's connector took the `exec` transport (C18), observed from the fake `codex` having been invoked at all — under the SDK transport it would not be (pinned by test/integration/flow-cancel-golden.test.js)
- [ ] No process spawned by the test survives it (pinned by test/integration/flow-cancel-golden.test.js)
- [ ] The test skips cleanly, with a stated reason, on `win32` — `CANCELLATION_UNSUPPORTED_PLATFORM` is refused before spawn (`stratum/ts/src/connectors/cancellation.ts:17-19`)

### Tests

`test/integration/flow-cancel-golden.test.js` (new) — the stratum-contract golden (S07-1).

`test/integration/build-abort-golden.test.js` (new) — the compose golden (S07-2).

Both live beside the existing real-server integration tests under `test/integration/`. The
fake-`codex` script and the project fixture are shared between them through one new helper,
`test/helpers/fake-codex-project.js`, since writing that script twice is how the two drift.
Both register a `t.after` that kills the tracked group.

### CHANGELOG

```
- **COMP-BUILD-CANCEL S07**: two golden integration tests against a real `stratum mcp` server.
  The first proves the contract — a flow-tagged agent run registers a real detached process
  group, a cancel issued from a SECOND client settles the run and kills that group, the audit
  reports `cancelled`, and a further tagged run is refused `flow_not_running`. The second proves
  the wiring — a real child `compose build` is stopped by a real `compose build --abort` from
  another process, ending with the flow `cancelled`, the agent's process group gone, the driver
  pid preserved in `active-build.json`, and the file the agent wrote after the cancel **not**
  merged into the target tree. Both use a fake `codex` executable on the server's PATH, so no
  model is called.
```

---

## 11. File Plan

| File | Action | Purpose |
|---|---|---|
| `lib/stratum-mcp-client.js` | edit | `flow` on the request, `cancellationId` minted with `flow`, `flowCancel()`, `isUnknownFlowError`, the two surface constants |
| `lib/build-cancel.js` | new | `createBuildCancel`, `isRunCancelled`, `looksCancelled`, `runCancelTeardown` |
| `lib/result-normalizer.js` | edit | `opts.buildSignal` chained to `stopRun`; `opts.flow` forwarded to both MCP dispatches |
| `lib/build.js` | edit | `buildCancel` created and threaded; four tagged call sites; `writeActiveBuild` `stampPid`; `abortBuild` rewrite; cancel detection; merge guard; signal handler |
| `bin/compose.js` | edit | three `--abort` exit-code paths; all three `.then`/`.catch` pairs await `pendingTeardown()` before exiting (C46) |
| `package.json` | edit | version `0.5.0`, stratum dep `^0.5.0` |
| `compose-mcp/package.json` | edit | version `0.5.0`, compose dep `^0.5.0` |
| `compose-mcp/server.json` | edit | version `0.5.0` in both places |
| `CHANGELOG.md` | edit | one entry per slice, in that slice's commit |
| `test/stratum-surface-guard.test.js` | new | S01 |
| `test/stratum-flow-cancel-client.test.js` | new | S02 |
| `test/build-cancel-unit.test.js` | new | S03 |
| `test/build-cancel-signal-chain.test.js` | new | S03 |
| `test/build-flow-tag.test.js` | new | S03 |
| `test/abort-build-cancel.test.js` | new | S04 |
| `test/build-cancel-detect.test.js` | new | S05 |
| `test/build-signal-teardown.test.js` | new | S06 |
| `test/integration/flow-cancel-golden.test.js` | new | S07-1, the stratum contract |
| `test/integration/build-abort-golden.test.js` | new | S07-2, the compose wiring |
| `test/helpers/fake-codex-project.js` | new | shared fake-`codex` script + project fixture for both goldens |
| `test/active-build-tmp-race.test.js` | new | S04, the C23 concurrent-writer receipt |
| `test/dispatch-ledger-transport.test.js` | new | S03, the C44/C51 receipt that a real tagged dispatch persists the field |
| `test/merge-cancel-fence.test.js` | new | S05, the only place the post-apply reversal is exercised (C50) |
| `lib/consumer-fanout.js` | edit | `restoreMergeBaseline` gains an optional `reason` recorded as `tx.rollbackReason` (C24); new `markRollbackFailed` (C40); new exported `MergeAfterCancelError` (C39) |
| `lib/dispatch-ledger.js` | edit | `transport_derived` added to `EVENT_FIELDS.dispatch.optional` (`:55-62`) AND to the `case 'dispatch'` validator (`:132-148`) — the ledger is default-deny (`:120-124`) and an unknown field makes `#recordAgentDispatch` drop the whole event silently (C44) |
| `lib/codex-preflight.js` | edit | the probe's controller also aborts on `buildCancel.signal` (C36) |
| `test/review-fixes-runtime.test.js` | edit | fixture advertises `flow`; expectations derived from the constants |
| `test/abort-build-engine.test.js` | edit | `fakeStratum` gains `flowCancel` |

`server/build-routes.js` is **not** edited: it already forwards `abortBuild`'s return value
(`:151-152`).

## 12. Boundary Map

### S01: version train and the surface constants
Produces:
  lib/stratum-mcp-client.js → REQUIRED_STRATUM_SURFACE, REQUIRED_STRATUM_RANGE (const)

Consumes: nothing (leaf node)

### S02: client flow tag and flow cancel
Produces:
  lib/stratum-mcp-client.js → buildAgentRunRequest, flowCancel, isUnknownFlowError, asTransportRefusal (function)
  lib/stratum-mcp-client.js → StratumError (class)

Consumes:
  from S01: lib/stratum-mcp-client.js → REQUIRED_STRATUM_SURFACE, REQUIRED_STRATUM_RANGE

### S03: build-level cancel handle and driver tagging
Produces:
  lib/build-cancel.js → createBuildCancel, isRunCancelled, flowTag (function)
  lib/build-cancel.js → registerBuildCancel, unregisterBuildCancel, lookupBuildCancel, pendingTeardown (function)
  lib/codex-preflight.js → preflightCodexWorktreeProbe (function)
  lib/result-normalizer.js → runAndNormalize (function)
  lib/build.js → runConsumerIssuance (function)

Consumes:
  from S02: lib/stratum-mcp-client.js → buildAgentRunRequest, flowCancel

### S04: abortBuild rewrite and the CLI/HTTP surface
Produces:
  lib/build.js → abortBuild, writeActiveBuild, isProcessAlive, claimActiveBuild (function)

Consumes:
  from S02: lib/stratum-mcp-client.js → flowCancel, isUnknownFlowError, asTransportRefusal
  from S03: lib/build-cancel.js → isRunCancelled, registerBuildCancel, unregisterBuildCancel, lookupBuildCancel

### S05: cancel detection and the no-merge rule
Produces:
  lib/build-cancel.js → looksCancelled, confirmCancellation (function)
  lib/build.js → reportConsumerStepDone, isTerminalFlow, decideBuildStart (function)
  lib/consumer-fanout.js → restoreMergeBaseline, markRollbackFailed (function)
  lib/consumer-fanout.js → MergeAfterCancelError (class)

Consumes:
  from S03: lib/build-cancel.js → createBuildCancel, isRunCancelled
  from S04: lib/build.js → writeActiveBuild

### S06: signal teardown
Produces:
  lib/build-cancel.js → runCancelTeardown (function)

Consumes:
  from S02: lib/stratum-mcp-client.js → flowCancel
  from S03: lib/build-cancel.js → createBuildCancel
  from S05: lib/build-cancel.js → looksCancelled

### S07: golden against the real server
Produces: nothing (integration only)

Consumes:
  from S02: lib/stratum-mcp-client.js → flowCancel
  from S03: lib/build-cancel.js → isRunCancelled

Wire formats — the `flow` request field, the `flow_cancel_unacknowledged` envelope, the
`active-build.json` record and the seven outcome classes of §7 — are prose in this blueprint,
not Boundary Map entries: they are not grep-checkable identifiers.

## 13. Out of scope

Copied from `decisions.md` §Out of scope, with the additions this blueprint found marked **(new)**:

- Preset `carry:` / `verify after: [execute_merge]` — COMP-FABLE-ASTRA slice 4; no preset exists yet.
- Reaching `isolation: none` agents from a second process other than via SIGTERM to the driver.
- ~~Tagging gate-time agents.~~ **Removed from Out of scope by the R1 ruling (2026-09-10).** The
  exclusion rested on a refusal that does not happen (C1), so v1 tags both gate-time sites and
  the `COMP-BUILD-CANCEL-GATE-TAG` follow-up is withdrawn. Listed here struck through rather
  than deleted so a reader of decisions.md finds out what happened to it.
- Windows (`CANCELLATION_UNSUPPORTED_PLATFORM`, `stratum/ts/src/connectors/cancellation.ts:17-19`).
- STRAT-LOCK-SCOPE — a judged ensure inside the run lock makes `run_lock_held` take up to 120s.
  Stratum follow-up; compose only retries.
- Cross-process env agreement. **Verified, not deferred (C11)**: compose sets no per-build state
  root, so both servers already agree.
- **(new)** GSD. `lib/gsd.js:510` calls `runConsumerIssuance` and `lib/gsd.js:689` calls
  `applyMerge`, but GSD is a different driver with its own supervisor
  (`lib/gsd-supervisor.js:129-138`). It passes no `buildCancel` and is behaviourally unchanged.
  Filed as **COMP-GSD-CANCEL**.
- **(new)** Background flows. Compose calls none of `stratum_flow_run_bg`, `stratum_flow_poll`,
  `stratum_flow_bg_poll` or `stratum_flow_cancel_bg` anywhere in `lib/`, and stratum's own
  background cancel abandons rather than settles.
- **(new)** An authoritative transport on the connector surface. `ConnectorResult` /
  `ConnectorTelemetry` carry none (`stratum/ts/src/connectors/base.ts:29-54`), so compose
  journals a derived value (C33). Filed as **STRAT-CONNECTOR-TRANSPORT-TELEMETRY**.
- **(new)** Closing the cross-process merge TOCTOU with a lock. `lib/consumer-fanout.js:1070-1079`
  states the window is inherent and pre-existing; C24 adds a post-apply reversal, not a lock.
- **(new)** Narrowing `abortBuild`'s two early refusals into structured CLI exit codes beyond
  0/1. They keep today's console lines and now return a shape; mapping them to distinct codes is
  a UX change nobody asked for.

## 14. Risks, and the falsifier for each

| # | Risk | Falsifier |
|---|---|---|
| R1 | A tag is added but the registry entry is never written, so a cancel returns `acknowledged: true` with every agent alive — the worst shape on this surface | S07 asserts a registry entry reaches `state: 'running'` with a recorded group before the cancel, and asserts the group is gone after. `node --test test/integration/flow-cancel-golden.test.js` |
| R2 | `isUnknownFlowError` over-matches and a live build is reported as "nothing to cancel", so `--abort` writes `aborted` over a running build | S07 records the real unknown-run shape and `test/stratum-flow-cancel-client.test.js` asserts the predicate rejects a `CANCELLATION_*` error, a transport error, and a generic `InternalError` with an unrelated message |
| R3 | `--abort` prints "Build aborted." after a refusal that swept nothing | `test/abort-build-cancel.test.js` row `run_lock_held`: asserts `active-build.json` is byte-unchanged, the vision item is untouched, and `ok === false`. `node --test test/abort-build-cancel.test.js` |
| R4 | The abort restamps `pid`, so the concurrent-build guard at `lib/build.js:2764-2766` later probes the wrong process | `test/abort-build-cancel.test.js` pid-preservation row reads `active-build.json` after an abort issued from a different pid and asserts `pid` still equals the driver's |
| R5 | Adding `flow` to the request breaks every call against a 0.4.x server, including in tests that previously passed | `node --test test/review-fixes-runtime.test.js test/execution-runtime.test.js test/stratum-surface-guard.test.js` — the old-server fixtures are the control, and the guard message is asserted from the constants |
| R6 | The version train is half-applied and a mismatched pair reaches a tag | `node --test test/version-sync.test.js` — four assertions, no edit permitted to that file |
| R7 | `buildSignal` listeners accumulate across a long build, leaking one per dispatch | `test/build-cancel-signal-chain.test.js` runs N sequential dispatches and asserts `getEventListeners`-equivalent count returns to zero |
| R8 | A patch captured after the cancel is merged anyway, which is the exact defect D5 names | `test/build-cancel-detect.test.js` merge-guard case: `applyMerge` is a spy that must record zero calls while the journal entry with its captured diff still exists |
| R9 | The signal handler's teardown hangs on a `flowCancel` that never resolves, and Ctrl-C stops working | `test/build-signal-teardown.test.js` deadline case: a never-resolving `flowCancel` under a fake clock must still reach `exit(130)` |
| R10 | S07 leaks a sleeping `codex` process group past the suite | The test's `t.after` kills the tracked group; the case asserts `process.kill(-pid, 0)` throws ESRCH before the test ends. `node --test test/integration/flow-cancel-golden.test.js && pgrep -f 'fake-codex' ; echo $?` (expect 1) |
| R11 | Detection triggers on an ordinary agent failure and aborts a healthy build | `test/build-cancel-detect.test.js` row `(agent_run_failed, audit=running)` asserts today's per-item failure behaviour is byte-identical — the audit is the authority, the predicate is only the trigger |
| R12 | The transport/detachment change reaches the **gate Q&A agent** — the one dispatch not already sending a `cancellationId` (C18, corrected) | `test/build-flow-tag.test.js` asserts that dispatch now carries a `cancellationId`; `COMPOSE_FLOW_TAGGING=0` reverts it without a release (S03-6); and the journal's `transport_derived` field shows which path each run took. Every other dispatch is unchanged, which the same test pins by asserting a `cancellationId` was already present before this feature |
| R13 | The one-shot re-sweep after `CANCELLATION_TEARDOWN_TIMEOUT` is later deleted as dead code, because it reads like a rare recovery when it is the common path (C19) | `test/abort-build-cancel.test.js` teardown-timeout row asserts `flowCancel` is called **exactly twice** and that local cleanup proceeds; the row's comment names C19 |
| R14 | Between S03 and S06 a Ctrl-C at a gate can orphan the gate Q&A agent, which is newly detached (C21, corrected — every other dispatch was already detached) | The ordering constraint after §2 is the mitigation; the detection is `test/build-signal-teardown.test.js`'s tagged child-process case, which sends a real SIGINT and asserts the agent's group is gone, so it fails if S03 ships without S06 |
| R15 | A same-process abort SIGTERMs the compose server, or leaves local agents alive (C22) | `test/abort-build-cancel.test.js` asserts `process.kill` is never called with `process.pid` on any row, and that the in-process row cancels through the handle |
| R16 | Two writers tear `active-build.json` (C23) | `test/active-build-tmp-race.test.js` — a real N-process race with zero parse failures. Confirm the test fires against the old shared-tmp code before trusting it |
| R17 | A cancel landing mid-`applyMerge` leaves a half-merged tree (C24) | `test/build-cancel-detect.test.js` post-apply case asserts the tree is back at `tx.baselineTree` and no issuance is still `merged`; `test/integration/build-abort-golden.test.js` asserts the agent's marker file is absent from the target tree |
| R18 | A cancelled build is terminalized `failed` and its feature marked `blocked` (C26) | `test/build-cancel-detect.test.js` terminal-status case asserts `aborted` / `killed` |
| R19 | An abort issued after a build finished overwrites its retained `complete` record (C31) | `test/abort-build-cancel.test.js` already-terminal row asserts zero writes |
| R20 | The teardown, the outer catch and the finally deadlock, or terminalize twice (C37) | `test/build-signal-teardown.test.js` asserts one terminal write and one `process.exit`, plus a wedged-pump case that must still terminalize on the `drained` deadline. A deadlock shows up as that test timing out |
| R21 | Adding `transport_derived` silently drops every dispatch ledger row (C44) | `test/dispatch-ledger-transport.test.js` asserts the persisted row exists AND carries the field; the "every dispatch still produces a row" criterion is the regression guard |
| R22 | A stale aborter kills a live build's vision item before discovering it lost ownership (C41) | `test/abort-build-cancel.test.js` `ownership_lost` row asserts zero writes of any kind, vision included |
| R23 | A cancelled build silently restarts as a fresh build instead of reporting (C42) | `test/build-cancel-detect.test.js` resume case asserts a named refusal and that no `plan` call was made |
| R24 | A sketch and its prose disagree, and the implementer follows the sketch (C45, C47, C48) | The consistency pass at the end of §14: every acceptance criterion names the slice line that delivers it. The mechanical version scans only FENCED code blocks above the Verification Table for `throw new ConsumerMergeDecisionError`, `void runCancelTeardown` and `const sameFlow = !cur` — a bare grep false-positives on the Corrections rows, which quote each defect on purpose |
| R25 | The CLI exits 1 through a teardown that has not written the record yet (C46) | `test/build-signal-teardown.test.js` asserts the CLI awaits `pendingTeardown()`, and the join bound is asserted to be derived rather than a literal |
| R26 | The post-apply reversal is never actually exercised, because the end-to-end test cannot reach it (C50) | `test/merge-cancel-fence.test.js` exists precisely for it and injects the race directly. If that file is missing, the path has no coverage at all |

---

## Verification Table

> **SUPERSEDED BY REVISION 2 (2026-09-10) — RE-VERIFY.** This pass verified the revision-1
> blueprint. Revision 2 rewrote C12, C14, C18 and C21, added C22–C33, and substantially changed
> S04, S05, S06 and S07, so the rows below no longer cover the document. Two verdicts are known
> to be stale rather than merely incomplete: the citations behind C18 and C21 were correct as
> *citations* while the *claims* built on them were overstated, which a per-citation pass cannot
> catch. Kept in full as the record of what was checked and when.

**Date:** 2026-09-10. **Verifier:** Claude Sonnet 5 (`claude-sonnet-5`), mechanical pass against
the compose working tree (`/Users/ruze/reg/my/forge/compose`) and stratum @ `6e4a68c` / `v0.5.0`
(`/Users/ruze/reg/my/forge/stratum`), both re-read the same day the blueprint claims grounding.

### Per-citation table

Every `path:line` / `path:line-line` citation in this blueprint, checked by opening the file at
that line and confirming the claimed function/signature/string/pattern appears at or within ±3
lines. Repeated citations (the same `path:line` used to support more than one claim) are
collapsed to one row. `verdict` is `OK` unless noted.

| Citation | Claim (short) | Verdict |
|---|---|---|
| `lib/build.js:5568,701,3482,3945` | `stratum_plan`/`stratum_step_done` call sites | OK |
| `lib/build.js:933` → `lib/result-normalizer.js:585` | consumer fanout agent dispatch chain | OK (585 falls inside the `runAndNormalize` MCP-dispatch block) |
| `lib/build.js:2976-2981`, `:2975-2981` | Ctrl-C sets one variable, closes stream | OK |
| `lib/build.js:5817-5827`, `:5799-5844`, `:5801`, `:5808`, `:5823-5825`, `:5829-5835`, `:5839-5842`, `:5843`, `:5815-5818` | `abortBuild` today: bare `catch{}`, no cancel, local writes | OK |
| `stratum/ts/src/mcp/server.ts:199-222`, `:200-205`, `:195` | flow tag → durable foreground registry record; cancellationId reuse refusal | OK |
| `lib/stratum-engine.js:248` | `resolveStratumMcpConnection` | OK |
| `stratum/ts/src/mcp/server.ts:291-302` | `abortLocal` finds nothing cross-process | OK |
| `lib/local-claude-connector.js`, `lib/result-normalizer.js:567` | `isolation:none` never enters stratum | OK |
| `lib/build.js:4374` | gate fixer dispatch (C1, S03-4, §1) | OK — exact |
| `stratum/ts/src/engine/engine.ts:1143-1145` | `admitFlowAgent` refuses on `status`/`cancelRequested`, not on a gate pause | OK |
| `stratum/ts/src/engine/engine.ts:1399,1621,3391,3410,3423` | the five `run.status` writers (completed×2, budget_exhausted, cancelled, failed) | OK |
| `lib/consumer-fanout.js:742` | `prepareIssuance` | OK |
| `lib/consumer-fanout.js:786` | `cumulativeDiff(...)` call | OFF-BY-2: actual line 788 (within tolerance) |
| `lib/build.js:4224`, `lib/gsd.js:689` | `applyMerge` call sites | OK |
| `lib/build.js:2252-2253` | `runBuild` discards `abortBuild`'s return | OK |
| `bin/compose.js:2860-2861,2977-2978,3088-3089` | three CLI entry points exit 0 unconditionally | OK |
| `stratum/ts/src/engine/engine.ts:1167` | unknown runId → `this.store.load(runId)` throws | OK |
| `stratum/ts/src/mcp/server.ts:477-485`, `:477-494` | `flow_cancel_unacknowledged` dispatcher branch | OK |
| `stratum/ts/src/mcp/server.ts:510` | raw rethrow for an uncoded `stratum_flow_cancel` failure | OK — exact (`if (!tool.startsWith("stratum_guard_")) throw error;`) |
| `stratum/ts/tests/mcp/flow_cancel_edges.test.ts:36-60` | pinned unknown-run shape: `McpError`, `data === undefined`, ENOENT-shaped message | OK |
| `lib/stratum-mcp-client.js:541-544` | `#callTool` copies `error.data.code` onto `error.code` | OK |
| `lib/stratum-mcp-client.js:540` | `error.rpcCode` preserved | OFF-BY-1: actual line 541 (within tolerance) |
| `lib/stratum-mcp-client.js:286-288` | guard message template (surface 17, `>=0.4.0`) | OK — exact |
| `test/review-fixes-runtime.test.js:25` | modern fixture field list | OK — exact |
| `test/review-fixes-runtime.test.js:73` | assertion regex hardcoding `surface: 17`/`0.4.0` | OK — exact |
| `test/execution-runtime.test.js:163-164` | second old-server fixture schema | OK — exact |
| `test/execution-runtime.test.js:176-178` | old-server rejection assertion | OK — exact |
| `test/execution-runtime.test.js:48` | suite already forces `STRATUM_CODEX_TRANSPORT: 'exec'` | OK |
| `lib/stratum-mcp-client.js:272` | `cancellationId` minted only under `signal` today | OK — exact |
| `stratum/ts/src/mcp/server.ts:182-186` | server refuses `flow` without `cancellationId` | OK |
| `lib/build.js:5815` | `opts.stratum ?? new StratumMcpClient()` | OK — exact |
| `test/abort-build-engine.test.js:28-33` | `fakeStratum` exposes only `connect`/`audit`/`close` | OK — exact |
| `test/ts-cutover-build-golden.test.js:154-160` | real-TS-server golden spawns the binary | OK |
| `test/helpers/ts-agent-harness.js:79` | `installAgentHarness` replaces `stratum.agentRun` wholesale | OK — exact |
| `stratum/ts/tests/mcp/flow_cancel.test.ts:106-123` | `spawningAgent` in-process `runAgent` injection | OK — exact |
| `stratum/ts/tests/mcp/flow_cancel.test.ts:127-139` | `waitForRecordedGroup` polling pattern | OK — exact |
| `stratum/ts/src/connectors/codex.ts:565-568,556-563` | `resolveCodexCommand` prefers PATH `codex` | OK — exact |
| `stratum/ts/src/connectors/codex.ts:188` | connector env = constructor's `options.env ?? process.env` (server passes none) | OK |
| `stratum/ts/src/mcp/server.ts:324-326`, `:326` | `agentRun` call passes no explicit `env`; `ownProcessGroup: true` iff `cancellationId` set | OK — exact |
| `stratum/ts/src/connectors/codex.ts:199-200,281-285,284` | `ownProcessGroup` forces `exec` transport, `detached: true` | OK — exact |
| `stratum/ts/src/connectors/codex.ts:126` | default transport is `sdk` | OK |
| `lib/stratum-mcp-client.js:460` | `connect()` accepts explicit spawn `env` | OK |
| `lib/flow-state.js:32` | the only production `STRATUM_STATE_ROOT` read | OK — exact |
| `lib/smartmemory-config.js:99-103` | `resolveStratumPolicyEnv` returns 3 keys or `{}` | OK — exact |
| `lib/build.js:2943-2949` | identity-guarded downgrade pattern (sameFlow/sameFeature) | OK |
| `lib/build.js:1471` | `writeActiveBuild` restamps `pid` unconditionally | OFF-BY-1: actual line 1472 (within tolerance) |
| `lib/build.js:1849` | pid named in concurrent-build refusal message | OK — exact |
| `lib/build.js:2764-2766` | pid read for liveness decision | OK — exact |
| `lib/build.js:1889,2088,2856,2948,4595,4613,5570,5603,5648` | the eight other `writeActiveBuild` call sites | OK — all confirmed unmodified call sites |
| `lib/result-normalizer.js:367-377` | `executionOptions` object | OK — exact (367-376) |
| `lib/result-normalizer.js:574` | "the local branch takes an `abortController`, not a signal" | **OFF-BY-8: actual line 566** (`abortController,` key in the local-dispatch options object); line 574 is an unrelated `telemetry:`/stream-write line inside the lane-stamp block |
| `lib/result-normalizer.js:583,749` | the two MCP dispatches' `signal: abortController.signal` | OK — exact |
| `lib/result-normalizer.js:433-434` | `abortController`/`stopRun` declared | OK — exact |
| `lib/local-claude-connector.js` | bare reference, no line claim | OK (file exists) |
| `lib/build.js:1937-1949` | `isProcessAlive`, `EPERM` → alive | OK — exact |
| `lib/process-termination.js:148` | `processTermination` export | OK — exact |
| `stratum/ts/src/engine/engine.ts:748,1306` | bare uncoded `Error("... is cancelled ...")` in `stepDoneLocked`/gate resolve | OK — exact |
| `stratum/ts/src/engine/engine.ts:873-877,524-528` | `PERSIST_ON_CANCELLED_RUN` on receipt/usage writes | OK |
| `stratum/ts/src/engine/engine.ts:3346-3349` | `flow_cancelled` commit/revert refusal | OK — exact |
| `stratum/ts/src/engine/engine.ts:1057-1061` | `stratum_audit` succeeds on a cancelled run | OK |
| `stratum/ts/src/engine/engine.ts:416-431` | `retainRun` lease writer | OK — exact |
| `stratum/ts/src/mcp/server.ts:307-309` | `cancelFlow` ack spread minus `settledByThisCall` | OK — exact |
| `test/execution-runtime.test.js:48`, `test/ts-cutover-pipeline-fanout-golden.test.js:474` | suite forces `exec` transport already | OK |
| `stratum/ts/src/engine/flow_cancel.ts:198-208,138-152` | post-settle vs pre-settle discriminator (`agents.unreachable`) | OK — exact |
| `stratum/ts/src/connectors/foreground_registry.ts:635-661` | sweep may not stamp a live server's entry settled | OK |
| `stratum/ts/src/engine/run_lock.ts:16,49-51` | `DEFAULT_CANCEL_LOCK_WAIT_MS = 120_000`, env-read `cancelLockWaitMs()` | OK — exact |
| `stratum/ts/src/engine/engine.ts:1188` | `cancelLockWaitMs()` applied at the lock-acquire call | OK — exact |
| `stratum/ts/src/connectors/claude.ts:80-92` | `spawnClaudeCodeProcess` hook, `detached`, only installed with `ownProcessGroup` | OK |
| `node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js:65-75` | MCP SDK spawns with no `detached` key | OK |
| `contracts/review-result.json:3-9` | `_source`/`_roadmap` fields | OK — exact |
| `lib/feature-validator.js:71` | `FEATURE_JSON_SCHEMA` path resolve | OK — exact |
| `lib/stratum-mcp-client.js:160-174` | `buildAgentRunRequest` body | OK — exact |
| `package.json:3,91` | version `0.4.2`; `"@smartmemory/stratum": "^0.4.5"` | OK — exact |
| `compose-mcp/package.json:3,11` | version `0.4.2`; `"@smartmemory/compose": "^0.4.2"` | OK — exact |
| `compose-mcp/server.json:6,11` | version `0.4.2` in both places | OK — exact |
| `test/version-sync.test.js:26-30,32,40-44,47-52,54-63` | `minorOf` + the four VERSION-SYNC assertions | OK — exact on every boundary |
| `lib/stratum-mcp-client.js:878` | `cancelAgentRun`, new `flowCancel` lands beside it | OK — exact |
| `stratum/ts/src/mcp/server.ts:200-205` | `stepId`/`itemIndex` copied verbatim into the registry record | OK |
| `stratum/ts/src/mcp/server.ts:195` | server refuses a reused `cancellationId` | OK — exact |
| `lib/stratum-mcp-client.js:520-523` | `_testClient` injection seam in `#callTool` | OK (seam at 517-524, claim within range) |
| `lib/stratum-mcp-client.js:283-289` | `#agentFields` refuses an unsupported key against an old server | OK |
| `lib/build-cancel.js` | new file, does not yet exist | OK — confirmed absent |
| `lib/build.js:933,907,751` | consumer-fanout tag site, `descriptor.itemIndex`, `runConsumerIssuance` param list | OK |
| `lib/build.js:3601,3356,3355` | ordinary step tag site, `stepId`/`flowId` in scope | OK |
| `lib/build.js:3508` | step fixer tag site | OK — exact |
| `lib/build.js:3686` | policy revision tag site | OK — exact |
| `lib/build.js:4363` | `gateStepId` in scope at the gate fixer site | OK |
| `lib/build.js:1974,3022,1981` | gate `askAgent` tag site; `context.flowId` set; `step_id ?? id` expression reused | OK — exact |
| `lib/stratum-mcp-client.js:855-860` | `runAgentText` → `#dispatchAgentRun` | OK (call at 857, within range) |
| `lib/stratum-mcp-client.js:273` | `buildAgentRunRequest({ ...opts, cancellationId })` | OK — exact |
| `test/usage-receipts.test.js:995` | `makeAskAgent(stratum, context, {...})` with no `flowId` | OK — exact |
| `lib/build.js:332,335,358` | `tier1CodexReview`/`tier2` stream writes pass `flowId: null` literally | OK — exact |
| `lib/import.js:217`, `lib/step-validator.js:42`, `lib/new.js:139,159,205` | untagged sites, no `flow_id` in scope | OK |
| `lib/bug-escalation.js:125,321` | `tier1CodexReview`/`tier2FreshAgent` `runAgentText` calls, outside a flow | OK |
| `lib/codex-preflight.js:131,77-88` | `preflightCodexWorktreeProbe` signature takes no flow id | OK — exact |
| `lib/experiment-judge.js:139`, `server/design-routes.js:462` | outside the build driver | OK |
| `lib/build.js:4386-4392,4366` | gate fixer reads only usage; `fixAgent = context.implementerAgent \|\| 'claude'` | OK |
| `lib/build.js:747-760,3198` | `runConsumerIssuance` signature, `runConsumerDescriptor` | OK |
| `lib/build.js:2267` | `let buildStatus = 'failed'` insertion point | OK — exact |
| `lib/build.js:1469-1477` | `writeActiveBuild` current body | OK |
| `bin/compose.js:2860,2977,3088` | the three `.then()` callbacks | OK |
| `server/build-routes.js:151-152` | already forwards `abortBuild`'s return via `res.json(result ?? {ok:true})` | OK — exact |
| `test/build-routes.test.js:221-235` | pins the three-argument `abortBuild` call | OK |
| `stratum/ts/src/mcp/server.ts:503-508` | generic `agent_run_failed` envelope shape | OK — exact |
| `lib/build.js:958-973,999-1017` | control-failure branch vs per-item failure envelope | OK |
| `lib/build.js:701,3482,3945,4260` | `stepDone`/`gateResolve` throw sites to wrap | OK |
| `lib/build.js:3275,3325` | `drainConsumerFatal`, `drainConsumersThenRethrow` | OK |
| `lib/build.js:4222-4226,4238-4240` | `applyMerge` call and its `ConsumerMergeDecisionError` catch/`repairFor` | OK |
| `lib/build.js:4593-4614,4611,4613` | terminal writes (complete/aborted) read current record first | OK |
| `lib/stratum-mcp-client.js:291` | `COMPOSE_CANCEL_TIMEOUT_MS` already read | OK (exact line: 292, within tolerance) |
| `lib/build.js:2297-2301` | `killed`/`aborted` map to the same terminal actuals status | OK — exact |
| `lib/build.js:4832` | build-history gate accepts `aborted` | OK |
| `lib/build.js:4965-4968,4980-4984` | the two `process.removeListener` sites | OK — exact |
| `stratum/ts/src/connectors/cancellation.ts:17-19` | `CANCELLATION_UNSUPPORTED_PLATFORM` refused before spawn on win32 | OK — exact |
| `../../../stratum/docs/features/STRAT-FLOW-CANCEL-FG/blueprint.md:2813-2840,:2841-2890` | §11 "the contract compose will call", §12 "Out of scope" | OK — section boundaries confirmed |
| `docs/features/COMP-FABLE-ASTRA/design.md:139-171,214-222` | D1 (loop-carried flow value), D5 (real cancellation) | OK |
| `docs/features/COMP-BUILD-CANCEL/explore-compose.md` (974 lines), `explore-stratum-full.md` (842 lines), `explore-stratum.md` (547 lines) | line counts as stated | OK — exact |
| `docs/features/COMP-BUILD-CANCEL/explore-stratum-s1s2.md` | "no longer exists" | OK — confirmed absent |
| `docs/features/COMP-BUILD-CANCEL/feature.json` | position 152, IN_PROGRESS, parent COMP-FABLE-ASTRA | OK — exact |
| `docs/features/COMP-BUILD-CANCEL/decisions.md` | D-A..D-G present | OK — all seven present |
| `.claude/rules/versioning.md`, `.claude/skills/compose/templates/boundary-map.md`, `CHANGELOG.md` | referenced files exist | OK |
| stratum commit `6e4a68c` / tag `v0.5.0` | grounding claim in the header | OK — confirmed via `git log`/`git describe` in the stratum checkout |

### Symbol checks

- `(existing)` symbols confirmed present by name: `buildAgentRunRequest`, `StratumError`, `cancelAgentRun`, `runAgentText`, `#dispatchAgentRun`, `#invokeAgentRun`, `#callTool`, `writeActiveBuild`, `abortBuild`, `isProcessAlive`, `runConsumerIssuance`, `makeAskAgent`, `preflightCodexWorktreeProbe`, `processTermination`, `resolveStratumMcpConnection`, `resolveCodexCommand`/`pathCodex`, `resolveCodexTransport`, `admitFlowAgent`-shaped guard (`run.status !== "running" || run.cancelRequested === true`), `retainRun`, `cancelFlowAgents`, `cancelLockWaitMs`, `requireProcessGroups`, `readFlowRound`, `resolveStratumPolicyEnv`, `validateBoundaryMap`/`parseBoundaryMap` (actual export names — the blueprint does not name-check these itself, checked as part of step 3 below).
- `(new)` files/symbols confirmed absent from the current tree: `lib/build-cancel.js` (whole file), and therefore `createBuildCancel`, `isRunCancelled`, `looksCancelled`, `runCancelTeardown` (no matches in `lib/`).
- One naming note, not a defect: `lib/boundary-map.js` exports `validateBoundaryMap({ blueprintText, blueprintPath, repoRoot })` — a single destructured-options argument, not `validateBoundaryMap(md, {root})` as informally described in the verification brief. Blueprint text itself makes no claim about this signature, so it is not a blueprint citation error.

### Boundary Map validator output

```json
{
 "ok": true,
 "violations": [],
 "warnings": []
}
```

### Summary

**148 distinct citations checked. 145 OK (exact or within ±3 lines). 3 OFF-BY-N within tolerance
(`lib/consumer-fanout.js:786` → actual 788; `lib/stratum-mcp-client.js:540` → actual 541;
`lib/build.js:1471` → actual 1472). 1 OFF-BY-N outside tolerance:
`lib/result-normalizer.js:574` → actual line 566 for the cited `abortController` key (C13). 0
STALE. 0 FILE-MISSING.** Boundary Map validator: `ok: true`, zero violations, zero warnings.

---

## Verification Table (revision 2)

**Date:** 2026-09-10. **Verifier:** Claude Sonnet 5 (`claude-sonnet-5`), re-verification pass
against the same two checkouts (compose working tree, stratum @ `6e4a68c` / `v0.5.0`), after the
blueprint was revised to ~1681 lines: C12/C14/C18/C21 rewritten, C22-C33 added, and slices
S04-S07 rewritten. This pass covers every citation new or changed since revision 1 — the C1-C20
citations that were unchanged text were not re-opened, since they were already checked and the
file content they point at has not moved.

**The revision-1 finding is fixed.** C13 now reads `lib/result-normalizer.js:566` for the local
branch's `abortController` key — confirmed exact — instead of the stale `:574`.

### Per-citation table — new and changed since revision 1

| Citation | Claim (short) | Verdict |
|---|---|---|
| `server/build-routes.js:134,151` | `runBuild` and `abortBuild` called in the same express process (C22) | OK — exact |
| `lib/build.js:1472` | `writeActiveBuild`'s shared `.tmp` name (C23) | OFF-BY-2: actual line 1474 (`const tmp = target + '.tmp';`), within tolerance |
| `lib/consumer-fanout.js:1085` | `mergeDiffIntoWorkingTree` call (C24) | OFF-BY-1: actual line 1084, within tolerance |
| `lib/consumer-fanout.js:1092` | `checkoutTreeDelta` call (C24) | OFF-BY-1: actual line 1091, within tolerance |
| `lib/consumer-fanout.js:1094-1100` | witness-mismatch check/throw (C24) | OK — actual 1093-1098, within tolerance |
| `lib/consumer-fanout.js:1088-1091` | `trackedTree` comment (C24) | OK — actual comment+assignment span 1085-1090, within tolerance |
| `lib/consumer-fanout.js:1070-1079` | TOCTOU already documented (C24, and again in S05-3) | OK — exact span |
| `lib/consumer-fanout.js:1168` | `restoreMergeBaseline(transaction, audit)` definition (C24) | OK — exact |
| `lib/consumer-fanout.js:1177` | `tx.baselineTree` restore call | OFF-BY-1: actual line 1176, within tolerance |
| `lib/consumer-fanout.js:1191-1210` | flip `merged` → `accepted`/`superseded` loop | OK — loop starts exactly 1191, ends within tolerance of 1209 |
| `lib/consumer-fanout.js:1168-1214` | whole `restoreMergeBaseline` function (S05-3) | OK |
| `lib/consumer-fanout.js:1179` | `tx.rollbackReason` sits beside `tx.rolledBackAt` (S05-3) | OFF-BY-1: actual line 1178, within tolerance |
| `lib/build.js:4251-4253` | "already the non-approve path" for the merge-baseline restore (C24, S05-3) | **OFF-BY-3 to -5, at the edge of tolerance: the actual `if (consumerMergeArtifacts && outcome !== 'approve' ...)` guard is at line 4256 and the call it guards at 4257**, not 4251-4253 (which is the tail of the preceding `afterMergeApplyBeforeGateResolve` hook block). Borderline — flagged, not counted as full OFF-BY-N |
| `lib/build.js:3601-3618` | ordinary step agent try/catch, rejects before `stepDone` (C25) | OK — exact (try opens 3600/3601, catch at 3618/3619) |
| `lib/build.js:4931-4932` | outer catch sets `buildStatus='failed'` unconditionally, calls `terminalizeThrownBuild` (C26) | OK — exact (4931 `buildStatus = 'failed'`, 4935 the call, within range) |
| `lib/build.js:2088-2094` | writes `status: 'failed'` | OK — exact (this is inside `writeFailedBuildTerminalState`, which `terminalizeThrownBuild` calls; the blueprint's one-hop-removed phrasing is accurate in effect) |
| `lib/build.js:2106` | flips vision item to `blocked` | OK — exact |
| `lib/build.js:4598-4614` | `killedByGate` aborted branch | OK — exact (`} else if (killedByGate) {` at 4598) |
| `stratum/ts/src/engine/flow_cancel.ts:128-141` | `cancelFlow` rethrows every non-`RUN_LOCK_TIMEOUT`/non-`CANCELLATION_UNCONFIRMED` error untouched (C28) | OK |
| `stratum/ts/src/engine/flow_cancel.ts:126-129` | comment naming ENOENT explicitly | OK |
| `lib/build.js:2012-2014` | `isTerminalFlow` definition | OK — exact |
| `lib/build.js:2770` | local-status short-circuit (`['complete','aborted','killed']`) | OK — exact |
| `lib/build.js:2772-2775` | audit consulted only when pid not alive; `flowTerminal = isTerminalFlow(audit?.status)` | OK — exact (else-if at 2772, the assignment at 2775) |
| `lib/build.js:2775,2834,3334,4274,4565,5820` | the seven (incl. definition) `isTerminalFlow` call sites (C30) | OK — all six call sites confirmed exact |
| `lib/build.js:2802` | `stratum.resume(resumeFlowId)` call | OFF-BY-3: actual line 2805, at the edge of tolerance |
| `lib/build.js:2772` | pid-alive path skips the audit entirely | OK — exact (same `else if` as above) |
| `lib/build.js:4593-4596` | retained `complete` record comment context (C31) | OK |
| `lib/build.js:4929` | "File retained on disk per STRAT-COMP-4" comment | OK — exact |
| `stratum/ts/src/connectors/base.ts:29-33` | `ConnectorTelemetry = {durationMs, model, effort?}` (C33) | OK — exact |
| `stratum/ts/src/connectors/base.ts:35-54` | `ConnectorResult` fields (`usdSource`, `split`, `text`, `usage`, `telemetry` — no transport) (C33) | OK — actual interface spans 35-55, within tolerance |
| `lib/result-normalizer.js:566` | local branch's `abortController` key (C13, corrected from rev 1's `:574`) | OK — exact, fix confirmed |
| `lib/result-normalizer.js:565-566` | "an injected `localQuery` (the seam at ...)" — S03 Tests section | **OFF-BY-8, outside tolerance: `localQuery` is actually defined at lines 557-558** (`const localQuery = opts.localQuery ?? (...)`), not 565-566, which falls inside the local-dispatch options object several lines later. Present in both revision 1 and 2; not previously reported |
| `lib/stratum-engine.js:248`, `stratum/ts/src/mcp/server.ts:291-302` | unchanged §1 boundary-table citations | OK (unchanged text, re-confirmed not required — content has not moved) |
| `test/ts-cutover-build-golden.test.js:133-160` | real tmp project fixture + real stratum server connect (S07-2) | OK |
| `test/judgment-trace.test.js:553` | the repo's only `execFileSync('node', [join(REPO_ROOT,'bin','compose.js'), ...])` child-CLI call | OK — exact citation. Caveat, not a citation defect: `test/init.test.js` and `test/lineage.test.js` also spawn `compose.js` as a child via a `COMPOSE_BIN` constant, so "the repo's only child-CLI call" is a slight overstatement if read as "the only test that spawns compose.js at all" — the literal grep pattern the sentence names is still unique |
| `lib/gsd-supervisor.js:129-138` | GSD's "own supervisor" | OK — plausible support (`defaultKillChild`), descriptive rather than a precise pinpoint claim |
| `lib/build.js:1994` | `askAgent` returns only text | OK — exact (`return text \|\| '(no answer)';`) |

### New/changed symbols

- `(new)`, confirmed absent from the tree: `lib/build-cancel.js` (still absent — `flowTag`, `registerBuildCancel`, `unregisterBuildCancel`, `lookupBuildCancel`, `confirmCancellation`, `beginTeardown`/`teardownStarted` on the handle are all correctly unimplemented), `test/helpers/fake-codex-project.js`, `test/integration/build-abort-golden.test.js`, `test/active-build-tmp-race.test.js`.
- `(existing)`, confirmed present: `restoreMergeBaseline` (`lib/consumer-fanout.js:1168`), `isTerminalFlow` (`lib/build.js:2012`), `terminalizeThrownBuild`/`writeFailedBuildTerminalState` (`lib/build.js:2073`, `:2161`).

### Boundary Map validator output (revision 2)

```json
{
 "ok": true,
 "violations": [],
 "warnings": []
}
```

### Summary (revision 2)

**~65 new/changed citations checked (C22-C33 plus the rewritten S04-S07 sections). 61 OK (exact
or within ±3 lines). 3 OFF-BY-N within tolerance not separately itemized above. 1 borderline
citation at the edge of tolerance (`lib/build.js:4251-4253` → actual 4256-4257) and 1 second
borderline (`lib/build.js:2802` → actual 2805). 1 genuine OFF-BY-N outside tolerance:
`lib/result-normalizer.js:565-566` for the `localQuery` test seam → actual lines 557-558 (present
since revision 1, not previously caught). 0 STALE. 0 FILE-MISSING. The revision-1 finding
(`lib/result-normalizer.js:574`) is confirmed fixed — now `:566`, exact.** All `(new)` symbols
confirmed absent from the tree; all `(existing)` symbols confirmed present. Boundary Map
validator: `ok: true`, zero violations, zero warnings.

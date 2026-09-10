# Stratum cross-process flow cancel — exploration for COMP-BUILD-CANCEL

Repo: `/Users/ruze/reg/my/forge/stratum` @ `6e4a68c` (tag v0.5.0, `ts/package.json:3` = `0.5.0`).
Read-only. Sections 1 and 2 (agent_run schema/admission, flow_cancel request/response) are
covered by the sibling explorer and are not repeated except where the cross-process story needs
them.

---

## 3. The cross-process story

### 3a. Which runs hold a driver lease

**A driver lease is written by `retainRun` only, and `retainRun` is the PIN.** `prepareLease`
does NOT write a lease — it only resolves an incumbent one.

`ts/src/engine/engine.ts:416-439` (`retainRun`):

```ts
  private retainRun(runId: string, run: PersistedRun): void {
    const active = this.activeRuns.get(runId);
    if (active) { active.refs += 1; return; }
    if (this.selfStartTime === undefined) {
      throw Object.assign(
        new Error(`cannot establish process identity; run ${runId} cannot be pinned`),
        { code: "RUN_LOCK_IDENTITY_UNAVAILABLE" },
      );
    }
    const token = writeDriverLeaseSync(this.store.root, runId, this.selfStartTime, this.driverLeases.get(runId));
    this.activeRuns.set(runId, { run, refs: 1 });
    this.driverLeases.set(runId, token);
  }
```

`ts/src/engine/engine.ts:449-462` (`prepareLease`) reads the lease, returns silently when it is
ours by token, reclaims it when the owner probes `dead`, and otherwise throws
`DRIVER_LEASE_HELD` with `holderPid`. It writes nothing.

The four `retainRun` call sites and their conditions:

| `engine.ts` | Caller | Fires for a compose foreground consumer-dispatch run? |
|---|---|---|
| `:626` | `flowRunBg` (after `prepareLease` at `:625`) | **No** — bg only, and consumer fanout is rejected for bg at `:697-703` (`consumer_dispatch_bg_unsupported`) |
| `:705` | `rehydrateBgFlows` (after `prepareLease` at `:704`) | **No** — guarded by `if (!run.bgDriven ...) continue` (`ts/src/engine/engine.ts:687-689`, re-checked under the lock at `:1003`) |
| `:1211` | `gateResolve` bg re-kick (after `prepareLease` at `:1210`) | **No** — only when `rekick`, i.e. `bgFlows.get(runId)?.status === "paused_gate"` (`:1196-1197`) |
| `:1900` | `scheduleFanout` | **No** — `scheduleFanout` returns at `ts/src/engine/engine.ts:1886` for `dispatch === "consumer"`: `if (scheduledStep?.fanout?.dispatch === "consumer") return;` |

**So: `stratum_plan` on a foreground consumer-dispatch run writes NO lease.** `plan`
(`:610-593`, lock at `:591`) persists and advances; the only pin path it can reach is
`scheduleFanout`, which returns early for consumer dispatch.

**`stratum_resume` also writes NO lease for a consumer-dispatch run — the compose explorer's
claim is REFUTED.** `resumeLocked` calls `await this.prepareLease(runId)` at
`ts/src/engine/engine.ts:1036`, and the comment above it says exactly why (`:1029-1035`): resume
is the takeover entry point, so an INCUMBENT lease must be resolved before `scheduleFanout` can
pin. The pin itself is at `:1052`:

```ts
    for (const step of flow.steps) if (step.fanout && run.steps[step.id]?.status === "running") this.scheduleFanout(run, step.id);
```

and `scheduleFanout` returns at `:1886` for consumer dispatch, so `retainRun` is never reached.
`engine.ts:704` is `rehydrateBgFlows`, not resume, and is `bgDriven`-only.

Consequences for compose:

- A resumed compose build does **not** refuse an out-of-process cancel with
  `engine_dispatch_active`. It has no lease to refuse with.
- `prepareLease` at `:1036` can still THROW on resume — `DRIVER_LEASE_HELD` — but only if some
  *other* live process left a lease on that run. For a consumer-dispatch build that never
  happens.
- Blueprint §2.1b states the same boundary: "Compose's consumer-dispatch team builds are never
  pinned (`scheduleFanout` returns at `engine.ts:1524`), so they have no lease and cross-process
  cancel works for them with no caveats" (`docs/features/STRAT-FLOW-CANCEL-FG/blueprint.md:441-443`).
  The `:1524` line number is the pre-implementation one; the shipped line is `:1886`.

**Lease liveness check.** `flowCancel` → `claimDriverLease`
(`ts/src/engine/engine.ts:1115-1129`):

```ts
  private async claimDriverLease(runId: string): Promise<void> {
    const lease = readDriverLeaseSync(this.store.root, runId);
    if (lease === undefined) return;
    if (this.driverLeases.get(runId) === lease.token) return;   // ours
    const state = await this.identity(lease.pid, lease.startTime);
    if (state === "dead") { releaseDriverLeaseSync(this.store.root, runId, lease.token); return; }
    throw Object.assign(
      new Error(`run ${runId} is driven by pid ${lease.pid}; cancel must be issued from that process`),
      { code: "CANCELLATION_UNCONFIRMED", reason: "engine_dispatch_active", holderPid: lease.pid },
    );
  }
```

Liveness is **pid + process start time**, not pid alone: `processIdentity` is tri-state
(`ts/src/connectors/proc_identity.ts`, contract in blueprint §2.1a) — `dead` only on ESRCH or a
readable-but-mismatched start time; EPERM or an unreadable start time is `unknown`, and
`unknown` **refuses** exactly like `alive`. Ownership is by TOKEN, never by identity
(`writeDriverLeaseSync` comment, `ts/src/engine/run_lock.ts:389-402`): two engines in one
process share pid+startTime, so same-identity is not same-owner.

**Release:** `releaseRun` (`ts/src/engine/engine.ts:465-484`) on the final unref (refs → 0),
token-and-inode-checked (`unlinkOwnSync`, `run_lock.ts:459-470`). The token is forgotten only
after a successful unlink (F5), so a transient unlink failure keeps the reclaim path open. A
crashed driver's lease file survives on disk and is reclaimed by the next `prepareLease` /
`claimDriverLease` that probes the owner `dead`.

Order inside `flowCancel` matters: the durable status is read from DISK **before** the lease
decision (`engine.ts:1160-1176`), so an already-terminal or already-cancelled run is never
refused with `engine_dispatch_active` — that is what makes a re-sweep after a teardown timeout
possible.

### 3b. Does a second process's cancel acquire the run lock while the driver is inside `stratum_agent_run`?

**Yes.** `stratum_agent_run` is not inside any run-lock section. The dispatcher
(`ts/src/mcp/server.ts:310-390`) takes the run lock only inside `engine.admitFlowAgent`
(`ts/src/engine/engine.ts:1136-1146`), which is `withRunLock(runId, () => this.loadRun(runId))`
— a load and release, once before the spawn (`server.ts:227`) and once per landed pid
(`server.ts:345`). Between those, the driver holds nothing. The long agent await is lock-free.

For a foreground consumer-dispatch build the driver process holds the run lock only during
`stratum_plan` and each `stratum_step_done` / `stratum_gate_resolve`.

`run_lock_held` means: `flowCancel`'s `acquireRunLock` did not get the file lock within
`STRATUM_CANCEL_LOCK_WAIT_MS` (default **120000**, `ts/src/engine/run_lock.ts:16`,
`flowCancel` passes it at `engine.ts:1189`). `acquireRunLock` throws `RUN_LOCK_TIMEOUT` with
`holderPid`; `cancelFlow` normalises it to
`CANCELLATION_UNCONFIRMED{reason:"run_lock_held", holderPid, flowSettled:false, status:"running", agents: all-zero}`
(`ts/src/engine/flow_cancel.ts:139-152`) and **mutates nothing and sweeps no agent**.

When does the driver hold the lock long enough to matter (STRAT-LOCK-SCOPE)? Blueprint
§2.1b, `docs/features/STRAT-FLOW-CANCEL-FG/blueprint.md:395-402`:

- `stepDoneLocked` → `settleStepAttempt` → `runEnsures` → `this.judge(...)` — a judged ensure is
  an LLM call, inside the lock.
- `advanceScopeLoop`'s `evaluate:` arm → `this.evaluateRunner(...)` — same.

The default run-lock timeout is 300000 (`run_lock.ts:14`) precisely because a judged ensure
routinely outlives 30s. So a compose abort issued while the driver is mid-`stepDone` with a
judged ensure waits up to 2 minutes, then reports `run_lock_held` **without cancelling
anything**. Retrying is the caller's job.

Staleness of the lock itself is decided by process identity, never by age (blueprint §2.1a
stale-break protocol, `run_lock.ts:332-376`): a dead driver's lock is broken under a break-lock
with an inode re-check; a live or `unknown` owner's lock is never broken.

### 3c. What the driver sees after the cancel settles

**The in-flight `stratum_agent_run`.** Two different paths, and compose gets the second one:

1. *Same-process cancel* (the cancel tool runs on the driver's own MCP server): `abortLocal`
   (`ts/src/mcp/server.ts:291-302`) aborts each matching `AbortController` with
   `new Error("Flow cancelled")`. The connector's `signal.throwIfAborted()`
   (`ts/src/connectors/codex.ts:400`, `ts/src/connectors/claude.ts:57`, `:194`) rethrows THAT
   error — a plain `Error` with **no `code`**.
2. *Cross-process cancel* (compose's `--abort` second server): the abort process holds no
   controllers, so `abortLocal` finds nothing and returns immediately. The child dies from the
   registry sweep's SIGTERM/SIGKILL to its process group. In the driver, `codex.runExec` sees
   `close` with a nonzero code and no agent text, and throws at
   `ts/src/connectors/codex.ts:409`: `throw new Error(stderr.trim() || \`codex exited with code ${exitCode}\`)`.

Either way the dispatcher's catch (`ts/src/mcp/server.ts:493-503`) wraps it:

```ts
          const data = { code: failure.code ?? "agent_run_failed", ... };
          throw await registryError("agent_run_failed", ErrorCode.InternalError, failure.message ?? String(error), data);
```

**There is no `agent_cancelled` code.** The driver's MCP call rejects with error envelope
`agent_run_failed`, `data.code === "agent_run_failed"` (no connector code is set on either
path), and a message that is either `Flow cancelled` (same-process) or
`codex exited with code 143` / captured stderr (cross-process). `usage`/`split`/`telemetry` ride
along when the connector attached them (`codex.ts:410-411`). MCP `ErrorCode.InternalError`.

Timing: `processTermination` (`ts/src/connectors/cancellation.ts:36-84`) sends SIGTERM to the
group, waits `STRATUM_CANCEL_GRACE_MS` (default 5000), SIGKILLs, awaits `close`, then reaps the
group with a 2000 ms deadline (`REAP_TIMEOUT_MS`). A reap overrun throws
`CANCELLATION_TEARDOWN_TIMEOUT`; other teardown failures are stamped `CANCELLATION_UNCONFIRMED`
(`cancellation.ts:75-79`) and those DO reach `data.code`.

**Subsequent engine calls on a cancelled run.** Exact shapes:

| Call | Result | Where |
|---|---|---|
| `stratum_step_done` | throws plain `Error("run <id> is cancelled; outstanding step issuances cannot be resolved")`, **no `code`**, no declared envelope — reaches the client as a raw MCP `InternalError` (`server.ts:504` rethrows anything non-agent, non-guard) | `engine.ts:748` |
| `stratum_step_done` (bg-driven run) | pre-lock refusal `Error("run <id> is background-driven; external stepDone is not permitted (poll via flow_bg_poll)")` | `engine.ts:3251-3263` |
| `stratum_gate_resolve` | throws plain `Error("run <id> is cancelled; gate <stepId> cannot be resolved")`, no code | `engine.ts:1306` |
| `stratum_resume` | throws plain `Error("run <id> is cancelled; resume is not permitted")`, no code | `engine.ts:1027-1029` |
| `stratum_plan` | unaffected — `plan` mints a NEW run id (`engine.ts:578`); it never touches the cancelled one |
| `stratum_audit` | **succeeds**, `status: "cancelled"`, full events incl. `flow_cancelled` | `engine.ts:1057-1061`; contract declares the `cancelled` variant |
| `stratum_flow_poll` / `stratum_flow_bg_poll` | succeed, `cancelled` variant declared | `ts/contracts/mcp-surface.json` |
| `stratum_usage_report` | throws `PERSIST_ON_CANCELLED_RUN` — `Error("run <id> is cancelled; no further receipts are accepted")` | `engine.ts:873-877` |
| `withReceiptUpdate` | throws `PERSIST_ON_CANCELLED_RUN` | `engine.ts:524-528` |
| `stratum_commit` / `stratum_revert` | `CheckpointOperationError("flow_cancelled", "Flow '<id>' is cancelled; commit is not permitted")`, returned as the declared checkpoint error ENVELOPE (not a throw) — `errorType: "flow_cancelled"` | `engine.ts:3346-3349`, `server.ts:471-475`, `engine.ts:321` |
| `stratum_flow_cancel` again | **succeeds**, `flowSettled: true`, `reason: "already_cancelled"`, and re-sweeps the agents | `engine.ts:1163-1174` |
| any internal `persist` | `PERSIST_ON_CANCELLED_RUN` unless it is `terminalCancel`'s own sanctioned write | `engine.ts:3510-3517` |

**There is no `run_cancelled` and no `RUN_NOT_RUNNING` code anywhere in the engine.** The only
codes on this path are `PERSIST_ON_CANCELLED_RUN`, `FLOW_NOT_RUNNING` (from `admitFlowAgent`
only, surfaced as the `flow_not_running` MCP envelope), `CANCELLATION_UNCONFIRMED`,
`CANCELLATION_TEARDOWN_TIMEOUT`, `DRIVER_LEASE_HELD`, `RUN_LOCK_TIMEOUT`,
`RUN_LOCK_IDENTITY_UNAVAILABLE`, `FLOW_ADMISSION_FAILED`.

A NEW `stratum_agent_run` with `flow: {runId}` against a cancelled run is refused before the
spawn: `admitFlowAgent` throws `FLOW_NOT_RUNNING` (`engine.ts:1143-1145`) and the dispatcher maps
it to the declared envelope `flow_not_running` with `ErrorCode.InvalidRequest` and
`data: {code: "flow_not_running", runId}` (`server.ts:123-128`). Same check re-runs after each
pid lands (`server.ts:345-352`), and on failure that child's group is killed and reaped.

---

## 4. `cancelled` RunStatus and the `flow_cancelled` event

`RunStatus` (`ts/src/engine/state.ts:8`):
`"running" | "completed" | "failed" | "budget_exhausted" | "cancelled"`.
`BgStatus` gains it too (`engine.ts:238`).

`stratum_audit` response for a cancelled run (`ts/contracts/mcp-surface.json`,
`tools.stratum_audit.responses.cancelled`) — identical shape to the other statuses:

```json
{ "runId": "string", "events": "array", "steps": "object", "flowSpent": "object", "output?": "any", "carry?": "object" }
```

`cancelled` is declared on `stratum_audit`, `stratum_flow_poll`, `stratum_flow_bg_poll`,
`stratum_flow_cancel_bg`, `stratum_flow_cancel`, `stratum_cancel_agent_run` — and deliberately
NOT on `stratum_plan`, `stratum_resume`, `stratum_step_done`, `stratum_gate_resolve`,
`stratum_revert`, which refuse instead (pinned by `ts/tests/mcp/flow_cancel.test.ts:390-404`).

`flow_cancelled` event, appended to the union at `ts/src/engine/state.ts:201`. Emitted once by
`terminalCancel` (`engine.ts:3407-3421`):

```ts
  private async terminalCancel(run: PersistedRun, reason?: string): Promise<EngineResponse> {
    run.cancelRequested = true;
    const burned = burnIssuances(run);
    run.status = "cancelled";
    this.event(run, "flow_cancelled", undefined, { by: "fg", ...(reason !== undefined ? { reason } : {}), burned });
    await this.persistTerminalCancel(run);
```

Events contract 4 (`ts/contracts/events.json`, `"events": 4`), kind:

```json
"flow_cancelled": { "detail": { "by": "string", "reason?": "string",
  "burned": { "steps": { "$array": "string" }, "items": "number" } } }
```

No `stepId` — a cancel is run-scoped. `burned` is the audit evidence: step ids whose
dispatch/gate token was deleted and the count of fanout items whose token was deleted
(`burnIssuances`, `ts/src/engine/state.ts:278-300`). Event validation is default-deny at the MCP
boundary (`server.ts:452-454`), so an undeclared detail key fails the tool call.

**MCP wire note:** `settledByThisCall` is stripped before the response is emitted
(`server.ts:305-308`) — it is engine-internal and would trip the default-deny response check.
So compose sees `{runId, status, flowSettled, acknowledged, reason?, ledger, agents}`.

---

## 5. Foreground agent registry `~/.stratum/ts/agent_fg/<12hex>/meta.json`

Root: `ts/src/connectors/foreground_registry.ts:13-15`, overridable by
`STRATUM_AGENT_FG_ROOT` (`:60-62`) or the `foregroundRegistryRoot` dependency. Deliberately a
sibling of the background registry so a foreground record can never be loaded and killed as a
detached background run (`:9-12`).

**Write conditions — the record only exists when `flow` is supplied.**
`ts/src/mcp/server.ts:203-232`: the `createForegroundRun({state: "starting", ...})` call is
inside `if (isRecord(request.flow))`. A `stratum_agent_run` with a `cancellationId` but **no
`flow`** creates an AbortController and nothing durable — invisible to any other process. `flow`
without `cancellationId` is rejected up front (`server.ts:182-186`).

Lifecycle (`foreground_registry.ts:74-84`): `starting` (record written before the spawn) →
`running` (`recordForegroundGroup` appends `{childPid, procStartTime}` from the connector's
`onSpawn`, `server.ts:330-345`) → `settled` (dispatcher `finally`, `server.ts:518-526`; never
deletes the directory). A `procStartTime` that cannot be read is a **registration failure**, not
a degraded success (`server.ts:337-341`) — the run is aborted and the child killed, because an
entry without a start time can never be signalled.

`ownProcessGroup` semantics: set on the connector iff a `cancellationId` was supplied
(`server.ts:326`). In codex it forces the `exec` transport and `detached: true`
(`ts/src/connectors/codex.ts:196-200`, `:284`), so the child IS a process group leader and
`process.kill(-pid, sig)` reaches its whole descendant tree. Claude uses the SDK's
`spawnClaudeCodeProcess` hook with `detached: process.platform !== "win32"`
(`ts/src/connectors/claude.ts:86-93`), and may spawn more than once — hence `groups` is an
array. Windows fails before spawn with `CANCELLATION_UNSUPPORTED_PLATFORM`
(`ts/src/connectors/cancellation.ts:17-19`).

**So yes: SIGTERM to the group reaches a `codex exec` / `claude` child tree** — provided the run
was dispatched with `cancellationId` AND `flow`, on POSIX. Anything the agent starts that
deliberately leaves the group (`setsid`, a daemon) is outside the contract (README:507).

`signalFlowAgents` (`foreground_registry.ts:487-501`): one pass — scan the registry for entries
whose `flow.runId` matches, then send each unsignalled group exactly one SIGTERM through four
identity gates (`signalGroup`, `:294-331`): group probe, start-time match, group-leader check,
start-time match again immediately before the kill, plus a deadline check as the last word. Each
group's grace clock starts at ITS OWN SIGTERM (`:557`).

`reapFlowAgents` (`:600-628`): loops `sweepPass` with `escalate: true` (SIGKILL after that
group's grace, re-running all four gates first — `escalateGroup`, `:344-372`), applies the
dead-owner exception, and breaks when every entry resolves or the shared absolute deadline
passes. At the deadline a standing `unknown` group probe becomes final `unreachable` (`:621-625`).

Counter semantics (`AgentCancelSummary`, `:104-143`; `summarise`, `:672-695`):

| Counter | Meaning |
|---|---|
| `signalled` | groups this sweep sent SIGTERM to |
| `reaped` | groups confirmed gone (ESRCH) **after** our signal |
| `gone` | groups already gone on the first probe — resolved and acknowledgeable |
| `unreachable` | identity mismatch, no recorded start time, not a group leader, or EPERM. Never killed, never acknowledgeable |
| `alreadySettled` | entries already `settled` when first seen (counted and skipped) |
| `unresolved` | entries still `starting` at the deadline — an agent may be spawning right now |
| `unsettled` | every matching entry not durably `settled` at the deadline |
| `unreaped` | groups in no final state at the deadline |

`acknowledged` requires `flowSettled && unsettled === 0 && unresolved === 0 && unreachable === 0
&& unreaped === 0` (`ts/src/engine/flow_cancel.ts:186-190`). Failure code selection
(`:191-193`): `unreachable > 0` with nothing unresolved/unreaped → `CANCELLATION_UNCONFIRMED`;
everything else → `CANCELLATION_TEARDOWN_TIMEOUT`.

**An agent mid-spawn** is exactly what `starting` exists for. The sweep rescans the directory
every 10 ms (`REAP_POLL_MS`), so a pid that lands during the sweep is absorbed and signalled. If
the deadline arrives while the entry is still `starting`, it counts `unresolved` (and
`unsettled`), so `acknowledged` is false and the call raises
`CANCELLATION_TEARDOWN_TIMEOUT` — the honest answer, since we cannot say the agent is gone. The
belt-and-braces half is on the dispatch side: `admitFlowAgent` re-runs after the pid lands
(`server.ts:345-352`) and kills+reaps that group itself if the flow is no longer running.

**Dead-owner exception** (`:635-661`): the sweep stamps an entry `settled` itself only when the
owning MCP server is PROVABLY dead (`serverPid` + `serverProcStartTime`, tri-state probe, `dead`
only) and every recorded group is resolved. `serverPid` is never signalled.

---

## 6. README, CHANGELOG, surface pin

**README `### stratum_flow_cancel` (README.md:483-497)** — verbatim key paragraphs:

> Cancel a running **foreground** flow by flow id. Unlike `stratum_flow_cancel_bg`, which
> abandons a background run, this settles the run to the terminal status `cancelled` under the
> per-run file lock, burns every outstanding step, gate and fanout-item issuance, and then
> terminates the foreground agents Stratum spawned for that flow.

> **Which process may issue it.** The lock makes the call safe from any process, but a run whose
> in-memory object is PINNED by a live driver can only be settled by that driver. A pin happens
> whenever a process is actively working the run: a background driver loop, a gate re-kick, or an
> engine-dispatch consumer fanout. The pinning process declares itself in a driver lease beside
> the run record, and a cancel from anywhere else is refused with `CANCELLATION_UNCONFIRMED` and
> `reason: "engine_dispatch_active"`, carrying the holder's pid ... An unpinned run, which is the
> common case for a foreground consumer fanout driven by an external agent, is cancellable from
> any process at all.

> **Returns:** `{runId, status, flowSettled, acknowledged, reason?, ledger, agents}`. `flowSettled`
> says the run is durably `cancelled`. `acknowledged` additionally says every agent group claimed
> for the flow reached a final resolved state, either torn down by this call (`reaped`) or already
> gone when we first probed it (`gone`), and that no entry is left unsettled, unresolved or
> unreachable.

> The durable status is read first, so a run that is already terminal is never mutated and never
> refused: a finished run returns `flowSettled: false` with `reason: "already_<status>"`, and an
> already-cancelled one returns `flowSettled: true` with `reason: "already_cancelled"` and still
> sweeps its agents.

> An unconfirmed teardown is an error, not a caveat: `CANCELLATION_TEARDOWN_TIMEOUT` (a group was
> signalled and outlived the deadline) or `CANCELLATION_UNCONFIRMED` (an entry is unreachable, the
> run lock was held, reported as `reason: "run_lock_held"` with `holderPid`, or a live driver holds
> the run, reported as `reason: "engine_dispatch_active"`). Errors raised after the settle carry the
> engine's real `status` and `flowSettled` plus the partial `agents` summary. Errors raised instead
> of a settle carry `flowSettled: false`, an all-zero `agents` summary because no teardown was
> attempted, and `status: "running"` as the caller's own assumption rather than a reading of the
> record, since nothing was loaded.

> Cancellation is split by ownership: foreground cancel settles the flow and kills the agents
> **Stratum** spawned, background cancel abandons the run, and a consumer's own in-process agents
> remain the consumer's to abort, because Stratum cannot reach them.

**README on `flow` in `agent_run` (README.md:503)** — verbatim:

> A foreground agent run may declare `flow: {runId, stepId?, itemIndex?}` alongside its
> `cancellationId`. That gives the run a durable record carrying its child pid and process start
> time, which is what lets `stratum_flow_cancel` terminate its process group from a different
> process. `flow` without a `cancellationId` is rejected: without an owned process group there is
> nothing to cancel.

README.md:1077 (CLI table): `stratum flow cancel <flow_id>      # Cancel a running foreground flow (exit 0 ok, 1 unconfirmed, 2 unknown flow)`

**CHANGELOG 0.5.0** (`CHANGELOG.md:3-27`) — three STRAT-FLOW-CANCEL-FG bullets (S03 surfaces,
S02 registry, S01 engine) plus the blueprint bullet, and the STRAT-LOOP-CARRY bullets. The
surface line compose needs: *"`cancelled` status on audit/flow_poll/flow_bg_poll; MCP surface
18→19 (25 tools)."* The STRAT-LOOP-CARRY S04 bullet adds *"MCP surface 17→18, version 0.5.0
(compose must take a minor when it adopts the surface)"*.

**Where the surface number is pinned:**

- Contract: `ts/contracts/mcp-surface.json:2` → `"surface": 19`. 25 tools; `stratum_flow_cancel`
  sits between `stratum_flow_cancel_bg` and `stratum_agent_run`.
- Loader: `ts/src/mcp/contracts.ts:10` (`surface: number`), `:32-33` (`mcpSurface()`).
- Tests pinning the literal: `ts/tests/mcp/contracts-grammar.test.ts:81-84` and
  `ts/tests/mcp/schema-grammar.test.ts:88` — both `expect(surface.surface).toBe(19)`.
- Package floor: `ts/package.json:3` → `"version": "0.5.0"`, tag `v0.5.0` @ `6e4a68c`.

So compose's version guard should cite **surface 19** and package floor **@smartmemory/stratum
0.5.0**. Note the blueprint (§11) warns the existing compose message "required execution
surface: 17" needs updating to 19, and that a new TOOL does not trip compose's `#agentFields`
guard — only a new `stratum_agent_run` REQUEST FIELD does, which `flow` is.

`stratum_flow_cancel` contract (`ts/contracts/mcp-surface.json`):
request `{runId: string}`; four response variants (`cancelled`, `completed`, `failed`,
`budget_exhausted`), each `{runId, flowSettled, acknowledged, reason?, ledger:{spent, budget?},
agents:{signalled, reaped, gone, unreachable, alreadySettled, unresolved, unsettled, unreaped}}`.
Error envelope `flow_cancel_unacknowledged`, data
`{code, runId, status, flowSettled, reason?, holderPid?, agents}` (`errors` block of the same
file; emitted at `ts/src/mcp/server.ts:477-494` with `ErrorCode.InternalError`).

---

## 7. CLI `stratum flow cancel <runId>`

File: `ts/src/cli/flow.ts` (60 lines), dispatched from `ts/src/cli/stratum.ts:30`
(`if (command === "flow") return (await import("./flow.js")).flowCommand(args);`). Usage line at
`stratum.ts:36` lists `flow` among the subcommands.

State root: `process.env.STRATUM_STATE_ROOT || new StateStore().root`, default
`~/.stratum/ts/flows` (`ts/src/engine/state.ts:309`). It builds its own `StratumEngine` and calls
`cancelFlow(engine, runId)` with **no `abortLocal`** — it holds no controllers, so the registry
sweep does all the work. Same code path as the MCP tool otherwise.

| Exit | Condition | stdout |
|---|---|---|
| 0 | success, including already-terminal and already-cancelled | `{_schema_version:"1", ok:true, flow_id, status, flowSettled, acknowledged, agents, detail?}` where `detail` is `reason` (e.g. `already_cancelled`) |
| 1 | `CANCELLATION_TEARDOWN_TIMEOUT` / `CANCELLATION_UNCONFIRMED` | `{_schema_version:"1", ok:false, error:<code>, flow_id, status, flowSettled, agents, reason?, holderPid?, message}` + message on stderr |
| 1 | any other error | `{_schema_version:"1", ok:false, error:"INVALID", flow_id, message}` |
| 2 | unknown flow (explicit ENOENT test) | `{_schema_version:"1", conflict:true, flow_id, detail:"flow_not_found"}` |
| 2 | wrong usage (`args[0] !== "cancel"` or wrong arity) | usage on stderr, no JSON |

Exit 0 for already-cancelled is deliberate (blueprint §13 open question 2): exit 2 maps to
`{conflict: true}` in compose's mutation client and would make every idempotent abort look like
a failure to a retry loop. **Exit 2 is reserved for a genuinely unknown flow id** — and for a
usage error, which is the one collision to watch: a malformed invocation is indistinguishable
from `flow_not_found` by exit code alone, though it emits no JSON.

Environment knobs that affect both surfaces:

| Env var | Default | Effect |
|---|---|---|
| `STRATUM_STATE_ROOT` | `~/.stratum/ts/flows` | which run records the cancel can see |
| `STRATUM_AGENT_FG_ROOT` | `~/.stratum/ts/agent_fg` | which registry the sweep scans |
| `STRATUM_CANCEL_LOCK_WAIT_MS` | 120000 | lock wait before the settle |
| `STRATUM_CANCEL_TIMEOUT_MS` | 15000 | teardown budget, clock starts AFTER the settle |
| `STRATUM_CANCEL_GRACE_MS` | 5000 | per-group SIGTERM→SIGKILL grace |
| `STRATUM_RUN_LOCK_TIMEOUT_MS` | 300000 | ordinary run-lock wait |

All are validated as nonnegative finite numbers where read (`run_lock.ts:40-55`,
`foreground_registry.ts:417-421`), so a mistyped value fails loudly instead of hanging.

---

## Surprises

Things that break the naive plan "abort reads runId from a file, calls `stratum_flow_cancel`
from a second process, the driver's agent calls then fail and it exits cleanly":

1. **`cancellationId` alone is not enough — the agent must also carry `flow: {runId}`.** Without
   `flow`, `createForegroundRun` is never called (`ts/src/mcp/server.ts:203-232`) and NOTHING
   durable records the child. The cross-process cancel then finds zero registry entries, reports
   an all-zero `agents` summary, and returns **`acknowledged: true`** while the agent keeps
   running against a cancelled flow. A clean-looking success with a live orphan is the worst
   failure mode on this surface, and it is one missing request field away.

2. **Both processes must agree on `STRATUM_STATE_ROOT` and `STRATUM_AGENT_FG_ROOT`.** The abort
   process builds its own engine over `process.env.STRATUM_STATE_ROOT || ~/.stratum/ts/flows`
   (`ts/src/cli/flow.ts:20`, `ts/src/mcp/server.ts:94`). If compose sets a per-build state root
   for the driver server and not for the abort server, the cancel gets ENOENT → exit 2 /
   `flow_not_found`, which reads as "unknown build".

3. **The driver's in-flight agent call does NOT return `agent_cancelled`.** It rejects with the
   generic `agent_run_failed` envelope, `data.code === "agent_run_failed"`, message
   `codex exited with code 143` or the child's stderr. Compose cannot distinguish "cancelled" from
   "the agent crashed" by the error alone — it has to correlate with its own abort flag or
   re-read the run status. Only a same-process abort produces the `Flow cancelled` message, and
   even that has no code.

4. **Every subsequent step call fails with an UNCODED plain `Error`.** `stepDone`, `gateResolve`
   and `resume` all throw bare `Error("run <id> is cancelled; ...")` with no `code` and no
   declared envelope, so they surface as raw MCP `InternalError`s. If compose's client classifies
   errors by `data.code`, these fall through to a generic-failure branch. Only `commit`/`revert`
   return a structured `flow_cancelled` checkpoint envelope, and only `agent_run` admission
   returns the declared `flow_not_running`.

5. **`run_lock_held` cancels nothing, and it can take two minutes to say so.** If the abort lands
   while the driver is inside `stepDone` with a judged ensure (an LLM call held INSIDE the run
   lock — STRAT-LOCK-SCOPE, blueprint §12), the cancel waits `STRATUM_CANCEL_LOCK_WAIT_MS`
   (120 s) and then raises `CANCELLATION_UNCONFIRMED{reason:"run_lock_held"}` having mutated
   nothing and swept no agent. `compose build --abort` must treat this as "retry", not "done" —
   and must not surface it as a fatal-non-retryable, which is how compose currently treats
   `CANCELLATION_TEARDOWN_TIMEOUT`.

6. **The two error codes mean opposite things about whether the build stopped.**
   `CANCELLATION_TEARDOWN_TIMEOUT` always means the flow IS settled (`status: "cancelled"`,
   `flowSettled: true`) and only an agent group outlived the deadline. `CANCELLATION_UNCONFIRMED`
   means either the same-but-unreachable, OR nothing happened at all (`flowSettled: false`). The
   envelope's `flowSettled` field is the only reliable discriminator — not the code.

7. **`engine_dispatch_active` is a real refusal, but not for compose's consumer builds.** No
   consumer-dispatch run — planned or resumed — ever writes a driver lease, because
   `scheduleFanout` returns at `engine.ts:1886` before `retainRun`. The compose explorer's claim
   that `prepareLease` at `:704`/`:1036` writes a lease on resume is wrong: `:704` is
   `rehydrateBgFlows` (bgDriven only) and `:1036` only RESOLVES an incumbent lease. Compose would
   only ever see `engine_dispatch_active` if it drove a bg flow or an engine-dispatch fanout.

8. **A cancelled run cannot be written to at all, including bookkeeping compose may want to
   flush.** `usageReport` and any receipt update throw `PERSIST_ON_CANCELLED_RUN`
   (`engine.ts:524-528`, `:873-877`). Any post-abort ledger flush compose does through Stratum
   will fail. Compose's own local writes (vision flip, `active-build.json`, build actuals) are
   unaffected — they are outside Stratum.

9. **`acknowledged: false` is delivered as a THROWN MCP error, not a response.** `cancelFlow`
   raises rather than returning when the sweep is incomplete (`flow_cancel.ts:194-200`), and the
   dispatcher converts it to `flow_cancel_unacknowledged`. The only response shapes compose will
   ever RECEIVE are successes: `acknowledged: true`, or an already-terminal run with
   `acknowledged: false` and `flowSettled: false`. Do not write a client that reads
   `acknowledged` off a happy-path response and expects to see failures there.

10. **An agent that was mid-spawn at the deadline poisons the acknowledgement.** A `starting`
    registry entry counts `unresolved` and `unsettled`, so a cancel issued in the ~milliseconds
    between `createForegroundRun` and the pid landing raises `CANCELLATION_TEARDOWN_TIMEOUT` even
    though the flow settled cleanly and `admitFlowAgent` will kill that child itself moments
    later. The documented recovery is to call `stratum_flow_cancel` again — it is idempotent,
    returns `already_cancelled`, and re-sweeps.

11. **`unreachable` is unrecoverable by retry.** EPERM on the group probe, a missing recorded
    start time, or a recycled pid all yield `unreachable`, which never becomes acknowledgeable no
    matter how many times the sweep runs. A retry loop keyed on `acknowledged` would spin
    forever; bound it.

12. **CLI exit 2 is overloaded.** Both "unknown flow" and "wrong usage" exit 2. Compose's
    mutation client maps exit 2 to `{conflict: true}` (per blueprint §11), so a typo'd invocation
    reports as a conflict on a build that exists. Prefer the MCP tool, or check for the JSON
    payload's presence.

13. **Windows is refused before spawn**, so any cancellable agent run there fails with
    `CANCELLATION_UNSUPPORTED_PLATFORM` (`ts/src/connectors/cancellation.ts:17-19`). Not a
    concern on darwin, but it means `flow` + `cancellationId` is not a universally safe default.

14. **Compose's own `isolation: "none"` local Claude agents are out of reach.** Blueprint §11 is
    explicit: they never enter Stratum, so compose keeps aborting them itself. A "cancel" that
    only calls Stratum leaves them running.

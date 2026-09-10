# Stratum 0.5.0 foreground-cancel contract — exploration report

**Scope:** what a consumer (Compose, a separate process driving a foreground flow via
`stratum_plan` / `stratum_step_done` and spawning agents via `stratum_agent_run`) must call to
(a) tag its agent runs with the flow and (b) cancel the flow.

**Source of truth:** `/Users/ruze/reg/my/forge/stratum` at `6e4a68c` (tag `v0.5.0`, HEAD of main),
package `@smartmemory/stratum` version `0.5.0` (`ts/package.json:3`). Read-only inspection.

---

## 1. `stratum_agent_run` — tagging a run with the flow

### Input schema

`ts/contracts/mcp-surface.json:1077` (request block, verbatim):

```json
"cancellationId?": "string",
"flow?": {
  "runId": "string",
  "stepId?": "string",
  "itemIndex?": "number"
}
```

Request validation is default-deny (`assertToolRequest`), so an undeclared key inside `flow` is
rejected.

### `cancellationId` is mandatory when `flow` is present

`ts/src/mcp/server.ts:182-186`:

```ts
if (tool === "stratum_agent_run" && request.flow !== undefined && request.cancellationId === undefined) {
  // Hand-validated here for the same reason the cancellationId checks are: the
  // bookkeeping must be in place before any awaited contract I/O. The SHAPE of `flow`
  // is still validated by assertToolRequest.
  throw await inputValidationError("flow", "flow requires a cancellationId: without a process group there is nothing to cancel");
}
```

`inputValidationError` (`server.ts:134-139`) emits the declared `input_validation_failed`
envelope with `ErrorCode.InvalidParams`:

```ts
return registryError("input_validation_failed", ErrorCode.InvalidParams, message, {
  code: "input_validation_failed",
  errors: [{ code: "input_validation_failed", path, message }],
});
```

Other hand-validated refusals on the same path (`server.ts:188-195`):

- `cancellationId must be a UUID` — regex `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`
- `cancellationId is only supported for foreground runs` — when `background: true`
- `cancellationId has already been used` — single-use per server process (checked against both the
  live `foreground` map and the `completed` LRU)

### What `flow` does

`server.ts:200-232`: when `flow` is a record, the dispatcher records `flowRunId`, writes a durable
registry record **before the spawn**, and then runs the pre-spawn admission check:

```ts
if (isRecord(request.flow)) {
  const flow = {
    runId: string(request.flow, "runId"),
    ...(typeof request.flow.stepId === "string" ? { stepId: request.flow.stepId } : {}),
    ...(typeof request.flow.itemIndex === "number" ? { itemIndex: request.flow.itemIndex } : {}),
  };
  flowRunId = flow.runId;
  foregroundFlows.set(cancellationId, flow.runId);
  const serverStartTime = await selfStartTime;
  registryId = await createForegroundRun({ /* ... */ }, registryOptions);
  try {
    await engine.admitFlowAgent(flow.runId);
  } catch (error) {
    await settleForegroundRun(registryId, registryOptions).catch(() => undefined);
    throw await admissionError(error, flow.runId);
  }
}
```

`cancellationId` (with or without `flow`) also sets `ownProcessGroup: true` on the connector
(`server.ts:326`) — see section 5.

### What `stepId` / `itemIndex` are validated against: NOTHING

They are copied verbatim into the registry record and never checked against the run's steps or its
fanout items. Only `flow.runId` is load-bearing: it is the admission key and the sweep key
(`foreground_registry.ts` scans match on `meta.flow.runId`).

### Admission: which run statuses admit an agent

`ts/src/engine/engine.ts:1133-1146` (verbatim):

```ts
  async admitFlowAgent(runId: string): Promise<void> {
    let run: PersistedRun;
    try {
      run = await this.withRunLock(runId, () => this.loadRun(runId));
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        throw Object.assign(new Error(`flow ${runId} is not running`), { code: "FLOW_NOT_RUNNING" });
      }
      throw Object.assign(new Error(`flow ${runId} admission check failed: ${message(error)}`), { code: "FLOW_ADMISSION_FAILED" });
    }
    if (run.status !== "running" || run.cancelRequested === true) {
      throw Object.assign(new Error(`flow ${runId} is ${run.status === "running" ? "cancelled" : run.status}`), { code: "FLOW_NOT_RUNNING" });
    }
  }
```

- The run MUST be durably `running` and MUST NOT have `cancelRequested === true`.
- **The current step is irrelevant.** Nothing compares `flow.stepId` to the run's ready step, and
  nothing compares `itemIndex` to a fanout item. A stale or wrong `stepId` is accepted silently.
- Missing record (ENOENT) => `FLOW_NOT_RUNNING`. Corrupt/unreadable record => `FLOW_ADMISSION_FAILED`
  (fails closed by design, `engine.ts:1127-1132`).
- Admission takes the cross-process run lock briefly (`engine.ts:1136`) at the DEFAULT
  `STRATUM_RUN_LOCK_TIMEOUT_MS` budget (300s), not the cancel budget.

Admission is checked **twice**: pre-spawn (`server.ts:226-231`) and again as each child pid lands
(`server.ts:342-351`). The second failure kills and reaps the just-spawned group first:

```ts
try {
  await engine.admitFlowAgent(flowRunId!);
} catch (error) {
  // R3-8: the recorded identity is REQUIRED to signal a group. It was just
  // written above, so pass it explicitly rather than re-reading the file.
  await killAndReapGroup(pid, { startTime: recorded.procStartTime });
  throw await admissionError(error, flowRunId!);
}
```

### `flow_not_running` / `flow_admission_failed` on the wire

`ts/src/mcp/server.ts:123-128` (verbatim):

```ts
async function admissionError(error: unknown, runId: string): Promise<McpError> {
  const code = (error as { code?: unknown } | undefined)?.code;
  const envelope = code === "FLOW_ADMISSION_FAILED" ? "flow_admission_failed" : "flow_not_running";
  const detail = error instanceof Error ? error.message : String(error);
  return registryError(envelope, ErrorCode.InvalidRequest, detail, { code: envelope, runId });
}
```

Declared shapes (`ts/contracts/mcp-surface.json`, `errors` block):

```json
"flow_not_running":       { "data": { "code": "string", "runId": "string", "status?": "string" } }
"flow_admission_failed":  { "data": { "code": "string", "runId": "string" } }
```

Both are JSON-RPC `InvalidRequest`. Note `status?` is declared on `flow_not_running` but the
dispatcher NEVER populates it (`server.ts:127` sends `{ code, runId }` only) — deliberate, per the
comment at `server.ts:120-122`: the engine's admission error carries no status and fabricating one
was forbidden by review finding R1-5.

Message text seen by the client is the engine's: `flow <runId> is not running`,
`flow <runId> is <status>`, `flow <runId> is cancelled`, or
`flow <runId> admission check failed: <detail>`.

---

## 2. `stratum_flow_cancel`

### Input / response schema

`ts/contracts/mcp-surface.json:990` (verbatim, one response variant shown; all four are identical
in shape and differ only by the `status` discriminant):

```json
"stratum_flow_cancel": {
  "request": { "runId": "string" },
  "responses": {
    "cancelled": {
      "runId": "string",
      "flowSettled": "boolean",
      "acknowledged": "boolean",
      "reason?": "string",
      "ledger": { "spent": "object", "budget?": "object" },
      "agents": {
        "signalled": "number", "reaped": "number", "gone": "number",
        "unreachable": "number", "alreadySettled": "number",
        "unresolved": "number", "unsettled": "number", "unreaped": "number"
      }
    },
    "completed": { ... }, "failed": { ... }, "budget_exhausted": { ... }
  }
}
```

Response variants are keyed by the run's real `status`: `cancelled | completed | failed |
budget_exhausted`. `RunStatus` itself is `ts/src/engine/state.ts:8`:

```ts
export type RunStatus = "running" | "completed" | "failed" | "budget_exhausted" | "cancelled";
```

`settledByThisCall` is engine-internal and stripped before the wire (`server.ts:306-309`).

### The result types

`ts/src/engine/engine.ts:260-267`:

```ts
export interface FlowCancelResult {
  runId: string;
  status: RunStatus;
  flowSettled: boolean;
  /** True only when this call performed the settle. */
  settledByThisCall: boolean;
  reason?: string;
  ledger: LedgerInfo;
}
```

`ts/src/engine/flow_cancel.ts:5-10`:

```ts
export interface FlowCancelAck extends FlowCancelResult {
  /** True only when flowSettled AND every claimed agent entry is reaped or durably settled
   *  (R1-5). Never true alongside an unresolved or unreachable-unsettled entry. */
  acknowledged: boolean;
  agents: AgentCancelSummary;
}
```

`acknowledged` is computed at `flow_cancel.ts:193-197`:

```ts
const acknowledged = settled.flowSettled
  && agents.unsettled === 0
  && agents.unresolved === 0
  && agents.unreachable === 0
  && agents.unreaped === 0;
```

### Already-terminal runs, and idempotency

`ts/src/engine/engine.ts:1167-1177` reads DISK first and never mutates a terminal run:

```ts
const persisted = await this.store.load(runId);
if (persisted.status !== "running") {
  return {
    runId,
    status: persisted.status,
    flowSettled: persisted.status === "cancelled",
    settledByThisCall: false,
    reason: `already_${persisted.status}`,
    ledger: this.ledgerInfo(persisted),
  };
}
```

- `completed` / `failed` / `budget_exhausted` => `flowSettled: false`, `reason: "already_completed"`
  etc, and **no agent sweep at all**: `flow_cancel.ts:153-156` returns
  `{ ...settled, acknowledged: false, agents: emptyAgents() }`.
- `cancelled` => `flowSettled: true`, `reason: "already_cancelled"`, and the sweep DOES run.
  That is the documented recovery from a `CANCELLATION_TEARDOWN_TIMEOUT` (`flow_cancel.ts:112-115`).
- Fully idempotent; two concurrent cancels converge
  (`ts/tests/mcp/flow_cancel_edges.test.ts:92`, "exactly one settles it, the other observes
  already_cancelled").
- The terminal-status read happens BEFORE the lease decision on purpose (`engine.ts:1157-1166`), so
  an already-cancelled run can be re-swept even while the original driver's lease is live.

### Error envelopes

Failure type, `ts/src/engine/flow_cancel.ts:33-42` (verbatim):

```ts
/** The single failure shape every cancel error carries (R3-5). */
export interface CancelFailure extends Error {
  code: "CANCELLATION_UNCONFIRMED" | "CANCELLATION_TEARDOWN_TIMEOUT";
  runId: string;
  status: RunStatus;
  flowSettled: boolean;
  agents: AgentCancelSummary;
  reason?: "run_lock_held" | "engine_dispatch_active" | "local_teardown_timeout";
  holderPid?: number;
}
```

MCP projection, `ts/src/mcp/server.ts:477-495`:

```ts
if (tool === "stratum_flow_cancel" && error instanceof Error && "code" in error
  && ["CANCELLATION_TEARDOWN_TIMEOUT", "CANCELLATION_UNCONFIRMED"].includes(String(error.code))) {
  const failure = error as Error & { status?: string; flowSettled?: boolean; reason?: string; holderPid?: number; agents?: AgentCancelSummary };
  throw await registryError("flow_cancel_unacknowledged", ErrorCode.InternalError, error.message, {
    code: String(error.code),
    runId: string(request, "runId"),
    status: failure.status ?? "running",
    flowSettled: failure.flowSettled ?? false,
    ...(failure.reason !== undefined ? { reason: failure.reason } : {}),
    ...(failure.holderPid !== undefined ? { holderPid: failure.holderPid } : {}),
    agents: failure.agents ?? { ...EMPTY_AGENTS },
  });
}
```

Declared envelope (`contracts/mcp-surface.json`, `errors.flow_cancel_unacknowledged`):

```json
{ "data": { "code": "string", "runId": "string", "status": "string", "flowSettled": "boolean",
            "reason?": "string", "holderPid?": "number",
            "agents": { "signalled": "number", "reaped": "number", "gone": "number",
                        "unreachable": "number", "alreadySettled": "number",
                        "unresolved": "number", "unsettled": "number", "unreaped": "number" } } }
```

The ONE envelope name covers BOTH codes. JSON-RPC code is `InternalError`.

Which code is chosen (`flow_cancel.ts:198-208`):

```ts
const code = agents.unreachable > 0 && agents.unresolved === 0 && agents.unreaped === 0
  ? "CANCELLATION_UNCONFIRMED"
  : "CANCELLATION_TEARDOWN_TIMEOUT";
```

Pre-settle refusals are normalised at `flow_cancel.ts:138-152`:

```ts
try {
  settled = await engine.flowCancel(runId, options.reason);
} catch (error) {
  const code = codeOf(error);
  if (code !== "RUN_LOCK_TIMEOUT" && code !== "CANCELLATION_UNCONFIRMED") throw error;
  const holderPid = pidOf(error);
  throw cancelError("CANCELLATION_UNCONFIRMED", {
    runId,
    status: "running",
    flowSettled: false,
    agents: emptyAgents(),
    reason: code === "RUN_LOCK_TIMEOUT" ? "run_lock_held" : (reasonOf(error) ?? "engine_dispatch_active"),
    ...(holderPid !== undefined ? { holderPid } : {}),
  }, error instanceof Error ? error.message : undefined);
}
```

Message texts (`flow_cancel.ts:55-57`):

- `run <runId> lock is held by pid <n>; cancel was not applied`
- `cancel of run <runId> was not acknowledged`
- lease refusal, from `engine.ts:1122`: `run <runId> is driven by pid <n>; cancel must be issued from that process`

`status: "running"` on a pre-settle refusal is the CALLER's assumption, not a read of the record
(nothing was loaded). Pinned by `ts/tests/mcp/flow_cancel.test.ts:267-288` (T-S03-4d).

**Settle-first is absolute**: a refusal sweeps NOTHING and the agents keep running
(`flow_cancel.ts:121-124`, pinned by `ts/tests/mcp/flow_cancel.test.ts:289-322`, T-S03-4e).

### Unknown run

`engine.flowCancel` on a missing record rejects with a bare ENOENT
(`ts/tests/engine/flow_cancel.test.ts:445-447`, T-S01-13). `cancelFlow` rethrows it untouched
(`flow_cancel.ts:128-130`), and the dispatcher has no branch for it, so it reaches the client as an
**undeclared** generic error. From `ts/tests/mcp/flow_cancel_edges.test.ts:36-60`:

```ts
expect(failure).toBeInstanceOf(McpError);
// The MCP SDK wraps an uncaught throw as a JSON-RPC InternalError with the raw message —
// there is no declared `data` envelope (no `code`, no `runId`) for this path...
expect(mcpFailure.data).toBeUndefined();
expect(mcpFailure.message).toMatch(/ENOENT|no such run|not found/i);
```

At the raw dispatcher layer it is a plain `Error` with `code === "ENOENT"`
(`flow_cancel_edges.test.ts:63-70`).

### Env vars and defaults

`ts/src/engine/run_lock.ts:14-55` and `ts/src/connectors/cancellation.ts:12`:

| var | default | what it bounds | ref |
|---|---|---|---|
| `STRATUM_CANCEL_LOCK_WAIT_MS` | `120_000` | how long `flowCancel` waits to ACQUIRE the run lock, before anything is settled | `run_lock.ts:16`, `:49-51`; applied at `engine.ts:1188` |
| `STRATUM_CANCEL_TIMEOUT_MS` | `15_000` | ONE absolute teardown deadline (signal + local abort + reap), clock starts AFTER settlement | `run_lock.ts:20`, `:53-55`; `flow_cancel.ts:81`; `foreground_registry.ts:419` |
| `STRATUM_CANCEL_GRACE_MS` | `5_000` | per-group SIGTERM to SIGKILL grace, clocked from each group's own SIGTERM | `connectors/cancellation.ts:12-13` |
| `STRATUM_RUN_LOCK_TIMEOUT_MS` | `300_000` | the general run-lock waiter (used by `stepDone`, `admitFlowAgent`, etc) | `run_lock.ts:14`, `:45-47` |

All four go through `requireDurationMs` (`run_lock.ts:40-43`), so a NaN/negative value throws at
read time rather than removing the deadline. `timeoutMs` / `graceMs` passed programmatically are
validated BEFORE the engine is touched (`flow_cancel.ts:80-95`, `:131-136`).

Also relevant: `STRATUM_STATE_ROOT` (default `~/.stratum/ts/flows`, `state.ts:309`; MCP reads it at
`server.ts:94`, CLI at `cli/flow.ts:20`) and `STRATUM_AGENT_FG_ROOT` (default
`~/.stratum/ts/agent_fg`, `foreground_registry.ts:13-15`, `:60-62`).

---

## 3. The cross-process story

### Does a consumer-dispatch run hold a driver lease? NO.

The lease is written only when the engine PINS a run (`retainRun`, refs 0 to 1). The four pin sites
are `flowRunBg`, `rehydrateBgFlows`, the gate bg re-kick and `scheduleFanout`
(blueprint §2.1b). And `scheduleFanout` returns before pinning for consumer dispatch —
`ts/src/engine/engine.ts:1884-1891`:

```ts
  private scheduleFanout(run: PersistedRun, stepId: string): void {
    const validated = this.validationFor(run);
    const scheduledStep = this.flowFor(run, validated.value).steps.find((step) => step.id === stepId);
    if (scheduledStep?.fanout?.dispatch === "consumer") return;
```

Blueprint §2.1b, "The v1 boundary this draws, stated plainly"
(`docs/features/STRAT-FLOW-CANCEL-FG/blueprint.md`, around line 455):

> - **Compose's consumer-dispatch team builds are never pinned** (`scheduleFanout` returns at
>   `engine.ts:1524`), so they have no lease and cross-process cancel works for them with no
>   caveats. That is the feature's first consumer and its whole motivating case.
> - **A foreground engine-dispatch fanout can be cancelled only from the process driving it** —
>   through the same `stratum_flow_cancel` tool on its own MCP server — **or after that process
>   dies.** A second process is told `engine_dispatch_active` with the holder pid...

Blueprint §11 "The contract compose will call" (line 2813) names the exact call sites compose
should use, and §12 "Out of scope" (line 2841) restates:

> A foreground **engine-dispatch** fanout is cancellable only from the process driving it, or
> once that process dies. Compose's consumer-dispatch builds are unaffected (never pinned).

The lease table itself (`engine.ts:1115-1125`):

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

### So: is the cross-process cancel expected to succeed while the driver is mid `stratum_agent_run`? YES.

That is exactly the golden flow, `ts/tests/engine/flow_cancel_golden.test.ts:123-205`:

> "cancels a live consumer-fanout run from a SECOND process, reaps its agent, and refuses every
> late write"

```ts
// 3. Cancel from a SECOND dispatcher over the same state and registry roots. Dispatcher B
//    holds an empty foreground map, so the same-process fast path is a no-op and the
//    cross-process registry path does all the work — the topology of `compose build --abort`.
const engineB = engineOver(stateRoot);
const dispatcherB = dispatcherOver(engineB, registryRoot);
const payload = await dispatcherB.call("stratum_flow_cancel", { runId });
```

with

```ts
expect(payload).toMatchObject({ runId, status: "cancelled", flowSettled: true, acknowledged: true });
expect(payload.agents).toEqual({ signalled: 1, reaped: 1, gone: 0, unreachable: 0, alreadySettled: 0, unresolved: 0, unsettled: 0, unreaped: 0 });
```

**The blocking case is the RUN LOCK, not the lease.** `stepDone` runs inside `withRunLock`
(`engine.ts:745`) and that locked section awaits LLM-scale work (`runEnsures` -> `this.judge(...)`,
`engine.ts:2099`/`:2111`; the `evaluate:` arm at `:1436`) — blueprint §12 names this as
pre-existing and filed as STRAT-LOCK-SCOPE. A cancel issued while the driver is inside
`stratum_step_done` therefore waits up to `STRATUM_CANCEL_LOCK_WAIT_MS` (120s) and then fails with
`CANCELLATION_UNCONFIRMED` / `reason: "run_lock_held"` / `holderPid`, having swept nothing.
`stratum_agent_run` itself does NOT hold the run lock for the duration of the agent — only
`admitFlowAgent` takes it, briefly.

### What the driving process observes afterwards

| driver call | behaviour on a cancelled run | ref |
|---|---|---|
| in-flight `stratum_agent_run` | child's process group is SIGTERMed by the other process; the call rejects. Over MCP it is the generic `agent_run_failed` envelope (`{code: failure.code ?? "agent_run_failed", ...}`) — **no cancellation-specific code on the cross-process path** | `server.ts:498-508`; golden test asserts only `expect(await agentCall).toBeInstanceOf(Error)` at `flow_cancel_golden.test.ts:189` |
| `stratum_step_done` | refused with a **plain `Error`, NO `code`**: `run <id> is cancelled; outstanding step issuances cannot be resolved`. No declared envelope, so the SDK wraps it as a generic `InternalError` | `engine.ts:748`; `flow_cancel_golden.test.ts:176-177` |
| `stratum_resume` | plain `Error`: `run <id> is cancelled; resume is not permitted` | `engine.ts:1027-1028`; `flow_cancel_golden.test.ts:182` |
| `stratum_gate_resolve` | plain `Error`: `run <id> is cancelled; gate <stepId> cannot be resolved` | `engine.ts:1306`; `flow_cancel_golden.test.ts:181` |
| `stratum_commit` / `stratum_revert` | `CheckpointOperationError("flow_cancelled", "Flow '<id>' is cancelled; <op> is not permitted")` — this one DOES have a declared envelope | `engine.ts:3347-3348`; `flow_cancel_golden.test.ts:185-186` |
| `stratum_flow_poll` / `stratum_audit` | return `status: "cancelled"` cleanly | `flow_cancel_golden.test.ts:200-203` |
| `stratum_plan` | unaffected: it starts a NEW run | — |

Late results cannot be accepted even by race: `burnIssuances` deletes every outstanding dispatch
and gate token at the settle (see section 4), and the golden test asserts
`items[0].acceptedDispatchToken` stays `undefined` (`flow_cancel_golden.test.ts:178`).

**There is no `cancelled` response variant on `stratum_plan`, `stratum_step_done` or
`stratum_resume`** — only on `stratum_audit`, `stratum_flow_poll` and `stratum_flow_bg_poll`
(verified against `contracts/mcp-surface.json`). So the driving process learns about the cancel
either from an undeclared error or by polling.

---

## 4. `cancelled` in audit / flow_poll, and the `flow_cancelled` event

`RunStatus` (`ts/src/engine/state.ts:8`) gains `"cancelled"`. Response variants declared in
`contracts/mcp-surface.json`:

```
stratum_audit     : running, completed, failed, budget_exhausted, cancelled
stratum_flow_poll : running, completed, failed, budget_exhausted, cancelled
stratum_plan      : ready, running, completed, failed, budget_exhausted     <-- no cancelled
stratum_step_done : ready, running, completed, failed, budget_exhausted     <-- no cancelled
stratum_resume    : ready, running, completed, failed, budget_exhausted     <-- no cancelled
```

`stratum_audit.responses.cancelled`:
`{"runId":"string","events":"array","steps":"object","flowSpent":"object","output?":"any","carry?":"object"}`

`stratum_flow_poll.responses.cancelled`:
`{"runId":"string","events":"array","nextCursor":"number","ledger":{"spent":"object","budget?":"object"},"output?":"any","failure?":"object"}`

Engine response for a cancelled run carries NO fabricated failure (`engine.ts:3475-3479`):

```ts
// Above the failed fallthrough: requiredFailure would otherwise INVENT
// {attempt: 0, reason: "run failed without context"} and report a cancelled run as a
// failure with a fabricated reason (C15).
if (run.status === "cancelled") return { status: "cancelled", runId: run.id, ledger };
```

### The event

`ts/contracts/events.json` (contract version 4):

```json
"flow_cancelled": {
  "detail": {
    "by": "string",
    "reason?": "string",
    "burned": { "steps": { "$array": "string" }, "items": "number" }
  }
}
```

Emitted by `terminalCancel`, `ts/src/engine/engine.ts:3407-3419`:

```ts
  private async terminalCancel(run: PersistedRun, reason?: string): Promise<EngineResponse> {
    run.cancelRequested = true;
    const burned = burnIssuances(run);
    run.status = "cancelled";
    this.event(run, "flow_cancelled", undefined, { by: "fg", ...(reason !== undefined ? { reason } : {}), burned });
    // R4-1: the ONE sanctioned write of a cancelled record.
    await this.persistTerminalCancel(run);
    this.emitFlowTerminal(run);
    const bg = this.bgFlows.get(run.id);
    if (bg) { bg.cancelRequested = true; bg.status = "cancelled"; bg.pendingGates = []; }
    return this.response(run);
  }
```

`by` is `"fg"` for this surface. `reason` is only ever set from the CLI/programmatic path —
blueprint §12 "Cancel reasons on the wire": the MCP request is `{runId}` only, nothing on the MCP
surface supplies `reason` in v1. (Note this `reason` on the EVENT is distinct from the `reason`
field on the RESPONSE, which carries `already_<status>`.)

`burnIssuances` (`ts/src/engine/state.ts:278-300`) deletes every ready/running step dispatch token,
every `waiting_gate` gate token, and every ready/running fanout item token, recursing into
sub-steps, and returns `{steps: string[], items: number}` as the event's audit evidence.

A cancelled record is final: `persist` refuses further writes
(`engine.ts:3516-3517`, `run <id> is cancelled; no further writes are accepted`), and
`usageReport` / receipts refuse too (`engine.ts:524-526`, `:873-875`).

---

## 5. The foreground agent registry

### Location and shape

Root resolution, `ts/src/connectors/foreground_registry.ts:13-15` and `:60-62`:

```ts
export function agentForegroundRoot(): string {
  return join(homedir(), ".stratum", "ts", "agent_fg");
}
...
function resolveRoot(options: RegistryRootOptions): string {
  return options.registryRoot ?? process.env.STRATUM_AGENT_FG_ROOT ?? agentForegroundRoot();
}
```

Record path is `<root>/<12-hex id>/meta.json` (`createForegroundRun` -> `newRunDir`,
`foreground_registry.ts:209-217`). It is deliberately a SIBLING of the background registry
(`:9-12`):

```ts
/** Deliberately a SIBLING of the background registry, never a member of it (C8). `loadMeta`
 *  (background.ts) accepts any meta.json whose runId matches its directory, so a foreground
 *  codex record dropped into `agent_runs` would be loadable by `cancelBackgroundRun` and
 *  killed as if it were a detached background run. */
```

`ForegroundRunMeta`, `foreground_registry.ts:82-102` (verbatim):

```ts
export interface ForegroundRunMeta {
  runId: string;
  foreground: true;
  state: ForegroundRunState;
  agent: "claude" | "codex";
  cancellationId: string;
  /** The MCP server process that owns the in-memory AbortController. ... Never signalled (invariant 14). */
  serverPid: number;
  /** REQUIRED for the dead-owner exception (R3-6). ... */
  serverProcStartTime?: string;
  flow: { runId: string; stepId?: string; itemIndex?: number };
  cwd: string;
  model?: string;
  createdAt: string;
  /** One entry per cancellable spawn. ... */
  groups: ForegroundGroup[];
  /** Stamped with `state: "settled"`. A settled entry is never signalled. */
  settledAt?: string;
}
```

Lifecycle `starting -> running -> settled` (`:70-80`): `starting` is written BEFORE the spawn so a
cancel that arrives mid-spawn cannot miss the agent; `running` is stamped by `onSpawn` with each
child's pid and start time; `settled` is stamped in the dispatcher's `finally` (`server.ts:525`).

### What compose must pass for the record to be written

**Both `cancellationId` AND `flow`.** The `createForegroundRun` call is inside
`if (isRecord(request.flow))` (`server.ts:200-223`). With `cancellationId` alone there is an
in-process AbortController but NO registry record, so no other process can find that agent.
Pinned by blueprint test T-S02-8 ("No `flow` field means no registry entry at all").

### Process group / `ownProcessGroup`: this is what makes SIGTERM reach codex/claude children

`server.ts:326`:

```ts
...(cancellationId !== undefined ? { ownProcessGroup: true } : {}),
```

- **Codex**: `ownProcessGroup` forces the `exec` transport (`ts/src/connectors/codex.ts:200`:
  `this.transport = this.ownProcessGroup ? "exec" : selectedTransport;`) and spawns
  `detached: this.ownProcessGroup && process.platform !== "win32"` (`codex.ts:284`). `onSpawn` is
  invoked only then (`codex.ts:286`).
- **Claude**: `ownProcessGroup` installs the SDK's `spawnClaudeCodeProcess` hook with
  `detached: process.platform !== "win32"` (`ts/src/connectors/claude.ts:86-92`), and `onSpawn`
  fires per spawned child — the SDK spawner may run more than once, which is why `groups` is an
  array (C9).
- The kill is a GROUP kill: `kill: (pid, signal) => { process.kill(-pid, signal); }`
  (`foreground_registry.ts:38`).
- A recorded group is only signallable if it passes the identity gates: `processGroupId(pid) === pid`
  (it must be a group leader) and a recorded `procStartTime` that still matches. Otherwise it counts
  as `unreachable` and is never signalled. A missing `procStartTime` is treated as a hard
  registration FAILURE that aborts the run (`server.ts:339-341`):

```ts
if (recorded.procStartTime === undefined) {
  throw Object.assign(new Error("could not capture process start time; agent would be uncancellable"), { code: "REGISTRY_WRITE_FAILED" });
}
```

- Windows: `requireProcessGroups` throws before spawn (`ts/src/connectors/cancellation.ts:18-20`)
  with `code: "CANCELLATION_UNSUPPORTED_PLATFORM"`.
- Escalation: SIGTERM, then SIGKILL after `graceMs` clocked from that group's own SIGTERM
  (`foreground_registry.ts` sweepPass `:556-563`).

### Who stamps `settled`

Normally only the OWNING dispatcher, in its `finally` (`server.ts:514-526`). A sweeping process may
stamp it only when the owner is PROVABLY dead — requiring both `serverPid` and
`serverProcStartTime` and a tri-state identity probe returning `dead`
(`foreground_registry.ts:644-668`). The reap loop rescans the registry each pass
(`sweepPass` -> `scan`, `:525`) until every entry is resolved or the deadline expires
(`:611-620`), so it does pick up a `settled` stamped by the other process mid-sweep.

---

## 6. Docs, version and surface pins

- **README** `/Users/ruze/reg/my/forge/stratum/README.md:483-495` — `### stratum_flow_cancel`,
  including "Which process may issue it" (the lease boundary), the returns shape, the
  already-terminal semantics, and the two error codes.
  `README.md:503` — `flow` on `stratum_agent_run`:

  > A foreground agent run may declare `flow: {runId, stepId?, itemIndex?}` alongside its
  > `cancellationId`. ... `flow` without a `cancellationId` is rejected: without an owned process
  > group there is nothing to cancel.

  `README.md:507` — process-group ownership is claimed only when a `cancellationId` is supplied.
  `README.md:1077` — `stratum flow cancel <flow_id>      # Cancel a running foreground flow (exit 0 ok, 1 unconfirmed, 2 unknown flow)`
- **CHANGELOG** `/Users/ruze/reg/my/forge/stratum/CHANGELOG.md:3-27` — `## [0.5.0] — 2026-09-10`,
  with S03 (surfaces, "MCP surface 18->19 (25 tools)"), S02 (foreground registry,
  `~/.stratum/ts/agent_fg/<12hex>/meta.json`, `flow` on agent_run, `admitFlowAgent`), S01 (engine:
  run lock, driver lease, `cancelled` RunStatus, `flow_cancelled` event, events contract 3->4).
  STRAT-LOOP-CARRY 0.5.0 bullets are at `CHANGELOG.md:29-41` (surface 17->18 was carry).
- **Surface constant `19`**: `ts/contracts/mcp-surface.json:2`. Pinned in
  `ts/tests/mcp/contracts-grammar.test.ts:81-83` ("freezes surface 19 ...", `expect(surface.surface).toBe(19)`)
  and `ts/tests/mcp/schema-grammar.test.ts:88`.
- **Tool count `25`**: pinned at `ts/tests/engine/p4.test.ts:1014`
  (`expect(Object.keys(surface.tools)).toHaveLength(25)`). NOTE: there is no `ts/tests/p4.test.ts`;
  the file is `ts/tests/engine/p4.test.ts`.
- **Package version**: `@smartmemory/stratum` `0.5.0` (`ts/package.json:2-3`). The MCP server
  advertises it as `SERVER_VERSION`, read from package.json at `ts/src/mcp/server.ts:29` and used
  at `:542`.

So a compose-side version guard should assert: package `@smartmemory/stratum` >= `0.5.0`, MCP
surface `19`, and the presence of the `stratum_flow_cancel` tool.

---

## 7. CLI `stratum flow cancel <runId>` exit codes

`ts/src/cli/flow.ts` (whole file is the command; dispatched from `ts/src/cli/stratum.ts:30`:
`if (command === "flow") return (await import("./flow.js")).flowCommand(args);`).

| exit | condition | stdout JSON |
|---|---|---|
| **0** | cancelled OR already terminal (any status), acknowledged | `{_schema_version:"1", ok:true, flow_id, status, flowSettled, acknowledged, agents, detail?}` where `detail` is the `already_<status>` reason |
| **1** | `CANCELLATION_UNCONFIRMED` or `CANCELLATION_TEARDOWN_TIMEOUT` | `{_schema_version:"1", ok:false, error:<code>, flow_id, status, flowSettled, agents, reason?, holderPid?, message}` |
| **1** | any other error | `{_schema_version:"1", ok:false, error:"INVALID", flow_id, message}` |
| **2** | unknown flow (ENOENT) | `{_schema_version:"1", conflict:true, flow_id, detail:"flow_not_found"}` |
| **2** | usage error (wrong argc) | usage line on stderr, no JSON |

The exit-0-for-already-cancelled ruling is explicit (`cli/flow.ts:23-26`):

```ts
// R1-8: an already-terminal flow is a SUCCESS, not a conflict. The caller asked for the
// flow to be stopped and the flow is stopped; exit 2 here maps to {conflict:true} in
// compose's mutation client and would make every idempotent abort look like a failure.
```

Blueprint §13 records the same decision and reserves exit 2 for a genuinely unknown flow id.

The CLI passes NO `abortLocal` (it holds no controllers) and reads `STRATUM_STATE_ROOT ||
~/.stratum/ts/flows` (`cli/flow.ts:20`). It runs the identical phase sequence as the MCP tool
because both call `cancelFlow` and nothing else (R1-4).

**The CLI is the better choice for `--abort` if compose needs to distinguish "unknown flow" from
other failures**, because that distinction does not exist on the MCP surface (see Surprise 1).

---

## Surprises

Things that break the naive plan "compose `--abort` reads runId from `active-build.json` and calls
`stratum_flow_cancel`; the driving process's agent calls then fail and it exits".

1. **An unknown run id has NO structured MCP error.** It arrives as a generic `McpError`
   (`InternalError`) with `data === undefined` — no `code`, no `runId`
   (`ts/tests/mcp/flow_cancel_edges.test.ts:36-60`). Compose cannot distinguish "this build was
   never a stratum flow / the state root is wrong" from any other internal failure. The CLI gives
   exit 2 + `{conflict:true, detail:"flow_not_found"}` instead.

2. **`acknowledged: false` is a SUCCESS response, not an error.** Every already-completed /
   already-failed run returns `{acknowledged:false, flowSettled:false, reason:"already_completed"}`
   on the success path (`flow_cancel.ts:153-156`). Treating `acknowledged` as the pass/fail signal
   makes a normal double-abort look broken.

3. **`CANCELLATION_TEARDOWN_TIMEOUT` means the flow IS cancelled.** The error fires AFTER a
   completed settle; the flow-side fact lives in `data.flowSettled`, not in the presence of an
   error. Blueprint §11 says so explicitly and warns "the build must not be re-abortable-as-if-
   nothing-happened". Compose's existing treatment of that code as fatal/non-retryable stays
   correct, but the local status writes must still happen.

4. **A cancel can block for two minutes and then fail.** If the driver is inside
   `stratum_step_done`, the run lock is held across judged-ensure and evaluate-runner awaits
   (blueprint §12, STRAT-LOCK-SCOPE), so the cancel waits `STRATUM_CANCEL_LOCK_WAIT_MS` = 120s and
   then raises `CANCELLATION_UNCONFIRMED / run_lock_held` with `holderPid`. Consider setting that
   var low on the abort path and retrying, rather than hanging the user's terminal.

5. **A refused cancel leaves the agents ALIVE, by design.** Settle-first is absolute: `run_lock_held`
   and `engine_dispatch_active` both return an all-zero `agents` summary and sweep nothing, and the
   run is still `running` afterwards (`flow_cancel.ts:121-124`; `ts/tests/mcp/flow_cancel.test.ts:289-322`).
   `--abort` must not report success on that path.

6. **Both roots must match across the two processes.** State root (`STRATUM_STATE_ROOT`, else
   `~/.stratum/ts/flows`) and registry root (`STRATUM_AGENT_FG_ROOT`, else `~/.stratum/ts/agent_fg`).
   If compose's MCP server is launched with either env var set and the abort process is not (or
   vice versa), the abort either gets ENOENT or silently sweeps an empty registry and reports
   `acknowledged: true` with zero agents — a false success.

7. **Only agents dispatched with BOTH `flow` and `cancellationId` are cancellable by flow.** Any
   `stratum_agent_run` compose issues without them leaves no registry record and survives the
   cancel entirely. Compose's own `isolation:"none"` local agents stay compose's to abort
   (blueprint §11 "The split") — stratum cannot reach them.

8. **Adding `flow` to `stratum_agent_run` trips compose's own `#agentFields` guard.** Blueprint §11
   names it: the guard reads `stratum_agent_run`'s schema, and its message ("required execution
   surface: 17") needs updating to 19 on the compose side. A new TOOL alone would not have tripped
   it; a new REQUEST FIELD does, by design.

9. **The driver's in-flight `stratum_agent_run` fails with the generic `agent_run_failed` envelope**
   — no cancellation-specific code on the cross-process path (`server.ts:498-508`). Compose cannot
   tell "the flow was cancelled" from "the agent crashed" without checking the flow status.

10. **`stratum_step_done` and `stratum_resume` refuse a cancelled run with a PLAIN `Error` and no
    `code`** (`engine.ts:748`, `:1027-1028`), reaching the client as an undeclared generic error.
    And neither tool's response contract has a `cancelled` variant. The only clean signal for the
    driving process is `stratum_flow_poll` / `stratum_audit`, which do declare it. String-matching
    `/cancelled/` is what stratum's own tests do.

11. **`acknowledged: true` depends on a FOREIGN process finishing its unwind.** The sweeping process
    cannot stamp another LIVE MCP server's entry `settled` (`foreground_registry.ts:644-668`), so if
    the driver's dispatcher takes longer than `STRATUM_CANCEL_TIMEOUT_MS` = 15s to reach its
    `finally`, the cancel raises `CANCELLATION_TEARDOWN_TIMEOUT` even though every group was reaped.
    Re-running the cancel is the sanctioned recovery and re-sweeps.

12. **`cancellationId` is single-use per server process** (`server.ts:195`). A retry that reuses one
    is `input_validation_failed`. Generate a fresh UUID per agent dispatch.

13. **`flow.stepId` and `flow.itemIndex` are decorative in v1.** They are recorded in the registry
    and never validated against the run; the sweep matches on `flow.runId` only. Do not rely on them
    for per-item cancellation.

14. **Windows is a hard no.** Any `stratum_agent_run` carrying a `cancellationId` fails BEFORE spawn
    with `CANCELLATION_UNSUPPORTED_PLATFORM` (`connectors/cancellation.ts:18-20`). Making agent runs
    cancellable makes them Windows-fatal.

15. **Cancelling a Codex agent forces the `exec` transport** (`codex.ts:200`), not the SDK path. If
    compose depends on SDK-transport behaviour for codex dispatches, adding `cancellationId`
    silently changes the transport.

---

## ELI5 TLDR

**The cancel compose wants already works, and the one thing that can stop it is compose's own lock,
not the new lease.** Compose drives its own builds, so stratum never "pins" the run, so a second
process is free to cancel it and kill the agents it spawned. But if that second process asks to
cancel while compose is in the middle of finishing a step, it waits two minutes and then gives up
with the agents still running.

The other trap is that a successful cancel can still come back as an error: when an agent takes too
long to die, stratum throws even though the build is definitively stopped. Read the field that says
the flow settled, not the fact that it threw.

Two smaller ones: an agent is only killable from another process if compose tags it with BOTH the
flow and a fresh cancellation id, and adding that tag trips compose's own schema guard, which still
says it requires surface 17. It is 19 now.

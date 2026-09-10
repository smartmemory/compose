# COMP-BUILD-CANCEL — adjudicated decisions (Fable, 2026-09-10)

Inputs: explore-compose.md (974 lines), explore-stratum-full.md (842 lines, §1-7 by explorer 1), explore-stratum.md (547 lines).
Parent design: ../COMP-FABLE-ASTRA/design.md §D1, §D5. Stratum side shipped in @smartmemory/stratum 0.5.0
(STRAT-FLOW-CANCEL-FG blueprint §11 "The contract compose will call", §12 Out of scope).

Adjudication of the one explorer conflict: the compose explorer (Surprise 5) claimed a resumed build holds
a driver lease and an out-of-process cancel may refuse with `engine_dispatch_active`. The stratum explorer
refuted it with the code path (`scheduleFanout` returns at engine.ts:1886 for consumer dispatch before
`retainRun`; engine.ts:704 is rehydrateBgFlows, :1036 only resolves an incumbent lease). RULING: consumer
builds never hold a lease; `engine_dispatch_active` is handled as a generic unconfirmed refusal, not designed for.

## D-A  Flow-tag every agent run made while the run is `running`
- `buildAgentRunRequest` gains `flow: {runId, stepId, itemIndex}` (itemIndex only for fanout items) when
  `opts.flow` is set. When `flow` is set, `cancellationId` is ALWAYS minted (UUID, never reused) even
  without a signal — Stratum refuses `flow` without it.
- Tag: consumer-dispatch items (`runConsumerIssuance` → `runAndNormalize` → `#invokeAgentRun`) with
  `{runId: flowId, stepId, itemIndex}`. Any other `stratum_agent_run` compose issues while the run status is
  `running` (step-executing agents in headless build) is tagged `{runId, stepId}`; the drafter enumerates
  those call sites from explore-compose.md §2/§4 and decides per site by whether the run is `running`
  at that moment. REVISED 2026-09-10 (blueprint C1): a gate-paused run is still `running`, so gate-time agents
  ARE tagged too `{runId, stepId}`. Untagged agents stay killable only by compose's own
  AbortController (D-F).
- `stepId`/`itemIndex` are informational to Stratum (not validated); still pass real values for the audit.

## D-B  Version guard and version train
- Guard message: "required execution surface: 19 (@smartmemory/stratum >=0.5.0)". No new constant file;
  but if a single `REQUIRED_STRATUM_SURFACE = 19` / `REQUIRED_STRATUM_RANGE` pair is introduced it must be
  referenced from the message and from tests (derive, never hardcode literals in tests — versioning memory).
- Both fixture schemas (`test/review-fixes-runtime.test.js:25`, `test/execution-runtime.test.js:163`) gain
  `flow` in the advertised `stratum_agent_run` properties.
- Version train in ONE commit: compose `0.5.0`, compose-mcp `0.5.0` (+ dep `^0.5.0`), server.json both
  sites, `@smartmemory/stratum` dep `^0.5.0`. CHANGELOG entry in the same commit. `test/version-sync.test.js`
  is the control. The node_modules symlink to ../stratum/ts is local dev setup: do not touch it.

## D-C  `compose build --abort` (out-of-process) calls `stratum_flow_cancel` FIRST, honestly
New client method `flowCancel(runId)` → `stratum_flow_cancel {runId}`, unwrapping the
`flow_cancel_unacknowledged` envelope into a `StratumError` whose `code` is `data.code`
(`CANCELLATION_UNCONFIRMED` | `CANCELLATION_TEARDOWN_TIMEOUT`) with `reason`, `holderPid`, `flowSettled`,
`agents` attached.

abortBuild sequence:
1. Read active-build.json; refuse if none / feature mismatch / already terminal (as today).
2. Fresh client, `flowCancel(active.flowId)`. Outcome classes:
   - success (`acknowledged:true`, or `acknowledged:false` with `reason: already_<terminal>`): settled.
   - `flow_not_found` / unknown run: treat as settled-nothing-to-cancel (local cleanup proceeds, say so).
   - `CANCELLATION_TEARDOWN_TIMEOUT` (flowSettled ALWAYS true): call `flowCancel` ONCE more (idempotent
     re-sweep, `already_cancelled`); if still unacknowledged, report `agents` counts (unreaped/unreachable)
     and continue: the flow IS settled.
   - `CANCELLATION_UNCONFIRMED` with `flowSettled:false` (`run_lock_held`, `engine_dispatch_active`, or a
     transport failure): retry `run_lock_held` up to `COMPOSE_ABORT_RETRIES` (default 2) with a short pause;
     if still unconfirmed → DO NOT write `aborted`, do not kill the vision item; print the reason + holderPid
     and return `{ok:false, ...}` (CLI exit 1). "A refusal sweeps nothing" — compose must not claim aborted.
   - `unreachable > 0` never clears by retry: report, do not loop on it.
   The discriminator for "did the build stop" is `flowSettled`, never the code.
3. Only when settled: SIGTERM the driver pid from active-build.json (best-effort, only if `status==='running'`
   and the pid is alive; ESRCH ignored) so the driver's handler (D-E) tears down isolation:none agents and
   exits. Then the existing vision-kill / active-build `aborted` / actuals writes, in that order.
4. active-build write must NOT restamp `pid` with the aborting process's pid (explore-compose Surprise 10):
   preserve the driver pid; use the identity-guarded downgrade pattern at build.js:2939-2950.
5. Return a structured result `{ok, flowId, status, flowSettled, acknowledged, reason, agents, holderPid}`;
   the HTTP route forwards it; the CLI prints one line per field that matters and exits 0/1.
The bare `catch {}` around the audit probe is replaced: only `flow_not_found`-class errors are tolerated.

## D-D  The driver detects a cross-process cancel and stops merging
After a cross-process cancel the driver's in-flight `stratum_agent_run` rejects with the GENERIC
`agent_run_failed` (message "codex exited with code 143" / stderr) — no cancel code — and the next
`stratum_step_done` / `gate_resolve` throws an UNCODED Error("run <id> is cancelled; ..."). Therefore:
- Add `isRunCancelled(flowId)` = `stratum.audit(flowId).status === 'cancelled'` (audit succeeds on a
  cancelled run). Call it (a) in the control-failure branch at build.js:958-973 before classifying an
  agent failure as retryable, and (b) when `step_done`/`gate_resolve` throws an error whose message
  matches /is cancelled/ or whose code is `PERSIST_ON_CANCELLED_RUN` / `flow_cancelled`.
- When cancelled: set a build-level `cancelled` flag, `buildStatus = 'aborted'`, stop the pump, skip every
  pending item retry, and NEVER merge a patch captured after the flag is set. The merge site (explore-compose
  §2 "Where captured patches are merged") checks the flag before applying; a captured diff for an item that
  completed after the cancel is discarded with a journal line, not merged.
- Terminal write uses the identity-guarded pattern so it does not clobber `aborted` written by abortBuild;
  no `usage_report` / receipt flush is attempted on a cancelled run (PERSIST_ON_CANCELLED_RUN).

## D-E  SIGINT/SIGTERM in the driver does a real teardown (same-process path)
The handler today only sets `buildStatus='killed'` and closes the stream. New handler, bounded and idempotent:
1. First signal: set `cancelled`, abort the build-level AbortController (D-F), call `flowCancel(flowId)` on
   the build's OWN client (same-process → `abortLocal` aborts the controllers; agent calls reject with
   "Flow cancelled"), under a deadline `COMPOSE_CANCEL_TIMEOUT_MS` (existing, 15000). On
   `already_cancelled` (abortBuild got there first) that is success.
2. Then vision kill, active-build `aborted` (identity-guarded), actuals, stream close, remove listeners,
   `process.exit(130)` for SIGINT / `143` for SIGTERM.
3. Second signal during teardown: force `process.exit` immediately.
The handler must not await the pump; it runs the teardown concurrently and exits.

## D-F  isolation:none agents die with the build
`runAndNormalize`'s per-call AbortController (result-normalizer.js:433) chains to a build-level
`AbortSignal` passed via `executionOptions` (result-normalizer.js:367-377) → `AbortSignal.any([...])`.
The signal handler (D-E) and the cancel detector (D-D) abort the build-level controller. abortBuild
(out-of-process) reaches them only via the SIGTERM to the driver pid (D-C step 3); this is the v1
boundary, stated in the blueprint.

## D-G  Tests (node:test; real stratum where it is cheap)
- Golden: an integration test that spawns the REAL `stratum mcp` server (as `resolveStratumMcpConnection`
  does), `stratum_plan`s a minimal consumer-fanout spec, runs `stratum_agent_run` with `flow` +
  `cancellationId` for an agent that sleeps (check how stratum's own tests fake a slow agent —
  ts/tests/mcp/flow_cancel*.test.ts — and reuse the same trick if it is reachable from a consumer, else
  use a real `claude`/`codex` connector only if the suite already does so; otherwise fall back to the
  injected `_testClient` for the agent step and keep the real server for plan + flow_cancel + audit).
  Assert: cancel from a SECOND client settles the run, audit says `cancelled`, a subsequent
  `stratum_agent_run` with `flow` is refused `flow_not_running`.
- abortBuild table-driven error harness with an injected client: each outcome class in D-C → expected
  local writes (or none) and return shape; pid preserved; driver SIGTERM only when settled.
- Driver detection (D-D): injected client where `agent_run` rejects `agent_run_failed` and `audit` returns
  `cancelled` → build ends `aborted`, no merge attempted, no retry.
- Signal handler (D-E): spawn the build in a child process with an injected slow local agent, send SIGINT,
  assert exit code, active-build `aborted`, flowCancel called once. If the harness cannot spawn a full build,
  unit-test the extracted teardown function with a fake client and a fake process object.
- Version guard: existing tests updated to advertise `flow`; a new assertion that a server WITHOUT `flow`
  yields UNSUPPORTED_AGENT_OPTIONS naming surface 19 / >=0.5.0 (derived from the constant, not a literal).
- version-sync test is the control for D-B; run it.
Never hardcode a version literal in a test. Never use a shipped preset spec as a test dialect fixture.

## Out of scope (state in blueprint §Out of scope)
- Preset `carry:` / `verify after: [execute_merge]` (COMP-FABLE-ASTRA slice 4; no preset exists yet).
- Reaching isolation:none agents from a second process other than via SIGTERM to the driver.
- (REVISED 2026-09-10: gate-time agents ARE tagged; see D-A.)
- Windows (`CANCELLATION_UNSUPPORTED_PLATFORM`).
- STRAT-LOCK-SCOPE (judged ensure inside the run lock makes `run_lock_held` take up to 120s): stratum
  follow-up, compose only retries.
- Cross-process env agreement: compose spawns both servers with the same env; a per-build
  STRATUM_STATE_ROOT is not introduced here — the blueprint verifies compose sets none today.

# Codex gate round 1 (gpt-5.6-sol/high, runId 6971d8d7ed4f, 2026-09-10) — findings + Fable rulings

1. must-fix HTTP route runs runBuild + abortBuild in ONE process; SIGTERM-to-pid would kill the compose server, and
   the self-pid guard would leave local agents alive on HTTP abort.
   RULING: accept. Add a module-level in-process registry `activeBuildCancels: Map<flowId, BuildCancel>` in
   lib/build-cancel.js (registered in runBuild, removed in finally). abortBuild checks it FIRST: same process →
   call buildCancel.cancel('abort') directly (no signal). Only when the recorded pid !== process.pid AND is alive
   does it SIGTERM. Never signal process.pid.
2. must-fix active-build.json writers race on a shared .tmp name.
   RULING: accept. Unique tmp name (`active-build.json.<pid>.<random>.tmp`) + ONE terminal owner: when the driver
   is alive (in-process handle present, or foreign pid alive), abortBuild does NOT write the terminal record; it
   waits (bounded, COMPOSE_ABORT_DRIVER_WAIT_MS default 20000) for the driver to exit/settle and re-reads. It
   writes `aborted` itself only when no live driver exists (pid dead/absent) or the wait expires (then it writes
   with the identity guard and reports `driverExited:false`).
3. must-fix no-merge-after-cancel is TOCTOU: cancel can settle mid-applyMerge.
   RULING: accept, two-part fence. Pre-apply check (as written) PLUS post-apply confirmation: after applyMerge
   returns, if `buildCancel.cancelled` or `isRunCancelled(flowId)` → reverse-apply that item's captured diff
   (`git apply -R` of the journaled cumulative diff; drafter verifies applyMerge's inputs make this possible),
   journal `merge_reverted_after_cancel`, and if the reverse fails journal `merge_revert_failed` and leave the
   tree dirty with a named finding (--fresh already owns clean restart). The isRunCancelled audit call after each
   merge is one cheap RPC; acceptable.
4. must-fix detection only at the consumer catch; ordinary step / gate fixer / gate Q&A rethrow before stepDone.
   RULING: accept. One shared boundary: `confirmCancellation(error, ctx)` in lib/build-cancel.js, called from
   runAndNormalize's error path (covers consumer, ordinary step, fixer) and from runAgentText's caller for gate Q&A.
5. must-fix outer catch resets buildStatus='failed' and terminalizes as failed; aborted branch keyed on killedByGate.
   RULING: accept. Outer catch: `if (buildCancel.cancelled) → aborted terminalizer` (existing aborted branch
   generalised to `killedByGate || buildCancel.cancelled`). Vision item → killed, not blocked.
6. must-fix cancel() conflates cancelled with teardownStarted; S05's cancel() before the first SIGTERM makes the
   first signal behave like a second.
   RULING: accept. Two states on the handle: `cancelled` (idempotent, reason recorded) and `teardownStarted`
   (set only by runCancelTeardown); the handler's second-signal branch keys on `teardownStarted`.
7. must-fix unknown flow ≠ nothing running (ENOENT rethrown before any sweep).
   RULING: accept. Unknown flow → `ok:false, reason:'flow_not_found'`, no local terminal write, no vision kill.
   Exception: active record has NO flowId (pre-plan) → nothing to cancel in stratum; proceed with driver
   handling per (1)/(2).
8. must-fix raw transport failure falls outside the outcome table.
   RULING: accept. flowCancel() normalises any non-envelope, non-unknown-flow error to a StratumError
   `CANCELLATION_UNCONFIRMED{reason:'transport', flowSettled:false, agents: zeros}`; abortBuild's table has a
   catch-all refusal row.
9. must-fix isTerminalFlow lacks `cancelled`; recovery would try to resume a cancelled run.
   RULING: accept. Add `cancelled` to isTerminalFlow; a resume attempt on an audited `cancelled` run writes the
   local record `aborted` (identity-guarded, driver-owned since this IS the driver) and refuses the resume with
   a named reason.
10. should-fix S04 lacks the early refusal on an already-terminal active record.
   RULING: accept; refuse with `ok:false, reason:'already_<status>'` and no writes.
11. should-fix golden exercises no real compose call site; contradictory assertions (step 4 resolves; S06 local
   vs tagged).
   RULING: accept. S07 gains a SECOND test: a real child `compose build` (spawned bin/compose.js in a tmp
   project, headless, using a pipeline whose agents are all codex so the fake `codex` on PATH serves them;
   drafter verifies which existing golden spawns a full build and reuses its project fixture) + `compose build
   --abort` from a second process; assert: flow audited `cancelled`, fake-codex process group gone, child exit
   code, active-build `aborted` with the driver pid preserved, no merge applied after cancel (the fake codex
   writes a file the merge would carry). Fix the two contradictory assertions: step-4 asserts the SUCCESS shape;
   S06's child test uses a tagged (stratum) agent, and a SEPARATE unit test covers the local-agent abort via the
   handle.
12. should-fix transport change reaches non-team modes with no equivalence coverage.
   RULING: partially accept. First VERIFY: consumer dispatch already passes a signal → cancellationId → exec
   today (stratum-mcp-client.js:272 + result-normalizer.js:583), so the team/fanout path is ALREADY exec and C18
   overstates the blast radius; the change reaches only ordinary-step and gate agents. State that precisely.
   Then: keep tagging everywhere (cancellable builds is the goal; ownProcessGroup requires exec by stratum
   design), add an env kill switch `COMPOSE_FLOW_TAGGING=0` (default on) that drops `flow` (and the minted
   cancellationId when no signal) so an exec-transport regression can be bypassed without a release, and record
   the transport in the build journal per agent run (from the returned telemetry if stratum reports it; drafter
   checks ConnectorResult for a transport field) so live builds show which transport ran. No fake equivalence test.

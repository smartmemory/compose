# Codex gate round 2 (gpt-5.6-sol/high, runId 82fa56a04eba, 2026-09-10) — findings + Fable rulings
All accepted. Budget note: r1 9 must-fix, r2 10 must-fix (on the fixes). Round 3 is the CAP: any must-fix left
after r3 → split S05 (driver detection + no-merge-after-cancel + resume refusal) into COMP-BUILD-CANCEL-DRIVER.

1. looksCancelled misses generic `agent_run_failed` (server.ts:503-508 → AgentError at result-normalizer.js:591-620).
   RULING: the trigger is "any failure of a FLOW-TAGGED call" (checked before AgentError conversion), then audit.
2. makeAskAgent has no route to buildCancel (context at build.js:3020-3047; makeAskAgent :1960/:4469).
   RULING: `buildCancel` goes on the build context; makeAskAgent reads it; add a killed-gate-Q&A acceptance case.
3. In-process registry registered after up to 180s of codex preflight (build.js:2916-2959, codex-preflight.js:33/127-141)
   while active-build.json already exists (build.js:5568-5588).
   RULING: register the handle the moment `response.runId` exists (startFresh/resume), before preflight; chain the
   build signal into the preflight controller.
4. Two concurrent terminal owners in the driver (fire-and-forget runCancelTeardown vs outer catch terminalizer,
   build.js:4931-4971).
   RULING: one shared promise: `buildCancel.teardown` (set by runCancelTeardown); the outer catch awaits it when
   present and skips its own terminalization; the teardown alone calls process.exit, after the outer finally's
   resource closes have run (teardown awaits a `drained` promise the build resolves in its finally, bounded).
5. Transport normalisation missing from the S02 sketch; connect() failures (stratum-mcp-client.js:442-468) bypass flowCancel.
   RULING: flowCancel normalises every non-envelope non-ENOENT error → CANCELLATION_UNCONFIRMED{reason:'transport'};
   abortBuild wraps connect() the same way; catch-all row in the table.
6. Post-merge fence throws ConsumerMergeDecisionError, which build.js:4223-4240 catches into repairFor.
   RULING: distinct error `MergeAfterCancelError` (code MERGE_AFTER_CANCEL), fence placed OUTSIDE that catch; unwinds
   straight to the cancelled terminalizer.
7. `merge_revert_failed` cannot be journaled: #mutate writes only after the callback succeeds (consumer-fanout.js:339-354).
   RULING: separate guarded failure mutation after a failed restore (`state:'rollback_failed'`, failureCode, failure).
8. Aborter cleanup not identity-guarded as a unit; missing flowId matches anything; vision killed before the guard.
   RULING: re-read + claim identity (flowId, else pid+startedAt strictly) BEFORE any mutation (vision, state,
   actuals); ok:false `ownership_lost` if the record changed.
9. Cancelled-resume acceptance checks only terminality (build.js:1832-1837, 2772-2805).
   RULING: explicit audited-`cancelled` branch: identity-guarded local `aborted` write with reason
   `flow_cancelled`, named refusal, no fresh plan; assert all three.
10. Child-build golden marker never reaches capture (killed sleeper never returns; capture at build.js:933-1018 /
   consumer-fanout.js:742-810). Step 7 still cites a CANCELLATION_* error at step 4.
   RULING: two lanes: lane A completes and captures a marker; lane B sleeps; abort during B; assert lane A's
   marker is NOT in the target tree (baseline restored) and the journal shows rollbackReason 'cancelled'.
   Fix step 7 wording (step 4 resolves).
11. should-fix `transport_derived` has no dispatch-ledger schema (dispatch-ledger.js:54-61/120-149; rejection
   swallowed at stratum-mcp-client.js:194-238); S03 overstates the gate fixer's transport change (it already
   passes signal+cancellationId, result-normalizer.js:581-586/747-751).
   RULING: add the field to the ledger schema + file plan, populate where cancellationId is minted, assert the
   persisted row; correct S03's claim.

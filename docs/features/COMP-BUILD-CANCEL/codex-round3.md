# Codex gate round 3 (gpt-5.6-sol/high, runId da0ee7b9e46d, 2026-09-10) — findings + Fable rulings
6 must-fix + 1 should-fix (r1 9, r2 10, r3 6): converging; 1/3/4 are sketch-vs-prose inconsistencies.
DECISION: revision 4 applies all seven; NO round-4 blueprint review (3-round budget; CLEAN is a cap). The
implementation review will re-check these seams. S05 is NOT split.

1. §3.6 handshake vs S05-4/S06-2 sketches contradict (teardown not assigned, no drained await, actuals emitted twice).
   RULING: make the sketches match §3.6 exactly; one place emits actuals (finalizeBuildAttempt, build.js:2295).
2. Join bound (5s) < teardown worst case (15s flowCancel + 10s drained); CLI catch exits 1 (compose.js:2860).
   RULING: join bound = COMPOSE_CANCEL_TIMEOUT_MS + COMPOSE_DRAIN_TIMEOUT_MS + 1s; and the CLI `.then/.catch`
   awaits `buildCancel.teardown` when present before exiting (export a `pendingTeardown()` accessor from
   lib/build-cancel.js the CLI can await).
3. S05-3 sketch still throws ConsumerMergeDecisionError (caught into repairFor at build.js:4223).
   RULING: sketch throws MergeAfterCancelError; fence outside the catch, as the prose says.
4. claimActiveBuild fallback matches undefined===undefined; S04 write sketch keeps the missing-flow disjunction.
   RULING: presence-validated fallback (pid AND startedAt present, else refuse `ownership_unverifiable`); remove the
   disjunction.
5. Audited-cancelled resume branch assumes "this process is the driver" — false in the HTTP server (build-routes.js:130).
   RULING: consult activeBuildCancels first; if a handle exists, hand the write to it (cancel('flow_cancelled')) and
   refuse the resume; write locally only when no handle exists and the identity claim succeeds.
6. Two-lane child golden cannot reach the merge (engine.ts:2074: fanout settles only when all lanes terminal; merge
   only after gate-ready, build.js:4219).
   RULING: the child golden asserts what a mid-fanout abort CAN prove: fake-codex groups gone, flow audited
   `cancelled`, driver exit code, active-build `aborted` with driver pid preserved, NO merge transaction in the
   journal, lane A's captured diff still journaled (evidence kept) and absent from the target tree. The post-apply
   fence + restoreMergeBaseline path is pinned by a UNIT test that injects the cancel between applyMerge's return
   and the fence (spy on applyMerge / isRunCancelled) — name it in S05 tests. Remove the unmeetable
   rollbackReason assertion from S07.
7. should-fix: preflight cancel not asserted end-to-end (codex-preflight.js:127 owns its own controller);
   transport_derived never carried back into the dispatch event (minted at stratum-mcp-client.js:270, event built
   at :194 from caller opts).
   RULING: preflight takes `signal` and the test uses a never-settling probe + cancel → prompt rejection; the
   dispatch event is built AFTER the cancellationId is minted (or patched with the derived fact) and the test
   asserts the persisted row from a real tagged dispatch through the client.

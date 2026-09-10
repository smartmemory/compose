# Implementation review round 2 (gpt-6-astra/high, runId dc1d1c8577e8, 2026-09-10) — commits 9a9ebb2..7014c13
Lenses: round-1 fixes hold + S04/S05 as new code. 123 focused tests passed; all 4 findings REPRODUCED by probes the
suite lacks (real child CLI runs + fake clients). All 4 accepted (Fable re-read each site; every one is visible in the
code as written). Fix before S07.

1. must-fix Cancellation during the post-apply audit bypasses rollback: build.js:4433 evaluates
   `buildCancel.cancelled || await isRunCancelled()` — the local flag is read BEFORE the audit await and never
   rechecked after it. A cancel landing during the await, with the audit returning its earlier `running` snapshot,
   passes the fence; the later guard at :4466 throws WITHOUT restoreMergeBaseline. Repro: active `aborted`, captured
   file still in the tree, transaction `complete`, issuance `merged`, no rollback reason. Same defect when the cancel
   is first confirmed by `gateResolve` (test/build-cancel-detect.test.js:201 passes while the merged file remains).
   FIX: recheck the handle after the audit; a cancel confirmed at gateResolve must roll back the applied merge
   before the gate is treated as accepted. Regression tests for both timings.
2. must-fix Ownership claim expires across the awaited vision update: build-cancel.js:194 claims, awaits
   killVision(), then writeTerminal(claim.record) with no re-claim; build.js:6226 (abortBuild) re-claims before the
   awaited `updateItemStatus`, then writeActiveBuild after it. Repro (real child CLI): install a replacement build
   while vision cleanup awaits → SIGINT teardown kills the shared vision item and overwrites the replacement's
   `running` record with the old flow's `aborted` record; abortBuild variant does the same and returns ok:true.
   Round-1 test passes because its replacement lands before the claim. FIX: re-claim after every await before the
   terminal write (and skip the write on ownership_lost); vision kill must not fire on a lost claim.
3. must-fix Same-process cancellation leaves web-gate drivers polling: build.js:4698 calls pollGateResolution
   without buildSignal; the loop at :5920 never checks cancellation. Repro: pending web gate + abortBuild → handle
   cancelled, bounded wait exhausted, `aborted` written, ok:true — driver keeps polling with registry handle +
   resources retained until a gate decision arrives. Affects ordinary non-team builds. FIX: thread buildSignal
   through pollGateResolution and its sleeps; exit the loop on abort and fall into confirmCancellation.
4. must-fix Health finalization downgrades `aborted` to `failed`: build.js:4868 checks `!buildCancel.cancelled` on
   entry only; a signal during the async health work sets buildStatus='aborted' and :4939 then overwrites it with
   'failed' and re-persists. Repro (real child CLI, SIGINT during health finalization with a rejecting threshold):
   exit 130, active `aborted`, history `failed`. FIX: recheck teardown ownership before every health mutation and
   before the final history/actuals emission.

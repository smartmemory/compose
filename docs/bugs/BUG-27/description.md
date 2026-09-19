# BUG-27: fanout receipt recovery emits a non-`legacy:` dispatchId after a real runner pause

## Steps to reproduce

1. `cd compose && COMPOSE_PORT=19997 node --test test/build-model-route-outcomes.test.js`
2. Test 28 fails: "real engine-driven fanout recovers persisted receipts and coverage after the runner pauses" (`test/build-model-route-outcomes.test.js:284`)
3. Reproduces 100% deterministically in isolation — 6/6 across 3 runs on the current `main` tip (`4fa1f6b`) and 3 runs on a clean worktree at the commit right before this session (`067b876`). Confirmed via controlled A/B, so it predates and is unrelated to both of today's commits (`0d001a6` docs/roadmap reconciliation, `4fa1f6b` kickoff-usage fix in `lib/new.js`).
4. NOTE: without `COMPOSE_PORT=19997` set, this test hangs indefinitely instead of failing, because a live local compose dev server on :4001 intercepts its gate probe (separate, already-known issue — see forge memory `reference_compose_npm_test_proofrun_hang.md`, "LIVE :4001 server captures test gates"). Always set `COMPOSE_PORT=19997` when running this test.

## Expected behavior

`assert.ok(receipts.every(r => r.engineReceiptEvidence.receipt.dispatchId.startsWith('legacy:')))` (line ~284) passes — every recovered receipt's `dispatchId` carries the `legacy:` prefix after the engine-driven fanout recovers persisted receipts and coverage following a real runner pause.

## Actual behavior

The assertion fails: at least one recovered receipt's `engineReceiptEvidence.receipt.dispatchId` does not start with `legacy:`. Test title implies the failure is specifically in the recovery path exercised when "the runner pauses" — i.e. something about how a paused/resumed fanout run reconstructs or re-derives dispatch ids for persisted receipts.

## Environment / Notes

- Node test runner (`node --test`), real engine/fanout machinery (not mocked) per the test's own naming convention ("real engine-driven fanout").
- This is a pre-existing, deterministic bug, not a load-sensitive `flake` like others noted in project memory (`test/lifecycle-routes.test.js`, `test/ts-cutover-pipeline-fanout-golden.test.js`): 6/6 identical failures across 6 isolated single-file runs (3 on `4fa1f6b`, 3 on `067b876`, see reproduction step 3 above), zero passes, with no concurrent load in any run.
- Relevant code is presumably in `lib/build.js` (fanout/receipt machinery) and/or `lib/routing-ledger.js` (receipt persistence/recovery) — neither of today's two commits touches these files.
- Diagnostic worktree used for the A/B control has already been cleaned up (`git worktree remove`).

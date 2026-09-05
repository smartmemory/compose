# COMP-LIFECYCLE-BACKFILL — progress ledger (session 2026-09-05)

Stratum run for this lifecycle: runId `9ed5acaf-cf66-42e8-a23b-be70a8bb14d3` (steps write_design DONE,
write_blueprint READY dispatchToken `ff97e416-04ed-4008-a952-cb3cad1f6baf`, implement pending).

## Done
- Roadmap reconciliation + completion-gate resolved_by fix: compose `d459846`.
- Design revision + three Codex gates (8→7→5, all folded): compose `f0b4259`; addendum `9289690`.
- Stratum releases, all published and on the registry: 0.4.2 `guard apply-upgrade` + `guard policy`;
  0.4.3 `guard digest`; 0.4.4 `expected_policy_checksum` on transition. Tags v0.4.2..v0.4.4.
- Blueprint written (Opus agent `blueprint-backfill`); gate r1 = 18 findings, r2 = 13 findings, all
  confirmed, adjudications in `reviews/blueprint-r{1,2}-2026-09-05.md` (committed `9289690`, `e98449b`).

- Blueprint gate r3 (astra, run `a9adac34b488`): 8 findings (7 P1 + 1 P2), 8/8 CONFIRMED, folded by
  Opus (C35-C42, writeContext, §5.9c, StoredHistoryEntry, R25-R29); validator ok; 21 stale
  verification rows from the 0.4.4 checksum work corrected. `reviews/blueprint-r3-2026-09-05.md`.
- `plan.md` written (tasks 1-4, checkbox ACs), aligned with the r3 fold.

## In flight
- Codex round 4, fixes-only (justified by the r3 P1s; review-budget rule says this is the last).
- Next: fold r4 if needed → `stratum_step_done` write_blueprint → S1 dispatch.

## Then
- plan.md (ordered tasks from the blueprint File Plan, S1→S2→S3).
- Implementation dispatch: S1 (graph/transport/descriptors) Codex terra; S2 (gate intent + valid-time
  history) Opus high — judgment-heavy; S3 (routes/MCP/readers/UI) Codex terra. Each slice: Codex
  impl review to CLEAN (≤3 rounds), controller adjudication, targeted tests; ONE compose full suite
  at the end (`CI=1 npm test`, then `npm run test:ui`, `npm run test:tracker` separately).
- compose package.json `@smartmemory/stratum` → `^0.4.4`; CHANGELOG + README operator steps.
- Ship: record_completion through the gate (fixed today), roadmap row, journal entry.

## Operator steps the user must do (cannot be automated)
1. `ssh-keygen -t ed25519 -f ~/.stratum/guard-signing -C "<who>"` (passphrase, never in ssh-agent).
2. Enrol the PUBLIC key in stratum `ts/contracts/guard-signers.allowed`, commit, release, install in compose.
3. `compose guard descriptors` → `ssh-keygen -Y sign -f ~/.stratum/guard-signing -n stratum-guard-descriptors .compose/guard-upgrades.json` → commit the json + .sig.

## Landmines
- Never send `resolved_by` other than agent|human to stratum ≥0.4.0 (broke every completion today).
- compose's node_modules/@smartmemory/stratum is a SYMLINK to stratum/ts — keep it; dist is built.
- compose Aug-30 dirt (docs/context/decisions.md, COMP-GUARD-CLAIM-1/*, COMP-MCP-ENFORCE/report.md) stays uncommitted.
- Codex full-suite counts from inside the sandbox are garbage for compose; run unsandboxed.

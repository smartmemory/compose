# COMP-LIFECYCLE-BACKFILL — progress ledger (session 2026-09-05)

Stratum run for this lifecycle: runId `9ed5acaf-cf66-42e8-a23b-be70a8bb14d3` (steps write_design DONE,
write_blueprint DONE 2026-09-06, implement READY dispatchToken `e94162a0-6e11-4234-b310-378192744354`).

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

- Blueprint gate r4 (astra, run `f79ddc7ffbaf`, fixes-only): 2 findings (1 P1 + 1 P2), both residuals
  of R3-2, both CONFIRMED and folded by the controller (C43/C44, error-shape helpers); validator ok.
  Reviewer executed §7.1 dep resolution from stratum/ts: works. GATE CLOSED (18→13→8→2).
  `reviews/blueprint-r4-2026-09-05.md`.

- S1 SHIPPED (Codex terra impl `870e3206969f`, review `c65530d8f566`: 3/3 confirmed + fixed by controller,
  `reviews/impl-s1-r1-2026-09-06.md`). Targeted set 11 files green (see commit). Seam cross-check
  derive∘project == buildPhaseGraph for all 4 modes. Live `compose guard descriptors` → 0 (correct; all 3
  real registered features terminal, 32 registered ids are test fixtures).

- S2 SHIPPED (Opus `impl-s2`; Codex astra reviews r1 = 7 findings (3 P1) all fixed, r2 = 2 P2 residuals fixed,
  no r3 — `reviews/impl-s2-r{1,2}-2026-09-06.md`). Final targeted set 485/485 unsandboxed; real
  `~/.stratum/guards` untouched (golden flow isolates HOME + CLI at an isolated stratum copy, no fake client).
  Accepted deviations: Flow A steps 6/7/8 (mid-op policy-change variants) unbuilt; H7 refuses at §4.1 4e;
  fresh branch uses raw guardTransition (wrapper collapses replayed→applied); projection widening +
  allowlist entry landed in S2; `server/schema-validator.js` gains Ajv `$data:true`.

- S3 SHIPPED (Codex terra impl `ee9553abb565`, review `25ca71ca7d1b` 3 P2 → fix run `fbcde24e8ccc`; two
  sandbox-invisible test defects fixed by the controller — `reviews/impl-s3-r1-2026-09-06.md`). Tool inventory
  re-pinned 52/27. Ship prep in the same commit: stratum ^0.4.4, CHANGELOG, README operator steps, report.md.

- SHIPPED + COMPLETE 2026-09-06. Full suite 6206/6206 after re-pinning the tool-count contracts
  (`dbc3e17`), test:ui 613, test:tracker 100. Completion recorded through the gate at `dbc3e17` via
  `compose record-completion` (the session's compose MCP process predates today's code and had registered
  the feature's guard with the legacy graph; the CLI ran the new code and the legacy-policy path accepted
  it live — guard ledger: ship→complete applied). Journal session 113. Stratum run
  `9ed5acaf-cf66-42e8-a23b-be70a8bb14d3` COMPLETED (3 steps, 4 dispatches).

## Done — nothing in flight
## Was planned as "Then" (all done)
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

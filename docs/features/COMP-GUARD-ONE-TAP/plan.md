# COMP-GUARD-ONE-TAP — Implementation Plan

**Design:** [design.md](./design.md) (r3, gate CLEAN). **Blueprint:** [blueprint.md](./blueprint.md).
**Ledger:** [progress.md](./progress.md). **Contract:** no new JSON contract — the refusal envelope is the
existing `{ refusedAt, reasons, guardError }` 422 body plus `hint`; the custody result shape is internal.

Sequential slices (S1 → S2 → S3 → S4); within a slice, tasks are ordered by dependency. TDD per task:
write the test, watch it fail for the right reason, implement, watch it pass. Codex implementation
review after S1+S2 together and after S3 (`gpt-5.6-terra/high`, workspace-write, then rerun any
server/route suite unsandboxed). One full suite at the end.

## S1 — custody, signer, generations

- [ ] **T1.1** `lib/dir-lock.js` (existing): `acquireDirLock(path, { timeoutMs } = {})`; `LOCK_ACQUIRE_TIMEOUT_MS`
      stays the default. Test: `test/dir-lock-timeout.test.js` (new — no dir-lock test exists today) — a 100 ms
      budget throws `DirLockTimeout` at ~100 ms while another holder sits on the lock; no option → default path.
- [ ] **T1.2** `lib/guard-custody.js` (new): constants, `custodyBackend`, `custodyStatus`, `custodySign`,
      `_testOnly_setCustodyBackend`, `SUDO_ENV`, `HINT_*`, `DESCRIPTOR_LOCK_TIMEOUT_MS`; `deps.execFile` injectable.
      Test: `test/guard-custody.test.js` — argv `['-k', SIGNER_PATH, ns]`, env allow-list, mapping table (approve /
      not-approved variants / signer 64 / signer 66 / spawn error / timeout), `_testOnly_*` refused outside test.
- [ ] **T1.3** `scripts/guard-sign/compose-guard-sign.sh` (existing): header comment only. Test:
      `test/guard-sign-script.test.js` — signs via `COMPOSE_GUARD_SIGN_KEY`, verifies with the installed
      `dist/guard/sshsig.js`; namespace injection → 64; missing key → 66; no staging leftovers; skip if no `ssh-keygen`.
- [ ] **T1.4** `server/stratum-client.js` (existing): `guardDescriptors(descriptorsPath)`. Test: existing transport
      test pattern (`test/lifecycle-backfill-upgrade.test.js:17` shape) — env carries the path, action `descriptors`.
- [ ] **T1.5** `lib/guard-descriptors.js` (existing): remove `writeDescriptorFile`; add `generationPaths`,
      `currentGeneration`, `adoptLegacyFlatPair`, `verifyGeneration`, `ensureSignedDescriptors`,
      `prepareUnsignedCandidate`, `pruneGenerations` (blueprint §2.3, all branches incl. try/catch). Test:
      `test/guard-descriptors.test.js` — layout, adoption idempotent, fresh → 0 prompts, refusal leaves `current`
      + bytes + no staging, invalid existing `<sha>` → refuse without moving `current`, unsigned candidate →
      signed in place, race destination re-verified, writable generation not fresh, thrown enumeration → envelope,
      prune keeps `current` + intents.

## S2 — gate hook and refusal envelope

- [ ] **T2.1** `server/lifecycle-guard.js` (existing): `applyBackfillUpgrade` per blueprint §3.1 (already-upgraded
      short-circuit, lock with budget, `ensure` dep, resolved generation path, cache refresh, complete envelopes);
      `_client.descriptors`. Test: `test/lifecycle-backfill-upgrade.test.js` rows in blueprint §3.5.
- [ ] **T2.2** `lib/completion-gate.js` (existing, :963-970): conditional manual line + hint. Test: golden flows.
- [ ] **T2.3** `server/vision-routes.js` (existing, :663-668): top-level `hint`. Test: routes suite + real-producer
      failure row (blueprint §3.5).
- [ ] **T2.4** `server/compose-mcp-tools.js` (existing, :710-715): 4xx message carries reasons + hint. Test: nearest
      MCP tools test (V-12 says nothing pins the old text).
- [ ] **T2.5** `test/lifecycle-backfill.test.js` (existing): replace `signDescriptors` with the test custody; Flow A
      confirmation-log counts 1 / 1 / 2; R27–R32; corrupt `.sig`; writable generation.
- [ ] **Gate S1+S2**: targeted suites green; Codex impl review → CLEAN (≤3 rounds); rerun server suites unsandboxed.

## S3 — CLI

- [ ] **T3.1** `lib/guard-enrol.js` (new): `PRINCIPAL_RE`, `SUDOERS_TEXT`, `validateAncestry`, `locateTrustRoot`,
      `candidateTrustRoot`, `installScript`, `installPlan`, `roundTrip`, `rebuildStratumDist`, `runEnrol` orchestrator
      (backend guard first; blueprint §4.1 order). Test: `test/guard-enrol.test.js` rows in blueprint §4.3 incl. the
      zero-side-effects orchestrator test and the spawn-contract test.
- [ ] **T3.2** `lib/guard-cli.js` (new): `runGuardDescriptors`, `runGuardSign`, `runGuardEnrol`, `signingStatusLines`,
      `--prune`. Test: `test/guard-cli.test.js` in-process rows; spawned `status` contract.
- [ ] **T3.3** `bin/compose.js` (existing, :1221-1236, :2325-2345): dispatch `descriptors | sign | enrol`, extend
      `status`, update the unknown-subcommand line.
- [ ] **Gate S3**: targeted suites green; Codex impl review → CLEAN.

## S4 — docs and ship

- [ ] **T4.1** `README.md:180-192` rewrite; `CHANGELOG.md` entry; `docs/features/COMP-GUARD-ONE-TAP/manual-check.md`
      (written); stratum header comment (separate stratum commit).
- [ ] **T4.2** Full suite once: `cd compose && CI=1 npm test` → file + `$?`; `npm run test:ui`; `npm run test:tracker`.
- [ ] **T4.3** `stratum_step_done(implement)`, `stratum_audit`, commit (explicit paths only), report.md, journal
      (milestone: decision-heavy session), feature status via `record-completion` CLI after the owner's manual check.

## Parallelisable

T1.2 ∥ T1.3 ∥ T1.4 (no shared files). T2.3 ∥ T2.4. T3.1 ∥ T3.2 until T3.3 wires both.

# COMP-GUARD-ONE-TAP — Implementation Report

**Related:** [design.md](./design.md) (r3) · [blueprint.md](./blueprint.md) · [plan.md](./plan.md) ·
[progress.md](./progress.md) (ledger) · [manual-check.md](./manual-check.md) · [reviews/](./reviews/)
**Status:** implementation COMPLETE, feature status stays until the owner runs `manual-check.md`
(`compose guard enrol` needs an interactive terminal and Touch ID; `sudo` is denied to agents here).

## What shipped (compose, 2026-09-06)

Signing an upgrade descriptor is now one Touch ID confirmation, and the descriptor lifecycle is automated end to end.

| Area | Files | Behaviour |
|---|---|---|
| Custody | `lib/guard-custody.js` (new) | `sudo -k <root signer> <namespace>` with a four-key scrubbed env, stdin bytes, 120 s budget; exit/stderr mapped to `signature_not_approved` vs `upgrade_descriptor_unavailable`, every refusal `{code,message,hint}`; `custodyStatus` reports install, rule, Touch ID presence, cached credential; test seam refused outside `NODE_ENV=test`. |
| Signer | `scripts/guard-sign/compose-guard-sign.sh` | Root-owned signer verified through the installed stratum verifier; namespace injection → 64, missing key → 66. Embedded into the enrol root script by heredoc (never a path). |
| Generations | `lib/guard-descriptors.js` | Immutable `.compose/guard-upgrades/<sha256>/descriptors.json(.sig)` behind an atomic `current` symlink; `ensureSignedDescriptors` (fresh → 0 prompts, sign in staging → verify → rename → repoint, race re-verified, every throw normalised to a refusal); legacy flat pair adopted only after verification; containment of dir, file, sig and the generations dir itself (symlinks refused); `prepareUnsignedCandidate` for hosts without custody; `pruneGenerations`. `writeDescriptorFile` removed. |
| Gate | `server/lifecycle-guard.js`, `lib/completion-gate.js`, `server/vision-routes.js`, `server/compose-mcp-tools.js` | `applyBackfillUpgrade`: already-upgraded short-circuit, workspace descriptor lock held through apply (150 s via `acquireDirLock(path,{timeoutMs})`), full refusal envelopes; `hint` rides `error` → HTTP 422 top-level `hint` → MCP error text carries reasons + hint. |
| CLI | `lib/guard-enrol.js`, `lib/guard-cli.js` (new), `bin/compose.js` | `compose guard enrol` (plan shown before ONE `sudo -k /bin/sh -s` root step, ancestry checked before and after, round trip before the trust root is written, source checkouts only, final verifier check), `sign`, `descriptors` (manual `ssh-keygen -Y sign` path when custody is `none`), `status [--prune]` signing block. |

Stratum: `ts/contracts/guard-signers.allowed` header note (stratum `5106933`).

## Verification

- Targeted suites, all unsandboxed and without `NODE_ENV` preset: custody 5, dir-lock 1, signer script 2, transport 12,
  descriptors 22, backfill golden 40, upgrade unit 5, routes 8, MCP http 7, enrol + cli + canon-guard 33.
- Full suite once: node:test 6251 (the only failures were the `NODE_ENV` seam issue, fixed and re-run targeted), `test:ui` 613/613,
  `test:tracker` 100/100. Outbound provider keys were neutered for the run.
- Codex gates: design r1–r3 (CLEAN), blueprint r1–r2 (CLEAN), impl S1+S2 r1 (3 P2) → r2 (2 P2) → fixed;
  impl S3 r1 (2 P1 + 3 P2) → all fixed → r2 fixes-only (see `reviews/`).

## Deviations from the blueprint

- "A second legacy feature with the same checksum" was a false premise: edge predicates embed the feature dir, so
  checksums differ per feature. One generation enumerates and covers every registered legacy resource; the second
  feature is `fresh`. Blueprint §3.5 wording corrected.
- `writeDescriptorFile` was removed in S3 (with its only caller) rather than S1.
- The routes "real producer failure" row needed a guard-enabled context and the history seam; only enumeration reaches
  the failing CLI.

## Follow-ups

- Measured at the owner's manual check (2026-09-06): the coverage probe took **76 s and ~370 stratum spawns** on this
  repo and logged 363 `guard_not_found` lines. Fixed the same day: coverage is `--coverage` opt-in (status now 0.17 s)
  and the client no longer logs not-found. **Still open:** `compose guard sign` and the gate's sign-on-demand path
  still enumerate by probing every feature dir (76 s before the Touch ID sheet here). Stratum stores registries at
  `~/.stratum/guards/<hash>/registry.json`; the clean fix is a stratum `guard list --prefix <resource-id-prefix>`
  action so compose discovers registered resources without probing (and without reading stratum's store directly).
- Owner: run `manual-check.md` once, then `compose record-completion` for this feature.

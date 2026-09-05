# COMP-GUARD-ONE-TAP — progress ledger

Stratum run `34832563-e55c-445a-b13b-c8a6896e7a0f` (flow `compose_feature`: write_design → write_blueprint → implement).
Owner is not gating: automated gates pass without asking; Codex reviews each gate to CLEAN (≤3 rounds).

## 2026-09-06

- Entry scan. Reality vs flush: the descriptor pair was already signed and committed (compose `cb527c2`);
  `compose guard init`/`status` already exist (canon-guard) → new verbs are `enrol`/`sign`.
- **Spike** (before any design commitment): ssh-agent confirm mode has no askpass on this Mac; data-protection
  keychain refuses unsigned CLIs (-34018) and ad-hoc entitlements get the process killed; Secure Enclave
  same wall; legacy keychain readable by `security` without a prompt; `pam_tid.so` present, Touch ID
  enrolled, `visudo -cf` accepts the per-command `timestamp_timeout=0` rule. Swift helper written then
  deleted. Details in design §"Spike record".
- Design r1 (keychain) → Codex r1: 7 findings (2 P1). Killed by #1 + spike → design r2 (root key + sudo +
  pam_tid) → Codex r2: 7 findings (4 P1) → design r3 (`sudo -k`, scrubbed env, `/Library/Compose/guard`,
  ancestry checks, round-trip before trust root, askpass withdrawn, immutable generations + atomic
  `current`, `signature_not_approved`) → Codex r3: 2 P1 layout defects (`/etc` symlink; unreadable `.pub`),
  fixed in place. **Design gate CLEAN.** `stratum_step_done(write_design)` recorded.
- `scripts/guard-sign/compose-guard-sign.sh` written; verified through the installed stratum verifier
  via the test seam (`COMPOSE_GUARD_SIGN_KEY`); namespace injection → exit 64.
- Blueprint written and Phase-5 verified (V-1..V-15): one stale range corrected (C8), no preload precedent
  for CLI tests (§4.3 rewritten), boundary map ok. Codex blueprint gate r1 (`d828a3f3d0d5`): 12 findings
  (1 P1) → all folded in (disposition table in blueprint); boundary map re-validated ok. Gate r2
  fixes-only (`717e09e7de69`): **REVIEW CLEAN**. `stratum_step_done(write_blueprint)` recorded; implement dispatchToken `17d3eed4-aac3-41a4-9484-f70f81fa5184`.
- `plan.md` written (S1–S4, T1.1–T4.3). `manual-check.md` written.

## Next

1. Fold Codex blueprint r2 findings (if any P1 remains → one more fixes round, then stop at 3).
2. `stratum_step_done(write_blueprint)` with dispatchToken `03c48821-510d-4d5b-9b13-9e2015040934`.
3. Phase 7: S1 (T1.1–T1.5) → S2 (T2.1–T2.5) → Codex impl review → S3 → review → S4; one full suite at the
   end (`CI=1 npm test` to a file + `$?`, `npm run test:ui`, `npm run test:tracker`).
4. Owner runs `manual-check.md` once (`compose guard enrol` needs an interactive terminal + Touch ID).

## Landmines carried from COMP-LIFECYCLE-BACKFILL

- Codex sandbox cannot bind a server: any route/server suite it "ran" never executed — rerun unsandboxed.
- `test/build-stream-smoke.test.js` flakes under pre-push load; push with `--no-verify` only after a green
  full suite on the same tree, and say so.
- Stale compose MCP server processes (some from August): use the CLI (`node bin/compose.js …`) for
  anything that must run today's code; never kill servers without asking.
- The working tree carries other sessions' uncommitted edits (`docs/context/decisions.md`,
  `COMP-GUARD-CLAIM-1/*`, `COMP-MCP-ENFORCE/report.md`, untracked `COMP-FOH/*`, `COMP-SEMVER-STRICT/*`):
  stage this feature's files explicitly, never `git add -A`.
- `sudo` and `visudo` invocations are denied to the agent by the permission layer here; the manual
  checklist is the only place they run.

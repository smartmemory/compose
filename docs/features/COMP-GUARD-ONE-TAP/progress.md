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
- **S1 landed** (Codex `f8e04fd5fefc`, terra/high, 9.7 min): `lib/guard-custody.js`, `acquireDirLock(path,{timeoutMs})`,
  `guardDescriptors` transport, generations API in `lib/guard-descriptors.js` (+ `prepareUnsignedCandidate`,
  `pruneGenerations`). Reran all five test files unsandboxed: 31/31. Adjudicated against blueprint §2: try/catch
  envelope + staging cleanup, realpath returns, invalid signed `<sha>` refused without moving `current`, race
  re-verified. Deviation accepted: `writeDescriptorFile` kept until S3 removes its only caller (`bin/compose.js:1226`).
- **S2 landed** (Codex `4a45c199fb52`, terra/high, 14 min): `applyBackfillUpgrade` rewrite (short-circuit, 150 s lock,
  `_testOnly_setEnsureDescriptors` seam, full envelopes), gate hint line, 422 `hint`, MCP 4xx reasons+hint. Codex could
  not run 3 of 4 suites (no server bind / ProcessIdentity in sandbox); unsandboxed rerun found **2 real test bugs**, fixed
  here: (1) routes "real producer failure" row used the guard-OFF ctx (200, `guarded:false`) and a fake policy that
  diverged from ensureGuard's projection; now its own `setup({guard:true})`, stored policy = real legacy projection,
  history seam injected so only enumeration reaches the failing CLI. (2) Flow A asserted BF-1/BF-2 share a checksum —
  false: edge predicates embed the feature dir; the generation covers both, BF-2 is `fresh`. `registerLegacy` also
  hardcoded `initial: explore_design`, which silently failed fix-mode registration (BF-3); retry count is 2 not 1.
  All S1+S2 suites green unsandboxed: 31 + 62. Blueprint §3.5 wording corrected.
- **Impl review r1 (S1+S2)** `9ec05b86ba57`: 3 P2, 0 P1 — see `reviews/impl-s1s2-r1.md`. #1 (adopt without verify)
  and #2 (path containment / symlinked `<sha>/`) → fixed by a Sonnet agent; #3 (`writeDescriptorFile` still
  reachable) → deferred to S3 where its caller is replaced. Round 2 = fixes-only review.
- **Impl review r2 (fixes-only)** `551891f6187c`: 2 P2 on the r1 fixes (adoption trusts a pre-existing `<sha>/`;
  containment misses file/sig realpaths + race recovery) — `reviews/impl-s1s2-r2.md`. Sent back to the same Sonnet
  agent; r3 verification folded into the S3 review (review budget).
- **r2 fixes landed** (Sonnet, verified 20/20 + 40/40): adoption verifies a pre-existing `<sha>/` before `current`;
  containment covers file + sig realpaths and the race-recovery path; rename race now also catches `ENOTDIR`
  (renaming a dir onto a planted symlink raises ENOTDIR on macOS, not EEXIST — found empirically by the fix agent).
- **S3 landed** (Codex `dc475dd6e024`, terra/high, 8 min, ran ∥ with the r2 fixes): `lib/guard-enrol.js`, `lib/guard-cli.js`,
  `bin/compose.js` dispatcher (`descriptors|sign|enrol`, `status [--prune]` signing block). Unsandboxed: 26/27 — the
  spawned `status` row assumed `cached admin credential: unknown` (this Mac says `none`). Controller removed
  `writeDescriptorFile` + its test row (descriptors 19/19). Adjudication vs blueprint §4 found 4 more: `none`-custody
  `descriptors` never publishes an operator-signed candidate (ensure must run first); enrol plan printed only AFTER
  the sudo step (must precede Touch ID); `installScript` chmods `/Library` itself; canon `guard status` now dies
  outside a workspace. All 5 → Sonnet agent `fix-s3-cli`. **Flag:** `status` coverage enumerates every feature dir ×
  4 modes through the stratum CLI (spec'd in blueprint §4.2) — on this repo that is hundreds of spawns; measure at
  ship, likely needs a `--coverage` opt-in or a cheaper registry query as a follow-up.
- **Full suite run 1** (`CI=1 npm test`, outbound keys neutered): 6210/6251 node:test, **2 fail + 39 cancelled, all in
  `test/lifecycle-backfill.test.js`** — root cause: `npm test` does not set `NODE_ENV`, my targeted runs did; the custody
  seam correctly refuses without it. Fixed the way the suite's other seam users do (file sets `process.env.NODE_ENV='test'`).
  Rerun without the var preset: 51/51 across the three seam suites. vitest suites never ran (chain stopped) → launched
  separately: `test:ui` 613/613, `test:tracker` 100/100.
- **S3 review r1** `7d30c133b9b3`: **2 P1 + 3 P2**, all real — `reviews/impl-s3-r1.md`. P1: enrol emitter defaulted to
  no-op (sudo reachable with no plan); packaged signer path interpolated unquoted into the root shell. Fixes split across
  the two Sonnet agents. r2 fixes-only next, then stop.
- **S3 r1 fixes landed** (two Sonnet agents ∥, verified locally): enrol/cli 33/33; descriptors + backfill golden + upgrade
  67/67, all run WITHOUT `NODE_ENV` preset. Emitter mandatory; signer embedded by heredoc (no path in the root shell);
  manual fallback only on the no-custody refusal; file+sig containment in adoption; symlinked generations dir refused
  everywhere; `prepareUnsignedCandidate` refuses over an existing `.sig`. r2 fixes-only review dispatched.
- **S3 review r2** `443411380c02`: 2 P2 + 1 P3 (dangling `.sig` symlink reads as absent via `realpath`; enrol
  preparation throws outside the envelope; two test weaknesses) — `reviews/impl-s3-r2.md`. Sent to the two agents.
  **Review budget reached** — after these land: targeted reruns, `stratum_step_done(implement)`, `stratum_audit`, commit.
- **S3 r2 fixes landed** (both agents): lstat-based `.sig` presence (dangling symlink refused, nothing written through
  it); enrol preparation failures return the envelope; tests strengthened. **Ship gate:** all 12 feature suites,
  `env -u NODE_ENV`, **141/141**. `stratum_step_done(implement)` recorded.
- **SHIPPED** compose `ebd98cc` (explicit paths; other sessions' files left in tree), stratum `5106933`. `stratum_audit`:
  flow completed, 3 dispatches, trace in the commit message. Memory `project_comp_guard_one_tap` updated.
- **Owner manual check, items 1–2 (2026-09-06 09:46):** `enrol` → password once (pam_tid not yet installed on the
  first run, expected), then Touch ID; `done`, fingerprint `SHA256:oNNK2K…`; trust root line committed in stratum
  `1d25be6`. `status` hit the flagged coverage cost: 76 s, 363 not-found log lines. Fixed: `--coverage` opt-in +
  not-found no longer logged (status 0.17 s). Open: `sign`/gate enumeration still probes every dir → stratum
  `guard list` follow-up (report.md).
- **COMPLETE (2026-09-06):** owner ran `sign` (fresh: legacy pair adopted, 0 descriptors, no sheet by design); I ran a
  real signature in a throwaway workspace: ONE Touch ID, `signed by ruze (SHA256:oNNK2K…)`, verified, 3.2 s; no cached
  credential after. Adopted generation committed `d667d34`, flat pair removed. `compose record-completion` →
  PLANNED → COMPLETE (`COMP-GUARD-ONE-TAP:ebd98cc…`). Checklist rows 5–7 not run (cancel/SSH/real backfill).
- **Follow-up started (owner: "now"):** stratum `guard list [--prefix]` action (Codex `3d3ba1f20379`, terra/high) ∥
  compose `enumerateRegisteredResources` via `guardList` with probe fallback (Sonnet `compose-guard-list`). Contract
  locked in both briefs: `{status:'ok', resources:[{resource_id, checksum, current_state, terminal, graph_version}], skipped}`.
- **guard list landed** (stratum `2d26986`, compose `9f4d289`): enumeration 76 s → 7 s; `compose guard sign` 17.7 s
  incl. one Touch ID. **Finding:** the listing returned **32 legacy resources the probe never saw** — all test
  fixtures (`BUG-1`, `BUG-A`, `FEAT-A`, `TS-BUILD-*`, mostly 2026-06-07) registered under THIS repo's workspace hash
  into the real `~/.stratum/guards` because stratum had no store override and older tests used the repo root.
  They have no feature dir (invisible to the probe) and now sit in signed generation `012728e…` (NOT committed —
  hold until the orphans are cleaned and a clean generation is re-signed). Fixed: stratum honours
  `STRATUM_GUARDS_DIR` (`48d1e26`); compose preload points the whole run at a temp store — proven: 65 guard-registering
  tests ran, real store stayed at 37 entries.
- **Orphans removed (owner: yes):** 32 test registrations deleted from `~/.stratum/guards` (listed in the session);
  5 real features remain. `sign` on the junk generation was `fresh` (it verifies and covers the empty need set), so
  `current` was restored to the committed 0-descriptor generation `cd35092…` and the junk dir deleted — no tap needed.

## Next

1. DONE — feature COMPLETE.
2. DONE — store clean (5 real registrations), `current` = committed `cd35092…`. (T4.1 docs already drafted, T4.2 full suite, T4.3 step_done/audit/commit) (Codex `dc475dd6e024`, barred from guard-descriptors) → controller removes `writeDescriptorFile` + its test row → Codex review (S3 + r2-fix verification) → S4 → S3 → review → S4; one full suite at the
   end (`CI=1 npm test` to a file + `$?`, `npm run test:ui`, `npm run test:tracker`).
2. Owner runs `manual-check.md` once (`compose guard enrol` needs an interactive terminal + Touch ID).

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

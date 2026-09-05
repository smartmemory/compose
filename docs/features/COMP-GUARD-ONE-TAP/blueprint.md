# COMP-GUARD-ONE-TAP — Implementation Blueprint

**Status:** DRAFT (2026-09-06), grounded against the tree at compose `5439886` + uncommitted design r3.
**Design:** [design.md](./design.md) (revision 3). **Stratum run:** `34832563-e55c-445a-b13b-c8a6896e7a0f`.

## Related Documents

- [design.md](./design.md) — decisions; this blueprint implements v1 scope exactly as decided there.
- [reviews/design-r1.md](./reviews/design-r1.md), [reviews/design-r2.md](./reviews/design-r2.md).
- Predecessor blueprint: [../COMP-LIFECYCLE-BACKFILL/blueprint.md](../COMP-LIFECYCLE-BACKFILL/blueprint.md)
  §3 (transport, descriptors) and §7 (golden-flow harness) — reused, not re-derived.

## 1. Corrections (design/brief assumption vs reality)

| # | Assumption | Reality (file:line) | Consequence |
|---|---|---|---|
| C1 | Brief: new verbs `compose guard init` / `status` | `bin/compose.js:2103-2345` — `guard init` is the canon-guard baseline, `guard status` prints the hook state; both dispatch on `PACKAGE_ROOT`, not the workspace | New verbs are `enrol` and `sign`; `status` is extended in place; `descriptors` (`bin/compose.js:1221-1236`) stays narrowly gated *above* the canon-guard dispatcher and uses `resolveCwdWithWorkspace` (`bin/compose.js:72`) — enrol/sign/descriptors all resolve the workspace this way |
| C2 | Design: test custody selected by `COMPOSE_GUARD_CUSTODY=test` | `package.json:56-68` `files` ships `lib/**` but not `test/**`; a lib module must never import `test/helpers/sshsig-sign.js` | Test custody is injected in-process: `_testOnly_setCustodyBackend(backend)` in `lib/guard-custody.js`, refused unless `NODE_ENV === 'test'` — a **new** restriction whose precedent is stratum's `setGuardTrustRootForTests` (`trust.ts:39`), not compose's `_testOnly_setGuardClient` (`server/lifecycle-guard.js:291`), which is unrestricted. No env var. The golden flows run the gate in-process (`test/lifecycle-backfill.test.js:205-222` imports `completionGate` directly), so injection reaches the real code path |
| C3 | Design r1: "the MCP tool already forwards the HTTP body" | `server/compose-mcp-tools.js:702-716` `_postLifecycle` throws `new Error(respBody.error)` on ≥400 — the string `backfill refused` — dropping `reasons`, `guardError`, hint | S2 changes `_postLifecycle` to include `reasons` and `hint` in the thrown message for 4xx bodies that carry them |
| C4 | Design: `applyBackfillUpgrade` "refreshes the registration cache" | `server/lifecycle-guard.js:295` `_registered` is module-private; `ensureGuard` (declared :403) sets `'legacy'` at :431 and `applyBackfillUpgrade` (:452-490) never touches it | Add the two `_registered.set(rid, 'cached')` calls inside `applyBackfillUpgrade` (same module, no new export) |
| C5 | Design: the gate "holds the descriptor lock through applyUpgrade" | `applyBackfillUpgrade` is the only caller of `applyUpgrade` (`server/lifecycle-guard.js:466`); the gate calls it at `lib/completion-gate.js:964` | The lock lives entirely inside `applyBackfillUpgrade`: acquire → ensure → apply → release. The gate is untouched except for the refusal line |
| C6 | Design: compose asks stratum to verify via `stratum guard descriptors` | `server/stratum-client.js` has no `descriptors` transport; `runGuard(action, kwargs, timeout, extraEnv)` (:225) already carries `extraEnv`, and `guardApplyUpgrade` (:396-404) shows the env-pinning shape; stratum `cli/guard.ts:176` `descriptors` accepts an empty payload and returns `inspectDescriptorFile()` (`descriptors.ts:238-270`: `signature` starts with `verified:` or `NOT VERIFIED:`) | Add `guardDescriptors(descriptorsPath)` = `runGuard('descriptors', {}, MUTATION_TIMEOUT_MS, { STRATUM_GUARD_UPGRADE_DESCRIPTORS })`; verdict = `status:'ok'` ∧ `signature.startsWith('verified:')` ∧ `group_or_world_writable === false` (see §2.3) |
| C7 | Design: enrol verifies the round trip "in-process with stratum's `verifySshsig`" | `@smartmemory/stratum` has no `exports` map (`../stratum/ts/package.json`), so deep imports work; `dist/guard/sshsig.js:185` `verifySshsig(message, armored, namespace, allowedKeys)`, `:217 sshFingerprint(raw)`, `:228 parseAllowedSigners(contents)`; the test already deep-resolves `@smartmemory/stratum/dist/...` (`test/helpers/stratum-test-bin.js:28-30`) | `lib/guard-enrol.js` imports those three through `createRequire(import.meta.url).resolve('@smartmemory/stratum/dist/guard/sshsig.js')` — the same resolution the runtime bin uses, so the verifier is the installed one |
| C8 | Design: descriptor path passed to stratum is `current/descriptors.json` | `descriptors.ts:144-160` (`descriptorPath` + `readDescriptorBytes`) requires an absolute path and refuses group/world-writable **files** (`stats.mode & 0o022`, follows symlinks); `loadDescriptorFile` at :193 reads file and `.sig` independently | Pass the **resolved** generation path (`fs.realpathSync(current)`), never the symlink, so the apply is pinned to immutable bytes even if `current` moves during the call |
| C9 | Design: legacy flat pair "moved under its own sha" | The flat pair is committed at compose `cb527c2` (`.compose/guard-upgrades.json` + `.sig`, 0 descriptors) | Adoption = copy into `<sha>/`, create `current`, leave the flat files in place (untracked deletion is the operator's git decision); `guard status` reports "legacy flat pair present — delete after committing generations" |
| C10 | Design: `bioutil -rs` for presence | Output is `Biometrics functionality: 1` / `Biometrics for unlock: 1` lines (checked 2026-09-06); the binary is `/usr/bin/bioutil` | Parse `Biometrics functionality:\s*1`; absent binary → `unknown` |
| C11 | Design: `sudo -n -v` to detect a live cached credential | `sudo -n -v` exits 0 iff a credential is cached for this process tree and 1 otherwise, printing to stderr; it never prompts with `-n` | Status runs it with the scrubbed env and reports `cached admin credential: live` on 0, `none` on 1, `unknown` on other |
| C12 | Design r2 §Docs: "fix the verify command in the trust-root header" | `../stratum/ts/contracts/guard-signers.allowed` header lines 30-35 document `ssh-keygen -Y sign` manual signing and "never add it to ssh-agent"; `../stratum/README.md:498-510` documents the descriptor path env | Stratum header: add two comment lines (the askpass finding + "compose automates this via a root-owned signer"); README: the verify command already exists at :506 and is correct (`stratum guard descriptors`) — **no change**. Both are cross-repo doc-only edits, committed in stratum separately |

## 2. Slice S1 — custody, signer, generations (compose `lib/`)

### 2.1 `scripts/guard-sign/compose-guard-sign.sh` (exists, 2026-09-06)

Already written and verified through the installed verifier (`SHA256:/Ocu35…`, namespace injection →
exit 64). Packaged by `package.json` `files: "scripts/**"` (:67). No change in this slice except the
test below.

### 2.2 `lib/guard-custody.js` (new)

```js
export const GUARD_DIR    = '/Library/Compose/guard';                 // root 0755
export const SIGNER_PATH  = '/Library/Compose/guard/sign';            // root 0755
export const PUBKEY_PATH  = '/Library/Compose/guard/signing-key.pub'; // root 0644 (readable: Codex r3 #2)
export const PRIVATE_DIR  = '/Library/Compose/guard/private';         // root 0700 (key + tmp)
export const SUDOERS_PATH = '/private/etc/sudoers.d/compose-guard';   // real path: /etc is a symlink (Codex r3 #1)
export const SUDO_LOCAL_PATH = '/private/etc/pam.d/sudo_local';
export const CUSTODY_TIMEOUT_MS = 120_000;
export const SUDO_ENV = () => ({ PATH: '/usr/bin:/bin', HOME: os.homedir(), USER: os.userInfo().username, LANG: 'C' });

export function custodyBackend()                      // 'sudo' on darwin, else 'none'; test override wins
export async function custodyStatus()                 // { backend, installed, rule, presence, cachedCredential, publicKeyLine, detail[] }
export async function custodySign({ bytes, namespace }) // { ok:true, armored } | { ok:false, code, message, hint }
export function _testOnly_setCustodyBackend(b)        // refused unless NODE_ENV==='test'; null resets
```

- `custodySign` (sudo): `execFile('/usr/bin/sudo', ['-k', SIGNER_PATH, namespace], { env: SUDO_ENV(),
  timeout: CUSTODY_TIMEOUT_MS, maxBuffer: 1 << 20 })`, stdin = bytes. Exit 0 → `{ ok, armored: stdout }`.
  Mapping (design §custody): exit 1 and stderr matches
  `/terminal is required|Sorry, try again|authentication failed|timed out/i` → `signature_not_approved`;
  `killed`/timeout → `signature_not_approved`; signer exit 64/66 or anything else →
  `upgrade_descriptor_unavailable` with `message = first stderr line`.
- `custodyStatus` (sudo): `stat` on `GUARD_DIR` (root, 0755), `PRIVATE_DIR` (root, 0700 — `stat`
  works without read permission on the parent), `SIGNER_PATH` (root, 0755), `PUBKEY_PATH` (root,
  0644), `SUDOERS_PATH` (root, 0440 — the dir is listable) (Codex bp #9); `rule` = `sudo -n -l SIGNER_PATH`
  → 0 = `present`, stderr `password is required` = `unknown`, else `absent`; `presence` = `bioutil -rs`
  (C10) + `sudo_local` has `^\s*auth\s+sufficient\s+pam_tid\.so` + not `SSH_CONNECTION`/`TMUX` →
  `likely|unlikely|unknown` with reasons; `cachedCredential` per C11.
- `none` backend: `custodySign` → `{ ok:false, code:'upgrade_descriptor_unavailable', hint:'compose guard enrol' }`.
- Hint strings are constants exported from this module (`HINT_ENROL`, `HINT_APPROVE`) so the gate,
  routes and CLI say the same words.

### 2.3 `lib/guard-descriptors.js` (edit) — generations

Keep `descriptorIdFor`, `deriveBackfillPolicy`, `buildDescriptorFile`, `enumerateRegisteredResources`
unchanged. **Remove `writeDescriptorFile`** (its only production caller is `bin/compose.js:1226`; the test
helper `signDescriptors` at `test/lifecycle-backfill.test.js:267-274` is rewritten in S1's tests).

Add:

```js
export const GENERATIONS_DIR = '.compose/guard-upgrades';          // + '/current' symlink
export const LEGACY_FLAT = '.compose/guard-upgrades.json';
export function generationPaths(workspaceRoot, sha)               // { dir, file, sig }
export async function currentGeneration(workspaceRoot)            // { sha, file, sig } | null  (realpath of current)
export async function adoptLegacyFlatPair(workspaceRoot)          // C9; idempotent; returns { adopted: boolean }
export async function verifyGeneration(workspaceRoot, file, verifier) // verifier = stratum-client guardDescriptors
export async function ensureSignedDescriptors({ workspaceRoot, needChecksums, custody, verifier })
```

`ensureSignedDescriptors` (design §publication, steps 2–5; **no lock inside** — C5, the caller holds it):
1. `adoptLegacyFlatPair` (first run only).
2. bytes = `buildDescriptorFile(await enumerateRegisteredResources(root))`; `sha = sha256(bytes)`.
3. `cur = await currentGeneration(root)`; if `cur` and `verifyGeneration(cur.file)` verified and every
   `needChecksums` has a descriptor id in `cur` → `{ status:'fresh', path: cur.file, prompts: 0 }`.
4. If `<sha>/` already exists (a prior crash after signing but before the pointer swap, **or** an
   unsigned candidate left by the manual path, see §4.2): if it has a `.sig` and `verifyGeneration`
   verifies and covers → repoint `current`, return `fresh`. If it has a `.sig` that does **not** verify →
   return `refused` with `code:'upgrade_descriptor_unavailable'`, `message: 'generation <sha> exists but
   its signature does not verify; remove it and retry'`, `hint: HINT_ENROL` — never sign over it, never
   move `current` (Codex bp #4). If it has no `.sig` (manual candidate) → fall through to signing, using
   its bytes (byte-equal by construction) and writing the `.sig` beside it after verification.
5. `staging = mkdtemp('.compose/guard-upgrades/.staging-')`; write `descriptors.json` (0600);
   `sig = await custody.sign({ bytes, namespace: 'stratum-guard-descriptors' })`; on `!ok` → `rm -rf staging`,
   return `{ status:'refused', code, message, hint }` (every refusal carries all three — `none` custody
   gets `message: 'no signing custody on this platform'`; Codex bp #7). Write `.sig` (0600);
   `verifyGeneration(staging/descriptors.json)`; on failure → rm staging, return `refused` with
   `code:'upgrade_descriptor_unavailable'`, `message: 'signature did not verify: <stratum text>'`,
   `hint: HINT_ENROL`. `rename(staging, <sha>/)`; if `<sha>/` appeared meanwhile (race), rm staging and
   **re-verify that exact pair** before using it — on failure refuse as in step 4. Then
   `symlink(sha, current.tmp)`, `rename(current.tmp, current)`.
6. `{ status:'signed', path: generation file, prompts: 1, sha }`.

The whole function body runs inside `try/catch`: any thrown error (enumeration → `guardPolicy` failures
throw at `lib/guard-descriptors.js:95`; fs errors; verifier transport errors) is normalised to
`{ status:'refused', code:'upgrade_descriptor_unavailable', message: err.message, hint: HINT_ENROL }`
after `rm -rf staging` (Codex bp #7). Every path returned is the **realpath** (C8).

`verifyGeneration(file)` verdict (Codex bp #5): the `guardDescriptors` result must have `status:'ok'`,
`signature` starting with `verified:`, **and** `group_or_world_writable === false` — apply refuses
writable files (`descriptors.ts:148-160`) even when inspection reports the signature verified, so a
verdict that ignores the mode bit would classify a generation `fresh` forever and have apply refuse it
every time.

`pruneGenerations(root)` (for `compose guard status --prune`, design §publication): under the same
external lock, delete every `<sha>/` that is not the `current` target and not referenced by a pending
`.compose/data/completion-intents/*.json`; never touches `current`.

### 2.4 `server/stratum-client.js` (edit)

Add after `guardApplyUpgrade` (:404):

```js
/** Inspect + verify a descriptor file through stratum's verifier (read-only). */
export async function guardDescriptors(descriptorsPath) {
  return runGuard('descriptors', {}, MUTATION_TIMEOUT_MS, { STRATUM_GUARD_UPGRADE_DESCRIPTORS: descriptorsPath });
}
```

### 2.5 Tests (S1)

- `test/guard-custody.test.js` (new): backend selection by platform; `_testOnly_setCustodyBackend`
  refused outside `NODE_ENV=test`; sudo backend driven against a **fake `sudo`** placed first on a
  temp `PATH`… — no: `custodySign` calls `/usr/bin/sudo` by absolute path (design: absolute paths). So
  the sudo backend takes an injectable `spawn` (`deps.execFile`) — the test asserts argv is exactly
  `['-k', SIGNER_PATH, namespace]`, env has no `SUDO_ASKPASS`/`SSH_ASKPASS`/`SUDO_PROMPT`, and the
  mapping table (exit/stderr → code) row by row, including "infrastructure failure is not a decline".
- `test/guard-sign-script.test.js` (new): spawns `scripts/guard-sign/compose-guard-sign.sh` with
  `COMPOSE_GUARD_SIGN_KEY` = temp `ssh-keygen` key; output verifies with the installed
  `dist/guard/sshsig.js` `verifySshsig`; namespace `-f x` → 64; missing key → 66; no staging leftovers.
  Skips (with a visible `skip` reason) when `/usr/bin/ssh-keygen` is absent.
- `test/guard-descriptors.test.js` (extend): generation layout, `adoptLegacyFlatPair` idempotency,
  fresh-path zero prompts, refused-path leaves `current` + bytes intact and no `.staging-*`, crash
  recovery (sha dir exists, no pointer) → fresh without prompt, concurrent `ensureSignedDescriptors`
  under one external lock → one prompt.

## 3. Slice S2 — sign on demand in the gate (compose `server/`, `lib/`)

### 3.1 `server/lifecycle-guard.js` `applyBackfillUpgrade` (:452-490, rewrite in place)

```js
export async function applyBackfillUpgrade({ featureCode, workspaceRoot, mode = 'build' }) {
  const rid = resourceId(featureCode, workspaceRoot, mode);
  const stored = await _client.policy(rid);                       // existing error handling kept (:455-462)
  // Codex r1 #4: already upgraded on a prior attempt (upgrade applied, later step failed, retry).
  const expected = deriveBackfillPolicy(policyChecksumFields(stored), mode);   // lib/guard-descriptors.js
  if (policiesEqual(expected, policyChecksumFields(stored))) {
    _registered.set(rid, 'cached');
    return { ok: true, status: 'unchanged', checksum: stored.checksum };
  }
  // Codex bp #6: the default dir-lock deadline is 30 s (lib/dir-lock.js:57) but a legitimate
  // approval may hold the lock for up to CUSTODY_TIMEOUT_MS (120 s) plus the apply. Budget = 150 s.
  let release;
  try {
    release = await acquireDirLock(path.join(workspaceRoot, '.compose', 'data', 'locks', 'guard-descriptors'),
      { timeoutMs: DESCRIPTOR_LOCK_TIMEOUT_MS });
  } catch (e) {   // DirLockTimeout or fs error → complete refusal envelope, never a throw (Codex bp #7)
    return { ok: false, reasons: [e.message], error: { code: 'upgrade_descriptor_unavailable', message: e.message, hint: HINT_APPROVE } };
  }
  try {
    const ensured = await ensureSignedDescriptors({          // never throws (see §2.3 try/catch)
      workspaceRoot, needChecksums: [stored.checksum],
      custody: _custody, verifier: _client.descriptors,
    });
    if (ensured.status === 'refused') {
      return { ok: false, reasons: [ensured.message], error: { code: ensured.code, message: ensured.message, hint: ensured.hint } };
    }
    const applied = await _client.applyUpgrade({ resourceId: rid, descriptorId: descriptorIdFor(stored.checksum, mode), descriptorsPath: ensured.path });
    // existing applied/unchanged/error handling (:472-489), reasons no longer say "re-sign"
    _registered.set(rid, 'cached');
    return { ok: true, status: applied.status, ledgerRef: applied.ledger_ref, checksum: applied.checksum, descriptorId: ..., generation: ensured.sha };
  } finally { await release(); }
}
```

`lib/dir-lock.js` (edit): `acquireDirLock(path, { timeoutMs } = {})` — the deadline at `:57` becomes
the default of an option; no caller changes. `DESCRIPTOR_LOCK_TIMEOUT_MS = 150_000` exported from
`lib/guard-custody.js`.

- `_client` gains `descriptors: _guardDescriptors` (:284-289); `_custody` = `{ sign: custodySign }` with
  `_testOnly_setCustody` **not** needed — custody injection already lives in `lib/guard-custody.js`.
- Imports added: `deriveBackfillPolicy`, `ensureSignedDescriptors` from `../lib/guard-descriptors.js`;
  `acquireDirLock` from `../lib/dir-lock.js`; `custodySign` from `../lib/guard-custody.js`.
- `policyChecksumFields` is at :300 and `policiesEqual` at :334 (V-2).

### 3.2 `lib/completion-gate.js` (:963-970, edit)

```js
if (!u.ok) {
  const manual = u.error?.code === 'upgrade_descriptor_unavailable' && custodyBackend() === 'none';
  return refusal('upgrade', [
    ...u.reasons,
    ...(u.error?.hint ? [u.error.hint] : []),
    ...(manual ? ['regenerate with `compose guard descriptors`, have the operator re-sign it, and commit both files'] : []),
  ], { guarded, error: u.error });
}
```

`refusal()` already carries `error` through (`:964` shape `{ guarded, error }`); `hint` rides inside
`error`. Import `custodyBackend` from `./guard-custody.js`.

### 3.3 `server/vision-routes.js` (:663-668, edit)

Add `...(gated.error?.hint ? { hint: gated.error.hint } : {})` to the 422 body.

### 3.4 `server/compose-mcp-tools.js` `_postLifecycle` (:710-715, edit) — C3

```js
if (status >= 400) {
  const b = respBody && typeof respBody === 'object' ? respBody : null;
  const parts = [b?.error ?? `HTTP ${status}`];
  if (Array.isArray(b?.reasons) && b.reasons.length) parts.push(b.reasons.join('; '));
  if (b?.hint) parts.push(`hint: ${b.hint}`);
  throw new Error(b ? parts.join(' — ') : `HTTP ${status}: ${...}`);
}
```

Affects every lifecycle tool's error text (they all use `_postLifecycle`); `test/judgment-writer-mcp.test.js`
and `test/mcp-tool-policy.test.js` pin tool *inventories*, not error strings — no re-pin. Check
`grep -rn "Compose server unreachable\|backfill refused" test/` before editing (blueprint verification
row V-12).

### 3.5 Tests (S2)

- `test/lifecycle-backfill-upgrade.test.js` (extend, :17-33 shape). Codex bp #11: enumeration inside
  `ensureSignedDescriptors` calls the real `guardPolicy` transport (`lib/guard-descriptors.js:92`), not
  `_client.policy`, so a faked `_client` alone would let an empty candidate pass. These unit rows
  therefore inject `ensure` (the `ensureSignedDescriptors` dependency of `applyBackfillUpgrade`) and
  assert only what this function owns: already-upgraded → `unchanged`, zero `ensure` calls, cache
  refreshed (`ensureGuard` afterwards returns `cached`); `ensure` refusal → `{ok:false,
  error:{code,message,hint}}` all three present; lock: a second `applyBackfillUpgrade` started while
  the first sits in a slow `ensure` **and then in a slow `applyUpgrade`** does not enter `ensure` until
  the first's `finally` ran (assert ordering via a shared event log), and it waits longer than 30 s
  when the deadline option is 150 s (use fake timers or a 35 s real wait in one row) (Codex bp #6);
  `DirLockTimeout` → refusal envelope, not a throw.
- `test/lifecycle-backfill.test.js` (extend §7 golden flows — the REAL producer path: real stratum
  copy, real enumeration through `guardPolicy`, real verifier via `stratum guard descriptors` on the
  copy, real apply): replace `signDescriptors` (:267-274) with `_testOnly_setCustodyBackend(testCustody(SIGNER))`
  where `testCustody` records confirmations. Flow A asserts the confirmation log length is **1** after
  the first backfill (the gate drops `prompts` at `lib/completion-gate.js:971`; the log is the
  observable); a second legacy feature with the same checksum → still 1; graph change → 2; the
  published generation's `.sig` verifies on the copy and `current` resolves to it. Refusal rows
  R27–R32 per design §4, plus: a generation dir with a **corrupt** `.sig` → refused, `current`
  unchanged, log unchanged; a group-writable generation → not `fresh`, refused with the mode message.
- `test/lifecycle-backfill-routes.test.js` (extend): 422 body carries `hint`; **a real producer
  failure** through HTTP — point the stratum CLI at a script that fails `guard policy` so enumeration
  throws inside `ensureSignedDescriptors` → 422 with `upgrade_descriptor_unavailable` + hint, not the
  generic 400 at `server/vision-routes.js:689` (Codex bp #7).
- `test/compose-mcp-tools.test.js` or nearest existing (verify in V-12): 422 with reasons+hint →
  thrown message contains both.

## 4. Slice S3 — CLI: `enrol`, `sign`, `descriptors`, `status` (compose `bin/`, `lib/`)

### 4.1 `lib/guard-enrol.js` (new)

```js
export const PRINCIPAL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SUDOERS_TEXT = (principal) =>
  `Defaults!${SIGNER_PATH} timestamp_timeout=0\n${principal} ALL=(root) ${SIGNER_PATH}\n`;
export function validateAncestry(p)            // every ancestor: uid 0, !(mode & 0o022), !symlink → { ok, offending }
export function locateTrustRoot()              // { kind:'source'|'dist', path, checkoutRoot|null } via createRequire resolve of @smartmemory/stratum/package.json
export function candidateTrustRoot(current, principal, publicKeyLine) // appends or reports { present:true }; parses whole candidate with parseAllowedSigners
export function installPlan(principal)         // the list printed before the root step
export function installScript(principal)       // sh text run ONCE via `sudo -k /bin/sh -c` … see below
export async function roundTrip({ custodySign, publicKeyLine })  // signs a fixture, verifySshsig against that one key
export async function rebuildStratumDist(checkoutRoot) // `npm run build` in checkoutRoot (only for kind:'source')
```

- **Backend guard first** (Codex bp #2): `runGuardEnrol` refuses with `enrol requires the sudo custody
  backend on macOS` when `custodyBackend() !== 'sudo'` — before the plan is printed, before any spawn,
  before any file is touched. The test backend therefore can never reach a trust root.
- **Root step** (one approval; Codex bp #1 — the same spawn contract as signing):
  `execFile('/usr/bin/sudo', ['-k', '/bin/sh', '-s'], { env: SUDO_ENV(), timeout: CUSTODY_TIMEOUT_MS })`
  with the script on stdin — scrubbed environment, never `-A`, absolute `sudo`. The script (rendered
  from a template string, printed verbatim in the plan first) starts with `set -eu; umask 022;
  PATH=/usr/bin:/bin:/usr/sbin; export PATH` and calls every binary by absolute path
  (`/bin/mkdir`, `/bin/cp`, `/usr/sbin/chown`, `/bin/chmod`, `/usr/bin/ssh-keygen`, `/usr/sbin/visudo`,
  `/usr/bin/install`, `/usr/bin/grep`, `/bin/cat`). It does:
  `mkdir -p /Library/Compose/guard/private/tmp` (`/Library/Compose` 0755, `guard` 0755, `private` 0700,
  `tmp` 0700), install signer from the packaged path (`cp` + `chown root:wheel` + `chmod 0755`),
  `ssh-keygen -t ed25519 -N '' -q -f /Library/Compose/guard/private/signing-key -C compose-guard`
  **only if absent** (never rotate), `chmod 0600` key, then `cp` the `.pub` up to `PUBKEY_PATH` with
  `0644`, write sudoers to a temp then `visudo -cf` then `install -m 0440` to `SUDOERS_PATH`
  (`/private/etc/...`), and append `auth sufficient pam_tid.so` to `SUDO_LOCAL_PATH` if no uncommented
  line exists (creating the file from the template's uncommented line if absent).
  Every step is idempotent; the script prints `ok <step>` lines the CLI echoes.
- Ancestry is validated **before** the plan is printed and again after the root step (both must pass).
- The sudoers text is a golden fixture in tests and passes `visudo -cf` (verified 2026-09-06).
- Order (design, Codex r2 #3): backend guard → ancestry → plan → root step → ancestry again → read
  `PUBKEY_PATH` → `roundTrip` (second approval; signs a **fixture descriptor file** `{version:1,
  descriptors:[]}` written to a temp dir with its `.sig`, verified in-process against that one key) →
  `candidateTrustRoot` → write (source checkout only; `dist` kind → print the line and refuse) →
  `rebuildStratumDist` → **final check reuses the retained fixture pair** (Codex bp #3):
  `guardDescriptors(fixture.file)` must return `signature` starting `verified: signed by <principal>
  (<fp>)` with the expected fingerprint AND `group_or_world_writable === false` — membership in
  `allowed_signers` alone is not enough because the inspector lists signers even when verification
  fails (`descriptors.ts:253-261`) → `done`.
- The orchestrator is tested as a whole with injected `execFile`, `fs`, and custody spies: with the
  test backend it performs **zero** spawns and zero writes; with a fake sudo backend it spawns exactly
  `['-k','/bin/sh','-s']` under `SUDO_ENV()` and the script text is byte-identical to the fixture.

### 4.2 `bin/compose.js` (edit)

- Replace the `guard descriptors` block (:1221-1236) with a block handling `descriptors | sign | enrol`
  (all workspace-resolved via `resolveCwdWithWorkspace`), delegating to `lib/guard-cli.js` (new, so
  `bin/compose.js` grows by ~20 lines, not 200):
  - `descriptors`: `ensureSignedDescriptors` under the same dir lock, custody = real; prints one line:
    `signed by <principal> (<fp>), N descriptor(s), verified` / `fresh: …` / the refusal + hint.
    **Manual path when custody is `none`** (Codex bp #8): a separate `prepareUnsignedCandidate(root)`
    writes the candidate bytes to `<sha>/descriptors.json` (0600) **without** a `.sig` and without
    touching `current`, and prints `ssh-keygen -Y sign -f <key> -n stratum-guard-descriptors
    <that file>`; the next `compose guard descriptors` (or the gate) finds `<sha>/` with a verifying
    `.sig` and publishes it via step 4 of §2.3 — verification always precedes publication.
  - `sign`: same as `descriptors` but forces a fresh signature when `current` is stale; identical output.
  - `enrol [--principal <p>]`: §4.1.
- Extend the `status` branch (:2325-2343): the canon-guard part keeps dispatching on `PACKAGE_ROOT`
  (dogfooding, unchanged); the new `signing:` block resolves the **workspace** with
  `resolveCwdWithWorkspace(args)` (Codex bp #10) and prints `custodyStatus()` + `currentGeneration()` +
  `verifyGeneration(current)` + coverage (enumerate registered non-terminal legacy checksums, compare
  to descriptor ids) + `git status --porcelain -- .compose/guard-upgrades` (committed or not) + legacy
  flat pair present (C9) + `cachedCredential`. `status --prune` runs `pruneGenerations` under the
  descriptor lock (§2.3) and reports what it removed.
- Update the unknown-subcommand line (:2345) to list `enrol | sign | descriptors | status [--prune]`.

### 4.3 Tests (S3)

- `test/guard-enrol.test.js` (new): `PRINCIPAL_RE` table; `SUDOERS_TEXT` golden bytes + `visudo -cf`
  when available; `validateAncestry` against a temp tree (root-owned dirs cannot be created in tests →
  inject `stat`); `candidateTrustRoot` refuses a name with a space, refuses non-ASCII, is idempotent on a
  present fingerprint, and the candidate parses with the installed `parseAllowedSigners`;
  `locateTrustRoot` returns `source` for the symlinked sibling (this repo) and `dist` for a real dir
  (temp fixture); `roundTrip` with the test signer passes, with a *different* key fails.
- `test/guard-cli.test.js` (new). V-13 found **no** preload precedent (`test/canon-guard-cli.test.js`
  plain-spawns `bin/compose.js`), and a spawned CLI cannot reach the in-process custody seam. So:
  `runGuardDescriptors` / `runGuardSign` / `signingStatusLines` from `lib/guard-cli.js` are tested
  **in-process** with `_testOnly_setCustodyBackend` (they return the lines; `bin/compose.js` only
  prints them), and `compose guard status` is additionally **spawned** end-to-end against a temp
  workspace where custody is `none`/not installed (no seam needed) to pin the printed contract.
  `enrol` is not spawned in tests (root); its pieces are unit-tested above.

## 5. Slice S4 — docs, cross-repo, manual check

- `README.md:180-192`: replace steps 1–5 with the enrol paragraph, the `tmux`/`pam_reattach` note, the
  admin `timestamp_timeout=0` recommendation, and the generations layout (one paragraph).
- `CHANGELOG.md` Unreleased: entry "One-tap guard authorization (COMP-GUARD-ONE-TAP)".
- `../stratum/ts/contracts/guard-signers.allowed` header: two comment lines (C12). Separate stratum commit.
- `docs/features/COMP-GUARD-ONE-TAP/manual-check.md` (new): the six checklist items from design §4 with
  a result column for the owner.
- `docs/features/COMP-GUARD-ONE-TAP/feature.json`: status per lifecycle; ROADMAP regenerated by the
  writer, never hand-edited.

## File Plan

| Path | Action | Slice |
|---|---|---|
| `scripts/guard-sign/compose-guard-sign.sh` | edit (written 2026-09-06; header comment only in S1) | S1 |
| `lib/guard-custody.js` | new | S1 |
| `lib/guard-descriptors.js` | edit (remove `writeDescriptorFile`, add generations) | S1 |
| `server/stratum-client.js` | edit (add `guardDescriptors`) | S1 |
| `lib/dir-lock.js` | edit (`timeoutMs` option, default unchanged) | S1 |
| `test/guard-custody.test.js` | new | S1 |
| `test/guard-sign-script.test.js` | new | S1 |
| `test/guard-descriptors.test.js` | edit | S1 |
| `server/lifecycle-guard.js` | edit (`applyBackfillUpgrade`, `_client.descriptors`) | S2 |
| `lib/completion-gate.js` | edit (:963-970) | S2 |
| `server/vision-routes.js` | edit (:663-668) | S2 |
| `server/compose-mcp-tools.js` | edit (:710-715) | S2 |
| `test/lifecycle-backfill-upgrade.test.js` | edit | S2 |
| `test/lifecycle-backfill.test.js` | edit | S2 |
| `test/lifecycle-backfill-routes.test.js` | edit | S2 |
| `lib/guard-enrol.js` | new | S3 |
| `lib/guard-cli.js` | new | S3 |
| `bin/compose.js` | edit (:1221-1236, :2325-2345) | S3 |
| `test/guard-enrol.test.js` | new | S3 |
| `test/guard-cli.test.js` | new | S3 |
| `README.md` | edit (:180-192) | S4 |
| `CHANGELOG.md` | edit | S4 |
| `docs/features/COMP-GUARD-ONE-TAP/manual-check.md` | new | S4 |
| `../stratum/ts/contracts/guard-signers.allowed` | edit (comment only, stratum repo) | S4 |

## Boundary Map

### S01: custody, signer, generations
Produces:
  lib/guard-custody.js → custodyBackend, custodyStatus, custodySign, _testOnly_setCustodyBackend, SIGNER_PATH, HINT_ENROL, HINT_APPROVE, DESCRIPTOR_LOCK_TIMEOUT_MS (function)
  lib/guard-descriptors.js → ensureSignedDescriptors, currentGeneration, adoptLegacyFlatPair, verifyGeneration, generationPaths, pruneGenerations, prepareUnsignedCandidate (function)
  server/stratum-client.js → guardDescriptors (function)

Consumes: nothing (leaf node)

### S02: gate hook and refusal envelope
Produces:
  server/lifecycle-guard.js → applyBackfillUpgrade (function)

Consumes:
  from S01: lib/guard-custody.js → custodySign, custodyBackend, HINT_ENROL, HINT_APPROVE
  from S01: lib/guard-descriptors.js → ensureSignedDescriptors
  from S01: server/stratum-client.js → guardDescriptors

### S03: CLI verbs
Produces:
  lib/guard-enrol.js → PRINCIPAL_RE, SUDOERS_TEXT, validateAncestry, locateTrustRoot, candidateTrustRoot, roundTrip, rebuildStratumDist (function)
  lib/guard-cli.js → runGuardDescriptors, runGuardSign, runGuardEnrol, signingStatusLines (function)

Consumes:
  from S01: lib/guard-custody.js → custodyStatus, custodySign, custodyBackend, SIGNER_PATH, DESCRIPTOR_LOCK_TIMEOUT_MS
  from S01: lib/guard-descriptors.js → ensureSignedDescriptors, currentGeneration, pruneGenerations, prepareUnsignedCandidate, verifyGeneration
  from S01: server/stratum-client.js → guardDescriptors

### S04: docs
Produces: nothing (integration only)

Consumes:
  from S03: lib/guard-cli.js → runGuardEnrol

## Codex blueprint gate r1 disposition (2026-09-06, gpt-6-astra)

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | P1 | Enrol root step lacked the scrubbed-spawn contract | §4.1: `execFile('/usr/bin/sudo', ['-k','/bin/sh','-s'], { env: SUDO_ENV() })`, installer pins `PATH` + absolute binaries; spawn contract asserted |
| 2 | P2 | No unconditional test-custody enrol refusal | §4.1 backend guard first; orchestrator test proves zero spawns/writes under the test backend |
| 3 | P2 | Enrol's final check accepted fingerprint membership alone | §4.1 reuses the round-trip fixture pair; requires verified signature + fingerprint + mode bit |
| 4 | P2 | Existing invalid `<sha>` could be signed over / reused unverified | §2.3 step 4/5: invalid existing generation → refuse, never move `current`; race destination re-verified |
| 5 | P2 | Verdict ignored `group_or_world_writable` | §2.3 verdict = ok ∧ verified ∧ not writable |
| 6 | P2 | 30 s lock deadline vs 120 s approval | `acquireDirLock(path, { timeoutMs })`; 150 s budget; contention tested through approval and apply |
| 7 | P2 | Thrown infrastructure failures bypass the envelope | §2.3 try/catch normalisation; §3.1 lock failure envelope; HTTP real-producer-failure test |
| 8 | P2 | Manual command printed for a deleted staging file | §4.2 `prepareUnsignedCandidate` writes an unsigned `<sha>/` without touching `current`; published on next run after verification |
| 9 | P2 | Status expected 0700 on `guard/` | §2.2 modes: `guard/` 0755, `private/` 0700, sudoers 0440 |
| 10 | P2 | Status not workspace-resolved; `--prune` missing | §4.2 signing block resolves the workspace; `pruneGenerations` under the lock |
| 11 | P2 | Unit test faked the wrong seam; `prompts` dropped by the gate | §3.5 unit rows inject `ensure`; golden flows exercise the real enumeration→sign→verify→apply chain and assert the confirmation log |
| 12 | P2 | Three stale references | Fixed: :300/:334 order, C4 :431, C2 precedent = stratum `setGuardTrustRootForTests` |

## Verification Table (Phase 5, 2026-09-06)

| V | Reference | Result |
|---|---|---|
| V-1 | `server/lifecycle-guard.js:452-453` `applyBackfillUpgrade` | ✅ |
| V-2 | `server/lifecycle-guard.js:284-291` `_client` + `_testOnly_setGuardClient`; `:295` `_registered`; `:300` `policyChecksumFields`; `:334` `policiesEqual`; `:403` `ensureGuard` | ✅ |
| V-3 | `lib/completion-gate.js:963-964` legacy branch → `applyBackfillUpgrade` | ✅ |
| V-4 | `server/vision-routes.js:663-664` 422 envelope | ✅ |
| V-5 | `server/compose-mcp-tools.js:702` `_postLifecycle` | ✅ |
| V-6 | `server/stratum-client.js:225` `runGuard(action, kwargs, timeoutMs, extraEnv)`; `:396` `guardApplyUpgrade` | ✅ |
| V-7 | `test/lifecycle-backfill.test.js:267` `signDescriptors`; `:205-222` in-process `completionGate` | ✅ |
| V-8 | `../stratum/ts/src/cli/guard.ts:176` `descriptors` action; `descriptors.ts:238` `inspectDescriptorFile` | ✅ |
| V-9 | `descriptors.ts:65-81` (C8, as first written) | ❌ stale — offsets from a piped grep; **corrected to :144-160 / :193** |
| V-10 | `dist/guard/sshsig.js:185/217/228` `verifySshsig`/`sshFingerprint`/`parseAllowedSigners`; `test/helpers/stratum-test-bin.js:28-30` deep resolve | ✅ |
| V-11 | `bin/compose.js:1221` descriptors block; `:2345` unknown-subcommand line; `package.json:67` `scripts/**` | ✅ |
| V-12 | `grep -rn "backfill refused\|Compose server unreachable" test/` | no matches — `_postLifecycle` error text is unpinned; §3.4 safe |
| V-13 | preload precedent in `test/canon-guard-cli.test.js` | ❌ none (plain `spawnSync`) — **§4.3 rewritten**: lib functions tested in-process, only `status` spawned |
| V-14 | `validateBoundaryMap` | `ok: true`, 0 violations, 2 warnings (table header row parsed as a file; the script's action text) — action text fixed |
| V-15 | `/etc` → `private/etc` symlink (design r3) | ✅ `lrwxr-xr-x root wheel /etc -> private/etc` |

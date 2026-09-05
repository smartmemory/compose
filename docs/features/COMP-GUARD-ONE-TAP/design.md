# COMP-GUARD-ONE-TAP — One-tap guard authorization

**Status:** IN_PROGRESS (design revision 3, 2026-09-06; revision 1 = brief + keychain design, killed by the
spike and Codex gate r1 the same day — see "Spike record"; revision 2 = sudo + Touch ID, tightened by
Codex gate r2 — see "Codex r2 disposition")
**Stratum run:** `34832563-e55c-445a-b13b-c8a6896e7a0f`
**Origin:** owner directive 2026-09-06 after shipping COMP-LIFECYCLE-BACKFILL: "no human should ever
have to do any of this, it should be fully automated." Owner chose, from three options, **one tap to
approve, everything else automated** over (a) fully unattended with an agent-held key and (b) keeping
the manual flow with better tooling.

## Related Documents

- Predecessor: [COMP-LIFECYCLE-BACKFILL](../COMP-LIFECYCLE-BACKFILL/report.md) — shipped the signed
  upgrade-descriptor mechanism this feature automates; its README section "Backfilling a completion"
  documents the five manual operator steps this feature deletes.
- Reviews: [reviews/design-r1.md](./reviews/design-r1.md) (Codex, gpt-6-astra, 7 findings — mapped in
  "Codex r1 disposition"), [reviews/design-r2.md](./reviews/design-r2.md) (7 findings — mapped in
  "Codex r2 disposition").
- Stratum trust root: `stratum/ts/contracts/guard-signers.allowed` (in-source, committed; read from the
  installed tree via `stratum/ts/src/guard/trust.ts`). Header fixed to printable ASCII in stratum `232aca3`.
- Stratum authz/descriptors: `stratum/ts/src/guard/descriptors.ts` (sshsig namespace
  `stratum-guard-descriptors`, mode check `0o022`, `STRATUM_GUARD_UPGRADE_DESCRIPTORS`,
  `inspectDescriptorFile` behind `stratum guard descriptors` — it returns `allowed_signers` even when the
  signature does NOT verify; the `signature` field is the verdict).
- Stratum verifier: `stratum/ts/src/guard/sshsig.ts` — **Ed25519 only** (`ssh-ed25519`); the
  `allowed_signers` parser splits on whitespace, refuses non-ASCII and option lists, and one bad line makes
  the whole trust root unavailable (`trust.ts:73`).
- Compose side today: `lib/guard-descriptors.js` (`writeDescriptorFile` — writes the canonical file
  immediately), `server/lifecycle-guard.js` (`ensureGuard` caches `legacy` at :403; `applyBackfillUpgrade`
  :452), `lib/completion-gate.js` (upgrade refusal :964 appends an unconditional manual-recovery line;
  per-feature `acquireDirLock` :753), `server/vision-routes.js` :663 (422 envelope: `refusedAt`, `reasons`,
  `guardError`), `server/stratum-client.js` `guardApplyUpgrade` (descriptor path in the child env),
  `test/helpers/sshsig-sign.js` (in-test signer), `test/lifecycle-backfill.test.js` (golden flows spawn a
  copied real stratum with a temp `HOME` and inject the test signer into the copy's
  `dist/contracts/guard-signers.allowed`).
- Related memories: guard-cli-auth-hole (override token was agent-mintable), guard-signed-authz.

## The invariant that must survive

An agent must not be able to authorize a change to the guard's own rules. The override token failed
this (agent-mintable over the CLI). The signed descriptor holds it ONLY while the private key is
unusable by any process the agent controls. "Fully unattended" would collapse the signature to
"compose ran", the same trust level the token had; the owner rejected that and accepted one tap.

Stated precisely, after the spike and the r1 review:

1. **The private key must never be readable by, or pass through, any process running as the operator's
   user.** A seed that is "released to a helper after a prompt" is agent-held for as long as that helper
   (which the agent can replace) chooses to keep it (Codex r1 #1).
2. **The user-presence check must be performed by the OS or a root-owned component**, never by our code,
   and the component that performs it must not be writable by the operator's user.
3. **One approval must authorize exactly one signature.** No credential cache may let a second signing
   ride on the first approval.

## What the human does

Exactly one thing, when a signature is needed: authenticate in the macOS system prompt (Touch ID, or
the account password fallback the same prompt offers). No commands, no files, no passphrase typing in
a terminal, nothing after a reboot. Plus, once per machine, `compose guard enrol`, which itself asks for
two approvals (install, then the first signature).

## Spike record (2026-09-06) — what does NOT work on the owner's machine

Measured, not argued. Every candidate below was tried by hand before the mechanism was chosen.

| Candidate | Result | Why it is out |
|---|---|---|
| ssh-agent confirm mode (`ssh-add -c`), the brief's default | Apple's ssh-agent looks for `/usr/X11R6/bin/ssh-askpass` (absent); no askpass in `$PATH`, Homebrew or `/usr/libexec` | Fails closed with no dialog. Would need a third-party askpass, `launchctl setenv` for the launchd agent, and a passphrase typed after every reboot (a Keychain-stored passphrase lets any same-user process `ssh-add --apple-load-keychain` WITHOUT `-c`). Not one tap, and the key is agent-reachable while loaded |
| Data-protection keychain item + `.userPresence`, Swift helper (design r1) | `SecItemAdd` → `-34018` (missing entitlement) from an unsigned CLI; ad-hoc signature with `com.apple.application-identifier` → process killed (exit 137); `security find-identity` → 0 signing identities | Needs an Apple Developer signing identity this machine does not have. Also fails invariant 1 (seed passes through a user-owned helper) — Codex r1 #1 |
| Secure Enclave key (`kSecAttrTokenIDSecureEnclave`) | Non-permanent key: "export not implemented"; permanent key: `-34018` | Same entitlement wall; P-256 only, so stratum's verifier would need extending anyway |
| Legacy login-keychain item with an empty application ACL (`security add-generic-password -T ""`) | `security find-generic-password -w` returned the secret **with no prompt** (`applications (0)` on the ACL) — Apple tools sit in the `apple-tool:` partition; changing the partition list needs the keychain password interactively | The agent reads it with the stock `security` binary. Also has the "Always Allow" foot-gun |
| FIDO2 `ed25519-sk` | Not tried: signs as `sk-ssh-ed25519@openssh.com`, which `sshsig.ts:261` refuses | Needs a stratum verifier extension and hardware — follow-up `STRAT-GUARD-SK` |
| `sudo` + `pam_tid` (Touch ID for sudo) | `/usr/lib/pam/pam_tid.so.2` present; `/etc/pam.d/sudo_local.template` present with the Touch ID line commented out; `/etc/sudoers.d/` in use; Touch ID enrolled (`bioutil -rs`) | **Chosen.** Could not be exercised end-to-end in the spike because enabling it needs one interactive sudo — that is the first item of the manual checklist |

## Decision: custody mechanism — a root-owned signer behind sudo + Touch ID

All root-owned files live under `/Library/Compose/guard/` (created by enrol as `root:wheel` 0755).
`/Library` is root-owned on every macOS install; `/usr/local` is not (Intel Homebrew makes it
user-writable), which is why it is not used. Enrol **refuses** unless every ancestor of every installed
path is root-owned, mode without group/world write, and not a symlink (Codex r2 #3). The two system
files enrol touches are addressed by their real paths, `/private/etc/pam.d/sudo_local` and
`/private/etc/sudoers.d/compose-guard`, because `/etc` itself is a symlink to `private/etc` on macOS
(Codex r3 #1; verified 2026-09-06).

Layout (Codex r3 #2 — the public half must be readable without root):

```
/Library/Compose/guard/                 root:wheel 0755
/Library/Compose/guard/sign             root:wheel 0755   the signer script
/Library/Compose/guard/signing-key.pub  root:wheel 0644   the enrolled public key (authoritative)
/Library/Compose/guard/private/         root:wheel 0700
/Library/Compose/guard/private/signing-key   root 0600   the private key
/Library/Compose/guard/private/tmp/     root:wheel 0700   signer staging
```

- **Key**: `/Library/Compose/guard/private/signing-key` — a passphrase-less Ed25519 OpenSSH key,
  generated **as root** by `/usr/bin/ssh-keygen -t ed25519`. The operator's user (and therefore every
  agent process) cannot read it or list its directory. Invariant 1 holds by file ownership, enforced by
  the kernel.
- **Signer**: `/Library/Compose/guard/sign` — a root-owned (0755, `root:wheel`) POSIX shell script
  installed by enrol from `scripts/guard-sign/compose-guard-sign.sh`. It sets `PATH=/usr/bin:/bin` and
  calls every binary by absolute path; it stages stdin under `/Library/Compose/guard/private/tmp/`
  (`mktemp -d` inside it — never the caller's `TMPDIR`), runs `/usr/bin/ssh-keygen -Y sign -q -f <key>
  -n "$1"`, prints the armored signature on stdout, and removes the staging dir on every exit path
  (Codex r2 #2). The namespace is its only argument, validated as `^[a-z][a-z0-9-]{1,63}$` so it cannot
  smuggle options. Invariant 2: the operator's user cannot edit it, and the sudoers rule names it by
  absolute path.
- **Approval**: `sudo -k /Library/Compose/guard/sign <namespace>`, spawned with a **scrubbed environment**
  (`PATH`, `HOME`, `USER`, `LANG` only — never `SUDO_ASKPASS`, `SSH_ASKPASS`, `SUDO_PROMPT`; Codex r2 #4)
  and never `-A`. `-k` with a command makes sudo ignore any cached credential for this run **and not
  update the cache afterwards**, so our own approval never seeds a timestamp that a later call could
  ride (sudoers(5) `-k`). sudo authenticates through PAM; `/private/etc/pam.d/sudo_local` carries
  `auth sufficient pam_tid.so`, so the OS shows the Touch ID sheet (password fallback is the same
  sheet). Neither our code nor the calling process answers it.
- **One approval, one signature** (invariant 3): `/private/etc/sudoers.d/compose-guard` is exactly

  ```
  Defaults!/Library/Compose/guard/sign timestamp_timeout=0
  <operator> ALL=(root) /Library/Compose/guard/sign
  ```

  `timestamp_timeout=0` for this command means sudo always re-authenticates for it regardless of any
  cached credential; `-k` on the call side guarantees the reverse (our run never leaves a credential
  behind). It is NOT `NOPASSWD`. Enrol validates the file with `visudo -cf` before installing it
  (checked 2026-09-06: `parsed OK`).
- **Public half**: `/Library/Compose/guard/signing-key.pub` (root-owned, 0644) so status and enrolment
  never need an approval. It is the authoritative source of the enrolled key: enrol reads it from here,
  never from a user-writable location.
- **Headless**: from an SSH session or a `tmux` pane without `pam_reattach`, `pam_tid` cannot reach the
  window server and sudo falls through to a password prompt on a tty that does not exist → sudo fails
  with "a terminal is required". A cancelled Touch ID sheet falls through to the same error (Codex r2
  #7), so custody does NOT claim to know which happened: both map to `signature_not_approved` with a hint
  covering both ("approve the Touch ID prompt; if none appeared, run `compose guard sign` from a
  terminal on this Mac"). Signer exit codes 64/66 and any other failure map to
  `upgrade_descriptor_unavailable` with the stderr line as detail — never to a human decline. Every
  refusal writes nothing.

### What this does and does not defend

- No user-owned process ever holds the key; replacing compose, the custody module, or any binary the
  operator's user can write changes nothing about who can sign. The only writable-by-agent input is the
  message bytes, which is the deal already made in COMP-LIFECYCLE-BACKFILL (the signature authorizes
  what compose asked to sign; the descriptor's `to_policy` is derived from the stored policy, not chosen).
- **Residual, accepted (inherent to every dialog scheme, and the trade the owner made):** an agent can
  run the sudo command itself and cause a Touch ID sheet to appear. The sheet says `sudo`, not why. The
  defences are timing (compose triggers a signature only inside a backfill the human requested), the
  `compose guard status` audit line (last signature time + what it covered), and the sudo log
  (`log show --predicate 'process == "sudo"'`), which records every invocation with the calling command.
  An agent that knows the account password can type it into the sheet's fallback; same class, not
  addressed.
- **Residual, documented, outside this feature's reach (Codex r2 #1):** the operator is an admin, so
  `%admin ALL=(ALL) ALL` also applies. If the human authenticates some *other* sudo in a process tree
  the agent shares (macOS `timestamp_type=tty`; ppid for tty-less processes), the agent can
  `sudo -n cat` the key for the next five minutes. This feature never seeds such a credential (`-k`), but
  it cannot revoke the operator's general sudo policy. `compose guard status` runs `sudo -n -v` and
  warns "a cached admin credential is live in this session" when it succeeds, and the README recommends
  `Defaults timestamp_timeout=0` for admins who want the invariant to hold against their own habits. An
  agent that can already become root can also edit the installed trust root; root is the boundary of
  every guard on this machine, not just this one.
- Enrol needs root once. The operator runs it interactively from a terminal; it is the one moment a
  script written by compose runs as root, and the operator sees exactly what will be installed before
  approving (enrol prints the files it will write, then asks). **Trust-root order:** enrol reads the
  public key from the root-owned `.pub`, signs a fixture through the real `sudo -k` path, verifies that
  signature in-process against that single key with stratum's `verifySshsig`, and only then writes the
  trust root (Codex r2 #3: a failed round trip must not leave an unverified key trusted).
- No askpass of any kind, ever. A password that passes through a user-owned helper can be captured and
  replayed; revision 2's `SUDO_ASKPASS` fallback is withdrawn (Codex r2 #4). If `pam_tid` does not show a
  sheet for a tty-less sudo, the degraded path is `compose guard sign` run by the human from a terminal
  (a tty password prompt owned by sudo, one command, no secret through our code), and the gate refuses
  with that hint.
- Hardware-backed custody (FIDO2, Secure Enclave) is strictly stronger and is filed as `STRAT-GUARD-SK`,
  blocked on stratum accepting `sk-ssh-ed25519@openssh.com` / `ecdsa-sha2-nistp256`.
- Non-macOS: no custody backend. Every signing path refuses with `upgrade_descriptor_unavailable` and
  the `compose guard enrol` hint, exactly as today. (The same root-key + sudo design works on Linux with a
  password sheet via `SUDO_ASKPASS`; follow-up `COMP-GUARD-ONE-TAP-2`.)

## Decision: enrolment without a stratum release (open question 1)

The trust root **stays in-source in stratum**. The env-settable alternatives are rejected for the reason
stratum's header gives: an environment variable is set silently by whatever process is running, and the
adversary in this threat model launches processes.

What compose automates on top of that:

- `compose guard enrol` locates the installed stratum's trust root (the package that
  `node_modules/@smartmemory/stratum` resolves to; `contracts/guard-signers.allowed` in a source tree,
  `dist/contracts/` in a published tree).
  - **Sibling source checkout (the symlink dev setup, which is this workspace):** build the candidate
    file in memory, **parse the whole candidate with stratum's own `parseAllowedSigners`** (Codex r1 #7),
    write it only if it parses, run `npm run build` in that checkout so `dist/` carries it, and report
    "enrolled — commit `<path>` in stratum". The commit is the reviewable act and is left to the human's
    normal git flow; local operation does not wait on it.
  - **Registry install (real directory under `node_modules`):** refuse with a message: enrolment
    requires a stratum release because the trust root is in-source by design; print the exact line to
    add. Writing into an installed package would be wiped on reinstall and would never be reviewed.
- **Principal** = `$USER` (or `--principal`), validated as `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; anything
  else refuses with the rule. Never `git config user.name` (spaces would be parsed as the key type).
- **Only the `sudo` custody backend may enrol.** The test backend's `enrol` refuses unconditionally: its
  key is agent-held by construction and must never reach a live trust root (Codex r1 #2). The golden
  flows keep injecting their fixture key into the isolated stratum copy, as today.
- Idempotent: a fingerprint already present is reported, not appended twice.
- A stratum-side "additional signers file whose path is pinned in the in-source root" would remove the
  release requirement for registry installs without an env path; that is stratum's call and is filed as
  `STRAT-GUARD-SIGNERS-EXTRA` (follow-up).

## Scope (v1)

### Custody interface (compose, `lib/guard-custody.js`)

One module, one interface, two backends:

```
status()                          → { backend, available, enrolled, publicKeyLine|null, detail }
enrol({ principal })              → { publicKeyLine }      (sudo backend: interactive, one approval)
sign({ bytes, namespace })        → { armored }            (exactly one approval; never touches disk
                                                             on the compose side)
```

- `sudo` backend (macOS). `status` reports three independent facts and says `unknown` where it cannot
  see (Codex r2 #6): **installed** — signer, key dir, `.pub`, and `/private/etc/sudoers.d/compose-guard` exist
  with root ownership and the expected modes (`stat` needs no read permission; the sudoers file's
  *content* is unknown to the user); **rule** — `sudo -n -l` result if it answers without
  authentication, else `unknown (sudo requires authentication to list)`; **presence** — `bioutil -rs`
  says biometrics enabled, `/private/etc/pam.d/sudo_local` (0644) carries the uncommented `pam_tid` line, and
  the process is not under `SSH_CONNECTION`/`TMUX` (a hint, not a proof). `sign` spawns
  `sudo -k /Library/Compose/guard/sign <namespace>` with the scrubbed environment, the bytes on stdin,
  and a 120 s wall clock, and maps: exit 0 → armored; sudo exit 1 with stderr matching
  `terminal is required|Sorry, try again|authentication failed|timed out` → `signature_not_approved`;
  wall-clock timeout → `signature_not_approved`; signer exit 64/66 or any other failure →
  `upgrade_descriptor_unavailable` with the stderr line. It never passes a password anywhere.
- `test` backend: selected by `COMPOSE_GUARD_CUSTODY=test`, **refused unless `NODE_ENV=test`** (the same
  seam discipline as stratum's `setGuardTrustRootForTests`). Signs with `test/helpers/sshsig-sign.js`,
  appends `{ at, namespace, bytesSha256 }` to a confirmation log the test reads, and can be told to
  report `signature_not_approved` or an infrastructure failure. `enrol` refuses (see above).
- Backend selection: `test` when the env says so, else `sudo` on `darwin`, else `none`.

### CLI surface (`bin/compose.js`)

`compose guard init` already exists (canon-guard workspace baseline) and `compose guard status` already
prints the canon-guard hook state, so the brief's verb names are corrected:

| Command | Does |
|---|---|
| `compose guard enrol` (new) | ancestry check on every install path (refuse otherwise) → print the plan (root files + trust-root line) → one sudo approval installs the `sudo_local` line, sudoers file (after `visudo -cf`), signer script, key dir + root key, pubkey file → **round-trip first** (second approval): sign a fixture through `sudo -k`, verify in-process against the root-owned `.pub` with stratum's `verifySshsig` → only then validate + write the trust root → rebuild stratum dist → confirm the fingerprint appears in `stratum guard descriptors` `allowed_signers` against the current generation (or a fixture generation when none exists; Codex r1 #6) → print `done`. Idempotent at every step. |
| `compose guard sign` (new) | regenerate descriptors → one approval → verify → one-line verdict. Explicit form of what the gate does on demand. |
| `compose guard descriptors` (changed) | generate, then **sign if custody is available**, then verify; prints one line: `signed by <principal> (<fp>), N descriptor(s), verified` or the refusal. Prints the manual `ssh-keygen` command only when custody is `none`. |
| `compose guard status` (extended) | after the canon-guard block, a `signing:` block — backend, enrolled fingerprint, trust-root membership, presence available now, descriptor freshness (every registered non-terminal legacy checksum covered), signature verdict, descriptor pair committed or not. |

### Descriptor publication (`lib/guard-descriptors.js`) — immutable generations, one atomic pointer

`writeDescriptorFile` today truncates the canonical file before anyone signs (Codex r1 #3), and any
two-file publication has a window where signature and descriptor disagree (Codex r2 #5). Both go away
with content-addressed generations:

```
.compose/guard-upgrades/<sha256-of-descriptor-bytes>/descriptors.json      (0600, never rewritten)
.compose/guard-upgrades/<sha256-of-descriptor-bytes>/descriptors.json.sig  (0600, never rewritten)
.compose/guard-upgrades/current  →  <sha256>/                              (symlink; the only mutable thing)
```

`ensureSignedDescriptors({ workspaceRoot, needChecksums, custody })` returns the **resolved, immutable**
generation path the caller must use for the rest of its operation:

1. Take the **workspace-wide** descriptor lock (`acquireDirLock` on `.compose/data/locks/guard-descriptors`)
   — the completion gate's lock is per feature and two backfills share these files. The caller holds it
   **through `applyUpgrade`** (the lock is passed in / released by the caller), so no publication can
   race an apply.
2. Build the candidate bytes in memory (`buildDescriptorFile`, unchanged) and their sha256.
3. If `current` resolves to a generation whose pair verifies (via `stratum guard descriptors`, the real
   verifier, pointed at that generation's file) and whose descriptors cover every needed checksum →
   return `{ status: 'fresh', path: <resolved generation file>, prompts: 0 }`. **No approval.**
4. Otherwise write `<sha>/descriptors.json` into a staging dir, request one signature over those exact
   bytes, write `.sig` beside it, verify the staged pair through the same verifier, `rename` the staging
   dir to `<sha>/` (a directory rename; a leftover from a crash is simply overwritten by content
   address), then repoint `current` with `symlink(tmp) + rename(tmp, current)` — one atomic step. On
   refusal or verification failure, delete the staging dir; `current` and every generation are untouched.
5. Return `{ status: 'signed', path, prompts: 1 }`.

The flat `.compose/guard-upgrades.json` + `.sig` shipped by COMP-LIFECYCLE-BACKFILL is honoured read-only
as a legacy generation on first run (moved under its own sha, `current` created), then never written
again. Generations are pruned by `compose guard status --prune` only; the gate never deletes. All of it
is committed by the operator as workspace canon (symlinks are fine in git).

### Sign on demand inside the gate

`server/lifecycle-guard.js` `applyBackfillUpgrade` becomes:

1. Read the stored policy. **If it already equals the expected upgraded policy** (the derived backfill
   policy for this mode), the upgrade already happened on an earlier attempt: refresh the registration
   cache to `cached` and return `{ ok: true, status: 'unchanged' }` — no descriptor, no approval (Codex
   r1 #4: a retry after "upgrade applied, policy read failed, intent not yet persisted" used to re-enter
   here asking for a checksum regeneration excludes).
2. Otherwise, under the workspace descriptor lock, `ensureSignedDescriptors({ needChecksums:
   [stored.checksum] })` (0 or 1 approval), then `applyUpgrade` with the **resolved generation path**
   it returned (never `current`), release the lock, then refresh the registration cache to `cached` on
   `applied`/`unchanged`.
3. Custody refusals become `{ ok: false, error: { code, message, hint }, reasons }` with `code` ∈
   `signature_not_approved` (the human did not complete the prompt, or none could be shown) |
   `upgrade_descriptor_unavailable` (custody `none`, not enrolled, signer/infrastructure failure,
   unverifiable pair) and `hint` = `compose guard enrol` or `approve the Touch ID prompt; if none
   appeared, run compose guard sign from a terminal on this Mac`.

Refusal envelope end to end (Codex r1 #5): the completion gate's upgrade refusal keeps
`refusedAt: 'upgrade'`, carries `error.code` and `error.hint` through unchanged, and **replaces** the
unconditional "regenerate … re-sign … commit both files" line with the custody hint (the manual line
survives only when `error.code` is `upgrade_descriptor_unavailable` AND custody is `none`). The HTTP
adapter adds top-level `hint` next to `guardError`. The MCP tool does NOT forward the body today:
`_postLifecycle` (`server/compose-mcp-tools.js:702`) throws `respBody.error` alone — the string
`backfill refused` — and drops `reasons`, `guardError` and any hint. In scope: on a 422 it throws an
error whose message carries `reasons` joined and the hint, so the agent that asked sees why.

The prompt appears from the compose server process (port 4001), which runs in the operator's GUI
session on the same Mac; the MCP tool and CLI delegate to it over HTTP, so the request simply waits (the
HTTP client timeout must exceed the 120 s custody wall clock — verify in the blueprint).

The descriptor pair is written by the gate but **not committed** by it — the gate never runs git
today (`lib/completion-gate.js` spawns only the test command). They are canonical workspace artifacts and
join the operator's next commit; `compose guard status` reports them as uncommitted if so.

### Docs

Delete the five-step "operator step" list from `README.md` §"Backfilling a completion"; replace with
"run `compose guard enrol` once; every later signature is a Touch ID prompt", plus the `tmux` note
(`pam_reattach`). Fix the verify command in the trust-root header to set the env var on the right
process. Record the askpass finding in the stratum header where it says "never add it to ssh-agent"
(unchanged advice, new reason).

## Codex r1 disposition

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | P1 | Replaceable helper can retain the seed; reuse duration is caller-controlled | **Design changed.** Key is root-owned and never in a user process; signer is root-owned and pinned by path in sudoers; `timestamp_timeout=0` removes credential reuse |
| 2 | P1 | Test custody + automatic enrolment = agent-held key in the live trust root | Test backend `enrol` refuses unconditionally; fixture keys only ever enter the isolated stratum copy |
| 3 | P2 | Declining already overwrote the canonical descriptor; per-feature lock only | Staged write + verify + rename; workspace-wide descriptor lock |
| 4 | P2 | Retry after a successful upgrade prompts for a checksum regeneration excludes; `legacy` cache never refreshed | Already-upgraded policy recognised first; cache refreshed on success; retry test added |
| 5 | P2 | Refusal envelope unspecified through gate and HTTP | Specified: `error.code` + `error.hint` end to end; manual-recovery line conditional |
| 6 | P2 | Enrol verification needs a descriptor fixture and must require a verified signature | Enrol round-trips the real current descriptors and requires `signature: verified:` |
| 7 | P2 | `git config user.name` can poison the whole trust root | `$USER`/`--principal` validated by regex; whole candidate parsed with stratum's parser before write |

## Codex r2 disposition

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | P1 | Other root paths (admin sudo) share a timestamp; per-command timeout does not cover them | `sudo -k` on every call so this feature never seeds a cache; residual documented honestly (root is the boundary of every guard on the machine); `status` warns when `sudo -n -v` succeeds; README recommends `timestamp_timeout=0` for admins |
| 2 | P1 | Signer environment caller-influenced (`PATH`, `TMPDIR`) | Signer pins `PATH`, calls binaries by absolute path, stages under a root-private 0700 dir |
| 3 | P1 | Root-owned leaf files under a user-writable ancestor; trust root written before verification | All files under `/Library/Compose/guard/`; enrol refuses on any non-root/writable/symlink ancestor; round-trip verified in-process against the root-owned `.pub` BEFORE the trust root is written |
| 4 | P1 | Inherited `SUDO_ASKPASS`; askpass fallback routes a password through user code | Scrubbed env on every spawn, never `-A`; askpass fallback withdrawn; degraded path is a human-run `compose guard sign` on a tty |
| 5 | P2 | Two-file publication not atomic; lock released before apply | Content-addressed immutable generations + one atomic `current` symlink swap; lock held through `applyUpgrade`; apply uses the resolved generation path |
| 6 | P2 | `sudo -n -l` probe can reject a correct install | Status reports installed / rule / presence separately with `unknown` where it cannot see |
| 7 | P2 | Cancelled Touch ID and headless are indistinguishable; infrastructure failures misreported as declines | Single honest code `signature_not_approved` for both; signer/infrastructure failures are `upgrade_descriptor_unavailable` with detail |

## Codex r3 disposition (fixes-only round)

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | P1 | `/etc` is a symlink → the ancestry rule refuses `/private/etc/pam.d/sudo_local` and `/etc/sudoers.d/…` | Install and validate via `/private/etc/...` |
| 2 | P1 | `.pub` inside a 0700 directory is unreadable → round trip and status blocked | `guard/` is 0755 with `sign` + `.pub`; the private key and staging live in `guard/private/` (0700) |

Both are layout fixes with no mechanism change; applied without a further round (review-loop budget:
trivial fixes need no re-review). **Design gate: CLEAN at r3 + fixes.**

## Open questions — resolved

1. Enrolment without a stratum release — **decided above**.
2. Headless / CI — refuse with `upgrade_descriptor_unavailable` and the `compose guard enrol` hint.
3. `guard override` and `guard migrate` — not in v1; the custody `sign({namespace})` call takes the
   namespace as a parameter and the signer script accepts it, so those verbs plug in with a one-line
   change each.
4. Test strategy — **decided:**
   - Golden flow (extends `test/lifecycle-backfill.test.js`'s harness: real stratum copy, temp `HOME`,
     test custody): register a legacy feature → backfill → the gate signs on demand → applied →
     confirmation log has **exactly one** entry; a second backfill on the same checksum → **zero** new
     entries (fresh pair reused); after the graph changes (new checksum) → exactly one more.
   - Refusal harness: custody reports not-approved → `signature_not_approved`, `current` still points
     at the previous generation and its pair is byte-identical, no staging dir left, guard state
     unchanged; custody `none` → `upgrade_descriptor_unavailable` with the enrol hint; custody
     infrastructure failure → `upgrade_descriptor_unavailable` with detail, never a decline;
     `COMPOSE_GUARD_CUSTODY=test` outside `NODE_ENV=test` → refused at module load; test backend
     `enrol` → refused; retry after upgrade success but before intent persistence → zero prompts,
     `status: 'unchanged'`; two concurrent backfills → one signature, both applied; the legacy flat
     pair is adopted as a generation on first run and never rewritten; the MCP tool's thrown error
     carries reasons and hint on a 422.
   - Contract: `compose guard status` and `compose guard descriptors` output shapes; the sudoers file
     content is a golden fixture checked byte-for-byte; the `sudo` spawn is asserted to use `-k`, the
     absolute signer path, and an environment without `SUDO_ASKPASS`/`SSH_ASKPASS` (the sudo backend is
     exercised against a fake `sudo` on `PATH` that records argv + env and runs the signer script with
     the test seam key); principal regex table; ancestry validator table (root-owned ok; user-owned,
     group-writable, symlink → refuse).
   - Signer script: run as the current user against a temp key with the key overridden via an env only
     the test sets (`COMPOSE_GUARD_SIGN_KEY`, honoured only when not running as root) so its sshsig
     output is verified through the real verifier without sudo (done by hand 2026-09-06: verified
     `SHA256:/Ocu35z0iNhTEEvO3wDeousRLRaVVpbJMQ/uaW7nwEw`); namespace injection refused (exit 64).
   - **Manual checklist** (`manual-check.md`, run once by the owner at ship): `compose guard enrol`
     shows two Touch ID sheets and prints `done`; `compose guard sign` shows one; cancelling the sheet
     yields `signature_not_approved` and leaves `current` and its pair intact; from an SSH session into
     the same Mac, `compose guard sign` yields `signature_not_approved`; two signatures within a minute
     prompt twice (no reuse); `sudo -n -v` fails right after an approved signature (no cache seeded);
     the produced `.sig` verifies through `stratum guard descriptors`.

## Not in scope

- Any mode where compose holds a usable private key without a human confirmation step.
- Hardware custody (FIDO2 `ed25519-sk`, Secure Enclave) — blocked on stratum verifier key types
  (`STRAT-GUARD-SK`).
- Linux backend (`COMP-GUARD-ONE-TAP-2`: same root-key + sudo shape with `SUDO_ASKPASS`).
- Automatic git commit of the descriptor pair.
- Covering `guard override` / `guard migrate` (namespace parameter reserved).

## Gate checkpoint — unproven technical assumptions

1. **`pam_tid` shows the Touch ID sheet for a `sudo` started by a non-tty child of the compose server
   running in the GUI session.** It does for terminal-launched sudo; the non-tty case is what the gate
   needs. Cannot be spiked without the operator (enabling it requires one interactive sudo). It is the
   first manual-checklist item, run by the owner at `compose guard enrol`. If it fails, the gate's
   sign-on-demand degrades to a refusal with the hint to run `compose guard sign` from a terminal
   (sudo's own tty prompt, Touch ID or password); no askpass, no fallback that moves a secret through
   user-owned code. The design's shape does not change; only where the one approval happens does.
2. ~~`visudo -cf` accepts a per-command `Defaults!` line with `timestamp_timeout=0` on macOS's sudo~~
   **Verified 2026-09-06** (`parsed OK`).
3. `sudo -k <command>` on macOS's sudo neither consults nor updates the timestamp (sudo(8) documents
   both). Verified at enrol by the manual-checklist item "`sudo -n -v` fails right after an approved
   signature".

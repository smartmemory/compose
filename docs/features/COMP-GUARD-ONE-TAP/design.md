# COMP-GUARD-ONE-TAP — One-tap guard authorization (design brief)

**Status:** PLANNED (brief only; design gate not yet run)
**Origin:** owner directive 2026-09-06 after shipping COMP-LIFECYCLE-BACKFILL: "no human should ever
have to do any of this, it should be fully automated." Owner chose, from three options, **one tap to
approve, everything else automated** over (a) fully unattended with an agent-held key and (b) keeping
the manual flow with better tooling.

## Related Documents

- Predecessor: [COMP-LIFECYCLE-BACKFILL](../COMP-LIFECYCLE-BACKFILL/report.md) — shipped the signed
  upgrade-descriptor mechanism this feature automates; its README section "Backfilling a completion"
  documents the six manual operator steps this feature deletes.
- Stratum trust root: `stratum/ts/contracts/guard-signers.allowed` (in-source, committed; read from the
  installed tree). Header fixed to printable ASCII in stratum `232aca3` — until then no key could load.
- Stratum authz/descriptors: `stratum/ts/src/guard/descriptors.ts` (sshsig namespace
  `stratum-guard-descriptors`, mode check `0o022`, `STRATUM_GUARD_UPGRADE_DESCRIPTORS`).
- Related memories: guard-cli-auth-hole (override token was agent-mintable), guard-signed-authz.

## The invariant that must survive

An agent must not be able to authorize a change to the guard's own rules. The override token failed
this (agent-mintable over the CLI). The signed descriptor holds it ONLY while the private key is
unusable by any process the agent controls. "Fully unattended" would collapse the signature to
"compose ran", the same trust level the token had; the owner rejected that and accepted one tap.

So: every step is automated EXCEPT the act of producing a signature, which requires a human
confirmation that cannot be scripted from inside the agent's process. Nothing else is manual.

## What the human does

Exactly one thing, when a signature is needed: click **Allow** in a system dialog (or touch a hardware
key). No commands, no files, no passphrase typing in a terminal.

## Mechanism candidates for the tap (design gate decides)

1. **ssh-agent in confirm mode** — key added with `ssh-add -c`; every signing use pops the macOS
   `ssh-askpass` confirm dialog. Standard, no new deps. Risk: `-c` protection is agent-side; verify the
   dialog cannot be auto-accepted by a process with the agent socket (it cannot answer the dialog, but
   check `SSH_ASKPASS` override paths and lock it down). Passphrase-less on disk is acceptable ONLY if the
   agent socket is the sole access path — consider a Keychain-stored passphrase instead.
2. **FIDO2 / security key** (`ssh-keygen -t ed25519-sk`) — touch-to-sign, strongest; requires hardware.
   Support as an option, not the default.
3. **macOS Keychain + Touch ID via a small helper** — best UX, most code, macOS-only. Park unless 1 fails.

## Scope (v1)

- `compose guard init` — generates the key into the chosen custody (1 or 2), enrols the public key in
  the trust root, rebuilds/installs stratum (symlink dev: rebuild dist; registry installs: needs a
  stratum release — see open question 1), verifies the root loads (`guard descriptors` returns the
  fingerprint). Idempotent. Prints nothing the human must act on except "done".
- **Sign on demand inside the gate** — when a backfill (or any future signed-authz path) finds a
  registered legacy resource with no valid descriptor, the gate generates descriptors and requests a
  signature through the custody path (one confirm dialog), then continues. No `upgrade_descriptor_unavailable`
  refusal on a machine with an enrolled key; the refusal remains for headless/agent-only environments.
- `compose guard sign` — the same request, callable explicitly; `compose guard status` shows key custody,
  enrolment, descriptor freshness, signature validity.
- Descriptor + `.sig` committed automatically by the gate's write sequence (they are canonical
  artifacts of the workspace), subject to the completion gate's existing commit discipline.
- Delete the six-step operator section from the README; replace with "run `compose guard init` once".
- Fix the tooling defects hit on 2026-09-06: the trust-root header (done, stratum `232aca3`); the
  verify command in docs put the env var on the wrong process (docs); `compose guard descriptors` should
  itself verify the signature and print a one-line verdict.

## Open questions for the design gate

1. **Enrolment without a stratum release.** The trust root is in-source in stratum by design (git-reviewed,
   not env-settable). For a compose operator that means every new signer requires a stratum commit,
   release and install. Options: keep (strongest, heaviest); a workspace-level trust root committed in
   the compose repo that stratum reads when `STRATUM_GUARD_SIGNERS` points at it (still git-reviewed,
   no release) — but this re-introduces an env-settable path stratum's header explicitly refuses; or a
   stratum-side "additional signers file" whose PATH is itself pinned in the in-source root. Needs the
   stratum owner's call.
2. Headless / CI behaviour: no dialog possible → refuse as today, with a message naming `compose guard init`.
3. Should the tap also cover `guard override` and `guard migrate` (the other signed-authz verbs)? Yes
   in principle; scope v1 to descriptors, design the request path so the others plug in.
4. Test strategy: the dialog cannot be driven in tests. Golden flow uses a test custody backend that
   records "confirmation requested" and signs with the in-test sshsig signer from
   `test/helpers/sshsig-sign.js`; a separate manual checklist covers the real dialog once.

## Not in scope

- Any mode where compose holds a usable private key without a human confirmation step.
- Windows/Linux custody backends beyond ssh-agent confirm mode.

# Codex design review r3 (gpt-6-astra/high, 2026-09-06) — fixes-only round

Reviewed design revision 3. Both findings are layout defects, not mechanism holes; fixed in place
without a further round (see `design.md` §"Codex r3 disposition"). Design gate CLEAN.

1. **P1 — The ancestry rule rejects macOS's `/etc` paths.** The design forbids symlink ancestors for every installed path, but enrollment installs `/etc/pam.d/sudo_local` and `/etc/sudoers.d/compose-guard`. Verified locally: `/etc -> private/etc`. Enrollment therefore refuses before installation.
   **Fix:** Install and validate those files through `/private/etc/...`, retaining the protected-ancestry checks.

2. **P1 — The private directory prevents enrollment from reading the public key.** The design places `signing-key` in root-only directory `/Library/Compose/guard` (0700), while the public key and signer share that directory. The operator cannot read the `.pub` despite its 0644 mode, blocking the required round-trip before trust-root publication and preventing status inspection.
   **Fix:** Make `guard/` root-owned 0755, put the private key in a separate root-owned 0700 subdirectory, and update the signer's key path.

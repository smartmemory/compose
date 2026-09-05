# Codex design review r2 (gpt-6-astra/high, 2026-09-06)

Reviewed design revision 2 (root-owned key + `sudo` + `pam_tid`). All seven findings are dispositioned
in `design.md` §"Codex r2 disposition" and produced revision 3.

1. **P1 — Per-command authentication leaves other root-access paths open (r1 #1 remains open).** The design protects direct signer invocations only. If the operator also has ordinary administrative sudo rights, an agent sharing a valid timestamp can instead run `sudo -n /bin/cat <key>` or invoke the script through a root shell. Timestamp sharing depends on `timestamp_type`: terminal, common parent, or globally. The direct command's zero timeout does not constrain those commands.
   **Fix:** Require and validate an effective sudo policy with no reusable alternative root-access route, or choose custody isolated from the operator's administrative credentials.

2. **P1 — The root script's execution environment remains caller-influenced.** The design specifies unqualified `ssh-keygen`, without a trusted `PATH` or environment contract. Where sudo preserves the caller's path, an agent-supplied executable runs as root during the legitimate approval and can export the key.
   **Fix:** Pin system executables and sanitize the environment inside the protected signer; stage stdin beneath a fixed protected directory, independently of caller `TMPDIR`.

3. **P1 — Root-owned leaf files do not establish an immutable signer or authentic enrollment key.** The design omits ancestor-directory and symlink requirements. On an installation with an operator-writable `/usr/local` ancestor, the agent can replace the signer or public-key pathname. Enrollment then writes the candidate trust root **before** its round-trip verification; a failed round trip leaves the substituted agent-held key trusted.
   **Fix:** Require protected, nonreplaceable path ancestry and authenticate the candidate public key against the protected signer before publishing trust-root changes.

4. **P1 — Askpass reintroduces a reusable secret through a user process.** "Never sets `SUDO_ASKPASS`" does not exclude inherited values: sudo reads the original environment and can select askpass without `-A`. Moreover, the proposed root-owned askpass fallback still executes as the invoking user and returns the password on stdout. An agent can wrap/invoke it, retain one legitimately entered password, and authenticate later signatures without another human approval.
   **Fix:** Remove the password-exporting fallback and enforce the permitted authentication path outside caller-controlled code; environment scrubbing alone cannot constrain direct hostile sudo callers.

5. **P2 — Publication is neither atomic nor locked through consumption (r1 #3 remains open).** The two renames expose new signature/old descriptor bytes; interruption between them permanently breaks the previous pair. The lock also releases before `applyUpgrade`. Stratum independently reads descriptor and signature (`descriptors.ts:193`), so another publication can make an already-approved backfill fail verification.
   **Fix:** Publish immutable descriptor generations through one atomic pointer change and retain the selected generation through verification and application.

6. **P2 — The availability probe can reject a correctly enrolled installation.** The design treats `sudo -n -l` success as rule availability. With normal `listpw` behavior and no usable timestamp, listing requires authentication; `-n` fails despite the signer permission existing. It also cannot establish whether Touch ID is currently available.
   **Fix:** Separate installation validity, permission inspection, and presence availability; represent authentication-required inspection as unknown, not unavailable.

7. **P2 — Cancellation and infrastructure failures receive incorrect refusal codes.** The design maps one stderr substring to `no_presence` and everything else to `declined`. Cancelling a sufficient `pam_tid` authentication can fall through to terminal password authentication, producing that same no-terminal error; missing keys, signer failures, and PAM errors become false human declines.
   **Fix:** Specify distinguishable authentication outcomes, or conservatively report an unknown/unavailable authentication failure when sudo cannot prove cancellation.

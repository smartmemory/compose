# Codex design review r1 (gpt-6-astra/high, 2026-09-06)

Reviewed design revision 1 (data-protection keychain + Swift helper). All seven findings are
dispositioned in `design.md` §"Codex r1 disposition"; finding 1 and the same-day spike together killed
revision 1.

1. **P1 — Keychain reads do not enforce one human approval per signature.** The design releases the seed into a replaceable helper and claims replacement "gains nothing." Under that access model, a replacement can retain the seed during a legitimate approval and sign indefinitely afterward; zeroing is controlled by that same helper. Stratum checks only the resulting signature, with no presence attestation (`sshsig.ts:195`). Furthermore, reuse duration `0` is caller-controlled: Apple documents that a nonzero value can satisfy keychain authentication from a recent device unlock without another prompt.
   **Fix:** Make protected signer identity and key custody part of v1 — either an isolated, nonreplaceable signer or nonexportable hardware signing with enforced per-operation presence — and test malicious callers, not just the honest helper.

2. **P1 — Automated enrollment lacks a refusal for agent-held test keys.** The design combines environment-selected test custody with automatic live trust-root enrollment, without forbidding that combination. An agent can set both environment variables; the test signer holds a usable private key (`sshsig-sign.js:47`). Stratum explicitly warns that `NODE_ENV=test` is not a hostile-caller boundary (`trust.ts:26`). Existing golden tests protect the live installation by injecting their key into an isolated copy (`lifecycle-backfill.test.js:73`).
   **Fix:** Refuse test-custody enrollment into the live trust root; keep fixture signer installation exclusively in the isolated test harness.

3. **P2 — Declining approval already overwrites the canonical descriptor.** Step 3 calls unchanged `writeDescriptorFile` before signing, but that function immediately truncates/writes `.compose/guard-upgrades.json` (`guard-descriptors.js:106`). Cancellation therefore violates "write nothing" and can invalidate an existing signed pair. Concurrent backfills also share this file while the completion lock is only per feature (`completion-gate.js:751`).
   **Fix:** Generate and sign staged bytes, preserve the existing pair on refusal, and serialize verified publication/use with a workspace-wide descriptor lock.

4. **P2 — The signing hook can prompt for an already-upgraded policy that regeneration excludes.** `ensureGuard` caches `legacy` (`lifecycle-guard.js:403`), and successful `applyBackfillUpgrade` does not refresh that cache (`lifecycle-guard.js:485`). If upgrade succeeds but the following policy read fails before intent creation, retry enters the hook again (`completion-gate.js:963`). The proposed hook requests coverage for the **new** checksum, while regeneration explicitly excludes policies containing `complete_backfilled` (`guard-descriptors.js:97`). Approval cannot produce the requested descriptor.
   **Fix:** Recognize the expected already-upgraded policy before signing, refresh the registration cache, and test retry after upgrade success but before intent persistence.

5. **P2 — Refusal propagation is unspecified at the boundary that currently adds manual recovery instructions.** The design assigns `signature_declined` and an enrollment hint, but the completion gate always returns `refusedAt: 'upgrade'`, copies only `u.error` and reasons, and appends "re-sign … and commit both files" (`completion-gate.js:964`). The HTTP adapter likewise omits a top-level hint (`vision-routes.js:663`). Merely adding the signing hook does not deliver the specified refusal contract.
   **Fix:** Specify the error-code/hint envelope through custody, upgrade, completion gate, and HTTP, and replace the unconditional manual-recovery message.

6. **P2 — First enrollment cannot perform the specified verification sequence.** The enrollment sequence asks `guard descriptors` for `allowed_signers` without creating a descriptor fixture. That inspector first requires an absolute descriptor environment path and a readable file (`descriptors.ts:247`). Additionally, finding a fingerprint does not verify the helper's sshsig output: the inspector returns `allowed_signers` even when signature verification fails (`descriptors.ts:253`).
   **Fix:** Define an isolated enrollment round-trip fixture, pass its path to the verifier, require a verified signature, and specify how that signing step fits the enrollment prompt contract.

7. **P2 — Using `git config user.name` verbatim can disable every signer.** The chosen principal source permits ordinary names such as `Jane Doe`. Stratum splits on whitespace and interprets the second token as the key type; it also rejects non-ASCII names (`sshsig.ts:246`). One malformed appended line makes the entire trust root unavailable (`trust.ts:73`).
   **Fix:** Derive a validated ASCII principal token and validate the complete candidate trust root before replacing or rebuilding it.

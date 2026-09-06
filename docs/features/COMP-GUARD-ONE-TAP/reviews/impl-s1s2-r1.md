# Codex implementation review — S1+S2, round 1 (`9ec05b86ba57`, gpt-5.6-terra/high, 2026-09-06)

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | P2 | `adoptLegacyFlatPair` makes a copied legacy pair `current` without verifying it; a corrupt committed pair becomes a persistent refusal on first use. | **Fix.** Verify in staging before publishing; unverifiable pair is not adopted and `current` is untouched. |
| 2 | P2 | Resolved generation paths (`current` target, existing `<sha>/`) are not constrained to the generations dir; a symlinked `<sha>/` could redirect the `.sig` write and `current` outside the workspace. | **Fix.** Containment check on realpaths, refuse symlinked `<sha>/`, require `sha256(bytes) == <sha>` for `current`, prune never follows symlinks. Note: the signature is always over in-process enumerated bytes, so this is storage hardening, not a signing-authority hole. |
| 3 | P2 | `writeDescriptorFile` still exported and reachable from `compose guard descriptors`; truncates the flat file before signing. | **Deferred to S3 (T3.3)** — accepted S1 deviation; the only caller (`bin/compose.js:1226`) is replaced by `runGuardDescriptors`, and the export + its test row are removed in the same slice. |

Fixes dispatched to a Sonnet agent (brief-bounded: two functions, enumerated tests). Round 2 reviews the fixes only.

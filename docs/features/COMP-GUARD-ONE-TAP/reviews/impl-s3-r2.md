# Codex implementation review — S3, round 2 fixes-only (`443411380c02`, gpt-5.6-terra/high, 2026-09-06)

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | P2 | `exists()` uses `realpath`, so a dangling `descriptors.json.sig` symlink counts as absent: the existing-unsigned branch, `prepareUnsignedCandidate` and adoption all skip the "has a .sig" refusal, and a signature could be written through the symlink. | **Fix.** `lstat`-based `.sig` presence; a symlinked `.sig` is refused. |
| 2 | P2 | `installScript()` (now reads the signer) and `emit()` sit outside `runEnrol`'s refusal handling; failures reject instead of returning the envelope (no spawn reached). | **Fix.** try/catch → refusal envelope before any spawn. |
| 3 | P3 | The non-sudo backend test passes no emitter (satisfied by the earlier refusal); the heredoc test checks only substrings. | **Fix** (tests only). |

Round budget reached: no further Codex round after these fixes; they are verified locally by targeted suites.

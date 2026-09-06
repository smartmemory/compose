# Codex implementation review — S3 + r2-fix verification, round 1 (`7d30c133b9b3`, gpt-5.6-terra/high, 2026-09-06)

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | P1 | `runEnrol` defaults `deps.emit` to a no-op: an in-process caller can reach `sudo -k /bin/sh -s` with no plan shown. | **Fix.** Emitter mandatory; refuse before any spawn/fs when absent. |
| 2 | P1 | `installScript` interpolates the runtime `PACKAGED_SIGNER` path unquoted into the root shell (space/`;` in the install path = injection). | **Fix.** No path in the root script: embed the signer bytes via a quoted heredoc (also puts the installed signer content into the printed plan). |
| 3 | P2 | `descriptors` under custody `none` swallows every `ensure` refusal (incl. "signature does not verify") and hands the operator a sign command over an existing bad `.sig`. | **Fix.** Manual fallback only on the no-custody refusal; `prepareUnsignedCandidate` refuses when a `.sig` exists. |
| 4 | P2 | Adoption's pre-existing `<sha>/` branch checks the dir but not file/sig containment. | **Fix.** Same file+sig realpath containment as `currentGeneration`. |
| 5 | P2 | Containment root is `realpath(.compose/guard-upgrades)`; a symlinked generations dir escapes the workspace wholesale. | **Fix.** lstat-refuse a symlinked generations dir; require its realpath under `realpath(workspaceRoot)`. |

Fixes split across the two existing Sonnet agents (enrol/cli vs descriptors). Round 2 = fixes-only, then stop (budget).

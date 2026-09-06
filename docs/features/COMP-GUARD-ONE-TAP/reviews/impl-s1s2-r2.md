# Codex implementation review — S1+S2, round 2 fixes-only (`551891f6187c`, gpt-5.6-terra/high, 2026-09-06)

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | P2 | `adoptLegacyFlatPair`: when `<sha>/` already exists, the verified staging copy is discarded and `current` is set to the pre-existing dir without verifying it. | **Fix.** Verify the existing target before `setCurrent`; if it does not verify → `{ adopted:false, reason }`, `current` untouched. Test: corrupt pre-existing `<sha>/` + valid legacy pair. |
| 2 | P2 | Containment checks only the generation dir; `descriptors.json`/`.sig` realpaths and the rename-race recovery path are unchecked, so a file-level symlink or a swapped `<sha>` symlink can escape. | **Fix.** `assertContained` on the realpath of file and sig everywhere a generation is resolved (`currentGeneration`, existing-target branch, race recovery); race recovery re-runs `lstat` + containment before re-verifying. Tests: file-level symlink outside; race that lands a symlinked `<sha>/`. |

Round budget: this is the last fixes round for S1+S2; verification of these two fixes is folded into the S3 review scope.

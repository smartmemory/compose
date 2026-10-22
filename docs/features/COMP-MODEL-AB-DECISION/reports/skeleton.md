# COMP-MODEL-AB-DECISION G5: walking skeleton readout (stage `debug`)

Run 2026-10-22 19:2x to 2026-10-23 00:07 (local). Spec `experiments/skeleton-debug.json` (Claude-only variant `skeleton-debug-claude.json`, same `id`, same run dir; driver `experiments/run-skeleton.mjs`). Records: `experiments/skeleton-debug-exp/runs/*`, `experiments/registry.json`.

## What ran
9 live stage runs (3 candidates x 3 reps, parallelism 1) on the notes-server fixture with the one planted bug. Within the approved budget (`maxRuns 9`, 900 s per run, 9M tokens, no USD cap). Total run wall time 11.9 min (sum of `wallMs`), total receipts-derived USD 4.16.

| Cell | reps | accuracy | usd per run | wallMs per run | admitted |
|---|---|---|---|---|---|
| claude::fast, sonnet-5-5/medium (reference) | 3 | 1, 1, 1 | 0.89, 0.47, 0.41 | 44066, 48517, 56945 | 3 of 3 |
| claude::standard, opus-5-5/medium | 3 | 1, 1, 1 | 0.94, 0.33, 0.35 | 58078, 50624, 43069 | 3 of 3 |
| codex::standard, gpt-6.1-sol/high | 3 | 1, 1, 1 | 0.13, 0.51, 0.12 | 114586, 170551, 128547 | 1 of 3 |

One matrix cell in the registry: key `debug|<provider>|<modelID>|<effort>|none`, with `accuracies`, `sourceRunIds`, a state (`measured` or `triaged`) and, for each non-champion cell, an `uplift` block (delta, 95% bootstrap interval, seed, resamples) bound to the champion row.

## Findings
1. **Standing flag 4 FAILS: every cell is all-1.** All nine runs scored accuracy 1 (hidden repro and 16-test suite pass). Uplift of opus over sonnet is `delta 0`. The near-binary oracle did not separate the models, as the plan warned it might. Not tuned; reported as is.
2. **Codex cell is `triaged`, not `measured`.** Codex reps 1 and 2 are not admitted: `mechanismEngaged` is false (the repro marker is in neither the transcript nor the workspace test log), though the oracle itself passed. Only rep 3 is admitted, so the registry row is `triaged` with `accuracies [1]` and no uplift (null with reason). Whether Codex did not run the repro or its transcript lacks the marker is unverified.
3. **Opus arm needed a stratum fix.** First attempt: 0 of 3 completed, API 400 "Claude Code 2.1.206 does not support this model" (stratum pinned agent-sdk 0.3.206). STRAT-SDK-BUMP-1 (`f6b36d9`, on stratum origin/main) moved it to 0.3.308 and the 3 runs were rerun with `--rerun failed`. The failed attempts consumed no tokens.
4. **Token receipts are not comparable across providers.** Opus runs record `tokensIn 10` (cache-dominated reads are evidently not counted as input), sonnet 17-20K, codex 255-882K. USD is receipts-derived and is the comparable column. Unverified: how `usdSource` is set per provider.
5. **The shipped `bug-fix.stratum.yaml` step `fix` is literal `claude` with effort unpinned**, so the sonnet/medium reference arm is not exactly what a real build runs.
6. **Whole-build cost: no data.** `.compose/data/build-history.jsonl` has 16 rows and none has status completed (15 failed or killed, 1 aborted), so no completed whole-build cost exists to compare (source: that file, n=16).
7. **Budget meter:** 9 of 9 runs dispatched, tokens under the 9M cap by the per-run assumption (9 x 1M = 9M at most, actual receipts far lower), no `BUDGET_STOP`.
8. **Leak gate:** after the runs `git status` in compose shows only the new untracked `experiments/`; the worktree count is 6 and no worktree HEAD was touched by me. The Codex runs ran in workspace copies. No before/after snapshot of the Codex arm's host state was taken beyond this check (unverified for files outside the repo).

## Decision needed from the owner (via s2-coord)
Whether to fan out (G6-G8 etc.) while the debug oracle gives all-1, or first make the stage discriminate (harder planted bug or more reps). Nothing further runs until the owner decides.

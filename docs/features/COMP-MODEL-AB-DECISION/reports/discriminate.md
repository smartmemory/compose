# COMP-MODEL-AB-DECISION: discrimination re-run readout (stage `debug`, harder planted bug)

Run 2026-10-23 to 2026-10-24 (local). Specs `experiments/discriminate-debug-claude.json` and `experiments/discriminate-debug-codex.json` (same `id`, run dir `experiments/discriminate-debug-exp/`), driver `experiments/run-discriminate.mjs`, registry `experiments/registry-discriminate.json`. Owner approved the 15-run run (5 reps x 3 models, about $14, this run only). Code under test: compose local main `3258bcb8` (COMP-STAGE-TRANSCRIPT-1, COMP-STAGE-DEBUG-HARDER-1 with `ORACLE_VERSION` 2, COMP-GOLDEN-LEAK-RACE-1). Follow-up to `reports/skeleton.md`.

## Lead finding: every one of the 15 runs failed the same check, so that check is not separating models
`tag-normalized` failed in 15 of 15 runs (`results.json`, `detail.failed` per run record). It is the two hidden tests in `test/fixtures/stage-grading/hidden/debug/suite/tag-filter.test.js:51` and `:58`: after `update` and after `importNotes` each tag is stored once, trimmed and lower-case (expected `['boats', 'travel']`, `['fun']`). The offline gold patch scores 1.0 (`test/archetype-debug.test.js`), so the check is reachable. The best any model scored is .875 (7 of 8 checks).

Meaning for the owner's decision: a check that every model fails is a check or hint problem (is the requirement discoverable from the repo and the repro?), not a model separator. **Cause of the shared miss is unverified**: I did not read the 15 diffs against the hidden assertions, so I cannot say whether the models missed the `update`/`import` normalisation, the dedupe, or the expected ordering. Reading `diff.patch` in each run record against those two tests would answer it, at no cost.

## Results (accuracy = hidden checks passed / 8)
| Cell | reps | accuracy per rep | median | mean | failed checks | usd per run |
|---|---|---|---|---|---|---|
| opus-5-5/medium (`claude::standard`) | 5 | .875 x5 | .875 | .875 | tag-normalized 5/5 | 1.13, 0.60, 0.45, 0.51, 0.48 |
| sonnet-5-5/medium (`claude::fast`) | 5 | .75, .875, .875, .875, .75 | .875 | .825 | tag-normalized 5/5, tag-filter-written 2/5 | 0.48, 0.17, 0.20, 0.17, 0.16 |
| gpt-6.1-sol/high (`codex::standard`) | 5 | .625, .875, .75, .625, .75 | .75 | .725 | tag-normalized 5/5, tag-filter-written 3/5, hygiene 2/5 | 0.36, 0.16, 0.14, 0.34, 0.18 |

Order by mean: opus .875, sonnet .825, codex .725. Before this run all nine G5 runs scored 1, so the stage no longer sits at the ceiling.

## Caveats
1. **n = 5 per cell.** No interval was computed here; the differences are small and not shown to be significant.
2. **Opus and sonnet tie on the median (.875).** The gap is in the mean, driven by two sonnet reps that also missed `tag-filter-written`.
3. **Ceiling .875.** The shared `tag-normalized` miss caps every cell at 7 of 8, which compresses the range and hides any difference on that check.
4. Token receipts are still not comparable across providers (`skeleton.md` finding 4); usd is receipts-derived.
5. Codex rep4's first attempt ended on a transport error (`MCP error -32603 ... Connection refused (os error 61)`, `run.log`), no score. It was re-run once; the first attempt's $0.54 is counted in spend.

## Spend
Claude arms $4.34 (sonnet 1.18, opus 3.17). Codex arm $1.19 for the five completed runs plus $0.54 for the failed rep4 attempt = $1.73. Total $6.07 of the approved ~$14. Ledger lines 2026-10-23 and 2026-10-24 (`forge-main:`).

## Transcript capture (COMP-STAGE-TRANSCRIPT-1)
`mechanismEngaged` is true and `transcript.jsonl` is non-empty on every completed run, Claude (10 of 10) and Codex (5 of 5). This closes the G5 gap where Codex reps 1 and 2 read false: the stage runner now records the tool events for both providers.

## Not done / needs the owner
- A re-run with the `tag-normalized` check softened or a hint-level change is paid and NOT approved (owner ruling 2026-10-23: only this 15-run run).
- The run records and this report are in compose local commits `fa90ab3d` and `d2ef084f`. They are not pushed: the pre-push gate is red on clean origin/main (4 files, `COMP-GATE-RED-ON-MAIN-1`).

## ELI5 TLDR
The harder bug stopped every model from getting a perfect score, and it now ranks them: Opus first, Sonnet close behind, Codex last. But all fifteen runs failed the same one check, so no model is better than the others at it, and that check (or the hint for it) is what the owner should look at before paying for another round. The numbers are five runs per model, so treat the ranking as a hint, not a verdict. Decision: change that check or hint and re-run (paid), or accept these results.

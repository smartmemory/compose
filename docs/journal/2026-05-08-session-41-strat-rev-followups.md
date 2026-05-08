# Session 41: STRAT-REV follow-ups + the doctor JSON bug

**Date:** 2026-05-08
**Feature:** STRAT-REV / STRAT-REV-FU-1, FU-2, FU-3 + COMP-DEPS-DOCTOR-JSON

## What happened

The day started innocuously: a `/roadmap` walk, then a request to build STRAT-REV-7 (cross-model adversarial synthesis). The exploration agents came back with a finding we'd already gotten earlier in the day for STRAT-PAR — the work had already shipped, and the archive entry was stale. Same drift, same root cause: rows that ship under a different ticket on the same day never get closed in their original section.

But the audit *did* surface three real refinements to the cross-model machinery:

- **FU-1.** The original design called for `>200 lines = large` to trigger cross-model review. The shipped impl gates only on file count (`≥9 files`). A 200-line single-file mega-refactor was under-classified as `small` and skipped cross-model review entirely.
- **FU-2.** Findings flagged by both Claude and Codex were treated identically to single-model findings. Two independent models agreeing is materially stronger evidence — but the result shape carried no signal for it.
- **FU-3.** The synthesis-failure fallback path could silently drop findings: if the caller's fallback array had `confidence < applied_gate`, the gate filter would suppress them. Already hit once in production (`codexAsFallback` shipped at 6, gate 7).

We wrote failing tests for each, then implemented:

- `classifyDiffSize(filesChanged, lineCount?)` now takes the larger of file-class and line-class; line-count gate kicks in at ≥200.
- `runCrossModelReview` computes lineCount once via `git diff --shortstat HEAD` and passes it to the gate.
- `promoteConsensusFinding` stamps `consensus: true` and boosts confidence by +2 (capped at 10) on findings present in the consensus array.
- `promoteFallbackConfidence` defensively raises any under-stamped fallback confidence to the gate value.

When asked if we'd run Codex review (we hadn't — that was the bug), Codex came back with two real findings:

- **must-fix.** The `git diff --shortstat` regex required an insertion count. A deletion-only diff (`1 file changed, 250 deletions(-)`) returned 0 instead of 250, and any unexpected shape silently fell to 0 instead of null. Fixed by extracting `parseShortstat` as a pure helper, matching insertions and deletions independently, and returning null on unrecognized shapes (preserves file-count-only fallback).
- **should-fix.** The `200`-line boundary was inconsistent: code said `< 200 ? medium : large` (so exactly 200 = large) but prose said `>200 = large`. Aligned the prose to the code.

Codex re-review wasn't run after the fixes — left as an open thread.

The user then asked us to fix two adjacent issues we'd flagged: T6 (`compose doctor --json` emitting two concatenated JSON objects, breaking `JSON.parse(stdout)`) and the journal entry (the MCP `write_journal_entry` tool was bound to the parent forge root and couldn't find `forge/docs/journal/README.md`).

T6 fix: `printDepReport(json: true)` printed the deps JSON itself, then `runDoctor` printed a *second* `{version: ...}` object. We extracted a pure `buildDepReport()` that returns the data shape, then merged with `versionInfo` into a single top-level JSON object. T6 passes; the change is internal to the `--json` path.

For the journal, the MCP tool is unreachable from the parent forge root because the journal lives under the compose subproject. We wrote this entry by hand, hand-picking session 41 (max prior + 1). Worth filing the MCP-root-binding visibility as a real bug in a follow-up — same root-mismatch class as the vision-state.json issue we found yesterday.

## What we built

- **`lib/review-normalize.js`** — `promoteConsensusFinding` (CONSENSUS_BOOST=2, MAX_CONFIDENCE=10, stamps `consensus:true`) and `promoteFallbackConfidence` (raise under-stamped fallback confidence to applied_gate). Consensus pipeline now `map(normalize) → filter(gate) → map(promoteConsensus)`. Fallback branch wraps caller arrays through `promoteFallbackConfidence`.
- **`lib/review-lenses.js`** — `classifyDiffSize(filesChanged, lineCount?)` and `shouldRunCrossModel(filesChanged, lineCount?)` accept optional line count. Larger of file-class and line-class wins. JSDoc rewritten to document both gates.
- **`lib/build.js`** — exported `parseShortstat(stdout)` pure helper (handles insertions-only, deletions-only, mixed, empty stdout, and unknown shapes). `computeChangedLineCount(cwd)` now delegates to `parseShortstat`. `runCrossModelReview` computes lineCount once and passes it to `shouldRunCrossModel`; emits lineCount on the `cross_model_review` start event.
- **`lib/deps.js`** — extracted pure `buildDepReport(result)` returning `{present, missing, scannedPaths}`. `printDepReport(opts.json)` now delegates.
- **`bin/compose.js`** — `runDoctor` (`--json` branch) builds a single top-level JSON document combining the dep report and the version block, fixes T6.
- **`test/cross-model-review.test.js`** — 6 new tests (FU-2: consensus stamp, +2 boost with cap, merge passthrough; FU-3: fallback promotion + sanity guard that parsed sub-gate findings still drop).
- **`test/review-lenses.test.js`** — 7 new dual-gate tests + 5 new `parseShortstat` regression tests (mixed, insertions-only, deletions-only, empty, unknown-shape).
- **`ROADMAP.md`** — STRAT-REV section flipped COMPLETE; STRAT-REV-FU-1/2/3 rows added; standalone tickets STRAT-MCP-CHUNK-SIZE / STRAT-COMPOSE-CODEX-COMPANION / COMP-CODEISLAND-BRIDGE promoted from breadcrumbs into the active roadmap.
- **`CHANGELOG.md`** — 2026-05-08 entry covering all three follow-ups + the T6 fix.

## What we learned

1. **The "stale archive entry" pattern is recurring.** Two reconciliations in two days surfaced the same drift class: a feature ships under ticket B, B is closed, but the original A-row stays PLANNED. The fix is process: when shipping under a different ticket, update *both* rows in the same commit. Worth a checklist item in the ship phase.
2. **Codex review on small invariant changes is high-yield.** We thought the FU-1/2/3 changeset was straightforward. Codex found a deletion-only regex bug and a boundary off-by-one in five minutes. The protocol of "always run Codex review before claiming done" needs to be more reflexive — we got pulled forward by the user being satisfied with the test green and skipped it. The user catching us was the safety net.
3. **MCP tools that resolve project root from cwd are surprising.** Two MCPs got bound to different roots in the same session: `compose__write_journal_entry` to `forge/`, the dev server we started to `forge/compose/`. There's no UI or CLI surface that tells you which root a given MCP tool will use. This is the kind of pre-cognitive trip wire that costs 20 minutes the first time and 0 after — but only after.
4. **Pure-helper extraction enables tests we wouldn't otherwise write.** `parseShortstat` and `buildDepReport` weren't strictly necessary as exports — both could have stayed inline. Pulling them out let us test the bug Codex found with five precise unit tests that don't shell out, and let `runDoctor` build a coherent JSON document instead of stringing together two `console.log` calls. Two small extractions with non-obvious downstream value.
5. **TDD on regression-style invariants pays compound interest.** FU-3 alone is 31 lines of code (one helper, one wrap call). The two tests are the spec for what "fallback path is safe" actually means in this codebase. Six months from now, when someone changes how `claudeFindingsFallback` is built, the tests will catch the next variant of the same bug.

## Open threads

- [ ] Re-run Codex review on the post-fix diff to confirm REVIEW CLEAN (didn't re-execute after the must-fix and should-fix were addressed).
- [ ] File the MCP-root-binding visibility ticket — both `compose__write_journal_entry` and `compose__get_vision_items` failed silently or invisibly today because they read a different project root than the user expected.
- [ ] Walk the `compose/docs/e2e-checklist.md` UI smoke pass (carried over from the morning).
- [ ] Wire UI highlighting for `consensus: true` findings in the cockpit `ContextStepDetail` / `ItemDetailPanel` (FU-2 only stamps the flag; the renderer hasn't picked it up yet).
- [ ] Decide whether `medium-files + medium-lines` should also trigger cross-model when lineCount is borderline (e.g. ≥150). Current rule says no.
- [ ] Commit and push.

*Three small invariants are sometimes worth more than one new feature.*

# 2026-05-02 — Session 33: Making pipeline-cli spec-aware (COMP-NEW-QUESTIONNAIRE-MISMATCH)

## What happened

Last session restored `pipelines/new.stratum.yaml` and Codex review surfaced one more thing we deferred: when the kickoff questionnaire asks "Who should review the brainstorm?", the choices "Codex (automated review)" and "Skip review" do nothing useful. `bin/compose.js:577-584` applies them by calling `pipelineSet(cwd, 'review_gate', ['--mode', 'review'])` and `pipelineDisable(cwd, ['review_gate'])` — but the helpers in `lib/pipeline-cli.js` hardcode `build.stratum.yaml` and `spec.flows.build`. The questionnaire was mutating the wrong file.

The mutation almost always silently failed (`review_gate` doesn't exist in the build pipeline today), and the call was wrapped in `try/catch` so the failure was invisible. If `review_gate` had ever existed in the build pipeline, the questionnaire would have started silently mutating it instead of the kickoff pipeline — a worse failure mode. Either way, the kickoff `review_gate` was unaffected by the questionnaire answer, despite the UI saying it would be.

The fix is mechanical. Six public exports of `lib/pipeline-cli.js` (`pipelineShow`, `pipelineSet`, `pipelineAdd`, `pipelineRemove`, `pipelineEnable`, `pipelineDisable`) gain an optional trailing `specName` parameter defaulting to `'build.stratum.yaml'`. `loadSpec` derives the flow name from the filename (`<name>.stratum.yaml` → `<name>`) and returns it; every `spec.flows?.build` reference becomes `spec.flows?.[flowName]`. Two callers in `bin/compose.js` pass `'new.stratum.yaml'` from the questionnaire branch.

We deliberately did *not* expose a `--spec` flag on the user-facing `compose pipeline ...` CLI. The literal bug is "questionnaire targets wrong file" — fixing that doesn't require letting users edit other specs interactively. Filing a follow-up only when somebody actually asks.

Codex came back REVIEW CLEAN on iteration 1. Full Node test suite (1993/1993) stayed green. Four new unit tests cover: default path unchanged, `pipelineDisable` targets the kickoff spec when `specName` is passed (and leaves build untouched), `pipelineSet --mode review` against a kickoff gate step produces a codex sub-flow, missing spec throws cleanly.

## What we built

**Changed:**
- `compose/lib/pipeline-cli.js` — `loadSpec` now takes `specName` and returns `flowName`; six public exports take optional trailing `specName`; six `spec.flows?.build` lookups switched to `spec.flows?.[flowName]`; error messages use `<flowName> flow` instead of `"build" flow`.
- `compose/bin/compose.js:577-584` — questionnaire path passes `'new.stratum.yaml'` to `pipelineSet` and `pipelineDisable`; catch comments updated.

**Added:**
- `compose/test/pipeline-cli-spec-target.test.js` — 4 tests, all pass.

**Doc updates:**
- `compose/CHANGELOG.md` — 2026-05-02 entry.
- `/Users/ruze/reg/my/forge/ROADMAP.md` — flipped `COMP-NEW-QUESTIONNAIRE-MISMATCH` to COMPLETE.

## What we learned

1. **`try/catch` around an undocumented invariant is a bug-hider.** The questionnaire branch wrapped both calls in `try { ... } catch { /* gate may not exist in new.stratum.yaml */ }`. The comment claimed to handle a known absence, but the actual failure was "wrong file entirely." A try/catch that says "this is fine if it fails" silently absorbs every other failure too.

2. **Helper functions that hardcode a target tend to grow callers that lie about what they do.** `pipelineSet`/`pipelineDisable` had no parameter for *which* spec — but that didn't stop the questionnaire from calling them as if they did. The fix is to make the parameter explicit, which forces every caller to declare its intent.

3. **Deriving the flow name from the filename is a convention worth lowering into the helper.** Both shipped specs use `<flow>.stratum.yaml`. Encoding that in `loadSpec` keeps callers thin and prevents drift between filename and flow name.

4. **Narrow scope held even when wider was tempting.** We could have shipped `compose pipeline --spec` while we were in there. We didn't, because that's a user-facing surface change with its own considerations (UX, docs, examples) and the literal bug is solvable without it.

## Open threads

- [ ] If a user ever wants to edit the kickoff pipeline by hand from the CLI, generalize `compose pipeline ...` to take `--spec`. Trivial extension of this change.

A flag that says "this might fail" almost always misses what's actually failing.

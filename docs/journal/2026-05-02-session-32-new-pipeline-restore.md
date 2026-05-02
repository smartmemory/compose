# 2026-05-02 — Session 32: Restoring the kickoff pipeline (COMP-NEW-PIPELINE-MISSING)

## What happened

Yesterday's COMP-DOCS-FACTS doc-correction round filed a real-bug ticket: `pipelines/new.stratum.yaml` is referenced by `bin/compose.js:387,551` and `lib/new.js:62`, but the file isn't in the shipped package. `compose new` would fail at runtime with "Kickoff spec not found." We didn't notice because `compose init` silently skips the copy when the package source is missing — the failure mode hid behind an existence check.

Today we cashed it in.

The first interesting moment was `git log --all --diff-filter=D -- pipelines/new.stratum.yaml`: the file was deleted on 2026-03-16 in commit `e597e89`, the COMP-UX-1 cockpit batch commit. That commit is about graph layouts, ops strips, and context panels — it has nothing to do with kickoff pipelines. The deletion was almost certainly unintentional, bundled into a 30-file batch. Six weeks of kickoff-broken without anyone noticing tells us something about how often `compose new` actually gets run against fresh projects.

We restored verbatim with `git checkout e597e89^ -- pipelines/new.stratum.yaml`, then ran the verification path: validate against current Stratum (post-`validate`-strip, mirroring how `lib/new.js` sends the spec), then `stratum_plan` to confirm all 6 steps resolve. Both passed. The file's structure is fundamentally compatible with current code.

Then we ran a Codex review of the restored file. It flagged three things — and only one of them was actually about restoration. The other two were latent bugs that had existed in the file the whole time:

1. **`brainstorm` doesn't handle research being skipped.** The questionnaire can disable research (`bin/compose.js:573` injects `skip_if: "true"` into the spec). When skipped, `$.steps.research.output.summary` resolves to `null` and `docs/discovery/research.md` doesn't exist, but the brainstorm intent unconditionally said "First read `docs/discovery/research.md`." This means `compose new --auto` and the no-research questionnaire path would always hit a confused brainstorm step that's looking for a file that isn't there.
2. **`scaffold`'s validate is misaimed.** The step had `validate.artifact: ROADMAP.md` with the criterion "At least one `docs/features/<CODE>/design.md` exists." But `lib/step-validator.js` reads only the named artifact — it can't enumerate the file system. The validator has been silently passing for as long as this file has existed, regardless of whether scaffold actually scaffolded anything.
3. **The questionnaire's review-agent choice doesn't reach kickoff.** `bin/compose.js:577` applies the choice via `pipelineSet`/`pipelineDisable`, but `lib/pipeline-cli.js:21` shows those helpers only edit `build.stratum.yaml`. The kickoff pipeline's `review_gate` is unaffected. This is a code bug, not a pipeline bug — filed separately as `COMP-NEW-QUESTIONNAIRE-MISMATCH`.

We took the wide path on #1 and #2 because the whole point of this ticket was making `compose new` work, and shipping a "fix" that still left `--auto` broken at the second step would have delivered nothing. Both fixes were small. #3 is for next time.

The brainstorm fix is text-only: rewrite the intent to be conditional ("If `docs/discovery/research.md` exists, read it; otherwise proceed from the product intent alone") and annotate the research input as may-be-null. Robust to both questionnaire paths without forking the pipeline.

The scaffold fix is structural: drop the `validate` block (it can't do what it claimed), add `ensure: - "len(result.created) > 0"`. The `ScaffoldResult` contract already had a `created: array` field; we just hadn't been checking it. Now if scaffold reports zero files, the step fails its postcondition and the recovery loop kicks in.

Codex's iteration-2 review came back REVIEW CLEAN. Total work: one git checkout, two text edits, one CHANGELOG entry, one journal entry. The smallest "this fixes a 6-week-old shipping bug" PR I've written.

## What we built

**Restored:**
- `compose/pipelines/new.stratum.yaml` — pulled from `e597e89^`.

**Fixed inline:**
- `pipelines/new.stratum.yaml` brainstorm step — intent rewritten for optional research; research input annotated.
- `pipelines/new.stratum.yaml` scaffold step — `validate` dropped, `ensure: - "len(result.created) > 0"` added.

**Doc updates:**
- `compose/docs/cli.md` — dropped "currently absent" note from `compose new`.
- `compose/docs/pipelines.md` — dropped both "absent" notes (kickoff section + Pipeline Specs table).
- `compose/CHANGELOG.md` — entry under 2026-05-02.
- `/Users/ruze/reg/my/forge/ROADMAP.md` — flipped `COMP-NEW-PIPELINE-MISSING` to COMPLETE; added `COMP-NEW-QUESTIONNAIRE-MISMATCH` row.

## What we learned

1. **A failure-mode that's invisible is a failure-mode that survives.** Six weeks of broken `compose new` because (a) the source file was missing, (b) `compose init` skips silently when the source is missing, and (c) the runtime error only fires *after* you try to use the broken thing. Three layers of "no signal" stacked.

2. **Restoration from git history beats reconstruction.** We considered rewriting the kickoff spec from scratch using `docs/pipelines.md` as a template. We didn't, because the deleted file had previously worked with the current code and "what worked" is much more useful than "what we think should work" as a starting point. The Codex review then flagged the *real* bugs — both pre-existing, neither caused by the restoration — and we fixed those too.

3. **"Restore" wasn't enough.** If we'd only restored the file (the literal scope), we would have shipped a `compose new` that errored on the `--auto` path — fixing one bug, leaving another. The user's "wide" call was right: when the goal is "make X work," shipping a fix that doesn't make X work is worse than not fixing.

4. **Validators that read one artifact can only check that artifact.** The scaffold step's `validate.artifact: ROADMAP.md` with a criterion about feature folders had been silently green for the entire history of the file. Lesson generalized: every validate criterion has to be answerable from inside the artifact it points at. If you need to verify something else, you need an `ensure` against the agent's structured output (or a different mechanism entirely).

## Open threads

- [ ] `COMP-NEW-QUESTIONNAIRE-MISMATCH` — make `pipelineSet`/`pipelineDisable` target-spec aware, or write a kickoff-specific path
- [ ] Consider an integration test for `compose new` — even a fast smoke test that validates `pipelines/new.stratum.yaml` and runs `stratum_plan` against it would have caught this restoration-needed state on day one

You can keep doing the obvious thing forever — the trick is having a system that notices when the obvious thing isn't happening.

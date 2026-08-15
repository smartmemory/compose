---
date: 2026-08-15
session_number: 110
slug: retries-that-hide-failures
summary: Two invisible failures — a ship step that self-healed its own contract rejection, and three commands dead for a month — then every stranded spec migrated in the same session
feature_code: COMP-PIPELINE-QUARANTINE
closing_line: Green is not the same as working; it is only the same as nothing having asked.
---

# Session 110 — COMP-PIPELINE-QUARANTINE

**Date:** 2026-08-15
**Feature:** `COMP-PIPELINE-QUARANTINE`

## What happened

The session opened on a resumed flush with four options and the ask was the smallest one: a Compose bug found in passing while shipping STRAT-TS-LEARN. `runGsd` handed `executeShipStep`'s raw return straight to `stepDone`, and engine contracts are strict Zod objects, so `commit`, `filesChanged` and `completionWarning` were rejected as unrecognized keys on every gsd ship. We had inferred that from a type signature; before writing anything we pulled the actual failure text out of a persisted run under `~/.stratum/ts/flows`, and there it was verbatim.

What made it interesting was not the defect but why nobody had ever seen it. The failure healed itself into a lie. Attempt 1 committed and got rejected; attempt 2 re-ran the entire ship step, found nothing left to stage, and returned `{phase, artifact:'no-changes', outcome, summary}` — which passes, because it declares nothing. So the step went green every time, at the cost of running twice (double test run, double `recordCompletion`) and a flow output that had never once carried the `commit_hash`/`files_changed` the pipeline's own docstring asks for. `runBuild` already had the correct narrowing inline at its own `stepDone` site; gsd simply never got it. We extracted `toPhaseResultOutput` as the single seam and kept `plan_items` at the `runBuild` call site, because build's contract declares it and gsd's does not — folding it into the shared helper would have recreated the identical strict-key failure the moment a ship result carried one.

Pushing that hit a second wall. The pre-push gate ran the full suite and reddened on `build-stream-smoke`, twice. It passed 3/3 in isolation. The test slept 500ms as a stand-in for "the bridge has drained the pre-connection events by now", which holds on an idle machine and breaks under full-suite load — exactly when the gate runs. Rather than bypass a hard gate we made the precondition deterministic. The first attempt failed *worse*: we polled for three broadcasts carrying `featureCode: 'LATE-1'`, and it timed out every time. Probing the bridge directly showed it emits three messages but stamps `build_step_start` with no `featureCode` — which is precisely why the flake had always reported `2 !== 0`. The predicate was unsatisfiable; counting against a baseline fixed it. No assertion was weakened.

With both repos pushed, the ask moved to the pipelines. A validation sweep had shown eight of eleven specs failing, and the runtime seam settled how bad it was: `bug-fix`, `plan`, `build-quick` and `refactor` all fail `stratum_plan` with a bare `-32602: spec validation failed`. STRAT-PY-RETIRE had converted only `build` and `gsd` and deleted the older execution paths; everything else was stranded. Three documented commands — `compose fix`, `compose plan`, `compose build --quick` — had been completely dead for a month. `plan.stratum.yaml` had been edited ten days earlier while already unrunnable.

We stopped and asked rather than picking a scope, because migrate-all-eight and quarantine-only differ by an order of magnitude. The answer was: start with just the bug-fix one. Two assumptions died on contact. `bug-fix` is `version: "0.1"`, not the v0.3 we had assumed — an older `functions:` dialect. And the claim that the cockpit picker was offering broken templates was simply wrong: no shipped spec has an uncommented `metadata:` block, so `loadTemplates` surfaces none of them. The code says so itself, in a comment we had not read.

Then the ask became "fix the rest", and the remaining ten went in the same session.

The five gate-free v0.1 pipelines were mechanical. `plan` needed its gates re-expressed and was verified by walking the backward edge on the engine. `build-quick` looked like the hard one at 421 lines — until diffing the two v0.3 ancestors showed it was *exactly* `build` minus seven steps, with otherwise identical step lists. So it was not converted at all: it was derived from the already-migrated v1 `build` by dropping those steps, which reuses that conversion's reviewed constructs rather than independently guessing a second translation of the same source. A scripted assertion proved no reference to a dropped step survived.

The presets were where the engine taught us things. `team-feature`'s worktree fanout was rejected outright: a consumer worktree fanout requires a following unconditional gate, and the v0.3 preset had none — merging per-task worktree patches had never been a decision point. Then a revise edge turned out to require flow-level `max_rounds`. And `team-review`'s merge step carried `ensure: result.clean == true`, which cannot converge by retry, because re-running a reducer re-merges the same frozen lens outputs; it would have spun to exhaustion and failed the flow with no chance for the code to be fixed in between. That is the exact lesson `build.stratum.yaml` note I1 had already recorded, repeated in a file nobody had run in four months.

The last thing to break was our own doc edit. The v1 preset headers had been rewritten to say `--template team-feature`; `--team` turned out to be a real flag that rewrites to that template and is *mutually exclusive* with `--template`, so the new headers documented a form that conflicts with the flag they replaced. Reverted in a follow-up commit.

## What we built

**Ship-contract fix (`e79fa73`)**
- `lib/build.js` — `toPhaseResultOutput`, the single narrowing seam; `tsShipOutput` now composes it.
- `lib/gsd.js` — narrow before `stepDone`.
- `test/ship-phase-result-contract.test.js` — asserts the helper's key set against field names parsed out of the pipeline YAML rather than hard-coded.

**SSE de-flake (`29fce99`)**
- `test/build-stream-smoke.test.js` — `waitUntil` polling replaces two fixed sleeps; throws on timeout so a genuinely stalled bridge still fails.

**Quarantine + bug-fix revival (`f8bbc82`)**
- `lib/pipeline-compat.js` (new) — compatibility keyed on the spec's own `version` stamp.
- `lib/build.js` — refusal at the single `resolveTemplatePath` seam.
- `server/pipeline-routes.js` — `listSpecFiles` carries `tsCompatible`.
- `pipelines/bug-fix.stratum.yaml` — v0.1 to v1.
- `test/pipeline-ts-engine-guard.test.js` (new) — iterates the directories, enforces both directions.

**The remaining ten (`a9114c2`, `6088e1e`)**
- `pipelines/{refactor,content,review-fix,research,coverage-sweep,plan,build-quick}.stratum.yaml` — all v1.
- `presets/{team-feature,team-research,team-review}.stratum.yaml` — all v1, plus four new `.profiles.json` sidecars carrying the agent profile strings v1 strips.
- `test/{build-quick,pipeline-model,roadmap-plan-golden}.test.js` — assertions re-expressed in v1 terms; dialect fixtures inlined.
- `docs/pipelines.md`, `docs/cli.md` — status column dropped, unavailability notes removed.

## What we learned

1. **A self-healing retry is a failure detector that has been disabled.** The ship step failed its contract on every run for months and nothing noticed, because the retry landed in a shape that asserts nothing. The symptoms are worth naming: a step whose attempt count is always 2, doubled side effects, and a flow output that never carries its optional fields.

2. **Coverage that names files cannot notice a file rotting.** The only pipeline tests named `build` and `gsd` explicitly, so nine specs became unrunnable with every suite green. The fix is not more tests, it is tests that iterate the directory.

3. **Never use a shipped artifact as a test's dialect fixture.** This bit three times. `pipeline-model.test.js` used `research.stratum.yaml` as its v0.1 example, so migrating it would have silently retired coverage of a branch still needed for workspaces pinning old specs. The guard's own refusal test read a real stranded spec and broke the moment the last one was migrated. A fixture that lives in the repo as production data will be changed by someone who is not thinking about your test.

4. **A reducer must not carry a convergence `ensure`.** Re-running it re-merges the same frozen inputs, so it cannot converge — it spins to exhaustion and fails. The decision belongs in a gate. We had already written this down for `build`; `team-review` proved that writing it down in one file does not protect the others.

5. **Deriving beats converting when a migrated sibling exists.** `build-quick` was the largest and scariest file and took the least judgment, because the diff proved it was a subset. The question "what is this file's relationship to one I have already done?" was worth more than any amount of careful reading.

6. **A strict engine is a teacher.** Three real defects in the v0.3 presets — an ungated worktree merge, a missing loop bound, a non-converging reducer — surfaced only because the v1 engine refused to accept them. They had been latent for months in specs that "worked" in the sense that nobody ran them.

7. **Verify at the seam that fails, not the one that is convenient.** Static validation flagged `build` and `gsd`, which demonstrably run; only planning on the real engine separated real breakage from pre-substitution noise. The same discipline caught our own errors: an unsatisfiable drain predicate, and a doc rewrite that contradicted a real CLI flag.

## Open threads

- [ ] Nothing has been driven through any migrated pipeline with live agent dispatch. Everything is verified at the engine seam (plan, and for bug-fix and plan a full walk); the first real run of each is the live proof.
- [ ] BEHAVIOR CHANGE to announce to anyone using the team presets: `team-feature` now pauses at an `execute_merge` gate and `team-review` ends at a `merge_gate`. Neither existed in v0.3 — the engine requires the first, and the second replaces a reducer ensure that could never converge. Flows that used to sail through now stop and ask.
- [ ] `lib/lifecycle-modes.js`'s `fix` graph omits `bisect` — eight phases listed against a nine-step spec. Informational today (no live guard), deliberately not edited as a side effect of the migration.
- [ ] `lib/bug-bisect.js` is real, tested, and still has no production caller; the spec's prose is its only wiring.
- [ ] The guard's "any non-v1 spec would be refused" test now iterates an empty set. Harmless — the neighbouring assertion that nothing shipped is non-v1 is the one carrying weight — but it is dead code until someone adds a stranded spec.

---

*Green is not the same as working; it is only the same as nothing having asked.*

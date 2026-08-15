---
date: 2026-08-15
session_number: 110
slug: retries-that-hide-failures
summary: "Two invisible failures: a ship step that self-healed its own contract rejection for months, and three documented commands dead for a month with every suite green"
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

With both repos pushed, the ask moved to the pipelines. A validation sweep across `pipelines/` had shown eight of eleven specs failing, and we went looking for how bad it really was. The runtime seam settled it: `bug-fix`, `plan`, `build-quick` and `refactor` all fail `stratum_plan` with a bare `-32602: spec validation failed`. STRAT-PY-RETIRE had converted only `build` and `gsd` and deleted the older execution paths; everything else was stranded. Three documented commands — `compose fix`, `compose plan`, `compose build --quick` — had been completely dead for a month. `plan.stratum.yaml` had been edited ten days earlier while already unrunnable.

We stopped and asked rather than picking a scope, because migrate-all-eight and quarantine-only differ by an order of magnitude. The answer was: start with just the bug-fix one.

Two assumptions died on contact. `bug-fix` is `version: "0.1"`, not the v0.3 we had assumed — an older `functions:` dialect — and we had to correct a message that asserted the wrong one. And the claim that the cockpit picker was offering broken templates was simply wrong: no shipped spec has an uncommented `metadata:` block, so `loadTemplates` surfaces none of them. The code says so itself, in a comment we had not read.

The migration converted cleanly — a linear nine-step chain with no backward routing, so unlike the build conversion there were no ROUTING_CYCLE gates to model. We verified it on the real engine rather than by reading: it plans, walks all nine steps to `completed` with the right flow output, and three negative probes confirm the COMP-DEBUG-1 discipline guards still bite while a compliant diagnosis advances.

The guard test then did its job before it was even committed. It failed twice on our own synthesized plan inputs (`*_agent` fields must resolve to a real connector; gsd declares `pre_merge_gate` optional but references it unconditionally), and once landed it turned the full suite red with thirteen failures — twelve stub-engine fixtures across five test files declaring `version: "0.2"`, a dialect no real spec uses, plus one hand-edit we had made to a generated table in `docs/cli.md`. All of it was the guard working.

## What we built

**Ship-contract fix (`e79fa73`)**
- `lib/build.js` — `toPhaseResultOutput`, the single narrowing seam; `tsShipOutput` now composes it.
- `lib/gsd.js` — narrow before `stepDone`.
- `test/ship-phase-result-contract.test.js` — asserts the helper's key set against field names parsed out of the pipeline YAML rather than hard-coded, across all four ship return branches.

**SSE de-flake (`29fce99`)**
- `test/build-stream-smoke.test.js` — `waitUntil` polling replaces two fixed sleeps; throws on timeout so a genuinely stalled bridge still fails.

**Pipeline quarantine + bug-fix revival (`f8bbc82`)**
- `lib/pipeline-compat.js` (new) — `tsCompatibilityOf` / `isTsEngineSpec` / `quarantineMessage`, keyed on the spec's own `version` stamp.
- `lib/build.js` — refusal at the single `resolveTemplatePath` seam, covering build, fix, plan, `--quick`, `--template` and bundled presets.
- `server/pipeline-routes.js` — `listSpecFiles` carries `tsCompatible` / `tsIncompatibleReason`.
- `pipelines/bug-fix.stratum.yaml` — re-authored v0.1 to TS v1, conversion decisions recorded in the header.
- `test/pipeline-ts-engine-guard.test.js` (new) — iterates `pipelines/` and `presets/`; every v1 spec must plan on the real engine, every quarantined one must be genuinely refused by it.
- `test/{build,build-modes,comp-fix-hard-gaps,compose-fix-resume,run-build-bug-mode}.test.js` — twelve v0.2 stub fixtures converted to minimal real v1 specs.
- `docs/pipelines.md`, `docs/cli.md` — runnable/quarantined status per spec; unavailable commands marked.

## What we learned

1. **A self-healing retry is a failure detector that has been disabled.** The ship step failed its contract on every run for months and nothing noticed, because the retry landed in a shape that asserts nothing. The symptoms of this class are worth naming: a step whose attempt count is always 2, doubled side effects, and a flow output that never carries its optional fields. Green plus a retry is not evidence of a working contract.

2. **Coverage that names files cannot notice a file rotting.** The only pipeline tests named `build` and `gsd` explicitly, so nine specs became unrunnable and every suite stayed green for a month. The fix is not more tests, it is tests that iterate the directory. The new guard was written to have nothing to remember: it derives its input from each spec's own declared types, so a brand-new pipeline is covered the day it lands.

3. **A quarantine that is not checked in both directions is an unchecked claim.** It would have been easy to mark specs incompatible and stop. Asserting that the engine *also* refuses each one is what keeps the flag honest — and it is the half that would catch us wrongly refusing something that actually runs.

4. **Verify at the seam that fails, not the one that is convenient.** Static validation said eight pipelines were broken but also flagged `build` and `gsd`, which demonstrably run — their errors were pre-substitution placeholders. Only planning them on the real engine separated real breakage from noise. Similarly, the ship bug was inferred from a type signature and confirmed from a persisted run; the flake was theorised and then disproved by probing the bridge directly.

5. **Load-bearing assumptions should be checked before they are built on.** Three died this session: `bug-fix` was v0.1 not v0.3; the template picker was never surfacing the broken specs at all; and our own drain predicate was unsatisfiable because of a field the bridge does not stamp. Each was cheap to check and would have been expensive to ship.

6. **When a gate blocks an explicit instruction, fix the gate honestly rather than bypassing it.** The pre-push hook printed its own `--no-verify` escape. Taking it would have been faster and would have left the next person with the same red.

## Open threads

- [ ] `compose fix` is revived at the engine seam but no real bug has been driven through it with live agent dispatch — the first real run is the live proof.
- [ ] `plan.stratum.yaml` and `build-quick.stratum.yaml` back real commands and are the next migration candidates.
- [ ] `content`, `coverage-sweep`, `refactor`, `research`, `review-fix` (v0.1) and the three `presets/` specs (v0.3) stay quarantined pending a keep-or-kill call.
- [ ] `lib/lifecycle-modes.js`'s `fix` graph omits `bisect` — eight phases listed against a nine-step spec. Informational today (no live guard), deliberately not edited as a side effect of the migration.
- [ ] `lib/bug-bisect.js` is real, tested, and still has no production caller; the spec's prose is its only wiring.

---

*Green is not the same as working; it is only the same as nothing having asked.*

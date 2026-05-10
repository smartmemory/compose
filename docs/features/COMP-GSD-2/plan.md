# COMP-GSD-2: Implementation Plan

**Status:** PLAN
**Date:** 2026-05-10
**Blueprint:** [blueprint.md](blueprint.md)
**Design:** [design.md](design.md)

---

## Task Order

T1 → T2 → T3 → T4 → T5 → T6 → T7

All sequential. Earlier draft claimed T3/T4 parallel; corrected — T4 (`buildTaskDescription`) consumes the enriched TaskGraphGsd shape produced by T3 (`enrichTaskGraph`) per the Boundary Map S03→S04 dependency in `blueprint.md`. T5 (pipeline spec) has no code dependency but is placed mid-sequence so it lands before T6 wires it into `runGsd`.

---

## Task 1: Contracts

- **Files:**
  - `contracts/taskgraph-gsd.json` (new)
  - `contracts/task-result.json` (new)
- **What:** Author two JSON Schemas. `taskgraph-gsd.json` extends Stratum's bare TaskGraph with required `produces` (array of `{file, symbols, kind}`) and `consumes` (array of `{from, file, symbols}`) per task node. `task-result.json` defines the per-task post-execution capture: `{status: "passed"|"failed", files_changed: string[], summary: string, produces: object, gates: Array<{command, status, output}>, attempts: number}`.
- **Pattern:** Existing schemas at `contracts/review-result.json`, `contracts/feature-json.schema.json` — same JSON Schema draft, same `_source` and `_roadmap` top-level fields.
- **Test:** `test/contracts-gsd.test.js` (new) — load each schema with `ajv`, validate a hand-crafted positive example and a negative example. Assert schema compilation succeeds.
- **Acceptance:**
  - [ ] `contracts/taskgraph-gsd.json` exists, valid JSON Schema, compiles under ajv
  - [ ] `contracts/task-result.json` exists, valid JSON Schema, compiles under ajv
  - [ ] Both files include `_source: "docs/features/COMP-GSD-2/blueprint.md"` and `_roadmap: "COMP-GSD-2"` per repo convention
  - [ ] `test/contracts-gsd.test.js` passes with positive + negative cases for each schema
- **Depends on:** none

---

## Task 2: Blackboard I/O

- **Files:**
  - `lib/gsd-blackboard.js` (new)
  - `test/gsd-blackboard.test.js` (new)
- **What:** Pure I/O module for `.compose/gsd/<code>/blackboard.json`. Exports:
  - `read(code) → Record<taskId, TaskResult>` — reads blackboard, returns `{}` if absent
  - `writeAll(code, taskResults)` — atomic batch write with mkdir-advisory-lock at `.compose/data/locks/gsd-<code>.lock`. Writes via temp-file + rename for atomicity.
  - `validate(taskResult)` → `{ok: boolean, errors: string[]}` — validates a single TaskResult against `contracts/task-result.json`
- **Pattern:** `lib/completion-writer.js:48-67` for the mkdir-advisory-lock pattern (`featureLockFile`, `acquireFeatureLock`); `lib/journal-writer.js` for the temp-file + rename atomic-write pattern.
- **Test:** `test/gsd-blackboard.test.js` — round-trip, lock contention (two concurrent `writeAll` calls), validate rejects malformed inputs.
- **Acceptance:**
  - [ ] `read('FOO')` returns `{}` when blackboard.json absent
  - [ ] `writeAll('FOO', {t1: {...}, t2: {...}})` then `read('FOO')` round-trips byte-equal
  - [ ] Two concurrent `writeAll` calls do not corrupt the file (one wins, one waits)
  - [ ] `validate(invalid)` returns `{ok: false, errors: [...]}` listing the schema violations
  - [ ] No unhandled promise rejections; all locks released in finally blocks
- **Depends on:** T1 (uses `contracts/task-result.json`)

---

## Task 3: Decompose enrichment

- **Files:**
  - `lib/gsd-decompose-enrich.js` (new)
  - `test/gsd-decompose-enrich.test.js` (new)
- **What:** Pure function `enrichTaskGraph(taskGraph, blueprintText) → TaskGraphGsd`. Calls `validateBoundaryMap({blueprintText, blueprintPath, repoRoot})` from `lib/boundary-map.js:275`. Throws if `ok !== true`. Otherwise calls `parseBoundaryMap` to get slices, then for each TaskGraph node finds the matching slice (slice's File Plan files ⊆ task's `files_owned`), and attaches `produces` and `consumes` arrays from the slice. Throws if any task has no matching slice or any slice has no matching task.
- **Pattern:** `lib/boundary-map.js` for the parseBoundaryMap/validateBoundaryMap output shapes. Treat as pure function — no I/O.
- **Test:** `test/gsd-decompose-enrich.test.js` — happy-path enrichment; throws on empty Boundary Map; throws on parse violations; throws on slice/task File Plan mismatch.
- **Acceptance:**
  - [ ] Happy-path: enrichTaskGraph returns TaskGraphGsd matching `contracts/taskgraph-gsd.json`
  - [ ] Empty Boundary Map → throws with message including "Boundary Map empty"
  - [ ] Parse violations present → throws with message including "Boundary Map invalid"
  - [ ] Slice with no matching task (no files_owned ⊇ slice File Plan) → throws naming the orphaned slice
  - [ ] Task with no matching slice → throws naming the orphaned task
  - [ ] Output matches `contracts/taskgraph-gsd.json` (validated under ajv in the test)
- **Depends on:** T1

---

## Task 4: Prompt assembly (`buildTaskDescription`)

- **Files:**
  - `lib/gsd-prompt.js` (new)
  - `test/gsd-prompt.test.js` (new)
- **What:** Pure function `buildTaskDescription({task, slice, upstreamTasks, gateCommands}) → string`. Emits a multi-section string for packing into `task.description`:
  1. `Symbols you must produce:` + slice's produces entries
  2. `Symbols you may consume from upstream tasks:` + slice's consumes entries
  3. `Boundary Map slice (the contract):` + verbatim slice text
  4. `Upstream tasks (spec-level summary, code lands at end-of-step merge):` + one line per upstream listing its declared produces
  5. `GATES — you MUST run these and they MUST pass before declaring done:` + each command from gateCommands
  6. Closing line: "Fix and re-run within this invocation. Do NOT declare done while gates are red."
- **Pattern:** Pure string template; no Stratum interpolation tokens used here (those are applied by Stratum at dispatch time around our description).
- **Test:** `test/gsd-prompt.test.js` — assert all six sections present; upstream filtered correctly by `task.depends_on`; gateCommands rendered verbatim with no shell escaping (we trust the project config).
- **Acceptance:**
  - [ ] All six sections present in returned string
  - [ ] Upstream summary contains exactly the tasks in `task.depends_on` and no others
  - [ ] gateCommands array of N renders N command lines
  - [ ] Empty produces/consumes render as "(none)" rather than empty section
- **Depends on:** T1

---

## Task 5: Pipeline spec

- **File:** `pipelines/gsd.stratum.yaml` (new)
- **What:** Three-step flow `gsd: decompose_gsd → execute → ship_gsd` per the Pipeline Spec Sketch in `blueprint.md`. Inputs: `featureCode`, `gateCommands`. Step 1 `decompose_gsd` instructs the agent to read `docs/features/{input.featureCode}/blueprint.md`, parse Boundary Map, and emit a TaskGraphGsd whose `description` strings are pre-baked rich prompt fragments. Step 2 `execute` is a `parallel_dispatch` with `max_concurrent: 1`, `isolation: worktree`, `capture_diff: true`, `merge: sequential_apply`, `retries: 2`, `intent_template` consuming `{task.id|description|files_owned|files_read|depends_on}` and `{input.featureCode}` only. Step 3 `ship_gsd` runs final verify + commit + docs work: explicit instructions to update ROADMAP.md (mark COMP-GSD-2 COMPLETE), CHANGELOG.md (entry under today's date), and CLAUDE.md (only if a new convention/command surface emerged). NO plan.md/report.md preconditions (those don't exist in GSD mode).
- **Pattern:** `pipelines/build.stratum.yaml` is the structural template (decompose at `:324-337`, parallel_dispatch at `:340-359`, ship at `:447-486`). Copy structure, rewrite intents.
- **Test:** `test/gsd-pipeline.test.js` (new) — load YAML, validate against Stratum's spec contract via `mcp__stratum__stratum_validate` (or equivalent CLI), assert all required fields present, assert `max_concurrent: 1` and `isolation: worktree`.
- **Acceptance:**
  - [ ] YAML parses
  - [ ] `stratum_validate` reports no errors
  - [ ] Three steps with ids `decompose_gsd`, `execute`, `ship_gsd`
  - [ ] `execute` has `max_concurrent: 1`, `isolation: worktree`, `capture_diff: true`, `merge: sequential_apply`, `retries: 2`
  - [ ] `intent_template` uses ONLY supported tokens (per `stratum-mcp/src/stratum_mcp/spec.py:567-590`)
  - [ ] `decompose_gsd` ensure includes `no_file_conflicts(result.tasks)` and `len(result.tasks) >= 1`
  - [ ] `ship_gsd` intent explicitly enumerates: update ROADMAP.md (mark COMP-GSD-2 COMPLETE), update CHANGELOG.md, optional CLAUDE.md, then commit + push
- **Depends on:** T1 (uses TaskGraphGsd contract); has no code dependency on T2-T4

---

## Task 6: Lifecycle entry (`runGsd` + CLI verb)

- **Files:**
  - `lib/gsd.js` (new)
  - `bin/compose.js` (modify near line 113 help + main verb switch)
- **What:** `runGsd(featureCode, opts)`:
  1. Validate `docs/features/<code>/blueprint.md` exists; error message: "Blueprint missing at <path>. Run `compose build <code>` to generate it, or author it by hand."
  2. Read blueprint text; call `validateBoundaryMap({blueprintText, blueprintPath, repoRoot}).ok === true`; error if not, surfacing the violations array.
  3. Read `gateCommands` from `loadProjectConfig().gateCommands` with fallback `["pnpm lint", "pnpm build", "pnpm test"]` (loader does NOT merge defaults).
  4. Load `pipelines/gsd.stratum.yaml`.
  5. Call `stratum.plan(specYaml, 'gsd', {featureCode, gateCommands})`.
  6. Run the same status-loop pattern as `runBuild` (`lib/build.js:938-3400`).
  7. **Validate decompose_gsd output** (between decompose_gsd completing and execute starting):
     - Run the agent-emitted TaskGraph through `enrichTaskGraph(taskGraph, blueprintText)` from T3.
     - **Structural failure** (orphaned slice or orphaned task): there is no reliable slice↔task pairing to repair from — fail loudly with the named orphan(s), surface to the human, do NOT enter execute.
     - **Structural success but missing/malformed `description` fields** on one or more tasks: the slice↔task mapping is valid, so call `buildTaskDescription({task, slice, upstreamTasks, gateCommands})` from T4 for each affected task to programmatically construct the missing description, mutate the TaskGraph in place, and proceed.
     - **All good (structural + descriptions present)**: proceed without changes.
     This integration point is the deterministic safety net for the agent's bake-in — agents are good but not infallible, and the spec-level prompt contract is load-bearing for v1 since runtime handoff is out of scope.
  8. After the `execute` step completes, walk `.compose/gsd/<code>/results/*.json` files in the merged base cwd, validate each TaskResult via `gsd-blackboard.validate`, write consolidated `blackboard.json` via `gsd-blackboard.writeAll`.
  9. Return PhaseResult (delegate ship_gsd's commit + push + ROADMAP/CHANGELOG update to the pipeline's `ship_gsd` step itself).
  - `bin/compose.js`: add `gsd` verb to help text near line 113 and add a case to the main verb switch that calls `runGsd`.
- **Pattern:** `lib/build.js:938` `runBuild` for the status-loop pattern; `bin/compose.js` existing verb dispatch (`build` and `fix`) for CLI integration.
- **Test:** Covered by Task 7 golden flow. Optional: `test/gsd-runner.test.js` for unit-level validation (preconditions, gateCommands fallback) with stratum mocked.
- **Acceptance:**
  - [ ] `compose gsd FOO` errors with helpful message when `docs/features/FOO/blueprint.md` is absent (message points to `compose build <code>` as the generator)
  - [ ] `compose gsd FOO` errors with helpful message + violations list when blueprint has no valid Boundary Map (uses `validateBoundaryMap`)
  - [ ] gateCommands fallback fires when project config lacks the field; explicit gateCommands override is used when present
  - [ ] `runGsd` invokes `enrichTaskGraph` on decompose_gsd output (post-step validation); throws clearly named error if validation fails
  - [ ] `runGsd` falls back to `buildTaskDescription` to repair tasks whose description fields are missing/malformed before dispatching execute
  - [ ] After execute step, `.compose/gsd/<code>/blackboard.json` populated with one entry per task; each validated via `gsd-blackboard.validate`
  - [ ] `compose gsd --help` shows the verb and brief description
  - [ ] Verb registered in main switch alongside `build` and `fix`
  - [ ] `ship_gsd` step (in pipeline, T5) updates ROADMAP.md (mark COMP-GSD-2 COMPLETE) and CHANGELOG.md; `runGsd` does NOT do these directly (pipeline owns it)
- **Depends on:** T2, T3, T4, T5

---

## Task 7: Golden flow test

- **File:** `test/gsd.test.js` (new)
- **What:** End-to-end golden flow. Scaffold a fixture feature folder in a temp repo with a blueprint containing a parseable Boundary Map (3 slices, with task 2 declaring `consumes from S01: ...`). Run `compose gsd <code>` against the fixture using the **same test harness** as `test/parallel-dispatch-server-defer.test.js` and `test/parallel-dispatch-server-worktree.test.js` — stubbed Stratum client and mock claude connector that returns canned task agent outputs. The mock connector inspects each task's `intent` (after Stratum interpolation) and asserts the prompt contract.
- **Pattern:** `test/parallel-dispatch-server-defer.test.js:31` (stubbed Stratum client setup); `test/parallel-dispatch-server-worktree.test.js:32` (mock connector pattern); `test/build.test.js:14` (full-runBuild integration via stubbed harness).
- **Test:** This IS the test.
- **Acceptance:**
  - [ ] Test scaffolds fixture feature with valid blueprint+Boundary Map (3 slices)
  - [ ] Stub Stratum client returns the canned `decompose_gsd` TaskGraph; runGsd validates it via `enrichTaskGraph` (T3 integration check)
  - [ ] Mock connector receives task 2's interpolated intent and asserts: (a) intent contains task 2's `description` verbatim; (b) description includes `Symbols you may consume from upstream tasks: <S01 symbols>`; (c) description includes `Upstream tasks (spec-level summary)` block listing task 1's declared produces — this is the load-bearing prompt-contract check since runtime handoff is out of scope for v1
  - [ ] Stratum events arrive in expected sequential order (build_task_start for tasks 1, 2, 3)
  - [ ] After run, `.compose/gsd/<code>/blackboard.json` exists with 3 entries; each validates via `gsd-blackboard.validate`
  - [ ] gateCommands fallback test: when project config lacks gateCommands, the canned prompts include the default lint/build/test commands
  - [ ] Test cleans up the temp repo in afterAll
- **Depends on:** T1–T6

---

## Files Summary

| File | Tasks |
|------|-------|
| `contracts/taskgraph-gsd.json` | T1 |
| `contracts/task-result.json` | T1 |
| `lib/gsd-blackboard.js` | T2 |
| `lib/gsd-decompose-enrich.js` | T3 |
| `lib/gsd-prompt.js` | T4 |
| `pipelines/gsd.stratum.yaml` | T5 |
| `lib/gsd.js` | T6 |
| `bin/compose.js` | T6 |
| `test/contracts-gsd.test.js` | T1 |
| `test/gsd-blackboard.test.js` | T2 |
| `test/gsd-decompose-enrich.test.js` | T3 |
| `test/gsd-prompt.test.js` | T4 |
| `test/gsd-pipeline.test.js` | T5 |
| `test/gsd.test.js` | T7 |

---

## Out of Scope (per blueprint)

- Runtime task-to-task handoff (task N+1 seeing task N's realized produces in its prompt)
- `lib/build.js` modifications (no per-task hook in v1)
- Parallelism `max_concurrent > 1` (GSD-3)
- Budget ceilings (GSD-4)
- Stuck detection (GSD-5)
- Headless+resume (GSD-6)
- Milestone HTML report (GSD-7)
- File-granular Boundary Map fallback

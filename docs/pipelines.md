# Pipelines

The Kickoff and Build pipelines, plus pipeline spec format and Stratum IR v0.3 reference.

## The Kickoff Pipeline

Defined in `pipelines/new.stratum.yaml`. Orchestrates product creation from intent to scaffolded feature folders.

> **Note:** `pipelines/new.stratum.yaml` is currently absent from the shipped package, even though `compose new` and `compose init` reference it. Tracked as `COMP-NEW-PIPELINE-MISSING` in `ROADMAP.md`.

### Steps

| # | Step | Agent | What It Does |
|---|------|-------|-------------|
| 1 | `research` | claude | Searches for prior art, existing tools, architectural patterns, risks. Writes to `docs/discovery/research.md`. Validated against criteria (>= 2 prior art entries, patterns, risks). |
| 2 | `brainstorm` | claude | Generates feature list with codes, user stories, 2-3 architecture options with trade-offs. Writes to `docs/discovery/brainstorm.md`. Validated (>= 3 features, user stories, architecture options). |
| 3 | `review_gate` | human | Gate: approve brainstorm, revise (loop back to brainstorm), or kill. Displays the brainstorm artifact for review. Timeout: 2 hours. |
| 4 | `roadmap` | claude | Structures brainstorm into phased ROADMAP.md with feature table. Validated (markdown table, phased features, PLANNED status). |
| 5 | `roadmap_gate` | human | Gate: approve roadmap, revise, or kill. Timeout: 1 hour. |
| 6 | `scaffold` | claude | Creates `docs/features/<CODE>/design.md` for each ROADMAP feature with seed content. |

### Contracts

- `ResearchResult`: `{ priorArt, patterns, risks, summary }`
- `BrainstormResult`: `{ features, userStories, archOptions, summary }`
- `RoadmapResult`: `{ phases, features, summary, artifact }`
- `ScaffoldResult`: `{ created, summary }`

### Skipping Research

The questionnaire can disable research. When skipped, the `research` step gets `skip_if: "true"` injected into the spec before planning.

## The Build Pipeline

Defined in `pipelines/build.stratum.yaml`. Executes a feature through the full development lifecycle.

### Steps

| # | Step | Agent | What It Does |
|---|------|-------|-------------|
| 1 | `explore_design` | claude | Explores codebase, writes design doc to `docs/features/{code}/design.md` |
| 2 | `scope` | claude | Scope the feature, identify boundaries |
| 3 | `design_gate` | human | Approve design, revise (loop to explore_design), or kill |
| 4 | `prd` | claude | Write PRD. **Skipped by default** — enable via `compose pipeline enable prd` |
| 5 | `architecture` | claude | Architecture doc with competing proposals. **Skipped by default** |
| 6 | `blueprint` | claude | Implementation blueprint with file:line references. Retries: 3 |
| 7 | `verification` | claude | Verify all blueprint references against actual code. `on_fail: blueprint` loops back if stale |
| 8 | `plan_gate` | human | Approve plan, revise (loop to plan), or kill |
| 9 | `decompose` | claude | Decompose plan into independent subtasks with `files_owned`/`files_read` |
| 10 | `execute` | claude | Parallel dispatch: TDD implementation in isolated git worktrees per subtask |
| 11 | `review` | claude (sub-flow) | Parallel multi-lens review: triage → 2-4 specialized lenses → merge/dedup. Outer step uses default retries; inner sub-flow steps set their own. |
| 12 | `codex_review` | codex (sub-flow) | Independent cross-model review after Claude lenses + fixes. Outer step uses default retries; inner `review_check` step has retries: 5. |
| 13 | `coverage` | claude (sub-flow) | Run tests, fix failures, re-run. Retries: 15 |
| 14 | `report` | claude | Post-implementation report. **Skipped by default** |
| 15 | `docs` | claude | Update CHANGELOG, ROADMAP, README, CLAUDE.md, and public docs |
| 16 | `ship` | claude | Run tests, run build, verify docs, stage, commit, push |
| 17 | `ship_gate` | human | Final approval |

### Sub-flows

**`parallel_review`** (STRAT-REV): Multi-lens review with three steps:
1. **triage** (claude) — reads file list, activates relevant lenses (always: diff-quality + contract-compliance; conditional: security, framework). On retry, reads `.compose/prior_dirty_lenses.json` for selective re-review.
2. **review_lenses** (parallel_dispatch, isolation: none) — fans out 2-4 lens agents concurrently. Each lens returns `LensFinding[]` with severity, file, line, confidence. Confidence gates and false-positive exclusion lists reduce noise.
3. **merge** (claude) — deduplicates findings by file+issue, assigns severity (must-fix/should-fix/nit), classifies as auto-fix vs ask.

**`review_check`** (fallback): Single-step codex review. Returns the full `ReviewResult` contract (`{ clean, summary, findings, meta, lenses_run, auto_fixes, asks }`). Retries until `clean == true` (max 5). Cross-agent fix: claude fixes, codex re-reviews. Used by `codex_review` step.

**`coverage_check`**: Single-step test runner. Returns `{ passing, summary, failures }`. Retries until `passing == true` (max 15). Fix pass dispatched on failure.

### Contracts

- `PhaseResult`: `{ phase, artifact, outcome, summary }` — `outcome` is one of `complete`, `skipped`, `failed`
- `ReviewResult`: `{ clean, summary, findings, meta, lenses_run, auto_fixes, asks }` — canonical shape produced by both `review_check` (Codex) and `parallel_review` (Claude); schema source: `compose/contracts/review-result.json`
- `TestResult`: `{ passing, summary, failures }`
- `LensFinding`: `{ lens, file, line, severity, finding, confidence }` — per-finding from a review lens
- `LensTask`: `{ id, lens_name, lens_focus, confidence_gate, exclusions }` — triage output for lens dispatch
- `LensResult`: `{ clean, findings[] }` — single lens output
- `TriageResult`: `{ tasks[] }` — triage step output
- `MergedReviewResult`: `{ clean, summary, findings[], lenses_run[], auto_fixes[], asks[] }` — merged review output
- `TaskGraph`: `{ tasks[] }` — decompose output for parallel dispatch

### on_fail Routing

The `verification` step has `on_fail: blueprint` — when retries are exhausted without valid references, the pipeline routes back to the blueprint step for a rewrite.

## Pipeline Specs

Compose ships seven pipeline specs in `pipelines/` (plus one expected-but-currently-absent kickoff spec):

| Spec | Flow | Purpose |
|------|------|---------|
| `build.stratum.yaml` | `build` | Feature lifecycle: design through ship |
| `bug-fix.stratum.yaml` | `bug_fix` | Bug-fix lifecycle (`compose fix`): reproduce → diagnose → bisect → scope_check → fix → test → verify → retro_check → ship |
| `content.stratum.yaml` | `content` | Content production pipeline |
| `coverage-sweep.stratum.yaml` | `coverage_sweep` | Test loop: run tests, fix failures until passing |
| `refactor.stratum.yaml` | `refactor` | Refactor lifecycle |
| `research.stratum.yaml` | `research` | Standalone research pipeline |
| `review-fix.stratum.yaml` | `review_fix` | Two-phase loop: implement then review/fix until clean |
| `new.stratum.yaml` | `new` | Product kickoff (research, brainstorm, roadmap, scaffold). **Currently absent from the shipped package** — see `COMP-NEW-PIPELINE-MISSING`. |

### Stratum IR v0.3

Specs use Stratum IR v0.3 format (backward-compatible superset of v0.2). All existing v0.2 specs run unchanged. Specs that use v0.3 features declare `version: "0.3"` at the top level.

**v0.2 primitives (all retained):**
- **contracts**: Output shape definitions with typed fields
- **functions**: Reusable compute/gate definitions with retries and postconditions
- **flows**: Step graphs with dependencies, routing, sub-flows
- **ensure expressions**: Python-like postconditions (`result.clean == True`, `file_exists(path)`)
- **input expressions**: Data flow between steps (`$.input.x`, `$.steps.prev.output.y`)
- **skip_if / skip_reason**: Conditional step skipping

**v0.3 additions (STRAT-PAR, STRAT-REV):**
- **`decompose` step type**: the agent emits a **TaskGraph** — an array of tasks, each with `files_owned` (write set), `files_read` (read set), and `depends_on` (dependency list). Used to break a sequential step into independent subtasks before parallel execution.
- **`parallel_dispatch` step type**: consumes a TaskGraph and coordinates concurrent agent runs. Fields: `source` (JSON pointer to task array, e.g. `$.steps.decompose.output.tasks`), `max_concurrent` (concurrency cap, default 3), `isolation` (`worktree` for write isolation, `branch`, or `none` for read-only tasks), `merge` (`sequential_apply` | `manual`), `require` (`all` | `any` | integer N), and `intent_template` (per-task prompt template with `{field}` interpolation).
- **`no_file_conflicts` ensure**: validates that no two independent tasks share `files_owned` entries.
- **`isolation: none`**: allows read-only parallel tasks (e.g. review lenses) to run without git worktree overhead.

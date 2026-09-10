# Pipelines

The Kickoff and Build pipelines, plus pipeline spec format and Stratum IR v0.3 reference.

## The Kickoff Pipeline

Defined in `pipelines/new.stratum.yaml`. Orchestrates product creation from intent to scaffolded feature folders.

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

Every shipped spec is authored for the TS v1 engine (`version: 1`). A spec on an older
dialect cannot start at all — the engine refuses it — so invoking one fails immediately
with a message naming the spec and the reason (see `lib/pipeline-compat.js`) rather than
a bare `-32602`. Compatibility is read from the spec's own `version` stamp, so
re-authoring a spec as `version: 1` is the whole of what makes it runnable.

| Spec | Flow | Purpose |
|------|------|---------|
| `build.stratum.yaml` | `build` | Feature lifecycle: design through ship |
| `build-quick.stratum.yaml` | `build` | Trimmed build lifecycle (`compose build --quick`): design → implement → ship, single gate |
| `gsd.stratum.yaml` | `gsd` | Per-task fresh-context dispatch across a decomposed blueprint |
| `new.stratum.yaml` | `new` | Product kickoff: research, brainstorm, roadmap, scaffold (`compose new`) |
| `plan.stratum.yaml` | `plan` | Product-planning lifecycle (`compose plan`): explore_design → plan → ship, two gates |
| `bug-fix.stratum.yaml` | `bug_fix` | Bug-fix lifecycle (`compose fix`): reproduce → diagnose → bisect → scope_check → fix → test → verify → retro_check → ship |
| `content.stratum.yaml` | `content` | Content production: research → draft → review → publish |
| `coverage-sweep.stratum.yaml` | `coverage_sweep` | Test loop: run tests, fix failures until passing |
| `refactor.stratum.yaml` | `refactor` | Refactor lifecycle: snapshot → analyze → plan → execute → test → review → ship |
| `research.stratum.yaml` | `research` | Standalone research: gather → analyze → report |
| `review-fix.stratum.yaml` | `review_fix` | Two-phase loop: implement then review/fix until clean |

The four bundled presets in `presets/` (`team-feature`, `team-research`, `team-review`, `team-fable-astra`)
are v1 as well. Each pairs with a `<name>.profiles.json` sidecar holding the agent
profiles (tool restrictions and model tiers) that v1 strips from the spec, which
compose re-applies at invocation — these are load-bearing wherever a fanout runs at
`isolation: none`, since the read-only restriction lives only there.

Agent profiles use `provider:template:tier`; template and tier are optional.
The tier allow-list comes from `server/model-tiers.js`:

| Tier | Claude | Codex |
|------|--------|-------|
| `critical` | `claude-opus-5` | `gpt-6-astra` |
| `standard` | `claude-sonnet-5` | `gpt-5.6-terra` |
| `fast` | `claude-haiku-4-5-20251001` | `gpt-5.3-codex-spark` |
| `coordinator` | `claude-fable-5-1` | unavailable (validation error) |

For example, `claude:orchestrator:coordinator` explicitly selects Fable with
adaptive thinking and high effort. Omitting the tier, as in
`claude:orchestrator`, keeps the connector default (`modelID: null`).

Profiles fail closed where it changes outcomes: a local spec whose bundled preset
counterpart (same basename) ships a sidecar that configures execution (per-item
tiers, output-driven gates, ownership, a cost ceiling: today `team-fable-astra`)
must have an adjacent `<name>.profiles.json`, or `PROFILE_SIDECAR_REQUIRED`
refuses the build before any plan or flow;
[copy both files](team-presets.md#customization). A missing string-only sidecar
(tool restrictions and tiers) still means bare defaults, and a custom spec with no
bundled counterpart never needs one.
An existing sidecar with invalid JSON or a non-object value stops the build. Preflight rejects unknown
tiers, unavailable provider/tier combinations, invalid profile values, and keys
that name no step in any flow. Keys beginning with `_` are metadata, not agent entries;
recognized `_consumer` and `_costCeiling` configuration is validated.
Fanout profiles use the enclosing step id and apply to its agent stages.
Static profiles and merged runtime role overrides are checked before a fresh
flow starts; restored resume roles are checked again before dispatch. One
`profile_preflight` event records `{ steps: { stepId: { profile, provider, tier,
modelID } } }` when the build stream opens, before step dispatch. Multi-stage
fanout entries use `stepId/stageIndex` so every stage is recorded.

### Fable-Astra wave loop

`compose build FEAT-1 --team fable-astra` selects `team-fable-astra` through the
existing named-template resolver. Fable plans 1–6 independent tasks with disjoint
literal file ownership; Codex workers use each task's critical/standard/fast tier
in isolated worktrees. Merge approval checkpoints the integrated tree before
Sonnet verifies it. A fresh read-only Astra reviewer receives the goal, acceptance
criteria, cumulative merged diff (including new files) and verification evidence,
never worker summaries. Fable assesses the evidence and every finding, then
requests another implementation wave, affected-only repair, completion or blocking.
Completion routes to ship, producing one commit parented by the build base.

The carried `wave` starts at `plan.output.tasks`; only an `assess_gate` revise
replaces it with `assess.output.tasks`. Merge retries reuse the recorded wave.
Both gates allow two revisions each, sharing the flow's four-revision limit.
Exhaustion or a blocked decision ends the flow failed. Failed verification reaches
review and assessment so defects can be repaired rather than merely retested.
Worker concurrency is the numeric literal 3; copy the YAML and sidecar together
to change it. `cost_ceiling_usd` is an optional numeric flow input with a $150
Compose-side default; `--cost-ceiling-usd` overrides it. A ceiling breach pauses
at `assess_gate` for an explicit human decision; see recovery below.

### Wave profiles, ownership and output gates

An agent entry can be a string (`"codex:implementer:critical"`) or an object:
`{"default":"codex:implementer:critical","tier_from":"item.tier"}`.
Only consumer fanouts support `tier_from`, and only `item.tier` is accepted.
An absent tier uses the default; explicit null, empty or unknown tiers fail.
The provider and template stay fixed for the stage. The whole recorded wave is
validated before any worker starts, including items beyond the concurrency limit.
Runtime agent overrides replace `default` while preserving `tier_from`.

Example sidecar for a custom wave pipeline (see `presets/team-fable-astra.profiles.json`
for the complete bundled configuration):

```json
{
  "plan": "claude:orchestrator:coordinator",
  "execute": {"default": "codex:implementer:critical", "tier_from": "item.tier"},
  "review": "codex:read-only-reviewer:critical",
  "assess": "claude:orchestrator:coordinator",
  "assess_gate": {
    "decide_from": {
      "step": "assess", "field": "action",
      "approve": ["complete"], "revise": ["repair", "implement"], "kill": ["blocked"]
    },
    "validators": [{"name": "WaveDecision", "review_step": "review", "tasks_field": "tasks"}]
  },
  "_consumer": {
    "execute": {"ownership": "item.files_owned", "independent": true, "checkpoint_gate": "execute_merge"}
  },
  "_costCeiling": {"input": "cost_ceiling_usd", "default": 150, "gates": ["assess_gate"]}
}
```

`_consumer` opts a fanout into ownership, independent task admission and/or wave
checkpoints. Ownership and checkpoints require worktree isolation; the checkpoint
gate must depend directly and unconditionally on that fanout. `files_owned` lists
literal repository-relative file paths, such as `src/adapter.js`. Globs, absolute
paths, `..`, `.git` components and directory paths are invalid. Independent tasks
have empty `depends_on` arrays and disjoint ownership. Renames require both source
and destination paths. Ownership is checked against the retained Git patch;
the worker's `files_changed` claim is not evidence of permission.

Gate objects map recorded output values to decisions. `WaveDecision` checks task
and finding shapes, open counts, blocking state against the recorded review, and
repair ownership. Sources must precede the gate and match its current epoch/token.
The reserved `review_gate` retains its existing behavior and cannot use
`decide_from` or appear in `_costCeiling.gates`. Other `_` metadata (including
`_comment` and `_reduceSteps`) retains its existing interpretation; unknown metadata
is inert and is not an agent profile.

### Cost ceiling and checkpoint recovery

`_costCeiling` enables accounting from acknowledged, attributed usage receipts.
Its `input` names the flow input override; `default` is used otherwise.
`--cost-ceiling-usd` overrides the effective limit for a single build, outside the
profile revision digest. USD equal to the limit is allowed. Greater spend, unknown
cost, unreadable state or unacknowledged receipts requires a human even under
`skip`/`flag` gate policies. A noninteractive build returns `waiting_gate`, retaining
the flow ID, gate token and reason in `.compose/data/active-build.json`; its stream
ends with `build_paused` instead of a terminal `build_end`.

For an initialized project with a custom `waves` pipeline and matching sidecar:

```bash
compose build FEAT-1 --template waves --cost-ceiling-usd 150
# After a ceiling pause, raise the limit and resume interactively:
compose build FEAT-1 --resume --cost-ceiling-usd 200
```

Raising the limit does not approve the held token. Choose an explicit human
`approve`, `revise`, or `kill` at the resumed gate; `revise` continues with the
pipeline's revision route. Resuming noninteractively keeps the human hold pending.
Repair evidence/configuration failures before resuming; increasing the limit alone
does not repair missing receipts or invalid outputs.

Approved waves publish to `compose/wave/<flowId>` (full ref
`refs/heads/compose/wave/<flowId>`), leaving HEAD and the real index unchanged.
The next wave starts from that checkpoint. Recovery reconciles the prepared
journal, ref and retained patch evidence before dispatch or cleanup. Ship squashes
the net checkpoint tree into one commit parented by the pinned base; intermediate
wave commits are outside its ancestry. Kill retains the checkpoint ref.
`compose build FEAT-1 --fresh` discards the previous flow's recorded ref using an
expected-tip check and starts a new flow; it does not delete other flow refs.
`--fresh` and `--resume` are mutually exclusive. Profile changes on resume fail
with `CONSUMER_PROFILE_REVISION_MISMATCH`.

**Integration status:** the controller recorded all six dispatch-3 real-engine
goldens passing after the cost/epoch fixes (Compose `53e3710`, Stratum `db8666c`).
See **Fixes r2** in the [dispatch-3 report](features/COMP-FABLE-ASTRA/reports/slice3-d3-impl.md).
Per-item receipt metadata is read from the persisted run record, not public audit
events. The bundled preset has a real-engine one-wave ship golden with recorded
Claude outputs and fake Codex. Real model quality, cancellation/recovery scenarios
and clean global-install parity remain slice-6 live-fire obligations; the Stratum
release must include the surface-20 and cost fixes before Compose ships.

### Wave failure codes

| Code | Meaning / response |
|---|---|
| `WAVE_INPUT_INVALID` | Recorded input, descriptor, wave length or epoch is inconsistent; no wave dispatch. |
| `WAVE_TIER_INVALID` | Explicit item tier is invalid; fix the task list before dispatch. |
| `WAVE_DEPENDENCIES_NOT_EMPTY` | An independent task declares dependencies. |
| `WAVE_OWNERSHIP_INVALID` | Missing/invalid literal ownership paths or incompatible isolation. |
| `WAVE_OWNERSHIP_CONFLICT` | Multiple tasks own the same path in an independent wave. |
| `FILES_OWNED_VIOLATION` | Retained patch edits outside the allowed paths; failed worker output is removed. |
| `OWNERSHIP_EVIDENCE_MISMATCH` | Binding, digest or retained patch no longer matches captured evidence; merge is refused. |
| `WAVE_DECISION_SHAPE` | Malformed decision, task or finding fields. |
| `WAVE_OPEN_COUNT_MISMATCH` | `open_count` disagrees with the open finding list. |
| `WAVE_BLOCKING_MISMATCH` | Decision blocking state disagrees with the recorded review. |
| `WAVE_COMPLETE_WITH_OPEN_FINDINGS` | Completion requested despite open findings or blocking. |
| `WAVE_BLOCKED_WITHOUT_FINDINGS` | Blocked decision contains no open findings. |
| `WAVE_REPAIR_EMPTY` | Repair/implement list has fewer than one or more than six tasks. |
| `WAVE_REPAIR_UNOWNED_FINDING` | A repair task owns none of the open findings' paths. |
| `GATE_CONFIG_INVALID` | Invalid mapping/validator or missing execute profile/provider. |
| `GATE_SOURCE_MISSING` | Decision source has no succeeded object output. |
| `GATE_SOURCE_STALE` | Source, review or waiting gate evidence has the wrong epoch/token. |
| `GATE_ACTION_UNKNOWN` | Recorded action has no configured mapping. |
| `GATE_VALIDATION_FAILED` | Decision validators returned findings; gate holds for a human. |
| `COST_CEILING_INVALID` | Pure gate helper received invalid spend/limit values. |
| `COST_CEILING_BREACHED` | Pure gate helper observed spend greater than the limit. |
| `WAVE_COST_CEILING_EXCEEDED` | Runner's persisted spend exceeds its effective limit; human hold. |
| `WAVE_COST_UNVERIFIED` | Receipt attribution, acknowledgement, snapshot or revision cannot be verified; human hold. |
| `WAVE_COST_CEILING_RESERVED_GATE` | `_costCeiling.gates` includes reserved `review_gate`; preflight refuses it. |
| `WAVE_EVIDENCE_INCOMPLETE` | Evidence receipt remains local after failed/unavailable replication; do not treat it as acknowledged. |
| `WAVE_CHECKPOINT_DIVERGED` | Ref, HEAD, checkpoint chain or tree differs from pinned evidence; reconcile before retrying. |
| `WAVE_CHECKPOINT_EVIDENCE_MISSING` | Required checkpoint object, patch, ship result or acknowledged evidence is unavailable; recovery/ship is refused. |

Malformed sidecar configuration otherwise uses `PIPELINE_PROFILE_INVALID`.
The `GATE_*` holds retain their recorded reason; they do not authorize automatic
approval under a permissive policy.

`test/pipeline-ts-engine-guard.test.js` iterates both directories and enforces this:
every spec must be v1, every v1 spec must actually plan on the engine, and a spec on an
older dialect must actually be refused by it.

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

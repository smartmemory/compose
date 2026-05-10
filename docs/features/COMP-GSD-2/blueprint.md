# COMP-GSD-2: Per-Task Fresh-Context Dispatch — Implementation Blueprint

**Status:** BLUEPRINT
**Date:** 2026-05-10
**Design:** [design.md](design.md)

---

## Reframing (after blueprint discovery)

The design called this a "third lifecycle mode that introduces fresh-context dispatch." That framing was wrong: `pipelines/build.stratum.yaml:340-359` already runs `parallel_dispatch` with `isolation: worktree` + `defer_advance: true` + `merge: sequential_apply` + per-task `claude` connector subprocesses (which are already fresh-context). And `lib/build.js:2894` (`executeParallelDispatchServer`) is the consumer-side handler that already deferred-merges per-task diffs back to the base cwd in topological order.

So GSD-2's actual scope, expressed in deltas to existing primitives:

1. **CLI entry** — new `compose gsd <code>` verb. Hard-requires `blueprint.md` AND a parseable `## Boundary Map` section in it (per `lib/boundary-map.js:41-50`); errors out with a pointer to `compose build --through blueprint` if missing. No file-granular fallback in v1 — symbol-level dispatch is the whole point and a fallback would be an untested degraded mode.
2. **Pipeline** — new `pipelines/gsd.stratum.yaml` with three steps: `decompose_gsd → execute → ship_gsd`. Each is GSD-specific (separate intents and contracts), not a copy of build.stratum.yaml. Reasons: existing `decompose` (`build.stratum.yaml:324-337`) reads `plan.md`, but GSD reads `blueprint.md` + Boundary Map; existing `ship` (`build.stratum.yaml:447-486`) checks for `plan.md` and `report.md` artifacts that GSD doesn't produce. Sharing the step *type* (`type: decompose`, `type: parallel_dispatch`) is fine; sharing the step *intent string* is not.
3. **Decompose enrichment** — `decompose_gsd` step's intent reads blueprint.md and parses its Boundary Map, emitting a `TaskGraphGsd` where each node carries `files_owned`, `files_read`, `depends_on`, and additionally `produces` / `consumes` symbol arrays drawn straight from Boundary Map slices.
4. **Per-task gates run INSIDE the agent.** `parallelAdvance(flowId, stepId, mergeStatus)` (`lib/stratum-mcp-client.js:450`) only accepts `'clean'|'conflict'`; there is no task-level retry-with-prompt-update channel. So gates execute in each task's intent template: the agent runs `gateCommands` as part of its TDD loop and refuses to declare done until they pass. Stratum's existing per-task retries handle transient failure; if the agent gives up, the task returns failure and `require: all` causes the step to fail.
5. **TaskResult is a *post-execution* capture, not a runtime handoff.** Critical scope reduction discovered during blueprint review: `executeParallelDispatchServer` (`lib/build.js:2894`) polls until the **whole** parallel_dispatch step reaches `outcome` and applies all diffs in one pass at `:2997-3024`. There is no interposition between tasks within a single step. Even with `max_concurrent: 1`, Compose cannot inject task N's realized output into task N+1's prompt within the same step.
   - **Spec-level handoff (in v1):** each task's prompt includes the Boundary Map's declared `produces`/`consumes` for upstream tasks (interpolated by Stratum from `$.steps.decompose_gsd.output.tasks`). The Boundary Map IS the contract; if upstream is declared to produce symbol `X` at file `foo.js`, downstream's prompt says "you may consume `X` at `foo.js`." Tasks implement to the contract independently; Compose's `applyServerDispatchDiffsCore` (`lib/build.js:3077`) merges the resulting diffs in topological order at end of step.
   - **Realized-output handoff (deferred):** task N+1 actually seeing task N's *implemented* code requires either (a) a future Stratum protocol extension to fire pre-task callbacks, or (b) generating one Stratum step per task instead of one parallel_dispatch step. Both are out of scope for v1.
   - **Blackboard role in v1:** `.compose/gsd/<code>/blackboard.json` is written by Compose **after** the parallel_dispatch step completes, by reading each task's `.compose/gsd/<code>/results/<task_id>.json` from the merged base cwd (each agent commits its result file at that per-task path as part of its diff; after `applyServerDispatchDiffsCore` runs, all per-task files coexist on disk). The blackboard is the audit/retro/milestone-report substrate (consumed by GSD-7), not the runtime channel.

Decisions 3, 4, and the v1-shaped 5 are the load-bearing novelty.

---

## File Plan

(All paths relative to repo root, which is `/Users/ruze/reg/my/forge/compose`. No `compose/` prefix — that was an error in design.md.)

| File | Action | Purpose |
|------|--------|---------|
| `bin/compose.js` | modify | Add `gsd` verb dispatch alongside `build`/`fix`. Help text near line 113; main verb switch lower in the file. |
| ~~`lib/gsd-dispatch.js`~~ | DROPPED | Earlier drafts proposed a per-task hook. Removed — `executeParallelDispatchServer` doesn't interpose between tasks, so the hook had nothing useful to do. Post-execution blackboard walk lives in `runGsd` instead. |
| `lib/gsd.js` | new | `runGsd(featureCode, opts)` — entry point. Validates `docs/features/<code>/blueprint.md` exists AND `validateBoundaryMap({...}).ok === true` (via `lib/boundary-map.js:275`); reads `gateCommands` from `loadProjectConfig()` falling back to `["pnpm lint","pnpm build","pnpm test"]` (loader does NOT merge defaults — see `server/project-root.js:109-118`); loads `pipelines/gsd.stratum.yaml`; calls `stratum.plan` with `{featureCode, gateCommands}` as flow inputs; runs the same status-loop pattern as `runBuild` (`lib/build.js:938`); after the `execute` step completes, walks the merged base cwd at `.compose/gsd/<code>/results/*.json` and writes the consolidated blackboard. |
| `lib/gsd-blackboard.js` | new | Read/write `.compose/gsd/<code>/blackboard.json` with mkdir-advisory-lock at `.compose/data/locks/gsd-<code>.lock` (mirrors `lib/completion-writer.js:48-67`). Exports: `read(code)`, `writeAll(code, taskResults)` (one-shot batch write after step completion), `validate(taskResult)` (against `contracts/task-result.json`). No per-task interleaved writes — the blackboard is finalized once per build. |
| `lib/gsd-prompt.js` | new | `buildTaskDescription({ task, slice, upstreamTasks, gateCommands })` — produces the rich `description` STRING that gets packed into each TaskGraph node by the `decompose_gsd` agent. (Stratum's parallel_dispatch only interpolates `{task.id\|description\|files_owned\|files_read\|depends_on\|index}` and `{input.<field>}` per `stratum-mcp/src/stratum_mcp/spec.py:567-590` — every other context payload must ride inside `description`.) The function emits a multi-section string: (1) Symbols you must produce; (2) Symbols you may consume from upstream tasks; (3) Boundary Map slice verbatim; (4) Upstream tasks summary (one line per upstream listing its declared produces); (5) GATES list with each command from `gateCommands`; (6) "fix and re-run within this invocation; do NOT declare done while gates are red." Used by `gsd.js` to validate decompose_gsd output and as a programmatic alternative if the decompose agent fails to bake descriptions itself. |
| `lib/gsd-decompose-enrich.js` | new | Pure function `enrichTaskGraph(taskGraph, blueprintText) → TaskGraphGsd`. Calls `parseBoundaryMap(blueprintText)` (`lib/boundary-map.js:41`), maps each TaskGraph node to its Boundary Map slice (slice's File Plan files ⊆ task `files_owned`), and attaches `produces`/`consumes` symbol arrays. **Throws** when Boundary Map is empty or has parse violations — v1 hard-requires `validateBoundaryMap(...).ok === true`. |
| `pipelines/gsd.stratum.yaml` | new | Three-step flow with GSD-specific intents (NOT copies of build.stratum.yaml). See "Pipeline Spec Sketch" below. |
| `contracts/taskgraph-gsd.json` | new | JSON Schema. Extends Stratum's bare TaskGraph (`tasks: array`) with required `produces` and `consumes` per node. Each `produces` entry: `{file, symbols, kind}`; each `consumes`: `{from, file, symbols}`. |
| `contracts/task-result.json` | new | JSON Schema for the worktree-written `TaskResult`: `{ status: "passed"\|"failed", files_changed: string[], summary: string, produces: { [symbol]: string }, gates: Array<{command: string, status: "pass"\|"fail", output: string}>, attempts: number }`. `gates` is an array (not an object keyed by lint/build/test) so it supports arbitrary project-configured `gateCommands`. The `merge_sha` field from design.md is dropped — the agent doesn't commit; Stratum's parallel_dispatch + Compose's `applyServerDispatchDiffsCore` (`lib/build.js:3077`) handle merging. The agent writes this file at `.compose/gsd/<featureCode>/results/<task_id>.json` (per-task, no collisions) and includes it in its diff; after step completion, `runGsd` reads all such files from the merged base cwd. |
| `lib/build.js` | NO modification needed | The post-execution blackboard walk happens in `runGsd` after `executeParallelDispatchServer` returns — no taskHook plumbing required. Removing the optional-parameter extension that earlier drafts proposed; build.js stays untouched in v1. |
| `test/gsd.test.js` | new | Golden flow: scaffold a fixture feature with blueprint+Boundary Map, run `compose gsd <code>` against a fake repo, assert blackboard.json populated with TaskResult per task, assert task N+1's prompt contained task N's produces. |
| `test/gsd-decompose-enrich.test.js` | new | Unit: enrich with valid Boundary Map; throws on empty; throws on slice/task File Plan mismatch. |
| `test/gsd-prompt.test.js` | new | Unit: prompt contains all four sources; upstream filtered correctly by `depends_on`; gateCommands rendered. |
| `test/gsd-blackboard.test.js` | new | Unit: read/write round-trip; lock contention; upstream filtering. |
| `CHANGELOG.md` | modify (later) | Entry on ship |
| `ROADMAP.md` | modify (later) | Mark COMP-GSD-2 COMPLETE |
| `CLAUDE.md` | modify (maybe) | Document `compose gsd` verb if user-facing surface emerges |

---

## Pipeline Spec Sketch

`pipelines/gsd.stratum.yaml` (illustrative — exact YAML finalized in plan):

```yaml
version: "0.3"
workflow:
  name: gsd
  description: "Per-task fresh-context dispatch from existing blueprint+Boundary Map"
  input:
    featureCode: { type: string, required: true }
    gateCommands: { type: array, required: true }   # injected by runGsd from loadProjectConfig() with default fallback

contracts:
  TaskGraphGsd:
    tasks: { type: array }   # each task has id, files_owned, files_read, depends_on, description (rich prompt fragment)
  PhaseResult:
    phase: { type: string }
    artifact: { type: string }
    outcome: { type: string }
    summary: { type: string }

flows:
  gsd:
    input:
      featureCode: { type: string }
      gateCommands: { type: array }
    output: PhaseResult
    steps:
      - id: decompose_gsd
        type: decompose
        agent: claude
        intent: >
          Read docs/features/{input.featureCode}/blueprint.md including its
          ## Boundary Map section. Decompose into independent tasks.

          For each task emit: id, files_owned, files_read, depends_on,
          AND a rich `description` string that is a complete prompt fragment
          containing all the spec context downstream interpolation can't carry:

            - "Symbols you must produce:" + the task's slice produces (file → symbol (kind))
            - "Symbols you may consume from upstream tasks:" + the task's slice consumes
            - "Boundary Map slice (the contract):" + verbatim slice from blueprint
            - "Upstream tasks (spec-level summary):" + one-line summary per upstream task
              listing its declared produces (so this task knows what symbols/files
              upstream tasks will land at end-of-step merge)
            - "GATES — you MUST run these and they MUST pass before declaring done:"
              + each command from the gateCommands list (passed via $.input.gateCommands)
            - "When gates fail, fix and re-run within this invocation. Do NOT declare
              done while any gate is red."

          Stratum's parallel_dispatch only interpolates {task.id}, {task.description},
          {task.files_owned}, {task.files_read}, {task.depends_on}, {task.index},
          {input.<field>}. Pack everything else into description.

          Each Boundary Map slice maps to exactly one task whose files_owned ⊇ the
          slice's File Plan files.
        inputs:
          featureCode: "$.input.featureCode"
          gateCommands: "$.input.gateCommands"
        output_contract: TaskGraphGsd
        ensure:
          - "no_file_conflicts(result.tasks)"
          - "len(result.tasks) >= 1"
        retries: 2

      - id: execute
        type: parallel_dispatch
        source: "$.steps.decompose_gsd.output.tasks"
        agent: claude
        max_concurrent: 1
        isolation: worktree
        capture_diff: true
        require: all
        merge: sequential_apply
        retries: 2
        intent_template: >
          Implement task {task.id} using TDD.
          Files you own (write): {task.files_owned}
          Files you may read: {task.files_read}
          Depends on: {task.depends_on}

          {task.description}

          When done, write TaskResult JSON to
          .compose/gsd/{input.featureCode}/results/{task.id}.json
          (schema: contracts/task-result.json) and INCLUDE that file in your diff.
        depends_on: [decompose_gsd]

      - id: ship_gsd
        agent: "claude::critical"
        intent: >
          Final verification. Run npm test and npx vite build.
          Update ROADMAP.md (mark COMP-GSD-2 COMPLETE) and CHANGELOG.md.
          Commit and push. Report commit hash and files_changed.
        inputs:
          featureCode: "$.input.featureCode"
        output_contract: PhaseResult
        ensure:
          - "result.outcome == 'complete'"
        retries: 2
        depends_on: [execute]
```

Note the differences from `build.stratum.yaml`'s steps: `decompose_gsd` reads blueprint.md not plan.md and requires `produces` per task; `execute` has `max_concurrent: 1` and a richer template; `ship_gsd` does not check for plan.md/report.md/docs.

---

## Implementation Order

1. **Contracts first** — `contracts/taskgraph-gsd.json`, `contracts/task-result.json`. Typed seams everything else depends on.
2. **`lib/gsd-blackboard.js`** + `test/gsd-blackboard.test.js`. Pure I/O (read + writeAll + validate).
3. **`lib/gsd-decompose-enrich.js`** + `test/gsd-decompose-enrich.test.js`. Pure function over `parseBoundaryMap` output. Throws on `validateBoundaryMap(...).ok === false`.
4. **`lib/gsd-prompt.js`** + `test/gsd-prompt.test.js`. Pure string assembly of the intent template.
5. **`pipelines/gsd.stratum.yaml`**. Validate via `stratum_validate`.
6. **`lib/gsd.js`** + `bin/compose.js` verb. Wires it together. Includes the post-step blackboard walk.
7. **`test/gsd.test.js`** — fixture-driven golden flow.

This is also the dependency order — no item depends on a later item. `lib/build.js` is untouched.

---

## Boundary Map

### S01: Contracts

File Plan: `contracts/taskgraph-gsd.json` (new), `contracts/task-result.json` (new)

Produces:
  contracts/taskgraph-gsd.json → TaskGraphGsd (type)
  contracts/task-result.json → TaskResult (type)

Consumes: nothing

### S02: Blackboard I/O

File Plan: `lib/gsd-blackboard.js` (new), `test/gsd-blackboard.test.js` (new)

Produces:
  lib/gsd-blackboard.js → read, writeAll, validate (function)

Consumes:
  from S01: contracts/task-result.json → TaskResult (type)

### S03: Decompose enrichment

File Plan: `lib/gsd-decompose-enrich.js` (new), `test/gsd-decompose-enrich.test.js` (new)

Produces:
  lib/gsd-decompose-enrich.js → enrichTaskGraph (function)

Consumes:
  from S01: contracts/taskgraph-gsd.json → TaskGraphGsd (type)

### S04: Prompt assembly

File Plan: `lib/gsd-prompt.js` (new), `test/gsd-prompt.test.js` (new)

Produces:
  lib/gsd-prompt.js → buildTaskDescription (function)

Consumes:
  from S01: contracts/task-result.json → TaskResult (type)
  from S03: lib/gsd-decompose-enrich.js → enrichTaskGraph (function)

### S05: Pipeline spec

File Plan: `pipelines/gsd.stratum.yaml` (new)

Produces:
  pipelines/gsd.stratum.yaml → gsdFlow (const)

Consumes: nothing

### S06: Lifecycle entry

File Plan: `lib/gsd.js` (new), `bin/compose.js` (modify near line 113)

Produces:
  lib/gsd.js → runGsd (function)
  bin/compose.js → gsdVerb (const)

Consumes:
  from S01: contracts/task-result.json → TaskResult (type)
  from S02: lib/gsd-blackboard.js → writeAll (function)
  from S03: lib/gsd-decompose-enrich.js → enrichTaskGraph (function)
  from S04: lib/gsd-prompt.js → buildTaskDescription (function)
  from S05: pipelines/gsd.stratum.yaml → gsdFlow (const)

## Corrections Table

| Spec Assumption | Reality | Resolution |
|----------------|---------|------------|
| Stratum's `claude` connector is "less native" than Agent tool dispatch (design.md Decision 1) | Each `claude` connector spawn is already a fresh subprocess; observability is via `parallelPoll` events streamed through `lib/build.js:2937`. Switching to the Agent tool would lose existing event plumbing. | Keep Stratum-spawned per-task agents. The "hybrid" claim from design.md is dropped in v1 — Stratum dispatches; Compose runs a post-step blackboard walk over committed per-task result files. No mid-step hook. |
| GSD-2 needs "no worktree, defer to GSD-3" or "stash" choices (design.md Decision 3) | `parallel_dispatch` with `isolation: worktree` + `defer_advance: true` already gives worktree-per-task with deferred merge (`lib/build.js:3000`). | Drop the option from scope discussion. GSD-2 reuses `isolation: worktree`. |
| Per-task gate-fail bounces task back with appended prompt (design.md Decision 4) | `parallelAdvance` (`lib/stratum-mcp-client.js:450`) only accepts `'clean'\|'conflict'`. There is NO task-level retry channel after `awaiting_consumer_advance`. | Move gates *inside* the task agent's intent. Agent runs gates as part of its own TDD loop and refuses to declare done until clean. Stratum's existing per-task `retries: 2` handles transient failure; if the agent gives up, the task returns failure and `require: all` causes the parent step to fail. |
| Blackboard provides runtime handoff: task N+1's prompt sees task N's realized produces (design.md Decision 4) | `executeParallelDispatchServer` (`lib/build.js:2894-2961`) polls until the **whole** parallel_dispatch step reaches `outcome` and applies all task diffs in one pass at `:2997-3024`. There is no per-task interposition even with `max_concurrent: 1`. The runtime channel does not exist. | v1: drop runtime handoff. Tasks see *spec-level* upstream context only — Boundary Map declares what each upstream task will produce; Stratum interpolates the TaskGraph into each task's intent. Realized handoff requires either a Stratum protocol extension (pre-task callbacks) or one-step-per-task pipeline generation; both are out of scope. v1 blackboard is a post-execution capture: `runGsd` walks the merged base cwd after the step completes, reads each task's `.compose/gsd/<code>/results/<task_id>.json` (which the agent committed as part of its diff), and writes `blackboard.json` once. Used by GSD-7 milestone reports and retros. |
| Per-task hook reads `<worktree>/.compose-task-result.json` from `pollResult.tasks` | `pollResult.tasks` exposes only per-task state + diff metadata (per `test/parallel-dispatch-server-defer.test.js:69` and `:3193-3200` of build.js). No worktree path or arbitrary task artifact is exposed. The hook had nothing to read. | The hook is removed entirely. The agent COMMITS `.compose-task-result.json` as a tracked file in its diff. After `applyServerDispatchDiffsCore` runs, the file lives in the merged base cwd at a deterministic path (`./.compose-task-result.json` per task — but since all tasks land in one cwd, we use `./.compose/gsd/<code>/results/<task_id>.json` instead). `runGsd` reads them all post-step. |
| Boundary Map presence check uses `parseBoundaryMap(...).slices.length >= 1` | `parseBoundaryMap` returns slices alongside parse violations; malformed maps with at least one slice would still pass. | Switch to `validateBoundaryMap({...}).ok === true` (`lib/boundary-map.js:275`). Rejects parse violations and slice-level structural errors. |
| `gateCommands` defaults to `["pnpm lint", "pnpm build", "pnpm test"]` via `loadProjectConfig()` | `loadProjectConfig()` (`server/project-root.js:109-118`) returns the raw `.compose/compose.json` when present and does NOT merge missing keys with `DEFAULT_CONFIG`. So `gateCommands` will be `undefined` for any existing project that hasn't added it. | `runGsd` does its own fallback: `const gateCommands = loadProjectConfig().gateCommands ?? ["pnpm lint", "pnpm build", "pnpm test"]`. No change to `loadProjectConfig` itself. |
| `pipelines/gsd.stratum.yaml` is "95% copy" of build.stratum.yaml (earlier blueprint draft) | Existing `decompose` reads plan.md (not blueprint.md); existing `ship` checks for plan.md/report.md/docs that GSD doesn't produce. Reusing intents verbatim would feed wrong inputs. | Author GSD-specific intents for `decompose_gsd` and `ship_gsd` (see Pipeline Spec Sketch). Share step *type* (`type: decompose`, `type: parallel_dispatch`), not step *intent*. |
| Boundary Map enrichment is a "no-op when absent" + open question Q1 errors out only on missing blueprint.md (earlier blueprint draft) | The two were contradictory. design.md leaned toward fallback; Q1 leaned toward hard requirement. | Hard-require Boundary Map for v1. `runGsd` checks `validateBoundaryMap({...}).ok === true` (`lib/boundary-map.js:275`) and errors out otherwise. `enrichTaskGraph` throws on empty/invalid. File-granular fallback is explicitly out of scope until a real use case appears. |
| File paths in design.md / earlier blueprint draft prefixed with `compose/` | The repo root IS `compose/` (cwd of all builds, all CLI invocations). Literal paths must drop the prefix. | All File Plan and Boundary Map paths now repo-relative (`bin/compose.js`, `lib/gsd.js`, etc.). |
| `gateCommands` schema added to `feature-json.schema.json` (earlier blueprint draft) | `feature-json.schema.json` governs per-feature `docs/features/<code>/feature.json`, not project config. Project config is loaded via `loadProjectConfig` in `server/project-root.js:109` from `.compose/compose.json` and currently has no JSON Schema. | Add `gateCommands` field to `.compose/compose.json` via `loadProjectConfig`; defaults to `["pnpm lint", "pnpm build", "pnpm test"]`. A formal schema for compose.json is out of scope here (separate hygiene task if wanted). |
| Lock pattern referenced `compose/lib/active-build.js` (earlier blueprint draft) | That file does not exist. The active-build state machinery lives inline in `lib/build.js:381-469`; the canonical advisory-lock pattern lives in `lib/completion-writer.js:48-67` and `lib/idempotency.js:42`. | `lib/gsd-blackboard.js` mirrors `completion-writer.js`'s mkdir-advisory-lock at `.compose/data/locks/gsd-<code>.lock`. |
| Agent tool's `isolation: "worktree"` semantics (design.md "Unproven assumptions") | Moot — we're not using the Agent tool detour. Stratum's worktree isolation is what we use, and it's already in production. | Removed from open questions. |

---

## Open Questions Resolved by Blueprint

- **Q1 (where does `compose gsd` start)** — Resolved: error out if `blueprint.md` is absent OR `validateBoundaryMap({...}).ok !== true`. `runGsd` validates preconditions before calling `stratum.plan`. Fix message: "run `compose build --through blueprint` first."
- **Q2 (gate command resolution)** — Resolved: `runGsd` reads `gateCommands` from `loadProjectConfig().gateCommands` and falls back to `["pnpm lint", "pnpm build", "pnpm test"]` when undefined (loader does NOT merge defaults). No `loadProjectConfig` change.
- **Q3 (retry cap)** — Resolved: per-task `retries: 2` declared in `pipelines/gsd.stratum.yaml`. Per-feature stop is GSD-4 territory (deferred).
- **Q4 (cockpit live view)** — Resolved: existing `executeParallelDispatchServer:2870-2887` (`emitPerTaskProgress`) already streams `build_task_start`/`build_task_done` events with parallel:true. Cockpit already consumes these for review steps. No new event subtype in v1 (no per-task hook left to emit anything new).

---

## Out of Scope (still)

Per design.md "Out of scope": parallelism (GSD-3), budget ceilings (GSD-4), stuck detection (GSD-5), headless+resume (GSD-6), milestone report (GSD-7), file-granular Boundary Map fallback (no use case until file-only features appear). The blueprint does not introduce code that would block any of these — each is additive to the seams introduced here.

# COMP-GSD-2: Per-Task Fresh-Context Dispatch — Implementation Blueprint

**Status:** BLUEPRINT
**Date:** 2026-05-10
**Design:** [design.md](design.md)

---

## Reframing (after blueprint discovery)

The design called this a "third lifecycle mode that introduces fresh-context dispatch." That framing was wrong: `compose/pipelines/build.stratum.yaml:340-359` already runs `parallel_dispatch` with `isolation: worktree` + `defer_advance: true` + `merge: sequential_apply` + per-task `claude` connector subprocesses (which are already fresh-context). And `compose/lib/build.js:2894` (`executeParallelDispatchServer`) is the consumer-side handler that already deferred-merges per-task diffs back to the base cwd in topological order.

So GSD-2's actual scope, expressed in deltas to existing primitives:

1. **CLI entry** — new `compose gsd <code>` verb that dispatches into a *narrowed* version of the build pipeline starting at `decompose`, reading existing `blueprint.md` + Boundary Map.
2. **Pipeline** — new `pipelines/gsd.stratum.yaml` with three real steps: `decompose → execute → ship`. The `execute` step inherits 95% of `build.stratum.yaml`'s shape but with `max_concurrent: 1` and a richer `intent_template` that interpolates Boundary Map symbols + upstream `TaskResult` blackboard.
3. **Decompose enrichment** — when the feature folder contains a Boundary Map, decompose's TaskGraph nodes carry symbol-level `produces` / `consumes` per task (today they only carry `files_owned`/`files_read`).
4. **Per-task gate sub-loop** — currently `build.stratum.yaml` runs review/coverage *after* all tasks complete. GSD-2 runs lint/build/test inside each task's worktree before squash-merge; failure bounces the task with the gate output appended to its prompt (capped retries).
5. **TaskResult blackboard** — a typed JSON file at `.compose/gsd/<code>/blackboard.json` that captures each task's realized produces (mapping Boundary Map symbols → file paths, signatures), so downstream tasks see the contract realized in code, not just the spec.

Decisions 4 & 5 are the load-bearing novelty. The rest is configuration of existing machinery.

---

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| `compose/bin/compose.js` | modify | Add `gsd` verb dispatch alongside `build`/`fix` (around line 113 help text + main verb switch) |
| `compose/lib/gsd.js` | new | `runGsd(featureCode, opts)` — entry point. Validates blueprint+boundary-map exist; loads `pipelines/gsd.stratum.yaml`; calls `stratum.plan`; runs the same status-loop pattern as `runBuild` (`compose/lib/build.js:938`); installs the per-task gate callback. |
| `compose/lib/gsd-dispatch.js` | new | Per-task callback registered with `executeParallelDispatchServer`'s deferred-merge path. For each task: (a) Stratum spawns the agent in its own worktree (existing behavior); (b) on poll completion, our callback runs lint/build/test inside the worktree; (c) on pass, write `TaskResult` to blackboard, signal `parallelAdvance(... 'clean')`; (d) on fail, signal a retry with gate output, capped at retries declared in the gsd pipeline. |
| `compose/lib/gsd-blackboard.js` | new | Read/write `.compose/gsd/<code>/blackboard.json` with file lock (use `proper-lockfile` already in deps if present, or simple .lock file pattern from `compose/lib/active-build.js`). Provides `read(code)`, `writeTask(code, taskId, result)`, `upstreamFor(code, taskId, taskGraph)`. |
| `compose/lib/gsd-prompt.js` | new | `buildTaskPrompt({ task, blueprintPath, boundaryMapSlice, upstream, gateCommands })` — assembles the four-source prompt described in design.md Decision 4. Reuses `parseBoundaryMap` from `compose/lib/boundary-map.js:41` to extract the slice for this task. |
| `compose/lib/gsd-decompose-enrich.js` | new | Post-processor that runs after Stratum's `decompose` step returns a `TaskGraph`. Calls `parseBoundaryMap(blueprintText)` (`compose/lib/boundary-map.js:41`), maps each TaskGraph node to its Boundary Map slice by `files_owned` overlap, and attaches `produces`/`consumes` symbol arrays to each node. No-op when Boundary Map is absent. |
| `compose/pipelines/gsd.stratum.yaml` | new | Three-step flow. `decompose` is identical to `build.stratum.yaml:324-337`. `execute` mirrors `build.stratum.yaml:340-359` but with `max_concurrent: 1`, `retries: 2` (per-task bounce cap), and `intent_template` extended to inject `{boundary_map_slice}` + `{upstream_blackboard}` placeholders. `ship` mirrors `build.stratum.yaml:447-486`. |
| `compose/contracts/taskgraph-gsd.json` | new | JSON Schema for the enriched TaskGraph (extends Stratum's bare TaskGraph with optional `produces` and `consumes` arrays per node). Referenced from `compose/lib/gsd-decompose-enrich.js`. |
| `compose/contracts/task-result.json` | new | JSON Schema for `TaskResult` blackboard entry: `{ status, files_changed, summary, produces, gate, merge_sha, attempts }` per design.md Decision 4. |
| `compose/lib/build.js` | modify | At the consumer-dispatch path (around `:2997` `if (hasServerMerge)` block) — add a hook so a registered per-task gate callback runs *before* the diff is applied to base cwd. Keep the existing zero-callback behavior as default; only `runGsd` registers the callback. Concretely: extend `applyServerDispatchDiffsCore` signature with optional `taskGateCallback` parameter, threaded through from `executeParallelDispatchServer`. |
| `compose/test/gsd.test.js` | new | Golden flow: scaffold a fixture feature with blueprint+boundary-map, run `compose gsd <code>` end-to-end against a fake repo, assert blackboard.json populated, assert sequential ordering, assert bounce-back on injected gate failure. |
| `compose/test/gsd-decompose-enrich.test.js` | new | Unit: enrich a TaskGraph with/without Boundary Map; verify slice→task mapping; verify no-op when Boundary Map absent. |
| `compose/test/gsd-prompt.test.js` | new | Unit: prompt assembly, upstream filtering by `depends_on`. |
| `compose/CHANGELOG.md` | modify (later) | Entry on ship |
| `compose/ROADMAP.md` | modify (later) | Mark COMP-GSD-2 COMPLETE |
| `compose/CLAUDE.md` | modify (maybe) | Document `compose gsd` verb if user-facing surface emerges |

---

## Implementation Order

1. **Contracts first** — `contracts/taskgraph-gsd.json`, `contracts/task-result.json`. These are the typed seams everything else depends on.
2. **`gsd-blackboard.js`** + tests. Pure I/O, easy to verify.
3. **`gsd-decompose-enrich.js`** + tests. Pure function over `parseBoundaryMap` output.
4. **`gsd-prompt.js`** + tests. Pure string assembly.
5. **`pipelines/gsd.stratum.yaml`**. Static; easy to validate via `stratum_validate`.
6. **`gsd-dispatch.js`** — the per-task gate callback. Hardest piece because it interacts with the worktree returned by Stratum.
7. **`build.js` hook plumbing** — minimal touch: add the optional `taskGateCallback` parameter and call it before merge.
8. **`gsd.js`** + `bin/compose.js` verb. Wires everything together.
9. **Golden flow test** — fixture feature, end-to-end.

This is also the dependency order; no item depends on a later item.

---

## Boundary Map

### S01: Contracts

File Plan: `compose/contracts/taskgraph-gsd.json` (new), `compose/contracts/task-result.json` (new)

Produces:
  compose/contracts/taskgraph-gsd.json → TaskGraphGsd (type)
  compose/contracts/task-result.json → TaskResult (type)

Consumes: nothing

### S02: Blackboard I/O

File Plan: `compose/lib/gsd-blackboard.js` (new), `compose/test/gsd-blackboard.test.js` (new)

Produces:
  compose/lib/gsd-blackboard.js → read, writeTask, upstreamFor (function)

Consumes:
  from S01: compose/contracts/task-result.json → TaskResult (type)

### S03: Decompose enrichment

File Plan: `compose/lib/gsd-decompose-enrich.js` (new), `compose/test/gsd-decompose-enrich.test.js` (new)

Produces:
  compose/lib/gsd-decompose-enrich.js → enrichTaskGraph (function)

Consumes:
  from S01: compose/contracts/taskgraph-gsd.json → TaskGraphGsd (type)

### S04: Prompt assembly

File Plan: `compose/lib/gsd-prompt.js` (new), `compose/test/gsd-prompt.test.js` (new)

Produces:
  compose/lib/gsd-prompt.js → buildTaskPrompt (function)

Consumes:
  from S01: compose/contracts/task-result.json → TaskResult (type)
  from S03: compose/lib/gsd-decompose-enrich.js → enrichTaskGraph (function)

### S05: Pipeline spec

File Plan: `compose/pipelines/gsd.stratum.yaml` (new)

Produces:
  compose/pipelines/gsd.stratum.yaml → gsdFlow (const)

Consumes: nothing

### S06: Per-task gate callback

File Plan: `compose/lib/gsd-dispatch.js` (new)

Produces:
  compose/lib/gsd-dispatch.js → taskGateCallback (function)

Consumes:
  from S02: compose/lib/gsd-blackboard.js → read, writeTask (function)
  from S04: compose/lib/gsd-prompt.js → buildTaskPrompt (function)

### S07: build.js hook

File Plan: `compose/lib/build.js` (edit near `:2997`)

Produces:
  compose/lib/build.js → applyServerDispatchDiffsCore (function)

Consumes:
  from S06: compose/lib/gsd-dispatch.js → taskGateCallback (function)

### S08: Lifecycle entry

File Plan: `compose/lib/gsd.js` (new), `compose/bin/compose.js` (modify near line 113)

Produces:
  compose/lib/gsd.js → runGsd (function)
  compose/bin/compose.js → gsdVerb (const)

Consumes:
  from S05: compose/pipelines/gsd.stratum.yaml → gsdFlow (const)
  from S06: compose/lib/gsd-dispatch.js → taskGateCallback (function)
  from S07: compose/lib/build.js → applyServerDispatchDiffsCore (function)

## Corrections Table

| Spec Assumption | Reality | Resolution |
|----------------|---------|------------|
| Stratum's `claude` connector is "less native to Compose" than Agent tool dispatch (design.md Decision 1) | Each `claude` connector spawn is already a fresh subprocess with no shared context; observability is via `parallelPoll` events streamed through `executeParallelDispatchServer:2937`. Native enough; switching to Agent tool would lose the existing event plumbing. | Keep Stratum-spawned per-task agents. The "hybrid" is now: Stratum dispatches; Compose's per-task callback handles the gate sub-loop and blackboard. No Agent-tool detour. |
| GSD-2 needs "no worktree, defer to GSD-3" or "stash" choices (design.md Decision 3) | `parallel_dispatch` with `isolation: worktree` + `defer_advance: true` already gives worktree-per-task with deferred merge. Existing code at `lib/build.js:3000` applies diffs in topological order. | Drop the option from scope discussion. GSD-2 reuses `isolation: worktree`; the only delta is the per-task gate callback inserted before merge. |
| `pipelines/gsd.stratum.yaml` is mostly net-new (design.md "## Files") | It's a 95% copy of three steps from `build.stratum.yaml` (`decompose`, `execute`, `ship`). The novelty is `max_concurrent: 1` + extended `intent_template`. | Frame the spec as a slice of build.stratum.yaml, not a parallel pipeline universe. |
| Boundary Map symbols are "consumed by downstream tasks" via prompt injection | Today `parseBoundaryMap` returns `{slices, parseViolations}` per `compose/lib/boundary-map.js:41`. Slices are tied to file paths via the File Plan section. We'll need a `slices→task` mapper based on `files_owned` overlap. | Build that mapper in `gsd-decompose-enrich.js` (Slice S03). Document the matching rule: a slice maps to a task iff the slice's File Plan files ⊆ the task's `files_owned`. |
| `executeParallelDispatchServer` accepts a per-task gate callback (implied by design.md) | It does not today. The deferred-merge branch at `lib/build.js:2997-3024` calls `applyServerDispatchDiffsCore` directly with no callback hook. | Extend `applyServerDispatchDiffsCore` signature with optional `taskGateCallback`. Default null preserves existing behavior. New parameter threaded through from `executeParallelDispatchServer`. |
| Agent tool's `isolation: "worktree"` semantics (design.md "Unproven assumptions") | This was the design's escape hatch. Now moot — we're not using the Agent tool detour. Stratum's worktree isolation is what we use, and it's already in production. | Removed from open questions. |

---

## Open Questions Resolved by Blueprint

- **Q1 (where does `compose gsd` start)** — Resolved: error out if `blueprint.md` or Boundary Map is absent. `runGsd` validates artifact preconditions before calling Stratum.
- **Q2 (gate command resolution)** — Resolved: read `gateCommands` array from `.compose/compose.json`; default `["pnpm lint", "pnpm build", "pnpm test"]`. Schema added to `feature-json.schema.json` extension.
- **Q3 (retry cap)** — Resolved: per-task `retries: 2` declared in `pipelines/gsd.stratum.yaml`. Per-feature stop is GSD-4 territory (deferred).
- **Q4 (cockpit live view)** — Resolved: existing `executeParallelDispatchServer:2870-2887` (`emitPerTaskProgress`) already streams `build_task_start`/`build_task_done` events with parallel:true. Cockpit already consumes these for review steps. New per-task gate callback emits an additional `build_task_gate` event subtype (small extension to `streamWriter` payload schema).

---

## Out of Scope (still)

Per design.md "Out of scope": parallelism (GSD-3), budget ceilings (GSD-4), stuck detection (GSD-5), headless+resume (GSD-6), milestone report (GSD-7). The blueprint does not introduce any code that would block these — each is additive to the seams introduced here.

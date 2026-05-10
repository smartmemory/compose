# COMP-GSD-2: Per-Task Fresh-Context Dispatch — Design

**Status:** DESIGN
**Date:** 2026-05-10

## Related Documents

- Roadmap: `compose/ROADMAP.md` § COMP-GSD (this row is GSD-2)
- Parent initiative: `docs/features/COMP-GSD/`
- Upstream sibling (shipped): `docs/features/COMP-GSD-1/` — Boundary Map artifact
- Downstream siblings (planned): GSD-3 (worktree+merge-queue), GSD-4 (budget ceilings), GSD-5 (stuck detection), GSD-6 (headless+resume), GSD-7 (milestone report)
- Existing primitives reused:
  - `compose/lib/build.js:3256` — `executeParallelDispatch` (consumer-side, worktree per task)
  - `compose/lib/build.js:2880` — `executeParallelDispatchServer` (Stratum-driven)
  - `compose/lib/stratum-mcp-client.js:416–456` — parallel start/poll/advance/done
  - `stratum-mcp/src/stratum_mcp/parallel_exec.py:142` — Stratum's `ParallelExecutor`
  - `stratum-mcp/src/stratum_mcp/server.py:133` — `stratum_agent_run`
  - `compose/pipelines/build.stratum.yaml` — existing `parallel_dispatch` step shape; existing `decompose` step (file-granular)

---

## Problem

Compose's Phase 7 today runs every task of a feature inside a single Claude session. `stepHistory` (`lib/build.js:923, 1203`) accumulates across the entire build, and the orchestrator's context window grows monotonically with the work. For features that exceed a single context window — multi-component refactors, long autonomous runs, anything that wants to keep going across days — Compose has no answer. The existing `executeParallelDispatch` is built for *review* (multi-lens), not *implementation*: it fans out, doesn't sequence, and was never wired to a feature's blueprint.

Reference projects (gsd-build, gsd-2, kangentic) solve this by giving each work unit its own context window and declaring up-front what crosses the boundary. Compose's Boundary Map (GSD-1, shipped) gives us the contract; what's missing is the dispatcher that actually runs each task in fresh context and pipes the typed handoff between them.

## Goal

Add a third lifecycle mode `compose gsd <feature>` that takes a feature with a verified blueprint and decomposes it into tasks, each dispatched as a fresh-context Claude Code Agent in its own worktree, with results piped between tasks via a typed `TaskResult` blackboard. Sequential by default (one task at a time); parallelism is a later sub-feature's concern (GSD-3's merge queue).

**In scope (v1):**
- New CLI verb `compose gsd <feature>` and `runGsd()` entry
- `pipelines/gsd.stratum.yaml` flow with steps: `decompose → dispatch → ship` (with internal per-task gate sub-loop)
- New `decompose` step that reads `blueprint.md` + `boundary-map.md` and emits validated `taskgraph.json`
- Hybrid dispatcher: Stratum's `parallel_dispatch` with `max_concurrent: 1` and `defer_advance: true`; Compose's per-task callback uses Claude Code's Agent tool with `isolation: "worktree"`
- Canonical `TaskResult` JSON contract; blackboard at `.compose/gsd/<feature>/blackboard.json`
- Per-task gate: lint/build/test on the worktree; squash-merge to feature branch on pass; bounce-back-to-task on fail (capped retries)

**Out of scope (deferred):**
- Parallelism + merge queue + conflict bounce-back (GSD-3 — narrowed)
- Budget ceilings and hard stops (GSD-4)
- Stuck detection (GSD-5)
- Headless mode + crash recovery (GSD-6)
- Milestone HTML report (GSD-7)

---

## Decision 1: Hybrid dispatch — Stratum schedules, Compose dispatches

**Considered:**
- Pure Stratum `parallel_dispatch` with `max_concurrent: 1`: free dependency DAG and result aggregation, but each task agent is a Stratum-spawned connector (`stratum_agent_run` invokes claude/codex via subprocess). Less native to Compose's session, harder to surface live in cockpit OpsStrip, and we'd lose Claude Code's native worktree primitive.
- Pure consumer-dispatch (extend `executeParallelDispatch`): native Agent tool calls, easy to stream into the cockpit. But we'd reimplement `depends_on` topology and result aggregation that STRAT-PAR already shipped.

**Chosen:** Hybrid. Stratum owns the TaskGraph DAG, scheduling, and aggregate roll-up via the existing `parallel_dispatch` machinery; Compose owns per-task agent dispatch via the Agent tool. Mechanism: declare the GSD step with `defer_advance: true` (already supported per `lib/build.js:2998`) so Stratum hands Compose each ready task and waits for `parallelAdvance` with the merge result instead of spawning its own connector.

This is essentially how `executeParallelDispatchServer` works today for review — we widen the same shape to "implementation tasks" with `max_concurrent: 1` set by the gsd pipeline.

## Decision 2: Decompose step reads blueprint + Boundary Map

**Considered:**
- Boundary Map IS the TaskGraph: tightest coupling; forces Boundary Map presence; can't represent non-symbol-bounded tasks like "add the gsd CLI verb."
- Reuse Phase 6 plan.md tasks: plan.md is human prose, not a typed contract; coupling GSD-2 to plan.md format is a hostage situation.

**Chosen:** New `decompose` step that reads both `blueprint.md` and `boundary-map.md`, emits a validated `TaskGraph` with file+symbol granularity, and writes it to `docs/features/<code>/taskgraph.json`. STRAT-PAR's existing `decompose` step (file-granular, in `build.stratum.yaml`) is the starting point; GSD's variant enriches each node with `produces`/`consumes` symbols when Boundary Map is present, falls back to file-granular when it's not. The artifact is a gateable seam — bad decomposition gets caught before any agent dispatches.

## Decision 3: Worktree-per-task isolation in v1

**Considered:** No worktree (sequential same-dir, defer to GSD-3); stash-based snapshots (cheap but leaky).

**Chosen:** Each task agent dispatch uses Claude Code's Agent tool with `isolation: "worktree"`. The runtime creates a worktree, the agent runs in it, the runtime cleans up automatically when the agent finishes (or returns the path + branch if changes exist). Per the Agent tool contract: "the worktree is automatically cleaned up if the agent makes no changes; otherwise the path and branch are returned in the result."

Compose's per-task callback then runs the gate (lint/build/test) inside the worktree, and on pass executes a squash-merge of the returned branch into the feature branch. On gate failure, the worktree is preserved and the task retries with the failure attached to its prompt (capped at the retry count declared in the gsd pipeline's `dispatch` step).

This pulls scope forward from GSD-3 — but the isolation primitive is essentially free, and shipping GSD-2 without it would mean shipping a known-leaky mode. GSD-3's remaining scope narrows to: parallelism (raising `max_concurrent`), a real merge queue, and conflict bounce-back protocol.

## Decision 4: Canonical `TaskResult` + blackboard handoff

Each task agent's prompt is assembled from four sources in priority order:

1. **Task intent** (from TaskGraph node): goal, file paths, symbols to produce/consume, acceptance criteria
2. **Blueprint excerpt** (Boundary Map slice for this task — the contract)
3. **Upstream task results** (from blackboard, filtered to tasks this one `depends_on`)
4. **Standing context**: feature design.md path, repo conventions, gate command list

After each task completes, Compose writes the result to `.compose/gsd/<feature>/blackboard.json` keyed by task id:

```json
{
  "<task_id>": {
    "status": "passed" | "failed" | "bounced",
    "files_changed": ["path/to/file.js"],
    "summary": "<one-paragraph what was done, machine-readable>",
    "produces": { "<symbol>": "<one-line shape>" },
    "gate": { "lint": "pass", "build": "pass", "test": "pass" },
    "merge_sha": "abc1234",
    "attempts": 1
  }
}
```

The `produces` field is the Boundary Map contract realized in code; downstream tasks see it in their prompt as "you may consume these symbols, with these shapes." This is the load-bearing handoff that makes fresh-context tasks work.

## Decision 5: New top-level CLI verb

`compose gsd <feature>` is a sibling of `build` and `fix` in `bin/compose.js`. New `runGsd()` in `lib/`. New `pipelines/gsd.stratum.yaml`. Rationale: GSD is its own lifecycle identity (long-run, fresh-context, multi-task) and the doc/journal surface deserves to mirror that. A `--gsd` flag on `build` would couple GSD execution to build's full phase ordering and would be awkward to reuse from `fix` if we ever want hard-bug GSD runs.

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `bin/compose.js` | modify | Add `gsd` verb dispatch alongside `build`/`fix` |
| `lib/gsd.js` | new | `runGsd(featureCode, opts)` — entry point, scaffolds folder if needed, calls Stratum, owns per-task callback |
| `lib/gsd-dispatch.js` | new | Per-task callback: build prompt, dispatch Agent with `isolation:"worktree"`, run gate, squash-merge or bounce |
| `lib/gsd-blackboard.js` | new | Read/write `.compose/gsd/<feature>/blackboard.json` with file lock |
| `lib/gsd-prompt.js` | new | Assemble per-task prompt from intent + blueprint slice + upstream results + standing context |
| `pipelines/gsd.stratum.yaml` | new | Flow: `decompose → dispatch (max_concurrent:1, defer_advance:true) → ship` |
| `contracts/taskgraph.json` | new | TaskGraph schema (nodes, depends_on, files_owned, files_read, produces, consumes) |
| `contracts/task-result.json` | new | TaskResult schema (status, files_changed, produces, gate, merge_sha, attempts) |
| `lib/build.js` | modify (small) | Extract shared dispatch helpers if needed; otherwise unchanged |
| `docs/features/COMP-GSD-2/blueprint.md` | new (later phase) | Implementation blueprint |
| `CHANGELOG.md` | modify (later) | Entry on ship |

## Open Questions

1. **Where does `compose gsd` start?** If the feature folder lacks `blueprint.md` or `boundary-map.md`, does `compose gsd` fall back to running build phases 1–5 inline, or does it error out and direct the user to run `compose build --through blueprint` first? **Tentative:** error out with a clear pointer — keeps GSD focused on the dispatch-from-blueprint scenario; reuse of build phases is a separate UX concern.
2. **Gate command resolution.** Lint/build/test commands per repo — read from `.compose/compose.json` (new field `gateCommands`)? Or detect from `package.json` scripts? **Tentative:** `gateCommands` config with sensible defaults (`pnpm lint`, `pnpm build`, `pnpm test`).
3. **Retry cap on bounce-back.** Per task or per feature? **Tentative:** per-task cap declared in `pipelines/gsd.stratum.yaml` (start at 2); per-feature stop is GSD-4's budget territory.
4. **Cockpit live view.** Each fresh Agent runs in its own context — how do its events surface in the cockpit OpsStrip? **Tentative:** Agent tool's notification mechanism + agent-stream telemetry; concrete wiring deferred to blueprint phase.

# Roadmap-graph enforcement templates: Design

**Status:** SHIPPED 2026-06-07
**Parent:** [COMP-ROADMAP-GRAPH-1](../COMP-ROADMAP-GRAPH-1/) · sibling [COMP-ROADMAP-GRAPH-1-2](../COMP-ROADMAP-GRAPH-1-2/)
**How-to:** [docs/howto/roadmap-graph.md](../../howto/roadmap-graph.md)

## Why

COMP-ROADMAP-GRAPH-1 shipped v1 narrow (P1 substrate + P2 CLI/MCP): the
generator, dangling-edge refusal, and `compose roadmap graph [--check]` exist.
The enforcement layer (Phase 3) was deferred — this feature delivers it.

## Problem

A generator that *can* refuse dangling edges only helps if something *runs* it
on the way to `main`. Projects need a drop-in pre-push gate and a CI gate.

## Decisions

1. **Split the guarantee by stakes.** Dangling edges (the Cytoscape-crash bug
   class) are the hard invariant; staleness of a committed graph is cosmetic and
   high-churn. The gate hard-fails on dangling; staleness enforcement is **opt-in
   by graph-file presence** (the gate no-ops until a graph exists on disk).
2. **`--check` IS the hand-edit lint.** It regenerates and byte-compares the
   whole file, catching any manual edit — data region *or* template scaffolding.
   This is strictly stronger than the originally-planned sentinel-region diff, so
   no separate lint script ships.
3. **Source-safe shell template.** The hook defines `roadmap_graph_gate` (uses
   `return`) and only auto-runs + `exit`s under a `BASH_SOURCE == $0` guard, so it
   works both copied into `.git/hooks/pre-push` and `source`d from an existing hook.
4. **Two CI modes.** Committed-graph (`--check`, fails on stale/dangling) vs
   artifact-only (generate fresh, fail on dangling, upload HTML) — projects pick
   by roadmap churn.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `templates/hooks/roadmap-graph-pre-push.sh` | new | source-safe opt-in pre-push gate |
| `templates/ci/roadmap-graph.yml` | new | reusable GitHub Actions snippet (Mode A/B) |
| `test/integration/roadmap-graph-hook.test.js` | new | executes the hook against fixtures (5 tests) |

## Outcome

Shipped. The hard guarantee (no dangling edge reaches `main`) is enforceable in
both pre-push and CI; `--check` doubles as the hand-edit lint.

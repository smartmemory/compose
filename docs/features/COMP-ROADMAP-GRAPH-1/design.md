# COMP-ROADMAP-GRAPH-1 — Design

**Status:** v1 SHIPPED (P1+P2) 2026-06-07 · parent PARTIAL
**Full roadmap-level spec:** [`plan.md`](plan.md) (problem, data model, 4-phase plan, acceptance criteria, non-goals — externally cross-linked, kept verbatim)
**Verified implementation blueprint:** [`blueprint.md`](blueprint.md) (corrections table + module map + verification table)

> This `design.md` is the compose-canonical design artifact. The detailed,
> cross-linked specification lives in `plan.md` (split from SmartMemory's
> META-GRAPH-1); this file states the design decisions that governed the v1
> build and points at the spec/blueprint rather than duplicating them.

## Problem

Multiple compose-using projects hand-maintain a dependency-graph HTML beside
their ROADMAP. The hand-maintenance contract fails repeatedly — stale edges
pointing at completed/renamed features crash the Cytoscape loader. Compose
already owns the upstream truth (feature.json status/phase, ROADMAP rows), so
the graph should be **derived**, not hand-drawn, once, in the substrate.

## Design decisions (v1)

1. **Derivation, not authoring.** Nodes come from compose state; the generator
   never writes ROADMAP.md. Per the Forge Roadmap Model, narrative stays
   hand-owned; only the graph derives.
2. **Node universe = feature folders ∪ ROADMAP rows.** `feature.json` status
   wins when a feature is registered; unregistered features fall back to
   `ROADMAP.md` parsing with a warning (closes the registration gap
   incrementally). External-prefix (cross-project) codes are *known but not
   rendered* so edges to them never dangle.
3. **Edges are explicit.** Per-folder `deps.yaml` (`depends_on` /
   `concurrent_with` / `blocks`) — co-located so renames are single-directory
   moves. No prose inference.
4. **Dangling-edge refusal is the core guarantee.** An edge to a code that
   exists *nowhere* is a hard error (`DANGLING_EDGE`, non-zero exit). An edge to
   a known-but-dropped (COMPLETE/SUPERSEDED/KILLED) node is silently removed.
   This is the exact bug class that crashed the hand-maintained graphs.
5. **Determinism → trustworthy gate.** No wall-clock in the output; stable key
   ordering. Re-running on clean inputs is a byte-for-byte no-op, so
   `--check` is a reliable CI/pre-commit gate.
6. **Template owns presentation; generator owns data.** A packaged
   Cytoscape/dagre template with `@generated:*` sentinel regions; only the
   `nodes`/`edges`/`config` arrays regenerate. Track→color is project-config.
7. **Thin surfaces over a shared core.** `compose roadmap graph [--out
   --project --check]` and `roadmap_graph` / `roadmap_graph_check` MCP tools are
   wrappers over `lib/roadmap-graph/`. MCP tools return small summaries only —
   never the HTML body.

## Scope

v1 ships Phase 1 (schemas + generator core) and Phase 2 (CLI + MCP). Deferred:
enforcement templates ([COMP-ROADMAP-GRAPH-1-1](../COMP-ROADMAP-GRAPH-1-1/)) and
forge-top dogfood + adoption howto ([COMP-ROADMAP-GRAPH-1-2](../COMP-ROADMAP-GRAPH-1-2/)).
See [`plan.md`](plan.md) §Non-Goals for what this deliberately does not do.

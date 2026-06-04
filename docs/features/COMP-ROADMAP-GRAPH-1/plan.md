# COMP-ROADMAP-GRAPH-1 — Generated Roadmap Dependency Graph (Compose Substrate)

**Status:** PLANNED
**Priority:** MEDIUM
**Created:** 2026-05-23
**Origin:** Split out of SmartMemory's `META-GRAPH-1` (filed 2026-04-19, [IDEA-134](../../product/ideabox.md)) after recognizing the work is compose substrate, not SmartMemory-specific.

**Related Documents:**
- [`forge/ROADMAP.md`](../../../../ROADMAP.md) — Standalone Tickets table
- [`COMP-MCP-ROADMAP-WRITER`](../COMP-MCP-ROADMAP-WRITER/) — Existing roadmap *writer* tools (`add_roadmap_entry`, `set_feature_status`, `roadmap_diff`); this feature is the *renderer* sibling.
- [`COMP-XREF-SCHEMA`](../../../../ROADMAP.md#standalone-tickets--planned) — External-reference shape, used so product-repo adoptions can cite this feature without status sync.
- First consumer: SmartMemory's [META-GRAPH-1](../../../../../smart-memory/smart-memory-docs/docs/features/META-GRAPH-1/plan.md) (thin adoption — populates `deps.yaml` + frontmatter, wires the generator into its CI).
- SmartMemory [META-GRAPH-2](../../../../../smart-memory/smart-memory-docs/docs/features/META-GRAPH-2/plan.md) (PARKED bidirectional sibling — would also migrate here if un-parked).

## Problem

Multiple Compose-using projects hand-maintain a dependency-graph HTML alongside their ROADMAP — SmartMemory's `docs/roadmap-graph.html` is the first concrete instance, but ScaleMate, Maya, Coder-Config and Forge itself all have the same shape of need. The hand-maintenance contract has failed twice in three weeks in SmartMemory (7 stale edges in one incident → Cytoscape load crash); rule-based enforcement does not scale.

Compose already owns the upstream truth (`scaffold_feature`, `get_feature_lifecycle`, `get_phase_summary`, `set_feature_status`). Each project re-implementing the generator is duplicative; doing it once in Compose lets every compose project inherit a working graph for free.

## Solution

Compose ships a `roadmap-graph` capability with three pieces:

1. **`deps.yaml` schema** — single small YAML file per feature folder declaring `depends_on` / `concurrent_with` / `blocks`. Co-located with the feature so renames are single-directory operations.
2. **Frontmatter convention** — `design.md` (or `feature.json` extension, per project preference) declares node-display metadata: `name`, `priority`, `track`, `desc`. Compose already owns `feature_id`, `phase`, `status` via lifecycle state.
3. **Generator** — `compose roadmap-graph` subcommand + `mcp__compose__roadmap_graph` MCP tool. Walks the project's `docs/features/*/` (path configurable via `compose.json#paths.features`), reads compose state + manifests, emits a self-contained HTML using a packaged template. Idempotent. Refuses to emit if any edge would dangle.

## Data Model

### Nodes — from compose state + frontmatter

Compose lifecycle already tracks:
- Feature ID
- Phase (`design` / `blueprint` / `plan` / `execute` / `ship`)
- Status (derived from phase + explicit overrides via `set_feature_status`)
- Artifact pointers

Per-project display metadata via frontmatter on `design.md` (preferred) or `meta.yaml` (fallback):

```yaml
---
feature_id: CORE-SUMMARY-1
name: Periodic Consolidated Memory Snapshots
priority: high          # high | medium | low
track: knowledge        # project-defined; arbitrary string
desc: |
  First-class memory_type="snapshot" items rolling up a workspace...
---
```

Projects without `design.md` frontmatter can fall back to a `meta.yaml` sibling. Projects that prefer `feature.json` (Compose convention) can extend it with the same keys — generator accepts whichever source is present.

### Edges — `deps.yaml` per feature folder

```yaml
# docs/features/<FEATURE-ID>/deps.yaml
depends_on:
  - CORE-ORIGIN-1
  - PLAT-PROGRESS-1
concurrent_with: []
blocks: []   # optional inverse-relation convenience
```

Central single-file alternatives rejected — co-location keeps the feature folder self-contained.

## Generator

`compose roadmap-graph [--project <path>] [--out <html>] [--check]`

1. Resolve project root via `derive_workspace_id()` (from `COMP-WORKSPACE-ID` substrate); read `paths.features` from `compose.json`.
2. Walk `<features>/*/` — for each entry collect `feature.json` + frontmatter + `deps.yaml`.
3. Query compose for phase/status per feature ID. Fallback path: parse the project's `ROADMAP.md` `**Status:**` markers for features not yet registered with compose (the Phase 4 adoption gap exists for every project).
4. Apply graph rules:
   - Drop nodes where status ∈ {COMPLETE, SUPERSEDED, KILLED}
   - Drop edges whose source or target was dropped
   - **Refuse to emit** (non-zero exit) if any non-dropped edge points at a non-existent feature ID — this is the actual Cytoscape-crash bug
5. Render `roadmap-graph.html` from a packaged template — only `const nodes = [...]` and `const edges = [...]` regenerate; surrounding HTML/CSS/JS is template-owned.

`--check` mode runs the generator, diffs against on-disk HTML, exits non-zero on diff. CI uses this.

## MCP Surface

Add to compose-mcp:

- `mcp__compose__roadmap_graph(project?: string, out?: string)` — generate and write
- `mcp__compose__roadmap_graph_check(project?: string)` — generate to memory, compare to on-disk, return diff summary

Both share the same generator core; CLI subcommand is a thin wrapper.

## Enforcement

Substrate provides the mechanism; each adopting project wires it in:

1. **Pre-commit hook template** (compose ships `.compose/hooks/roadmap-graph.sh`) — runs `compose roadmap-graph --check`, refuses commit on dangling edges
2. **CI gate template** — GitHub Action snippet in `compose/templates/` that projects copy into their workflows
3. **Hand-edit lint** — generator marks the `const nodes`/`const edges` blocks with sentinel comments; lint script in compose flags PRs that touch them without corresponding `deps.yaml` / frontmatter changes

## Phases

### Phase 1 — Substrate (3–4 days)
- [ ] `deps.yaml` schema + JSON-schema validator in `compose/contracts/`
- [ ] Frontmatter schema (design.md preferred, feature.json/meta.yaml fallbacks) + validator
- [ ] Generator core (`compose/lib/roadmap-graph/`) — input collection, compose lifecycle integration, ROADMAP.md fallback parser, dangling-edge refusal, idempotent template render
- [ ] Packaged HTML template (extracted from SmartMemory's current `roadmap-graph.html` — generic enough to skin per-project via CSS variables for track colors)
- [ ] Unit tests: idempotency, dangling-edge refusal, COMPLETE-node drop, status-source precedence (compose wins when registered, ROADMAP.md wins when not)

### Phase 2 — CLI + MCP (1–2 days)
- [ ] `compose roadmap-graph` subcommand in `bin/compose.js`
- [ ] `mcp__compose__roadmap_graph` + `roadmap_graph_check` MCP tools
- [ ] `--project` flag honored end-to-end (cross-workspace generation from forge-top works)
- [ ] Integration test against a fixture project with seeded `deps.yaml` + frontmatter

### Phase 3 — Enforcement templates (1 day)
- [ ] Pre-commit hook template at `compose/templates/hooks/roadmap-graph.sh`
- [ ] CI gate snippet at `compose/templates/ci/roadmap-graph.yml`
- [ ] Hand-edit sentinel + lint script
- [ ] `compose setup` extended to optionally install the hook + emit a stub `compose.json#paths.features` entry

### Phase 4 — Compose-side adoption (1 day)
- [ ] Generate `forge/docs/roadmap-graph.html` from forge's own ROADMAP — first non-SmartMemory consumer, validates the substrate before downstream projects adopt
- [ ] Document the schema + adoption recipe in `compose/docs/howto/roadmap-graph.md`

## Acceptance Criteria

- [ ] `compose roadmap-graph` produces a valid graph for any project with `deps.yaml` + frontmatter populated
- [ ] Generator refuses to emit (non-zero exit) when any edge would dangle — proves the original Cytoscape-crash bug class cannot recur
- [ ] Running the generator twice on clean inputs produces zero diff
- [ ] Status precedence is observable: registered compose features take precedence, unregistered features fall back to `ROADMAP.md` parsing with a warning
- [ ] First consumer (SmartMemory's META-GRAPH-1) can adopt with no Forge-side code changes — only data (`deps.yaml` + frontmatter) and CI wiring
- [ ] Forge-top's own `roadmap-graph.html` is generated and self-consistent (dogfood gate)

## Non-Goals

- **Not the ROADMAP.md generator.** ROADMAP.md stays hand-written narrative; only the graph derives. The Forge "Roadmap Model" decision (forge-top is narrative-owned) applies symmetrically per-project — generators don't write ROADMAP.md.
- **Not bidirectional edge editing.** That's META-GRAPH-2's scope (currently PARKED in SmartMemory). If un-parked, it migrates here as `COMP-ROADMAP-GRAPH-2`.
- **Not a dependency inference engine.** Deps are explicitly declared in `deps.yaml`. No prose parsing.
- **Not status sync between projects.** Per the Forge Roadmap Model — cross-project references resolve read-only via `COMP-XREF-SCHEMA` and never write back.

## Risk / Open Questions

- **Per-project node-styling divergence.** SmartMemory has eight `track` values with specific colors; ScaleMate/Maya will have different vocabularies. Resolution: track→color is project-owned (`compose.json#roadmap_graph.tracks`); generator passes through, template uses CSS variables.
- **`design.md` vs `feature.json` frontmatter source.** SmartMemory writes `design.md` per feature; Compose writes `feature.json`. Generator accepts both, with a documented precedence (`design.md` frontmatter wins if both present). Documented in adoption recipe.
- **Compose-registration gap.** Most existing project features aren't compose-registered. Phase 1 generator gracefully falls back to `ROADMAP.md` `**Status:**` parsing; Phase 4 SmartMemory adoption (and equivalent in other projects) closes the gap incrementally.

## Why It's Worth Doing

The bug we just fixed in SmartMemory was 7 dangling edges across 4 feature completions — 100% drift rate on a rule that had existed for weeks. The same shape recurs in every multi-feature project. Solving it once in Compose costs ~5–7 days, lets four projects retire their hand-maintenance rules, and makes the next compose-using project's roadmap graph free.

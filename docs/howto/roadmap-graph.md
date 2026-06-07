# How-to: Roadmap Dependency Graph

`compose roadmap graph` renders a self-contained `roadmap-graph.html` — an
interactive Cytoscape view of your features and their dependencies — derived
deterministically from compose state. It replaces hand-maintained graph HTML,
which drifts and crashes the Cytoscape loader on stale edges.

Feature: [COMP-ROADMAP-GRAPH-1](../features/COMP-ROADMAP-GRAPH-1/) ·
enforcement: [COMP-ROADMAP-GRAPH-1-1](../features/COMP-ROADMAP-GRAPH-1-1/) ·
dogfood: [COMP-ROADMAP-GRAPH-1-2](../features/COMP-ROADMAP-GRAPH-1-2/).

## What it reads

| Input | Source | Notes |
|---|---|---|
| **Nodes** | `docs/features/*/feature.json` ∪ `ROADMAP.md` rows | `feature.json` status wins; unregistered features fall back to ROADMAP parsing (with a warning). COMPLETE/SUPERSEDED/KILLED nodes are dropped. |
| **Edges** | per-folder `deps.yaml` | explicit; no prose inference. |
| **Display metadata** | `design.md` YAML frontmatter → `feature.json` keys → defaults | `name`, `priority`, `track`, `desc`. |
| **Theme** | `.compose/compose.json#roadmap_graph` | `title`, `subtitle`, `tracks` (name→color), `out`. All optional. |

External-prefix codes (`compose.json#externalPrefixes`, e.g. `STRAT-`) are
treated as **known but not rendered** — cross-project references resolve so
edges to them never dangle, but they don't clutter this project's graph.

## 1. Declare edges — `deps.yaml`

Drop a `deps.yaml` in any feature folder (all keys optional, default `[]`):

```yaml
# docs/features/<CODE>/deps.yaml
depends_on:        # prerequisites of this feature
  - CORE-AUTH-1
concurrent_with:   # siblings, no blocking relationship
  - CORE-UI-2
blocks:            # features this one is a prerequisite of (inverse convenience)
  - CORE-API-3
```

Edge direction: `depends_on: [X]` on feature `F` draws `X → F` (prerequisite →
dependent; the arrow points at what gets unblocked).

## 2. (Optional) Add display metadata

Either extend `feature.json`:

```json
{ "code": "CORE-AUTH-1", "name": "Session auth", "priority": "high", "track": "platform", "desc": "…" }
```

…or add YAML frontmatter to `design.md` (frontmatter wins if both present):

```markdown
---
name: Session auth
priority: high      # high | medium | low  → node border weight
track: platform     # arbitrary string     → node color
desc: One-paragraph blurb shown in the tooltip.
---
```

## 3. (Optional) Theme — `compose.json`

```json
{
  "roadmap_graph": {
    "title": "MyProject — Roadmap",
    "subtitle": "open + parked features",
    "out": "docs/roadmap-graph.html",
    "tracks": { "platform": "#ec4899", "knowledge": "#0ea5e9" }
  }
}
```

## 4. Generate

```bash
compose roadmap graph                 # → roadmap-graph.html (or compose.json#roadmap_graph.out)
compose roadmap graph --out docs/g.html
compose roadmap graph --project ../other-repo
compose roadmap graph --check         # exit 1 if missing/stale/dangling; never writes
```

The generator **refuses to emit** (`DANGLING_EDGE`, non-zero exit) if any edge
points at a feature code that exists nowhere — the exact bug class that crashed
hand-maintained graphs. Output is byte-identical on re-run (no wall-clock), so
`--check` is a reliable gate.

MCP equivalents: `roadmap_graph({ project?, out? })` and
`roadmap_graph_check({ project? })` (return small summaries, never the HTML).

## 5. Enforce

Pick the mode that matches your roadmap's churn:

### A. Committed graph (stable roadmaps)

Commit `roadmap-graph.html`. Wire the gate so PRs that change features without
regenerating fail:

- **Pre-push:** `templates/hooks/roadmap-graph-pre-push.sh`. It no-ops until the
  graph file exists (opt-in), then blocks on stale/dangling. Set
  `COMPOSE_GRAPH_OUT` for a custom output path. Two ways to install:
    - *Standalone* — copy it to `.git/hooks/pre-push` and `chmod +x`. Note this
      **overwrites** any existing pre-push hook (including one installed by
      `compose hooks install`); if you already have one, use the source mode.
    - *Compose with an existing hook* — `source` it and call the function, so
      gates stack:
      ```bash
      source path/to/roadmap-graph-pre-push.sh
      roadmap_graph_gate || exit 1
      ```
      Sourced, it only defines `roadmap_graph_gate` (no `exit`), so it never
      kills your shell.
- **CI:** copy `templates/ci/roadmap-graph.yml`, Mode A (`compose roadmap graph
  --check`).

`--check` regenerates and byte-compares the whole file, so any hand-edit — to
the data **or** the template scaffolding — surfaces as drift. That is the
hand-edit lint; no separate sentinel script is needed.

### B. Artifact-only (high-churn roadmaps)

Don't commit the graph. CI regenerates it fresh each run, fails only on a
dangling edge, and uploads the HTML as an artifact — `templates/ci/roadmap-graph.yml`,
Mode B. This is how compose itself dogfoods the generator
(`.github/workflows/roadmap-graph.yml`): its feature statuses flip too often for
a committed graph to stay fresh, so it guards the dangling-edge invariant in CI
and ships the rendered graph as a downloadable build artifact.

## Notes

- The `@generated:config/nodes/edges` sentinel regions in the template mark the
  regenerated blocks; everything else is template-owned scaffolding.
- Track colors are project-owned; the generator passes them through to CSS so
  each project skins its own graph.

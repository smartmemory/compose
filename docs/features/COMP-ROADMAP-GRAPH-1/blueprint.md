# COMP-ROADMAP-GRAPH-1 — Implementation Blueprint (v1 narrow: P1 + P2)

**Status:** v1 SHIPPED (P1+P2) 2026-06-07 — parent feature PARTIAL. Phase 3 → [COMP-ROADMAP-GRAPH-1-1](../COMP-ROADMAP-GRAPH-1-1/); Phase 4 → [COMP-ROADMAP-GRAPH-1-2](../COMP-ROADMAP-GRAPH-1-2/).
**Scope this build:** Phase 1 (substrate: schemas + generator core) + Phase 2 (CLI + MCP). Phase 3 (enforcement templates) and Phase 4 (forge-top dogfood/adoption) are deferred and filed as follow-ups.
**Design of record:** [`plan.md`](plan.md) (roadmap-level spec).

**Related Documents:**
- [`plan.md`](plan.md) — the design/spec this blueprint implements
- `lib/roadmap-gen.js`, `lib/roadmap-parser.js` — existing roadmap *writer*/*parser* siblings (reused)

---

## Corrections Table (plan assumption → verified reality)

| # | Plan assumption | Reality (verified) | Action |
|---|---|---|---|
| 1 | `derive_workspace_id()` resolves project root | Real API: `resolveWorkspace(hint)` + `getWorkspaceFlag(args)` in `lib/resolve-workspace.js`; the CLI already wraps both in `resolveCwdWithWorkspace(args)` at `bin/compose.js:62`. `deriveId({root})` exists in `discover-workspaces.js` but is not what we call. | Use `resolveCwdWithWorkspace(args)` in CLI; `getTargetRoot()` in MCP handlers. |
| 2 | Query compose lifecycle for per-feature status/phase | No separate lifecycle fn. `readFeature(cwd, code, featuresDir)` / `listFeatures(cwd, featuresDir)` in `lib/feature-json.js` return `{code, status, phase, description, ...}` directly from feature.json. Status is UPPERCASE (`PLANNED|IN_PROGRESS|PARTIAL|COMPLETE|SUPERSEDED|PARKED|BLOCKED|KILLED`). | Read feature.json directly. |
| 3 | Parse ROADMAP.md `**Status:**` markers for unregistered features | `parseRoadmap(text)` in `lib/roadmap-parser.js` returns `FeatureEntry[]` = `{code, description, status, phaseId, position}` from the markdown table. Field is `phaseId` (not `phase`). | Use `parseRoadmap` for the fallback node universe. |
| 4 | Frontmatter is on `design.md` | Compose features carry no design.md frontmatter; feature.json is the source. SmartMemory uses `**Bold:** value` prose, not YAML frontmatter — no machine-readable deps/track exist there yet. | Display metadata source precedence: `design.md` YAML frontmatter (if present) → `feature.json` extension keys (`name|priority|track|desc`) → defaults. deps come only from `deps.yaml`. |
| 5 | Template status values | SmartMemory HTML uses idiosyncratic lowercase `planned|parked|partial|open`. | Our template owns its status vocabulary: lowercase `planned|in_progress|partial|parked|blocked`. Map UPPERCASE→lowercase; drop `complete|superseded|killed`. |
| 6 | — | YAML dep is declared: `yaml ^2.8.2` (`package.json:109`). Import `{ parse } from 'yaml'`. | Use it for deps.yaml + frontmatter. |
| 7 | — | Schema validation: `SchemaValidator` (`server/schema-validator.js`), `validateRoot(obj) → {valid, errors}` (Ajv). Mirror `lib/feature-validator.js` wiring. | Add two contracts, validate with `SchemaValidator`. |
| 8 | — | Tests are globbed: `test/*.test.js test/comp-obs-branch/*.test.js test/integration/*.test.js`. A new `test/roadmap-graph/` subdir would NOT be picked up. | Unit tests at `test/roadmap-graph.test.js` (flat); integration at `test/integration/roadmap-graph.test.js`. |
| 9 | — | `set_feature_status`/roadmap MCP tools blow the response token cap by returning the full ROADMAP. | `roadmap_graph`/`roadmap_graph_check` return small summaries (counts + dropped/dangling lists), **never** the HTML body. |

---

## Module Structure (all new)

```
compose/contracts/
  roadmap-deps.schema.json            (new) — deps.yaml shape
  roadmap-graph-frontmatter.schema.json (new) — display-metadata shape
compose/lib/roadmap-graph/
  index.js      (new) — generateRoadmapGraph(cwd, opts), checkRoadmapGraph(cwd, opts); atomic write
  collect.js    (new) — collectGraphInputs(cwd, featuresDir) → { nodes, rawEdges, knownCodes, warnings }
  model.js      (new) — buildGraph(inputs) → { nodes, edges, dropped }; throws DanglingEdgeError
  render.js     (new) — renderGraphHtml({ nodes, edges, config }) → string
  config.js     (new) — loadGraphConfig(cwd) → { title, subtitle, tracks, out }
  template.html (new) — packaged Cytoscape + dagre template with sentinel-marked data regions
compose/bin/compose.js                (edit) — add `roadmap graph` subcommand
compose/server/compose-mcp.js         (edit) — TOOLS entries + dispatch cases
compose/server/compose-mcp-tools.js   (edit) — toolRoadmapGraph, toolRoadmapGraphCheck
compose/test/roadmap-graph.test.js            (new) — unit (collect, model, render)
compose/test/integration/roadmap-graph.test.js (new) — CLI + MCP fixture end-to-end
```

## Data Contracts

**`deps.yaml`** (per feature folder, all keys optional, default `[]`):
```yaml
depends_on: [CODE, ...]       # prerequisites of this feature
concurrent_with: [CODE, ...]  # sibling features (no blocking)
blocks: [CODE, ...]           # features this one is a prerequisite of (inverse convenience)
```
Schema: `additionalProperties:false`; each array item matches `^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*$`.

**Frontmatter / display metadata** (`design.md` YAML frontmatter or `feature.json` keys, all optional):
```yaml
name: <human title>
priority: high | medium | low
track: <project-defined string>
desc: <one-paragraph blurb>
```

## Node / Edge shapes (template data)

```js
node = { id, label, name, status, priority, track, desc }   // status lowercased+mapped
edge = { source, target, type }                             // type: 'dep' | 'concurrent'
```

**Edge direction convention** (prerequisite → dependent; arrow points at the unblocked feature):
- feature `F` with `depends_on: [X]` → `{source: X, target: F, type:'dep'}`
- feature `F` with `blocks: [Y]` → `{source: F, target: Y, type:'dep'}`
- feature `F` with `concurrent_with: [Z]` → `{source: min(F,Z), target: max(F,Z), type:'concurrent'}` (canonicalized + deduped)

## Generator algorithm

1. **Node universe** = union of (a) every feature folder with `feature.json`, and (b) every real-coded ROADMAP.md row. feature.json wins when both present (status precedence); ROADMAP-only features get a `warning` and minimal display metadata. `knownCodes` = the universe's code set (the dangling oracle).
2. **Drop** nodes whose status ∈ `{COMPLETE, SUPERSEDED, KILLED}`. Record `droppedCodes`.
3. **Edges** from each folder's `deps.yaml`. For each raw edge endpoint:
   - endpoint ∉ `knownCodes` → **dangling** (collect).
   - endpoint ∈ `droppedCodes` (or otherwise absent from final nodes) → silently drop the edge.
   - else keep. Dedup.
4. **Refuse to emit** (`throw DanglingEdgeError` → non-zero CLI exit / `isError` MCP result) if any dangling edges. *This is the Cytoscape-crash bug class being killed.*
5. **Render** deterministically: `listFeatures` already sorts by phase→position→code; edges sorted by `(type, source, target)`; `JSON.stringify(…, null, 2)`. **No wall-clock timestamp** in output → byte-identical on re-run (idempotency).

## CLI surface (`bin/compose.js`, inside `if (cmd === 'roadmap')` before the default)

```
compose roadmap graph [--out <html>] [--project <path>] [--check]
```
- `--out` overrides config/default output path.
- `--check` renders to memory, diffs against on-disk file, exits 1 on diff or dangling.
- root via `resolveCwdWithWorkspace(args)`; `--project <path>` overrides root.

## MCP surface (`server/compose-mcp.js` + `compose-mcp-tools.js`)

- `roadmap_graph({ project?, out? })` → `toolRoadmapGraph` → `{ path, nodeCount, edgeCount, droppedCount, warnings }`
- `roadmap_graph_check({ project? })` → `toolRoadmapGraphCheck` → `{ matches, dangling, diffSummary }`

Handlers call `generateRoadmapGraph(getTargetRoot(), args)` / `checkRoadmapGraph(...)`. Summaries only — never the HTML body.

## Verification Table (Phase 5 — all confirmed against disk)

| Claim | Location | ✓ |
|---|---|---|
| `resolveCwdWithWorkspace(args)` exists | `bin/compose.js:62` | ✅ |
| `readFeature`/`listFeatures` signatures | `lib/feature-json.js:36,117` | ✅ |
| `parseRoadmap`→`{code,status,phaseId,position}` | `lib/roadmap-parser.js:54,43` | ✅ |
| `SchemaValidator.validateRoot` | `server/schema-validator.js:33,74` | ✅ |
| `loadFeaturesDir`/`loadExternalPrefixes` | `lib/project-paths.js:24,43` | ✅ |
| `yaml ^2.8.2` declared | `package.json:109` | ✅ |
| `roadmap` CLI dispatch block | `bin/compose.js:1042` | ✅ |
| MCP `TOOLS` array + `switch` dispatch + `getTargetRoot()` handler pattern | `server/compose-mcp.js:79,678`; `compose-mcp-tools.js:12` | ✅ |
| atomic tmp+rename render pattern | `lib/bug-index-gen.js` | ✅ |
| test glob (flat + integration/) | `package.json:22` | ✅ |

## Deferred (filed as follow-ups)

- **P3 — Enforcement templates:** pre-commit hook + CI snippet + hand-edit sentinel lint.
- **P4 — Compose-side dogfood:** generate `forge/docs/roadmap-graph.html`, write `docs/howto/roadmap-graph.md`.

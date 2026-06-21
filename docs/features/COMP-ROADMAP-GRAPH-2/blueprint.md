# COMP-ROADMAP-GRAPH-2: Implementation Blueprint

**Status:** BLUEPRINT
**Date:** 2026-06-21
**Design:** [design.md](./design.md)

## Architecture in one paragraph

Both graph projections feed the **one** renderer chain `buildGraph → loadGraphConfig → renderGraphHtml`. A new **vision adapter** (`visionToGraphInputs`) converts a `VisionStore`'s items/connections into the exact `{ nodes, rawEdges, knownCodes }` shape `buildGraph` already consumes from `collect.js`. The **live projection** (cockpit export routes) feeds the running in-memory store through the adapter. The **canonical projection** (CLI / MCP / CI) builds a throwaway store via `scanFeatures + seedFeatures` — which is extended to absorb everything `collect.js` did (deps.yaml edges, track, external-prefix oracle, ROADMAP-fallback nodes) — then through the same adapter. Once the canonical projection is a verified superset of `collect.js`'s output, `collect.js` and the dead seed/hook are deleted.

## Corrections table (design assumption → verified reality)

| Design / assumed | Reality | Ref |
|---|---|---|
| renderer is `renderGraph(nodes, edges, config)` | `renderGraphHtml({ nodes, edges, config })` — single object arg | `render.js:25` |
| `attachGraphExportRoutes(app, store)` | `attachGraphExportRoutes(app, { store, requireSensitiveToken })` | `graph-export.js:320` |
| edges keyed `{from,to}` throughout | `RawEdge` (buildGraph **input**) = `{from,to,type}`; buildGraph **output** renames to `{source,target,type}` | `model.js:51` vs `:92` |
| `DanglingEdgeError.dangling[].type` | payload key is `kind` | `model.js:30,34` |
| vision item has a `track` field | **No `track` field**; track today lives in `description` as `Track: x`, regex-scraped on export | `vision-store.js:159-178`; `graph-export.js:56` |
| `scanFeatures` returns `{code,...}` | field is `name` (= dir = code); no `code` key | `feature-scan.js:154` |
| seed reads `deps.yaml` | it does **not**; only `collect.js:91-106` reads deps.yaml. seed makes only `informs` edges | `feature-scan.js:669-713` |
| vision connection types include `dep`/`concurrent` | `VALID_CONNECTION_TYPES=['informs','blocks','supports','contradicts','implements']`; `dep`/`concurrent` are graph-edge types, mapped at projection time | `vision-store.js:12` |
| `generateRoadmapGraph` opts is rich | opts is only `{ out }`; `out` default lives in `loadGraphConfig` config | `index.js:36`; `config.js:41-46` |
| externalPrefixes from a graph-specific key | `compose.json#externalPrefixes` via `loadExternalPrefixes` (`[]` if absent) | `project-paths.js:56`; `collect.js:35` |
| buildGraph input status | UPPERCASE (`PLANNED`/`IN_PROGRESS`/...); `DROP_STATUSES={COMPLETE,SUPERSEDED,KILLED}` | `model.js:12,15-21` |

Note: `graph-export.js`'s `extractGraphData` already emits `renderGraphHtml`-compatible node/edge shapes (`:83-91`,`:107-111`), but it **bypasses `buildGraph`** (no dangling check, no DROP_STATUSES, lowercase statuses, wall-clock `${date}`). The adapter must produce **buildGraph input** shape (UPPERCASE status, `{from,to}` edges), not the post-buildGraph shape.

## Implementation slices (ordered; migration before retire)

### S1 — Vision adapter (new `lib/roadmap-graph/vision-adapter.js`)
`visionToGraphInputs(items, connections, { externalPrefixes = [] }) → { nodes, rawEdges, knownCodes, warnings }`.
- [ ] Node per item: `{ id: item.featureCode || item.title, status: toUpper(item.status), name, priority: item.priority||'medium', track: item.group||'standalone', desc: stripTrackPriority(item.description) }`. Filter to `type==='feature'` (parity with `graph-export.js:43`).
- [ ] Status map vision→UPPERCASE: `planned/ready→PLANNED, in_progress/review→IN_PROGRESS, complete→COMPLETE, blocked→BLOCKED, parked→PARKED, killed→KILLED, superseded→SUPERSEDED` (feeds model.js DROP_STATUSES + STATUS_MAP).
- [ ] Edge per connection, mapped to `{from,to,type:'dep'|'concurrent'}`: `blocks/informs/implements→dep`, `supports/contradicts→concurrent` (parity with `graph-export.js:30-36`). Resolve `fromId`/`toId` (uuids) → featureCode via an id→code map.
- [ ] `knownCodes` = all emitted node ids ∪ `externalPrefixes`-matching edge endpoints (so external refs don't trip dangling). Drop edges with an endpoint neither known nor external → `warnings` (live projection must never throw).

### S2 — Repoint live export routes (`server/graph-export.js`)
- [ ] Replace `generateHTML(store)` calls at `:329` and `:339` with: `visionToGraphInputs(store.items, store.connections, {externalPrefixes}) → buildGraph(inputs) → renderGraphHtml({...built, config: loadGraphConfig(getTargetRoot())})`.
- [ ] Delete the inline `generateHTML`/`extractGraphData`/local `STATUS_MAP`/`EDGE_TYPE_MAP`/template (`:18-36`, `:121-314`).
- [ ] Live projection swallows `DanglingEdgeError` defensively (adapter already drops unknown-endpoint edges, so buildGraph should not throw; keep a guard).
- [ ] Routes, token-gate (`requireSensitiveToken`), save-path (`docs/roadmap-graph.html`), and the cockpit buttons (`GraphView.jsx:1009-1027`) are unchanged.

### S3 — Seed absorbs `collect.js` semantics (canonical-projection prerequisites)
- [ ] **S3a deps.yaml → connections.** Extend `seedFeatures` (`feature-scan.js:609`) to read each feature's `deps.yaml` and create typed vision connections: `depends_on[d]` → connection `{from: d, to: code, type:'blocks'}`; `blocks[b]` → `{from: code, to: b, type:'blocks'}`; `concurrent_with[c]` → `{from: code, to: c, type:'supports'}` (undirected-canonicalized). Adapter maps these back to dep/concurrent in S1. (Reuse `depsToEdges` semantics from `model.js:125` for direction.)
- [ ] **S3b track.** Decision (Open Q2): reuse `group` as track. Seed sets `group` from feature/design `track` metadata when present (precedence: design.md frontmatter `track` > feature.json > `'standalone'`). No vision-store schema change. Document `group`==track in code comment + design.
- [ ] **S3c external-prefix oracle.** Thread `loadExternalPrefixes(cwd)` into the adapter's `knownCodes` (done in S1); confirm canonical CLI/CI pass it.
- [ ] **S3d ROADMAP-fallback nodes.** Decision (confirm at gate): seed adds real-coded ROADMAP.md rows lacking a feature folder as `status` nodes (parity with `collect.js:64`), OR we intentionally narrow to feature-folder nodes and document the delta. Default: preserve (add fallback nodes) to keep node universe identical.

### S4 — Canonical headless projection (`lib/roadmap-graph/index.js`)
- [ ] New internal `buildFromVision(cwd) → { html, nodes, edges, dropped, warnings, config }`: construct throwaway `VisionStore` (tmp dataDir or in-memory), `seedFeatures(scanFeatures(featuresDir), store)`, `visionToGraphInputs(...)`, `buildGraph`, `loadGraphConfig`, `renderGraphHtml`. Deterministic (no persisted state read, no timestamps).
- [ ] Repoint `generateRoadmapGraph`/`checkRoadmapGraph` (`:39`,`:59`) to use `buildFromVision` instead of `collectGraphInputs`. Keep atomicWrite + diff/`--check` determinism + DANGLING_EDGE rethrow.
- [ ] CLI `compose roadmap graph [--check]` (`bin/compose.js:1290`) and MCP `toolRoadmapGraph`/`toolRoadmapGraphCheck` (`compose-mcp-tools.js:551,584`) need **no change** — they call the index.js API, which now sources from vision.
- [ ] **Superset gate:** on a real project (this repo), diff `buildFromVision` `{nodes,edges}` vs old `collectGraphInputs→buildGraph`. Must be a superset or a documented delta before S5.

### S5 — Retire (only after S3+S4 superset gate passes)
- [ ] Delete `lib/roadmap-graph/collect.js` + its tests; migrate any kept helper (`stripMd`, frontmatter read) used elsewhere.
- [ ] Delete `seedFromRoadmapGraph`/`parseRoadmapGraph`/`findRoadmapGraph`/`GRAPH_STATUS_MAP`/`GRAPH_EDGE_MAP` (`feature-scan.js:434-593`) and the two callers (`server/index.js:177,210`).
- [ ] Delete `templates/hooks/roadmap-graph-pre-push.sh`.
- [ ] Repoint `.github/workflows/roadmap-graph.yml` + `templates/ci/roadmap-graph.yml` to regenerate-from-vision + dangling gate; drop committed-artifact `--check` mode (keep `roadmap_graph_check` function for opt-in committed CI, Open Q1).

## Boundary Map

| Symbol | Kind | Slice | Producer → Consumers |
|---|---|---|---|
| `visionToGraphInputs` | function | S1 (`lib/roadmap-graph/vision-adapter.js`, new) | produces `{nodes,rawEdges,knownCodes,warnings}`; consumed by S2 routes + S4 `buildFromVision` |
| `buildGraph` | function | existing (`model.js:59`) | consumes adapter output `{nodes,rawEdges,knownCodes}` from S1 |
| `renderGraphHtml` | function | existing (`render.js:25`) | consumes `{nodes,edges,config}` from buildGraph + loadGraphConfig |
| `loadGraphConfig` | function | existing (`config.js:31`) | consumed by S2 + S4 |
| `buildFromVision` | function | S4 (`lib/roadmap-graph/index.js`) | from S1 adapter + seed; consumed by `generateRoadmapGraph`/`checkRoadmapGraph` |
| `seedFeatures` | function | S3 (`feature-scan.js:609`, modify) | now emits deps.yaml-typed connections + track-as-group; consumed by S4 |
| `attachGraphExportRoutes` | function | S2 (`graph-export.js:320`, modify) | body swaps `generateHTML`→adapter chain; signature unchanged |
| `loadExternalPrefixes` | function | existing (`project-paths.js:56`) | consumed by S1 adapter via S3c |

All Boundary Map `from S##` references point to earlier slices (S2/S4 ← S1; S4 ← S3). No forward references.

## Verification table (Phase 5)

All file:line references read against working tree on 2026-06-21. Zero stale entries.

| Claim | Verified | Result |
|---|---|---|
| `renderGraphHtml({ nodes, edges, config })` single-object | `render.js:25` | ✓ exact |
| `buildGraph({ nodes, rawEdges, knownCodes })`; output edge `{source,target,type}` | `model.js:59,92` | ✓ exact (RawEdge `{from,to,type}` `:47-51`) |
| `DROP_STATUSES={COMPLETE,SUPERSEDED,KILLED}`; STATUS_MAP UPPERCASE→lower | `model.js:12,15-21` | ✓ exact |
| `depsToEdges(code, deps)` | `model.js:125` | ✓ exact |
| `collectGraphInputs(cwd, featuresDir)`; externalPrefixes via `loadExternalPrefixes`; ROADMAP fallback | `collect.js:31,35,64` | ✓ exact |
| `loadGraphConfig(cwd)` → `{title,subtitle,tracks,out}` | `config.js:31,41-46` | ✓ exact |
| `generateRoadmapGraph`/`checkRoadmapGraph(cwd, opts)` + `atomicWrite` | `index.js:39,59,80` | ✓ exact |
| `attachGraphExportRoutes(app, { store, requireSensitiveToken })`; seam `generateHTML(store)` at GET/POST | `graph-export.js:320,329,339` | ✓ exact — swap target confirmed |
| `VALID_CONNECTION_TYPES` excludes dep/concurrent | `vision-store.js:12` | ✓ exact — map at adapter confirmed |
| item has **no `track`**, has `group` (`deriveGroup` fallback) | `vision-store.js:159-178` | ✓ confirmed — S3b group-as-track valid |
| `createConnection({ fromId, toId, type })` | `vision-store.js:289` | ✓ exact |
| `scanFeatures` returns `name`(=code), **no deps.yaml read** | `feature-scan.js:154`; deps.yaml only in `collect.js:91` | ✓ confirmed — S3a is net-new |
| `seedFeatures(features, store)` | `feature-scan.js:609` | ✓ exact |
| CLI `subcmd === 'graph'`; MCP tool fns | `bin/compose.js:1290`; `compose-mcp-tools.js:551,584` | ✓ exact — no change needed (call index.js API) |

**Gate:** all references verified, zero stale, Boundary Map has no forward references. Blueprint approved for planning.

# COMP-ROADMAP-GRAPH-2: Single Graph — Cockpit/Vision Store as the One Source

**Status:** DESIGN
**Date:** 2026-06-21

## Related Documents

- [Compose Roadmap](../../../ROADMAP.md)
- [COMP-ROADMAP-GRAPH-1](../COMP-ROADMAP-GRAPH-1/) — the static feature.json/deps.yaml generator this feature collapses onto the vision store
- [COMP-ROADMAP-GRAPH-1-3](../COMP-ROADMAP-GRAPH-1-3/) — PLANNED: keep COMPLETE nodes as dimmed historical (orthogonal; not in scope here)
- [COMP-UX-1a](../COMP-UX-1a/) — made the cockpit Graph the default view
- [COMP-COCKPIT-10] — the existing cockpit "Export → open / save HTML" buttons (`GraphView.jsx:1059-1060`)

---

## Problem

Compose has **three** "roadmap graph" surfaces that overlap and drift:

1. **Cockpit live graph** — `src/components/vision/GraphView.jsx` (Cytoscape + `cytoscape-fcose`/`-dagre`), renders the **vision store** over websocket, persists node positions via `/api/graph/layout`. This is the graph users actually look at.
2. **Static generator** — `lib/roadmap-graph/*` renders a deterministic standalone HTML from a **different** source (`feature.json` + per-feature `deps.yaml` + `ROADMAP.md`), with a dangling-edge anti-crash refusal. Exposed via MCP (`roadmap_graph`/`roadmap_graph_check`), CLI (`compose roadmap graph [--check]`), and opt-in pre-push + CI staleness gates.
3. **Vision-store HTML export** — `server/graph-export.js` renders the *same kind* of standalone HTML but from the vision store, through a **forked, non-deterministic duplicate template**. Plus `seedFromRoadmapGraph` reads such an HTML file **back** into the store on every boot/project-switch.

The result is **two renderers, two data sources, two status/edge maps**, plus a circular store→HTML→store seed. Concrete defects found during exploration:

- `graph-export.js` ships a hand-written inline template (`:129-313`) that is a fork of `lib/roadmap-graph/template.html` — drift risk, two CDNs, two style sets.
- `graph-export.js` embeds a wall-clock `${date}` (`:124`) and unsorted JSON (`:217`) → output is **not byte-stable**, so it can never pass `--check`.
- `graph-export.js` has **no dangling-edge refusal** — silently drops bad-endpoint edges (`:101-111`), unlike `model.js:79-95`.
- `seedFromRoadmapGraph` runs **unconditionally** on every startup (`server/index.js:210`) and project-switch (`:177`), reverse-parsing HTML via `Function()` eval (`feature-scan.js:450`). It **always no-ops** in real runs (no compose target ships a `roadmap-graph.html`).

### Two capabilities probed and found dead

- **SmartMemory-format interop** — *effectively dead*. The only `roadmap-graph.html` anywhere under `my/` is `SmartMemory/smart-memory-docs/docs/roadmap-graph.html`, a **hand-maintained docs file** (governed by `SmartMemory/.claude/rules/roadmap-graph.md`) with no programmatic producer or consumer. Compose's exporter output is committed nowhere. No live pairing exists.
- **Cold-start seed (`seedFromRoadmapGraph`)** — *wired but always no-ops*, and circular + fragile. Safe to delete.

## Goal

**The cockpit's vision-store graph is the single source of all roadmap-graph functionality.** One data model (the vision model), one renderer (the canonical deterministic template), and every other surface (cockpit export button, MCP tool, CLI, CI gate) becomes a thin caller of that one path.

**In scope**
- Collapse to **one renderer**: `lib/roadmap-graph`'s `renderGraphHtml` + `template.html`, fed by a **vision-model adapter**.
- Collapse to **one source**: the vision model (hydrated from `vision-state.json`, seeded from `feature.json` the same way the server already does).
- Repoint `server/graph-export.js` routes at the canonical renderer (delete its forked template). The cockpit export buttons keep working unchanged.
- Preserve the **dangling-edge refusal**, **deterministic/byte-stable output**, **offline HTML**, and the **CI gate** (regenerate-from-vision-model + dangling check).
- **Delete** the dead `seedFromRoadmapGraph`/`parseRoadmapGraph`/`findRoadmapGraph` path and its `index.js` wiring.
- **Delete** the self-justifying **pre-push `--check` staleness enforcement** (the local hook template). CI keeps the dangling/regenerate gate.
- Keep MCP `roadmap_graph` + CLI `compose roadmap graph` as thin callers reading the vision model headless.

**Out of scope**
- COMP-ROADMAP-GRAPH-1-3 (dimmed-historical COMPLETE nodes) — default behavior stays "drop COMPLETE/SUPERSEDED/KILLED".
- The unrelated `ProductGraph.jsx`/`GraphRenderer.jsx` ontology diagram (not roadmap data).
- `ConnectionGraph.jsx` SVG neighborhood inspector (not the roadmap graph).
- Any new graph *visual* features; this is a consolidation, not a redesign.

---

## Decision 1: One renderer, fed by a vision-model adapter

Keep `lib/roadmap-graph`'s deterministic `template.html` + `renderGraphHtml` (the byte-stable, dangling-safe renderer) as the **single** renderer. Replace `collect.js`'s `feature.json`/`deps.yaml` graph-collection with a **vision-model adapter** that maps vision items → nodes and vision connections → edges, then feeds the existing `buildGraph`/`renderGraphHtml` path unchanged.

`server/graph-export.js` deletes its inline `generateHTML` (`:121-314`) and calls `renderGraphHtml` instead. Its two routes (`GET`/`POST /api/export/roadmap-graph`) and the cockpit buttons are untouched at the seam — only the HTML producer changes.

**Why:** one template, one status/edge map, one place that can drift. `renderGraphHtml` already gives determinism (key-sorted JSON, no timestamp → `--check` parity) and the `DanglingEdgeError` gate for free. graph-export.js's three defects (forked template, wall-clock date, no dangling refusal) all disappear by deletion, not by patching.

## Decision 2: One source = the vision model — with two explicit projections, not one ambiguous fallback

**Codex review (2026-06-21) showed the naive "vision-state.json if present, else scan+seed" fallback is unsound**: the live `VisionStore` holds arbitrary cockpit-authored items + manual edits, and `seedFeatures` only *upserts* (never rebuilds/removes stale state, `feature-scan.js:618`). So that fallback would render *different* graphs depending on whether prior cockpit state exists — fatal for `--check`/CI determinism.

Resolve by naming **two projections of the one model**, both through the **same adapter + renderer**, differing only in which store instance feeds them:

- **Live projection ("export what the cockpit shows").** The `GET/POST /api/export/roadmap-graph` routes + cockpit buttons render the **live in-memory `VisionStore`**, including manual edits. Non-canonical by definition, non-deterministic-friendly, for the user looking at their cockpit.
- **Canonical projection ("the roadmap graph").** Headless CLI / MCP / CI render a **freshly, deterministically seeded** model: `scanFeatures` + `seedFeatures` into a throwaway in-memory store, ignoring persisted local mutations. This is the byte-stable input that drives `--check` and the CI dangling gate. It does **not** read `vision-state.json`.

**Why:** this keeps "one model shape, one adapter, one renderer" while being honest that the cockpit store is a *superset* of the canonical roadmap (it also holds ad-hoc local items). The canonical artifact must be reproducible from committed source (`feature.json`/`deps.yaml`/ROADMAP.md via the seed), not from a developer's mutable local cockpit state. `feature.json` is therefore **not a second graph source** — it is the deterministic seed of the canonical projection.

## Decision 4: The vision model must become a faithful superset of `collect.js` BEFORE `collect.js` is retired (migration prerequisites)

Codex confirmed `collect.js` is not just a collector — it carries semantics the vision seed lacks today. Retiring it first would **change the graph's meaning, not just its implementation.** The following are hard prerequisites, sequenced before the delete:

1. **Dependency edges (`deps.yaml` → typed connections).** Real dep semantics come from `deps.yaml` via `depsToEdges` (`collect.js:86`, `model.js:120`). The vision seed only makes `informs` edges from prose cross-links (`feature-scan.js:668`). Prereq: teach `seedFeatures` to ingest `deps.yaml` `depends_on`/`blocks`/`concurrent_with` as typed vision connections, so the canonical projection keeps full dependency provenance. (Verify against a real project's two edge sets in blueprint.)
2. **`track` field.** `VisionStore` has **no `track` field** (`vision-store.js:159`); the seed persists only `description/status/phase/confidence/files/group` (`feature-scan.js:625`), and `graph-export.js` regex-scrapes `Track:`/`Priority:` from descriptions (`:55`). Prereq: either add a first-class `track` to the vision item (seeded from feature/design metadata, `collect.js:52`) or commit to `group`-as-track with a documented fidelity note. The adapter cannot "just pick a field" — the model must carry it first.
3. **External-prefix dangling oracle.** `collect.js:35` treats configured external-prefix refs as *known-but-not-rendered* so cross-project edges don't trip `DanglingEdgeError`. `scanFeatures` has no such notion. Prereq: re-home the external-prefix allowlist into the adapter / seed so the canonical projection doesn't false-positive on legitimate external refs.
4. **ROADMAP-fallback node universe.** `collect.js:64` pulls real-coded ROADMAP.md rows that lack a feature folder as fallback nodes. `scanFeatures` only walks feature directories (`feature-scan.js:137`). Prereq: decide whether the seed adds those fallback nodes (preserve current node universe) or we intentionally narrow to feature-folder nodes (documented behavior change).

**Sequencing guard:** `collect.js` may only be deleted once 1–4 land and a diff on a real project shows the canonical projection's `{nodes, edges}` is a superset of (or intentionally-documented delta from) the old collector's output.

## Decision 3: Delete the dead seed and the pre-push staleness chore; keep the CI gate

- **Delete** `seedFromRoadmapGraph` + `parseRoadmapGraph` + `findRoadmapGraph` (`feature-scan.js:434-593`) and the two callers (`server/index.js:177,210`). It is dead, circular, and uses `Function()` eval.
- **Delete** the pre-push hook template (`templates/hooks/roadmap-graph-pre-push.sh`) and its `--check` staleness role. The artifact is now always regenerable from the live model on demand, so "is the committed HTML stale" is a self-created chore.
- **Keep** the CI workflow value: regenerate from the vision model and fail on `DanglingEdgeError` (the real anti-crash gate). Repoint `.github/workflows/roadmap-graph.yml` (and the shippable `templates/ci/roadmap-graph.yml`) at the vision-model path. Drop committed-artifact `--check` mode unless we keep `roadmap_graph_check` for an opt-in committed graph.

## Approaches considered

- **A — Adapter into the canonical renderer (CHOSEN).** New vision-model adapter; `lib/roadmap-graph` renders it; graph-export/MCP/CLI/CI are thin callers; delete forked template + dead seed + pre-push chore. One renderer, one source. Most consolidation, preserves every unique capability the user chose to keep.
- **B — Keep both renderers, just dedupe the template.** Have graph-export.js `import` the canonical `template.html` but keep its own vision collection. Rejected: still two collection paths and two status maps; only fixes the template fork, not the source duplication. Doesn't deliver "one source".
- **C — Live-only, delete all static machinery.** (The rejected fork from the gate question.) Simplest code-wise but drops offline viewing + the CI dangling gate, which are genuinely not replaceable by a live view.

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `lib/roadmap-graph/vision-adapter.js` | new | Map vision items/connections → graph `{nodes, edges, config}` for `buildGraph`. The one place vision→graph vocab mapping lives. |
| `lib/roadmap-graph/index.js` | modify | Add a vision-model entrypoint (e.g. `generateFromVision(store|stateJson, opts)`) alongside/over the existing `generateRoadmapGraph`. Keep atomic-write + `checkRoadmapGraph` determinism. |
| `lib/roadmap-graph/collect.js` | retire LAST (after Decision 4 prereqs) | feature.json/deps.yaml collection superseded by the vision model. Its external-prefix oracle (`:35`) + ROADMAP-fallback nodes (`:64`) + metadata precedence (`:52,130-157`) must be re-homed first, not dropped. |
| `lib/roadmap-graph/model.js` | keep | `buildGraph` + `DanglingEdgeError` + status/edge canon — reused unchanged. |
| `lib/roadmap-graph/{render.js,template.html,config.js}` | keep | The one renderer + config (`compose.json#roadmap_graph`). |
| `lib/roadmap-graph/vision-seed.js` | new (likely) | Deterministic canonical-projection seed: scan+seed (+ deps.yaml + external-prefix) into a throwaway store for headless render. Shared by CLI/MCP/CI. |
| `server/graph-export.js` | modify | Delete inline `generateHTML` (`:121-314`); route handlers call the canonical renderer with the **live** in-memory store (live projection). Routes + token-gate unchanged. |
| `server/vision-store.js` | modify | Add first-class `track` field to the item shape (Decision 4.2) — or document `group`-as-track. |
| `server/feature-scan.js` | modify | Delete `seedFromRoadmapGraph`/`parseRoadmapGraph`/`findRoadmapGraph` (`:434-593`) + `GRAPH_STATUS_MAP`/`GRAPH_EDGE_MAP`. Extend `seedFeatures` to ingest `deps.yaml` typed edges, `track`, and external-prefix awareness (Decision 4.1–4.3). |
| `server/index.js` | modify | Remove the two `seedFromRoadmapGraph` calls (`:177,210`). |
| `server/compose-mcp-tools.js` | modify | `toolRoadmapGraph`/`toolRoadmapGraphCheck` call the vision-model entrypoint. Small summaries unchanged. |
| `bin/compose.js` | modify | `compose roadmap graph` builds the vision model headless (vision-state.json or scan+seed) then renders. Drop any feature.json-specific assumptions. |
| `templates/hooks/roadmap-graph-pre-push.sh` | delete | Pre-push `--check` staleness chore retired. |
| `templates/ci/roadmap-graph.yml`, `.github/workflows/roadmap-graph.yml` | modify | Regenerate from vision model + dangling gate; drop committed-artifact `--check` mode. |
| `src/components/vision/GraphView.jsx` | keep | Export buttons (`:1009-1027`, `:1059-1060`) unchanged — they hit the same routes. |
| `test/graph-export-routes.test.js`, `test/roadmap-graph*.test.js` | modify | Re-point at the unified path; add a byte-stability (`--check` idempotency) test and a dangling-refusal test for the vision source. |

## Open Questions

Findings 1 (edge reconciliation), 2 (track metadata), 3 (external-prefix oracle), and 4 (ROADMAP-fallback nodes) from the Codex design review are **resolved into Decision 4 as sequenced prerequisites** — no longer open. Remaining:

1. **Keep `roadmap_graph_check` at all?** With no committed artifact + pre-push chore gone, `_check` (regen-vs-on-disk diff) only serves an opt-in committed-graph CI mode. (Recommend: keep the function, drop only the hook — low cost, preserves the opt-in CI mode.)
2. **`track` as a field vs `group` reuse.** Decision 4.2 allows either. Default recommendation: reuse `group` as track with a documented fidelity note (avoids a vision-store schema migration); promote to a first-class `track` only if blueprint finds `group` already overloaded.
3. **Completed-node default.** Confirm we keep `DROP_STATUSES` default (drop COMPLETE/SUPERSEDED/KILLED) so behavior matches both current paths; the dimmed-historical mode stays deferred to COMP-ROADMAP-GRAPH-1-3.

# COMP-ROADMAP-GRAPH-2: Implementation Report (S1+S2 increment)

**Status:** PARTIAL — S1+S2 of 5 shipped
**Date:** 2026-06-21
**Design:** [design.md](./design.md) · **Blueprint:** [blueprint.md](./blueprint.md)

## Summary

First increment of collapsing the three roadmap-graph surfaces onto one renderer.
Landed the foundational vision→graph adapter (S1) and repointed the cockpit's
standalone HTML export onto the single canonical renderer (S2). The forked,
non-deterministic export template is gone. The deeper seed migration and the
retirement of `collect.js` (S3–S5) are deferred to a follow-up under the same
feature code, per an explicit stage-it-first decision at the S2 checkpoint.

## Delivered vs planned

| Slice | Planned | Status |
|---|---|---|
| S1 vision adapter | `visionToGraphInputs` → buildGraph input shape | ✅ shipped |
| S2 live export onto canonical renderer | delete forked template, route through buildGraph→renderGraphHtml | ✅ shipped |
| S3 seed absorbs collect.js semantics | deps.yaml→connections, track, external, fallback | ⏳ deferred |
| S4 `buildFromVision` canonical headless | CLI/MCP repoint + superset gate | ⏳ deferred |
| S5 retire collect.js + dead seed + hook | deletions | ⏳ deferred |

## Key implementation decisions

- **Two projections, one renderer.** S2 is the *live* projection ("export what
  the cockpit shows"): it renders the in-memory store through the same
  `buildGraph → renderGraphHtml` chain the headless path will use. The adapter
  only emits edges between resolved feature nodes, so `buildGraph` cannot dangle
  on the live store; a defensive `DANGLING_EDGE` catch rebuilds without the
  offending edges so the export route never 500s.
- **`lifecycle.featureCode` precedence.** Matched the live store's historical
  code resolution (`lifecycle.featureCode || featureCode || title`) — caught by
  reading the old `extractGraphData` at `graph-export.js:51`, not assumed.
- **External-prefix codes are known-but-not-rendered.** Verified against
  `buildGraph` (`model.js:84`): codes in `knownCodes` but not in `kept` have
  their edges silently dropped, so external refs neither dangle nor orphan.
- **No vision-store schema change yet.** S1 reads `group` as the track carrier
  (the model has no `track` field). The decision to formalize group-as-track vs
  add a field lands with S3.

## Architecture deviations from blueprint

None. S1+S2 implemented as specified. The corrections table in the blueprint
(e.g. `renderGraphHtml` single-object arg, `RawEdge {from,to}`, `dangling.kind`)
held up against the working tree during verification.

## Test coverage

- New `test/roadmap-graph-vision-adapter.test.js` — 12 unit tests (node mapping,
  status/edge maps, lifecycle.featureCode, external-prefix knownness,
  feeds-buildGraph-without-throwing).
- Existing `test/graph-export-routes.test.js` (6) and `test/roadmap-graph.test.js`
  (21) remain green — the route contract and the static path are unbroken.

## Known issues & tech debt

- The static path (`collect.js` + MCP `roadmap_graph` + CLI) still reads
  feature.json/deps.yaml — it is **not yet** unified onto the vision model. Until
  S3+S4, there remain two data sources (live store vs feature.json), though now
  only **one renderer**.
- The dead `seedFromRoadmapGraph` / pre-push hook are still present (S5).

## Lessons learned

- Reading the old `extractGraphData` before deleting it surfaced the
  `lifecycle.featureCode` precedence that a from-scratch adapter would have
  missed — delete-after-read, not delete-then-discover.
- `buildGraph`'s "known but not rendered → drop edge" branch is what makes the
  external-prefix oracle safe; the adapter only had to put external codes in
  `knownCodes`, not special-case edge filtering.

# COMP-ROADMAP-GRAPH-2: Implementation Report

**Status:** COMPLETE — S1–S5 shipped
**Date:** 2026-06-21
**Design:** [design.md](./design.md) · **Blueprint:** [blueprint.md](./blueprint.md)

## Summary

Collapsed the three overlapping roadmap-graph surfaces onto **one renderer + one
source**. The cockpit's live export and the headless CLI/MCP/CI generator now
both render the vision model through `buildGraph → renderGraphHtml`. The static
`collect.js` collector is retired; its committed-source collection moved into the
vision seed, which is now a **managed projection of `feature.json`** (canon).

The work landed in two pushes: S1+S2 (one renderer, shipped first as a low-risk
increment) then S3–S5 (the seed migration + `collect.js` retirement). A pivotal
finding mid-S4 reframed the second half: the superset gate proved the vision
seed produced 233 nodes vs collect.js's 57 because `scanFeatures` read status
from design.md prose, not `feature.json`. Making `feature.json` status
authoritative — the user's explicit "feature.json is canon, kill the de-syncs"
directive — collapsed the gate to an exact match (57/57 nodes, 33/33 edges).

## Delivered vs planned

| Slice | Planned | Status |
|---|---|---|
| S1 vision adapter | `visionToGraphInputs` → buildGraph input shape | ✅ shipped |
| S2 live export onto canonical renderer | delete forked template, route through buildGraph→renderGraphHtml | ✅ shipped |
| S3 seed absorbs collect.js semantics | deps.yaml→connections, track, **feature.json status authoritative**, ROADMAP-fallback | ✅ shipped |
| S4 canonical headless projection | `server/roadmap-graph-vision.js` + CLI/MCP repoint + superset gate (57/57, 33/33) | ✅ shipped |
| S5 retire collect.js + dead seed | deleted `collect.js`, `seedFromRoadmapGraph`/parse/find + startup calls | ✅ shipped |

**S5 note:** the pre-push hook template was **retained** (not deleted). It now
runs `compose roadmap graph --check` against the canonical vision projection, so
it is the legitimate "committed artifact matches canon" CI gate the design chose
to keep — no longer a separate-source staleness chore. Its removal, if still
wanted, is a trivial follow-up.

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

- **Documented deltas vs the old static path** (all intentional under "vision is
  the source"): node `name` is the vision title (= code) rather than design.md
  frontmatter `name`; `PARTIAL` features render as `in_progress` (the vision
  vocab has no `partial`); track grouping comes from the vision `group`
  (auto-derived per epic) rather than a static `standalone` default. The
  superset gate confirmed node/edge *sets* and statuses match exactly bar these.
- **`feature.json` status now syncs onto the live cockpit on every seed.** This
  is the intended de-sync fix (feature.json is canon), but it means manual
  *feature* status edits in the cockpit are overridden — by design.
- **Deps-derived structural edges (`blocks`/`supports`) are reconciled on seed**,
  not appended: removing a `deps.yaml` edge drops the stale connection so the
  live export can't drift from canonical. Consequence (Codex-flagged, accepted as
  intended): a hand-drawn `blocks`/`supports` edge between two managed features
  is indistinguishable from a derived one and is removed on reseed — feature
  dependencies are `deps.yaml`-managed, not hand-edited (the "managed, no manual"
  mandate). A provenance flag to preserve manual structural edges was
  deliberately not added (out of scope).
- The pre-push hook removal (S5) was deferred as trivial (see S5 note above).

## Lessons learned

- The superset diff gate was the MVP of this feature: it empirically converted a
  suspected design risk into a precise root cause (status sourced from prose, not
  `feature.json`) and then proved the fix exact (57/57, 33/33). Build the gate
  before trusting the migration.
- Routing a canonical artifact through a runtime store is lossy by default — the
  store can't represent an edge to a missing node, so the dangling-edge *lint*
  had to be re-added explicitly (crash-prevention survived; the loud typo-catch
  did not, until restored in `collectVisionInputs`).
- Reading the old `extractGraphData` before deleting it surfaced the
  `lifecycle.featureCode` precedence a from-scratch adapter would have missed.
- "feature.json is canon" is the unifying principle: it fixes the graph, the
  cockpit status display, and (per a parallel directive) ROADMAP.md generation.

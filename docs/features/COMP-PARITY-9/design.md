# COMP-PARITY-9: UI feature scaffolding (New Feature dialog)

**Status:** DESIGN (Phase 1 — not yet implemented)
**Created:** 2026-06-07
**Phase:** COMP-PARITY: UI↔CLI Parity

---

## Problem

The CLI has `compose feature <CODE> "<description>"` (`bin/compose.js:939`), which
scaffolds a feature in one shot: `docs/features/<CODE>/`, a `feature.json` (source
of truth), a seed `design.md`, and a `ROADMAP.md` row. There is **no cockpit
affordance for this**. The only UI path that produces a feature is ideabox
*promote* (`IdeaboxPromoteDialog.jsx` → `POST /api/ideabox/ideas/:id/promote`),
and it requires an existing idea as the entry point — you cannot start a feature
from a blank slate in the UI. This is a direct UI↔CLI parity gap.

## Approach

Add a small **New Feature** dialog opened from the header controls. It collects a
feature code, a description, and an optional phase, validates the code, and POSTs
to a new auth-gated endpoint `POST /api/features/scaffold`. The server reuses the
existing typed writer rather than reimplementing folder/feature.json/roadmap
creation.

The load-bearing reuse is `addRoadmapEntry(cwd, args)` in
`lib/feature-writer.js:99`. It already does exactly what we need and nothing more:

- `validateCode(args.code)` — strict `isFeatureCode` contract (`lib/feature-code.js`).
- refuses if the feature already exists (`feature-writer: feature "<code>" already exists`).
- `provider.createFeature` writes the validated `feature.json`.
- `provider.renderRoadmap()` regenerates the `ROADMAP.md` row.
- returns a **compact** result `{ code, phase, position, roadmap_path, roundtrip }`.

That compactness matters. Project memory records that the *MCP* `add_roadmap_entry`
tool blows the MCP token cap because the MCP serialization layer echoes the full
roadmap; the underlying `addRoadmapEntry` lib function does **not** — it returns
the small object above. By calling the lib function directly from an Express
handler (not through the MCP boundary) we get the compact return for free, and the
route layer never echoes the regenerated roadmap to the UI.

The one thing `addRoadmapEntry` does not do that the CLI verb does is write the
seed `design.md` stub. The handler adds that small write after a successful entry
(idempotent: skip if the file already exists), matching `bin/compose.js:1046-1065`.

## Options considered

1. **New `/api/ideabox`-style route module that reuses `addRoadmapEntry`** *(chosen)*.
   Smallest correct surface. No reimplementation of scaffolding. Compact return
   guaranteed by the lib function. Mirrors `build-routes.js` for auth + test shape.
2. **Reimplement the CLI verb's inline logic in the handler.** Rejected: the verb
   logic in `bin/compose.js` is hand-rolled roadmap-string-splicing that predates
   the typed writer; `addRoadmapEntry` is the maintained, validated, roundtrip-guarded
   path. Duplicating it would drift.
3. **Call the MCP `scaffold_feature` tool.** Rejected: that tool (`toolScaffoldFeature`,
   `compose-mcp-tools.js:707`) only scaffolds *phase-artifact stubs* via
   `ArtifactManager.scaffold` — it does **not** create `feature.json` or a roadmap
   row, so it does not close the parity gap.

## Chosen design

- **Endpoint:** `POST /api/features/scaffold`, body `{ code, description, phase?, group? }`.
  Auth-gated with `requireSensitiveOrPaired` (the same import alias
  `requireSensitiveToken` that `build-routes.js` uses). Calls `addRoadmapEntry`,
  then writes the seed `design.md`. Returns the compact `{ ok, code, phase,
  position, roadmap_path, featurePath }`. `400` on invalid code / missing
  description; `409` on duplicate code. The narrative-owned-workspace refusal
  thrown by `addRoadmapEntry` surfaces as a clean error.
- **Dialog:** `NewFeatureDialog.jsx` mirroring `IdeaboxPromoteDialog` conventions
  (Dialog primitive, `wsFetch`, client-side `isFeatureCode`-equivalent validation),
  a single submit step.
- **Wiring:** one import + one attach line in `vision-server.js`; one import, one
  header button, one dialog mount in `App.jsx` (all discrete additive insertions —
  COMP-PARITY-2/-6/-8 also touch these files in parallel).

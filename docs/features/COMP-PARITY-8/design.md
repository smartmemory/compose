# COMP-PARITY-8 — UI launchers for build-all and gsd

**Status:** DESIGN (Phase 1) — not yet implemented. Reviewers: assess the approach, not shipped code.

## Problem

The cockpit can dispatch a single feature build (the `StartBuildPopover` /
`startBuild` → `POST /api/build/start` path), but two batch-grade CLI verbs have
**no UI trigger**:

- `compose build --all` — parses ROADMAP.md, builds a dependency DAG, and runs
  every still-buildable (PLANNED/PARTIAL) feature in topological order
  (`lib/build-all.js` → `runBuildAll`).
- `compose gsd <CODE>` — per-task fresh-context dispatch for one feature from
  its existing `blueprint.md` Boundary Map (`lib/gsd.js` → `runGsd`).

Both are CLI/headless-only, so a UI-first user cannot run a roadmap-wide build
or a GSD build at all. The roadmap row asks us to add cockpit controls that
**reuse the existing build-start dispatch**.

## Constraints (verified against the codebase)

- `POST /api/build/start` (`server/build-routes.js:39`) is the single dispatch
  seam. It currently accepts `mode` ∈ {`feature`,`bug`} and calls
  `runBuild(featureCode, opts)`. Auth: `requireSensitiveOrPaired` (aliased
  `requireSensitiveToken`).
- **COMP-PARITY-2 is being built in parallel** and also edits
  `server/build-routes.js`, `src/App.jsx`, and `src/lib/startBuild.js`. It adds
  `mode:'new'`/resume. All my edits to those three files must be **additive,
  anchored insertions** that coexist with PARITY-2's — no rewrites of shared
  blocks, no shared launcher component.
- `runBuildAll({ cwd?, dryRun?, filter?, features? })` returns
  `{ built, failed, skipped, skippedComplete }`. It does not take a
  `featureCode` and is roadmap-wide.
- `runGsd(featureCode, { cwd?, resume? })` returns `{ status, flowId,
  blackboardEntries }`; it hard-requires `docs/features/<CODE>/blueprint.md`.

## Options

1. **New endpoints** (`/api/build/all`, `/api/gsd/start`). Rejected: the
   roadmap row and the PARITY-2 precedent both say *reuse build-start dispatch*;
   two more endpoints duplicate auth + error handling and diverge from PARITY-2.
2. **New modes on `POST /api/build/start`** (`mode:'all'`, `mode:'gsd'`).
   **Chosen.** Mirrors how PARITY-2 adds `mode:'new'`; one auth-guarded seam;
   the existing 409-on-"already active" mapping is reusable for GSD.
3. **Reuse PARITY-2's LaunchPopover for the UI.** Rejected per coordination
   note — sharing a component would couple the two features' files. Ship an
   **independent control** in its own file; note a unified launcher as a
   follow-up.

## Chosen approach

**Server:** add two additive `mode` branches to the existing
`POST /api/build/start` handler. `mode:'all'` wraps `runBuildAll` (no
`featureCode` required — roadmap-wide); `mode:'gsd'` requires `featureCode` and
wraps `runGsd`. Both injected as `deps` for tests, mirroring `runBuild`. The
existing `featureCode required` / mode-validation guards are widened additively
so `mode:'all'` is exempt from the `featureCode` requirement and `mode:'gsd'`
keeps it.

**UI:** a self-contained header control `BuildAllGsdControl.jsx` (its own file,
mirroring `EnvironmentHealthPanel`'s header-button-plus-popover pattern and
`StartBuildPopover`'s styling/testids). It offers two actions: **Build all
PLANNED** (confirm-gated via `useConfirm()` — it is expensive and
roadmap-wide) and **GSD `<CODE>`** (a feature-code text input). Both dispatch
through the shared `startBuild` helper with a new optional field, never a new
fetch path.

**startBuild:** add an optional passthrough so callers can send `mode:'all'`
or `mode:'gsd'`. The helper already forwards `mode`; the only addition is
allowing `featureCode` to be omitted for `mode:'all'` (distinct from any
`resume` field PARITY-2 may add).

This keeps every change additive, backward-compatible, and disjoint from
PARITY-2 while reusing the one dispatch seam.

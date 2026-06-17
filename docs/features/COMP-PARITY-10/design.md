# COMP-PARITY-10 — QA Scope Cockpit Panel — Design

**Status:** Phase 1 design doc (not yet implemented). Sibling of COMP-PARITY-6 (Validate tab), built additively.

## Problem

`compose qa-scope <CODE>` (bin/compose.js:2694) maps a feature's `filesChanged` to
affected/adjacent routes via the COMP-QA mapper (`lib/qa-scoping.js`). COMP-QA shipped
this as a build-phase step and a terminal verb, but there is **no cockpit surface**. A
UI-first reviewer who wants to see "what does this change touch?" must drop to a shell.
COMP-PARITY-10 closes that gap: surface the existing qa-scoping analysis in the cockpit,
read-only, backed by the same mapper (no logic fork).

## Approach

Mirror the freshest read-only-panel precedent in the codebase, COMP-PARITY-3's
environment-health pair:

- **Server:** a new `server/qa-scope-routes.js` exporting `attachQaScopeRoutes(app, deps?)`,
  exactly like `server/health-routes.js` → `attachHealthRoutes`. One GET endpoint,
  read-only, **no auth gate** (mirrors `GET /api/environment-health`, which has no
  `requireSensitiveToken`). It wraps `readFeature` + `mapFilesToRoutes` + `classifyRoutes`
  and returns the same fields the CLI prints. Injectable deps (`readFeature`, `mapFilesToRoutes`,
  `classifyRoutes`) let tests stub the mapper without disk fixtures — the same injectable-runner
  trick `attachHealthRoutes` uses for `runCommand`.
- **UI:** a new view component `src/components/vision/QaScopeView.jsx` that fetches
  `/api/qa-scope?featureCode=…` via `wsFetch` and renders affected / adjacent / unmapped
  with the EnvironmentHealthPanel fetch/loading/error idiom (monotonic request token,
  degrade-never-throw). It reads the already-derived `featureCode` (`activeFeatureCode`)
  that App.jsx threads into every view.

## Options considered

1. **New ViewTab keyed to the active feature** *(chosen)* — add a `qa-scope` key to
   `ViewTabs` + `viewTabsState.DEFAULT_MAIN_TABS` + a `CockpitView` switch case, exactly
   how COMP-PARITY-6 adds its `validate` tab. The view uses the active `featureCode` already
   threaded through `CockpitView`. Cleanest match to the existing view system; one discrete
   additive entry per shared file; coexists with PARITY-6 as a sibling tab.
2. **Sub-panel inside an existing view (e.g. ItemDetailPanel / DocsView)** — rejected: it
   buries route analysis inside an unrelated surface, needs intrusive edits to a large
   existing component, and doesn't match how every other capability (Gates, Pipeline,
   Sessions, Builds) is its own tab.
3. **Header popover like EnvironmentHealthPanel** — rejected: the health dot is a passive,
   always-on, project-wide signal. QA scope is per-feature, list-shaped, and read on demand
   while reviewing a specific feature — a main-area view fits the mental model far better.

## Chosen design

New `qa-scope` ViewTab. Endpoint `GET /api/qa-scope?featureCode=<CODE>` resolves
`req.workspace.root` as cwd (same root the CLI's `resolveCwdWithWorkspace` produces),
calls `readFeature(root, code)`, then `mapFilesToRoutes(feature.filesChanged, { cwd: root })`
and `classifyRoutes(result.affectedRoutes, [])` — byte-for-byte the CLI's pipeline
(bin/compose.js:2707-2724, including the `allKnown = []` v1 no-registry note). Response:
`{ featureCode, framework, docsOnly, affected, adjacent, unmappedFiles, filesChanged }`,
plus `{ found: false }` for an unknown code and a `docsOnly`/empty-diff signal so the
panel can render the same "no filesChanged recorded" guidance the CLI prints. Read-only,
degrade-never-500. Tab/panel additions to App.jsx, ViewTabs.jsx, and viewTabsState.js are
single additive lines that sit alongside PARITY-6's parallel `validate` additions.

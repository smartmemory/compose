# COMP-PARITY-6 — compose validate findings panel

**Status:** Phase 1 (design) — proposal for review, not shipped code.
**Phase:** COMP-PARITY: UI↔CLI Parity · **Complexity:** S · **Parent:** COMP-PARITY

## Related Documents
- Blueprint: `docs/features/COMP-PARITY-6/blueprint.md`
- Sibling pattern (read-only CLI-verb-as-panel): COMP-PARITY-3 — `server/health-routes.js`, `src/components/cockpit/EnvironmentHealthPanel.jsx`

## Problem

`compose validate` (and the cross-artifact `validateFeature` / `validateProject`
logic in `lib/feature-validator.js`) is **terminal-only**. The validator surfaces
32 finding kinds across feature and project scope — status drift, dangling links,
missing artifacts, orphan folders, journal-index drift — each with a severity
(`error` / `warning` / `info`). Today this signal is reachable only by running the
CLI in a shell; a UI-first reviewer working in the cockpit has **zero visibility**
into whether the workspace's artifacts are internally consistent. This is the same
"silent drift, no UI signal" gap that COMP-PARITY-3 closed for environment health.

## Approach

Mirror the COMP-PARITY-3 pattern exactly: a **read-only REST endpoint that wraps
the existing CLI logic** plus a **read-only cockpit surface** that fetches it.

- **Server:** a new `server/validate-routes.js` exporting `attachValidateRoutes(app, deps?)`,
  registering `GET /api/validate?scope=feature|project&featureCode=…`. The handler
  calls the existing `validateFeature(cwd, code)` / `validateProject(cwd, options)`
  with `cwd = req.workspace.root` (the same workspace source `health-routes.js`
  uses) and returns the validator's native result object verbatim, plus a
  `bySeverity` rollup the panel renders. The validator's public contract is
  **unchanged** — we wrap, never reimplement. Path is deliberately NOT under an
  auth-allowlisted prefix, matching the health read endpoint (default-deny remote,
  open on localhost). `external` xref resolution stays OFF (no network) — the panel
  is a fast, local, read-only consistency check.

- **UI:** a new top-level **Validate view tab**. A `src/components/vision/ValidateView.jsx`
  fetches `/api/validate` for the current scope (project by default; feature scope
  when a feature is focused), groups findings by severity, and renders them. It
  reuses the canonical `EnvironmentHealthPanel` fetch idiom: a `wsFetch`-based hook
  with monotonic request-token guarding, loading / error / empty states, a manual
  `↻` refresh, and a scope toggle (Project ↔ Feature). Read-only; degrades, never
  throws.

## Options considered

1. **New top-level ViewTab (chosen).** Validation findings are an *independent
   finding surface* over the whole workspace (project scope) or a selected feature
   (feature scope). That is exactly what a top-level view is for — it parallels
   Sessions, Builds, Gates, and Docs. It is discoverable, gives findings room to
   list and group, and supports a scope toggle without crowding another panel.
   Cost: one additive entry each in `ViewTabs` `TAB_META`, `DEFAULT_MAIN_TABS`, and
   the `CockpitView` switch.

2. **Header popover (like EnvironmentHealthPanel).** A passive dot + popover. Good
   for a tiny always-on summary, but findings are a *list* (potentially dozens,
   grouped by severity, per-feature) — a 360px popover is the wrong container, and
   the header is already dense (health dot, pair, theme, font).

3. **Sub-panel inside an existing view (e.g. context panel).** Couples validation
   to a selection and hides it behind the right rail; project-scope findings have
   no natural selection to hang off. Rejected.

## Chosen

Option 1 — a new **Validate** ViewTab backed by `GET /api/validate`. It is the
cleanest match for an independent finding surface, mirrors the established
read-only-CLI-verb pattern (server: health-routes; UI: simple view like
SessionsView), and keeps shared-file edits to minimal additive lines. Severity
grouping (`error` → `warning` → `info`) and a Project/Feature scope toggle are the
only view-specific logic; everything else is the proven fetch/render scaffold.

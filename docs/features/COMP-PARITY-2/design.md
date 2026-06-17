# COMP-PARITY-2 — UI launchers for the fix and new lifecycles

**Status:** DESIGN
**Date:** 2026-06-16
**Phase:** COMP-PARITY: UI↔CLI Parity

## Problem

The Pipeline tab renders a fix or new-product run **once it is already running** (it hydrates
from `active-build.json` via `GET /api/build/state`). But there is **no UI control to start
those lifecycles**. A UI-first dev who wants to `compose fix <bug>` or `compose new "<intent>"`
— the two richest lifecycles — is forced back to the terminal. There is also no way to
**resume an aborted fix** from the cockpit, even though the CLI supports `compose fix <code> --resume`.

Today the only build launcher is `StartBuildPopover` (src/components/vision/StartBuildPopover.jsx),
reachable only from an *existing vision item's* detail panel (ItemDetailPanel) — it dispatches
`POST /api/build/start` with `mode: 'feature' | 'bug'`. There is no top-level, item-independent
entry point, and the `new` product-kickoff lifecycle is not exposed to the server at all
(`compose new` calls `runNew(intent, opts)` in `lib/new.js`, a different entry point than
`runBuild`).

## Goal

A single top-level cockpit launcher that can: (1) start a **fix** lifecycle from a bug code,
(2) start a **new** product-kickoff from an intent string, and (3) **resume** the active fix
when one exists — without forcing the user to find or create a vision item first. Reuse the
existing `POST /api/build/start` dispatch substrate; add no new lifecycle model.

## Options considered

**A. Extend `StartBuildPopover` in place.** Add a "new" mode and a resume affordance to the
existing popover and surface it from the header. *Rejected:* the popover is item-scoped
(defaults its feature code from `item.lifecycle.featureCode`), and threading a null/synthetic
item plus a third mode bloats a component whose contract is "dispatch THIS item." Mixing the
intent-string `new` flow into a feature-code form muddies both.

**B. New top-level `LaunchPopover` component + extend `build-routes.js` additively.** A new
self-contained header-mounted launcher with three modes (Fix / New / Resume). `fix` reuses the
proven `mode: 'bug'` path; `new` adds an additive `mode: 'new'` branch in `build-routes.js`
that calls an injectable `runNew(intent, …)`; `resume` adds a `resume: true` flag that reads
`active-build.json` server-side and forwards `resumeFlowId` (mirroring the CLI's T8 logic).
*Chosen.* Keeps `App.jsx` to import + mount only; keeps the popover small; keeps the server
change purely additive and backward-compatible (existing payloads unchanged).

**C. Add a separate `POST /api/new/start` route module.** Cleaner separation but invents a new
route surface + a `vision-server.js` registration, when the existing `/api/build/start` handler
already owns dispatch, token-guarding, and the 409-conflict mapping. *Rejected* as more
surface for no behavioral gain — the prompt's constraint is "reuse build-start-style dispatch."

## Chosen approach (B)

1. **Server (additive):** in `server/build-routes.js`, accept `mode: 'new'` (dispatches via an
   injectable `runNew` dep with the intent carried in `description`) and a `resume: true` flag
   for `mode: 'bug'` (reads `active-build.json`, validates ownership/mode like the CLI, forwards
   `resumeFlowId`). Existing `feature`/`bug` payloads behave identically. Same
   `requireSensitiveOrPaired` guard, same 409 mapping.
2. **Shared helper:** extend `src/lib/startBuild.js` to pass through the optional `resume` flag
   (the body already round-trips `mode`/`description`; add `resume`).
3. **UI (new component):** `src/components/cockpit/LaunchPopover.jsx` — a header-mounted popover
   with Fix / New / Resume modes, dispatching via the shared `startBuild` helper. Resume mode is
   enabled only when `activeBuild?.mode === 'bug'` and prefills its code.
4. **App.jsx:** import + mount the launcher button in the header controls cluster only.

This is the smallest correct change: one new UI file, one shared-helper passthrough line, one
additive server block, and an import+mount in `App.jsx`. No new lifecycle model; `runNew` is
the same function the CLI already drives.

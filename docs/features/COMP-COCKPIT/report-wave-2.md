# COMP-COCKPIT Wave 2 — Implementation Report

**Status:** COMPLETE
**Shipped:** 2026-06-11
**Plan:** `plan-wave-2.md` · **Blueprint:** `blueprint-wave-2.md` · **Design:** `design-wave-2.md`
**Commits:** `969106c..b2bce68` (9 commits on main)

## Summary

Closed the four 2026-06-10 UX-journey-sweep gaps: failed-build retry from Past Builds (COCKPIT-7), cross-view entity links on a shared `EntityLink`/`NavigationContext` primitive (COCKPIT-8), a journal/changelog cockpit surface over the existing writer libs (COCKPIT-9), and wire-or-remove for five orphaned server routes (COCKPIT-10: three deleted, two wired behind a GraphView Export control).

## Delivered vs Planned

All four items delivered per blueprint. Notable in-flight additions, all from review rounds:

- `POST /api/export/roadmap-graph/save` token-gated (was unauthenticated filesystem write — Codex round 1, the one security must-fix).
- `EntityLink` gained `canNavigate(kind, id)` resolvability so stale targets degrade to plain text instead of dead links.
- `openGate` clears **both** gate-hiding filters (phase + feature-focus) and no-ops on vanished gates.
- Journal write form carries `feature_code` (seeded from the active filter) and is journal-source-only.
- JournalView fetches guarded against stale-response races (monotonic request id + latest-closure ref for post-write refresh).

## Key Decisions

- Retry is pure frontend (record already has `featureCode`+`mode`; `/api/build/start` 409s per-feature, not globally).
- `/api/vision/blocked`, `/api/vision/ui`, `/api/plan/parse` deleted rather than wired — zero callers, and blocked-state is already computed client-side.
- Changelog writes stay agent/pipeline-owned; the UI writes journal entries only.
- Slug collisions resolved by retrying on the writer's under-lock `idempotent` signal — no writer changes needed.

## Verification

- TDD per slice (red confirmed before implementation in all four).
- Full suite green: node phase + UI (199) + tracker (100), exit 0. One earlier run showed 12 fails + 1 cancelled; immediate re-run of the identical command was fully green — flake, consistent with a hung-test cascade, not reproduced.
- E2E smoke against a live server: journal/changelog reads (string `limit` honored), 401s on both token-gated writes, export HTML, deleted routes 404, clean start/stop.
- Codex review loop: REVIEW CLEAN after 6 converging rounds (security → contract → UX → races).
- Cross-feature integration review: clean after fixing its one should-fix (`openGate` stale fallback).

## Files Changed

New: `src/lib/startBuild.js`, `src/lib/navigation.jsx`, `src/components/shared/EntityLink.jsx`, `src/components/vision/JournalView.jsx`, `server/journal-routes.js`, 3 test files.
Edited: `App.jsx`, `PastBuildsView`, `StartBuildPopover`, `GraphView`, `GateView`, `ItemDetailPanel`, `AttentionQueueSidebar`, `OpenLoopsPanel`, `ContextPanel`, `DashboardView`, `ViewTabs`, `viewTabsState`, `vision-routes.js`, `vision-server.js`, `graph-export.js`, 4 test files.

## Known Issues / Tech Debt

- The full-suite flake (12 fails + 1 cancelled, non-reproducible) was not root-caused; if it recurs, the cancelled test is the lead.
- `EntityLink` adoption is the four named sites + Dashboard; older surfaces (e.g. SessionsView's bespoke link) migrate opportunistically.
- Journal write surfaces a 500 if `docs/journal/README.md` is missing (acceptable for compose-self; revisit if the surface ships to arbitrary projects).

## Lessons

- The reviewer pair (Codex + integration agent) independently converged on the same `openGate` bug — the per-feature review would not have caught the filter interactions.
- Two distinct stale-closure bugs in one small view (fetch race, post-write refresh): self-fetching views need the request-id + latest-ref pattern from the start.

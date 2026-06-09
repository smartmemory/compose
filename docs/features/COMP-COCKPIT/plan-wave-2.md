# COMP-COCKPIT Wave 2 — Execution Plan

**Status:** PLAN (Phase 6)
**Created:** 2026-06-10
**Blueprint:** `blueprint-wave-2.md` (gate clean, boundary map validated)

## Task graph

```
Wave A (parallel):  Task 1 (S01 / COCKPIT-7)   Task 2 (S02 / COCKPIT-10)   — disjoint files
Wave B:             Task 3 (S03 / COCKPIT-8)   — touches App.jsx, produces EntityLink
Wave C:             Task 4 (S04 / COCKPIT-9)   — consumes EntityLink, touches App.jsx
Wave D:             integration review → full suite → E2E smoke → Codex loop → coverage sweep
```

Waves B and C are sequential because both edit `src/App.jsx` and S04 consumes S03's `EntityLink`.

## Tasks

### Task 1 — COCKPIT-7 retry (S01)
Files: `src/lib/startBuild.js` (new), `StartBuildPopover.jsx`, `PastBuildsView.jsx`, `test/ui/past-builds-view.test.jsx` (all per blueprint §S01).
TDD: write failing BuildRow retry tests first (visibility per status, dispatch payload, 409 → warn notify).

### Task 2 — COCKPIT-10 orphan routes (S02)
Files: `server/vision-routes.js` (delete 3 handlers), `src/components/vision/GraphView.jsx` (Export control), `test/graph-export-routes.test.js` (new) (per blueprint §S02).
TDD: write export-route tests + deleted-route 404 assertions first.

### Task 3 — COCKPIT-8 entity links (S03)
Files: `src/lib/navigation.jsx` (new), `src/components/shared/EntityLink.jsx` (new), `App.jsx`, `GateView.jsx`, `ItemDetailPanel.jsx`, `AttentionQueueSidebar.jsx`, `OpenLoopsPanel.jsx`, `ContextPanel.jsx`, `DashboardView.jsx:249`, `test/ui/entity-link.test.jsx` (new), `test/ui/open-loops-panel.test.jsx` (per blueprint §S03).
TDD: EntityLink + openGate (phase-filter clearing) tests first.

### Task 4 — COCKPIT-9 journal surface (S04)
Files: `server/journal-routes.js` (new), `server/vision-server.js`, `src/components/vision/JournalView.jsx` (new), `viewTabsState.js`, `ViewTabs.jsx`, `App.jsx`, `test/journal-routes.test.js` (new), `test/ui/journal-view.test.jsx` (new), `test/cockpit-layout.test.js` (per blueprint §S04).
TDD: journal-routes tests first (limit parsing, slug-retry, INVALID_INPUT→400, token).

### Wave D — verification
1. Cross-item integration review (batch-build rule): EntityLink usage across S03/S04 surfaces, App.jsx merge of S03+S04 edits, no contract drift.
2. Full suite: `npm test -- --test-timeout=90000` (proof-run hang guard).
3. E2E smoke on affected flows (dev server, Playwright) — per Phase 7 step 2.
4. Codex review loop until REVIEW CLEAN (max 5).
5. Coverage sweep until TESTS PASSING (max 15).

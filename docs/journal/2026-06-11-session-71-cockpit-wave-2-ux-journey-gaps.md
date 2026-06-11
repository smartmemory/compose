---
date: 2026-06-11
session_number: 71
slug: cockpit-wave-2-ux-journey-gaps
summary: "COMP-COCKPIT Wave 2 shipped: build retry, EntityLink cross-view navigation, journal/changelog cockpit surface, orphan routes resolved"
feature_code: COMP-COCKPIT
closing_line: The orphan route was only safe while it stayed an orphan.
---

# Session 71 — COMP-COCKPIT

**Date:** 2026-06-11
**Feature:** `COMP-COCKPIT`

## What happened

The human invoked /compose build COMP-COCKPIT. The entry scan showed Wave 1 (items 1-6) COMPLETE, so the build targeted Wave 2 (COCKPIT-7..10, from the 2026-06-10 UX journey sweep). Three parallel explorers mapped the four areas; the design gate took 3 Codex rounds (journal adapter contracts, openGate vs phase filter, route-mount seam, slug-collision concurrency), the blueprint gate 2 (DashboardView line target, limit parsing, tab-migration test). Implementation ran as three waves of subagents (7+10 parallel, then 8, then 9 which consumes 8's EntityLink). The post-implementation loop was the densest part: an integration reviewer and Codex independently converged on the same openGate stale-fallback bug, and Codex went 6 rounds total — an unauthenticated filesystem-write route (export save), EntityLink dead links, the feature-focus filter hiding deep-linked gates, journal entries vanishing under an active filter, and two distinct stale-closure races in JournalView's fetching. One full-suite run flaked (12 fails + 1 cancelled, non-reproducible); the identical re-run was green end-to-end.

## What we built

New: src/lib/startBuild.js, src/lib/navigation.jsx, src/components/shared/EntityLink.jsx, src/components/vision/JournalView.jsx, server/journal-routes.js, three test files. Edited: App.jsx (NavigationContext, openGate with double filter-clear, canNavigate), PastBuildsView (Retry), StartBuildPopover, GraphView (export controls), GateView (scroll-to-focus), ItemDetailPanel, AttentionQueueSidebar (expand-in-place), OpenLoopsPanel, ContextPanel, DashboardView, ViewTabs/viewTabsState (journal tab), vision-routes.js (3 orphan routes deleted), vision-server.js, graph-export.js (token-gated save). Artifacts: design-wave-2.md, blueprint-wave-2.md (boundary map validated), plan-wave-2.md, report-wave-2.md.

## What we learned

1. Wiring a previously-orphaned route is a security event: the export-save route was harmless while nobody called it; giving it a UI caller without re-auditing auth would have shipped an unauthenticated filesystem write. 2. A 'jump to X' primitive must enumerate every filter that can hide X — phase filter and feature-focus were found in separate review rounds; either alone made the deep-link a silent no-op. 3. Self-fetching views need the request-id + latest-closure-ref pattern from the start: one small JournalView had two distinct stale-closure bugs, found in consecutive rounds. 4. The review pair (cross-feature integration agent + Codex) earned its cost — they independently converged on the same bug, and the integration lens caught a seam (provider-without-canNavigate consumers) per-feature reviews missed.

## Open threads

- [ ] COMP-MOBILE-1 still open in the Wave 2 roadmap phase (heading left PARTIAL)
- [ ] Full-suite flake (12 fails + 1 cancelled, not reproduced) — if it recurs, start from the cancelled test
- [ ] EntityLink adoption beyond the named sites (SessionsView bespoke link) is opportunistic
- [ ] Journal write 500s if docs/journal/README.md is missing — revisit if the surface ships beyond compose-self

---

*The orphan route was only safe while it stayed an orphan.*

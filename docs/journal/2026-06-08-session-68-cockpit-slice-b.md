---
date: 2026-06-08
session_number: 68
slug: cockpit-slice-b
summary: COMP-COCKPIT Slice B — run history, inline gate artifact, first-run empty-state CTAs; umbrella COMPLETE
feature_code: COMP-COCKPIT
closing_line: The cockpit can now tell you what it did, show you what it's deciding, and welcome you when it's empty.
---

# Session 68 — COMP-COCKPIT

**Date:** 2026-06-08
**Feature:** `COMP-COCKPIT`

## What happened

Finished the COMP-COCKPIT umbrella by delivering Slice B {COCKPIT-4, COCKPIT-5, COCKPIT-3} — the observability/onboarding half deferred when Slice A {1,2,6} shipped on 2026-06-07. The umbrella design was already gate-approved, so we resumed at the blueprint: verified every file:line ref against post-Slice-A source (lines had shifted), wrote a Slice-B blueprint, and ran it past Codex. Codex's blueprint pass earned its keep twice — it caught (1) a health-gate race where archiving build history at the three terminal sites would record 'complete' for a build the COMP-HEALTH gate later downgrades to 'failed', and (2) a view-local emptiness leak where every cockpit view receives pre-filtered data and so can't tell 'empty project' from 'filters exclude everything'. We corrected the blueprint (single post-health archive site; central isEmptyProject from raw store items) before writing code. Implementation went TDD; the Codex implementation review came back REVIEW CLEAN on the first pass.

## What we built

New: lib/build-history.js (append-only writer + bounded most-recent-first reader, best-effort/never-throws); src/components/vision/PastBuildsView.jsx (prop-driven, mirrors SessionsView); src/components/vision/shared/MarkdownViewer.jsx (extracted from DocsView: ReactMarkdown+remarkGfm+mermaid). Modified: lib/build.js (one archive call after the COMP-HEALTH block using final buildStatus + in-memory vars, failureReason from last failed step); server/build-routes.js (GET /api/builds, read-only, no token); useVisionStore.js (buildHistory + fetchBuildHistory); viewTabsState.js + ViewTabs.jsx (build-history tab); GateView.jsx (collapsible inline gate.artifactSnapshot, snapshot-only); DocsView.jsx (use shared MarkdownViewer); ItemFormDialog.jsx (feature preset + initialType); TreeView/GraphView/DashboardView.jsx (empty-state CTAs gated on isEmptyProject); App.jsx (isEmptyProject, handleCreateFeature, createInitialType, view wiring). Tests: 21 new across build-history, build-routes, past-builds-view, gate-artifact-inline, empty-state-cta.

## What we learned

1. Archiving terminal state must happen after ALL status mutations — the COMP-HEALTH gate downgrades buildStatus after the active-build.json terminal writes, so the only correct archive point is post-health, where stepHistory is still in scope. 2. In a filtered-view architecture, only the data source can honestly decide emptiness; any component downstream of a filter sees length===0 for both empty and filtered-out. Compute the signal once at the source and thread it. 3. Codex reviewing a Phase-4 blueprint frames findings as 'the code doesn't exist yet' (a category artifact), but the underlying design corrections were real — read past the framing. 4. Assemble run records from in-memory build context, never re-read active-build.json (last-writer-wins across concurrent builds).

## Open threads

- [ ] Run history is forward-only; no backfill of pre-existing runs (data never persisted).
- [ ] Live build to PastBuildsView E2E not auto-run (avoided auto-starting servers); writer + call site verified by unit tests + Codex.
- [ ] COCKPIT-4 'compare to latest' live-fetch affordance deferred from v1 (snapshot-only for gate immutability).
- [ ] App.jsx / GraphView.jsx remain over the refactor threshold (not grown by this work).

---

*The cockpit can now tell you what it did, show you what it's deciding, and welcome you when it's empty.*

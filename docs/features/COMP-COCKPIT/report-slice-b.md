# COMP-COCKPIT Slice B — Implementation Report

**Scope shipped:** Slice B = {COCKPIT-4 inline gate artifact, COCKPIT-5 first-run empty-state CTAs, COCKPIT-3 run history}. Slice A {2,1,6} shipped 2026-06-07.
**Date:** 2026-06-08
**Blueprint:** `docs/features/COMP-COCKPIT/blueprint-slice-b.md` (Phase 5 PASS).

## 1. Summary
Closed the three observability/onboarding gaps from the 2026-06-07 cockpit UX sweep. A UI-first user can now audit past build runs, read a gate's artifact body inline before deciding, and create their first feature from an empty project — all without dropping to the terminal.

## 2. Delivered vs Planned
| Planned | Status |
|---|---|
| COCKPIT-3: `lib/build-history.js` append-only writer + bounded reader | ✅ |
| COCKPIT-3: single archive call after the COMP-HEALTH gate (final buildStatus, in-memory vars) | ✅ |
| COCKPIT-3: `GET /api/builds` (read-only, no token) | ✅ |
| COCKPIT-3: `PastBuildsView` (prop-driven) + store + header-tab registration + App wiring | ✅ |
| COCKPIT-4: shared `MarkdownViewer` extracted from DocsView | ✅ |
| COCKPIT-4: GateView renders `gate.artifactSnapshot` inline (collapsible, snapshot-only) | ✅ |
| COCKPIT-5: `feature` preset + `initialType` prop in ItemFormDialog | ✅ |
| COCKPIT-5: central `isEmptyProject` threaded to Tree/Graph/Dashboard empty states | ✅ |

## 3. Key Implementation Decisions
1. **Single post-health archive site (not the 3 terminal sites).** Codex blueprint review caught that the COMP-HEALTH gate (`lib/build.js:~1994`) can downgrade `buildStatus` to `failed` *after* the terminal `active-build.json` writes. Archiving at the terminal sites would record `complete` for a build whose final status is `failed`. The archive call sits after the health block (still inside the main try, so `stepHistory` is in scope) and uses the final `buildStatus`.
2. **Assemble the record from in-memory build context, never re-read `active-build.json`** (last-writer-wins across concurrent builds — `project_compose_idempotency_gaps`). History writes are best-effort and swallow their own errors so they can never break the build path.
3. **Snapshot-only inline artifact, no live fetch** (COCKPIT-4). GateView is fetch-free; rendering `gate.artifactSnapshot` preserves gate immutability (a post-gate file edit can't change what the reviewer approved). The optional "compare to latest" live fetch from the design was dropped from v1.
4. **Central `isEmptyProject`, not view-local heuristics** (COCKPIT-5). Codex review caught that every view receives pre-filtered data, so `length===0` inside a view can't distinguish "empty project" from "filters exclude everything." App computes `isEmptyProject = items.length === 0` from raw store items and threads it down; the create-feature CTA only renders on that branch.
5. **Prop-driven `PastBuildsView`** mirroring `SessionsView` (App reads `buildHistory` from the store and triggers the fetch on view activation) — keeps the component trivially testable and consistent with the existing pattern.
6. **Header-tab registration** (`viewTabsState.js` + `ViewTabs.jsx`), the cockpit's real nav — Codex caught that the sidebar is not the primary navigation, so a switch-only registration would have been unreachable.

## 4. Architecture Deviations
- Design listed COCKPIT-3 archival at three terminal sites and an optional COCKPIT-4 live "compare to latest"; both were corrected/narrowed in the blueprint after the Codex design pass (single archive site; snapshot-only). No other deviations.

## 5. Test Coverage (21 new tests)
- `test/build-history.test.js` (5) — round-trip, newest-first + limit, missing file → [], malformed-line skip, bad-dir safety.
- `test/build-routes.test.js` (+2) — `GET /api/builds` returns records newest-first (no token), empty when no history.
- `test/ui/past-builds-view.test.jsx` (4) — honest empty state, render w/ duration+failure reason, status filter, feature-code resolution.
- `test/ui/gate-artifact-inline.test.jsx` (3) — toggle present w/ snapshot, expands to markdown body, absent when no snapshot.
- `test/ui/empty-state-cta.test.jsx` (5) — Tree CTA on empty vs "no match" when filtered, Dashboard CTA gating, ItemFormDialog feature preset.
- Full suite: **node 3459, UI 173, tracker 100 — all green**; `npm run build` OK; Codex implementation review **REVIEW CLEAN** (first pass).

## 6. Files Changed
New: `lib/build-history.js`, `src/components/vision/PastBuildsView.jsx`, `src/components/vision/shared/MarkdownViewer.jsx`, 3 `test/ui/*.test.jsx`, `test/build-history.test.js`.
Modified: `lib/build.js`, `server/build-routes.js`, `src/components/vision/useVisionStore.js`, `src/components/cockpit/{viewTabsState,ViewTabs}.jsx`, `src/components/vision/{GateView,DocsView,TreeView,GraphView,DashboardView}.jsx`, `src/components/vision/shared/ItemFormDialog.jsx`, `src/App.jsx`, `test/build-routes.test.js`.

## 7. Known Issues & Tech Debt
- **Run history is forward-only.** Only builds that run after this ships are recorded — historical runs were never persisted (no backfill; can't reconstruct duration/cost/failure). Honest empty state until the first archived run.
- **E2E smoke not auto-run** — component tests + production build + a full real-build pass cover the behavior; a live build→PastBuildsView E2E was not executed to avoid auto-starting servers. The archive call site was verified by Codex against the live `buildStatus` flow.
- `/api/terminal/inject` (4002) liveness remains pre-existing/out-of-scope (`COMP-WORKSPACE-AGENT-SVR`).
- Touched files `App.jsx` (1300+), `GraphView.jsx` (1200+) remain over the refactor threshold — not grown materially by this work; refactor is separate.

## 8. Lessons Learned
- The Codex blueprint pass paid for itself twice: the health-gate downgrade race (would have mis-recorded build outcomes) and the view-local emptiness leak (CTA would have shown on filtered-but-nonempty projects). Both were category-correct *design* findings even though Codex framed them as "code doesn't exist yet."
- When a feature surfaces "decide emptiness/state," check whether the deciding component actually has unfiltered data — in a filtered-view architecture the only honest signal lives at the source.

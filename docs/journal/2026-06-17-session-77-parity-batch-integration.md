---
date: 2026-06-17
session_number: 77
slug: parity-batch-integration
summary: Shipped the final 6 COMP-PARITY features (2/5/6/8/9/10) — closed the umbrella; integration-level Codex review caught a build-dispatch workspace desync, a completions path-traversal, a GSD 409 contract, and a QA-scope stale-render
feature_code: COMP-PARITY
closing_line: Six features built blind in parallel, then made true by one integration review — the gates that confirm are cheaper than the bugs that ship.
---

# Session 77 — COMP-PARITY

**Date:** 2026-06-17
**Feature:** `COMP-PARITY`

## What happened

We resumed a paused batch build (`_COMP-PARITY-batch-resume.md`): design + blueprint were done for all six remaining COMP-PARITY features, and six parallel agents had already written the disjoint new files with passing per-file tests. The uncommitted-but-inert work was waiting on the part you can't parallelize — centrally wiring eight shared files (build-routes, vision-routes, vision-server, App.jsx, startBuild, ViewTabs, viewTabsState, ItemDetailPanel) so the new components actually mount and the new endpoints actually attach.

We did the central integration by hand, one shared file at a time, verifying with `vite build` after the structural changes and re-running the constrained tests (e.g. the start-build-popover body assertion that forced `featureCode`/`resume` to stay out of the payload unless present). Then we wrote the three server-handler tests we owned (launch-routes, build-all-gsd-routes, completions-route) and ran the full suite.

The real value came from the Codex *integration* review — reviewing the actual diff, not the blueprints. Per-feature reviews had passed, but the cross-feature pass found four things the parallel agents couldn't see individually: (1) `/api/build/start` runners default to `process.cwd()` and `switchProject()` never `chdir`s, so after a project switch a launched build could target a different workspace than the cockpit shows; (2) `GET /api/completions` forwarded raw `featureCode` into a `join()`'d path on an open route — a path traversal; (3) GSD concurrent-run refusals came back as 500 instead of the 409 the other launchers use; (4) `QaScopeView` rendered a blank success block on the degraded `{found:true,error}` response and kept stale scope under a new feature header during a switch. We fixed all four, looped Codex to REVIEW CLEAN, and shipped.

## What we built

Integrated (modified, shared): server/build-routes.js (merged PARITY-2 new/resume + PARITY-8 all/gsd into one allow-set; bound dispatch to getTargetRoot(); launcherErrorStatus() 409 mapping), server/vision-routes.js (GET /api/completions, isFeatureCode guard), server/vision-server.js (attach validate/qa-scope/feature-scaffold), src/App.jsx (mount LaunchPopover/BuildAllGsdControl/ValidateView/QaScopeView/NewFeatureDialog + launch/new state + header controls), src/lib/startBuild.js (optional featureCode + resume passthrough), src/components/cockpit/ViewTabs.jsx + viewTabsState.js (Validate + QA Scope tabs), src/components/vision/ItemDetailPanel.jsx (CompletionBadge), src/components/vision/QaScopeView.jsx (degraded-error branch + clear-on-switch).

New tests we owned: test/launch-routes.test.js, test/build-all-gsd-routes.test.js (incl. cwd-binding + GSD-409), test/completions-route.test.js (incl. path-traversal rejection); plus added degraded + transition cases to test/ui/qa-scope-view.test.jsx. Disjoint new files (components, routes, *State.js logic, and their tests) were authored by the parallel agents in the prior session.

Ship: 6 feature.json -> COMPLETE, 7 ROADMAP rows (6 + umbrella) -> COMPLETE, CHANGELOG 2026-06-17 entry, this journal entry.

## What we learned

1. Integration review is a distinct gate, not a formality. Six clean per-feature reviews still left four real defects that only exist *between* features (shared dispatch root, open-route validation, cross-launcher status contract). Review the assembled diff, not the parts.
2. "Consistent with the file" beats "consistent with the newest pattern." Codex first flagged build/completions/scaffold for using getTargetRoot() instead of req.workspace.root. The right call was to keep them on the global target — the entire vision store and surface they sit alongside use it; switching only these would desync them from the data they're displayed against. The actual bug was subtler: the dispatch runners defaulted to process.cwd(), which is neither.
3. A latent bug in pre-existing code becomes yours the moment you extend its pattern. The feature/bug build path already ignored the project root; adding new/all/gsd dispatch made it worth fixing at the wiring point (cwd: getTargetRoot()) for every mode at once.
4. Open read routes that join() user input into a path need a code-shape guard even when the function 'only reads feature.json' — traversal still leaks other projects' data.
5. Match the test's exact contract before changing a payload: start-build-popover asserted an exact body, so featureCode/resume had to stay omitted-when-absent rather than always-present.

## Open threads

- [ ] record_completion per feature against the ship commit SHA (commit-SHA-bound completions[] + commit_sha) — clears the validator's MISSING_COMPLETION_REPORT / COMPLETION_WITHOUT_CHANGELOG warnings.
- [ ] vision-state.json shows STATUS_MISMATCH_FEATUREJSON_VS_VISION_STATE for the newly-COMPLETE features (and pre-existing COMP-PARITY-4) — gitignored local drift; reconcile with `compose validate --fix --apply` if the running cockpit needs to reflect COMPLETE.
- [ ] mode=new still returns 500 on failure (runNew has no concurrency contract); revisit if runNew ever grows one.

---

*Six features built blind in parallel, then made true by one integration review — the gates that confirm are cheaper than the bugs that ship.*

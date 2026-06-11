---
date: 2026-06-11
session_number: 72
slug: comp-mobile-1-monitoring-loop
summary: COMP-MOBILE-1 shipped — mobile badges/alert bar, build step breakdown + history, roadmap mutations; 8 design-gate + 5 blueprint-gate + 4 impl-review Codex findings fixed
feature_code: COMP-MOBILE-1
closing_line: The phone can finally feel the build break — now it just needs a way to hear about it from outside the house.
---

# Session 72 — COMP-MOBILE-1

**Date:** 2026-06-11
**Feature:** `COMP-MOBILE-1`

## What happened

The human asked us to sound out COMP-MOBILE-1 (mobile monitoring-loop completeness), then said "make it happen." Mid-research a sharp question landed — "would the mobile UX hit the local desktop?" — and we verified both servers bind 127.0.0.1: the phone literally cannot reach the PWA today without a tunnel. That's COMP-MOBILE-REMOTE's charter, deliberately deferred. The human chose to finish MOBILE-1 first anyway.

The Codex gates earned their keep. The design gate (3 rounds, 8 findings) caught that GET /api/builds history records carry NO per-step data (the historical step breakdown we'd designed was impossible — scope cut), that connections require a server-validated type enum and have no label field, that the gateCreated WS payload has no phase fields, that useRoadmapItems' WS handler listens for message types the server never broadcasts (dead code since birth), and that the post-build health gate can downgrade complete→failed AFTER the terminal buildState broadcast — mobile would alert 'complete' for a build that actually failed. Each finding reshaped the design before a line of code existed. The blueprint gate (3 rounds, 5 findings) added that active-build steps[] holds only completed history (the running step exists solely as currentStepId) and that ItemDetailSheet was already shipping server-invalid values ('partial' status, 0–5 confidence vs the server's 0–4). Implementation went out as three Sonnet-dispatched slices (S01 shared-lib/hygiene/badges, S02 steps+history, S03 roadmap mutations); the post-impl Codex review found 4 real bugs (corrective alert dead in the retry path, wrong create-response shape, snapshots clobbering in-flight creates/deletes, stale isTerminal missing 'complete'), all fixed and locked by a 34-test coverage sweep.

## What we built

NEW: src/lib/pipeline-steps.js (shared PIPELINE_STEPS + mergePipelineSteps/isGatePending/isTerminalBuildStatus, consumed by desktop PipelineView AND mobile), src/mobile/components/MobileAlertBar.jsx, BuildStepsList.jsx, BuildHistoryList.jsx, CreateItemSheet.jsx, src/mobile/hooks/useMonitorEvents.js, useBuildHistory.js; test/ui/pipeline-steps.test.js, mobile-notifications.test.jsx, mobile-coverage-sweep.test.jsx.
MODIFIED: MobileApp.jsx (3-hook lift to shell, badges, alert bar), BottomNav.jsx (badges prop), BuildDetailView.jsx (Steps/Log toggle), BuildCard.jsx, BuildsTab/AgentsTab/RoadmapTab (prop-driven), ItemDetailSheet.jsx (delete two-tap, connections, status/confidence contract fix), useRoadmapItems.js (visionState/hydrate rewire, 5 mutations, token plumbing), AgentCard/AgentDetailView/useInteractiveSession (agentServerUrl), constants.js/PipelineView.jsx (shared-lib extraction), mobile.css. Tests: vitest 209→329, node suite green, build green. Commits a861ec5, c5410ef, 414cced, 3919504, 2b8c72e, 87ecced, ed25059.

## What we learned

1. Design-gate Codex reviews on contracts (not code) are the cheapest bug class to fix — 8 contract mismatches died on paper; the health-gate downgrade race alone would have been a nasty field bug.
2. A mobile hook can pass all its tests while its WS path is 100% dead code (useRoadmapItems listened for itemCreated/itemUpdated; the server only broadcasts visionState/hydrate snapshots) — tests that mock the socket can't catch listening for the wrong message; only contract-checking against the broadcaster can.
3. active-build.json steps[] is completed-history-only; the running step lives solely in currentStepId. Any consumer that infers 'active' from steps[] membership is wrong by construction.
4. Build terminal-status spelling is split across the codebase ('complete' from the build writer vs 'completed' elsewhere); centralizing in isTerminalBuildStatus killed two latent abort-button bugs (BuildCard + BuildDetailView).
5. One Codex round inverted its own prior finding (claimed the flowId fix should be featureCode+recency — the opposite of what round 3 asked). Reviewer misreads happen; the gate protocol needs a human-judgment escape hatch, which we used.
6. Optimistic-mutation overlays need all three op kinds (patch/create/delete) replayed over server snapshots — patches alone leave creates vanishing and deletes resurrecting under the 16ms-coalesced visionState broadcast.

## Open threads

- [ ] COMP-MOBILE-REMOTE is now the gating item for the end-to-end phone story (servers bind 127.0.0.1; PWA unreachable without a tunnel)
- [x] Backend follow-up candidate: re-broadcast buildState after the health gate downgrades a build — DONE same day as COMP-MOBILE-1-1 (persistHealthGateDowngrade, identity-guarded)
- [x] Backend follow-up candidate: include per-step data in build-history records — DONE same day as COMP-MOBILE-1-1 (projectHistorySteps; mobile history rows render steps)
- [ ] Desktop NotificationBar still has no WS→notify mapping for gate/build events; mobile's useMonitorEvents pattern could be ported back
- [ ] No Playwright E2E exists for mobile — Phase 7's E2E step degraded to vitest integration + build smoke

---

*The phone can finally feel the build break — now it just needs a way to hear about it from outside the house.*

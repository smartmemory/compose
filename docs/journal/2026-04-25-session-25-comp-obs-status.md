# Session 25 — COMP-OBS-STATUS: Ship the Status Band

**Date:** 2026-04-25
**Feature:** COMP-OBS-STATUS (Wave 6 Situational Awareness)
**Status:** COMPLETE

## What Happened

The user asked us to implement COMP-OBS-STATUS end-to-end from a frozen design + blueprint + plan. The feature adds a 32px sticky status band at the top of VisionTracker that answers "where are we, what's next, is it safe to stop" for the currently-selected feature.

We followed strict TDD: write test → watch fail → implement → watch pass, phase by phase.

**Chunk A — Server:** Built the producer, emit dispatcher, and route wiring.

- `status-snapshot.js`: The core pure function `computeStatusSnapshot(state, featureCode, now)` implementing all 8 rule branches from design Decision 2 in exact priority order. The tricky parts were: (a) the null/unknown phase guard that short-circuits branches 4–7 silently, (b) the `_openLoopsCount` injection into the iterationState reference to thread it into branch 8 without a separate parameter, and (c) gate-id truncation in branch 4 using headroom calculation.

- `status-emit.js`: A thin dispatcher, 30 lines. Calls `computeStatusSnapshot` and broadcasts `{type: 'statusSnapshot', featureCode, snapshot}`. Returns the snapshot for caller convenience.

- `vision-routes.js`: Wired `emitStatusSnapshot` at 11 broadcast sites — lifecycleStarted, 4 lifecycleTransition variants (advance/skip/kill/complete), iterationStarted, iterationComplete (report + abort), gateCreated, gateResolved. Added the `iterationUpdate` emit (Decision 4 — STATUS broadcasts here even though TIMELINE does not, so the "Iterating… (attempt N)" sentence stays live). Added `GET /api/lifecycle/status?featureCode=<FC>` route.

- `cc-session-watcher.js` / `vision-server.js`: Optional injectable deps (`emitStatusSnapshot`, `getState`) pattern, consistent with how the watcher already accepts `broadcastMessage` — no-op default, injected in production.

**Chunk B — Client:** Store slice, message handler, pure helpers, React component, stacking fix, VisionTracker mount.

- `useVisionStore.js`: Added `statusSnapshots: {}` slice and `setStatusSnapshot(featureCode, snap)` action (both the public action and the internal WS setter dispatch).

- `visionMessageHandler.js`: One `else if` branch for `type: 'statusSnapshot'` → `setStatusSnapshot(msg.featureCode, msg.snapshot)`.

- `statusBandLogic.js`: `truncateForSentence` (client mirror of server util) and `formatExpansionPanel` returning labelled rows for the detail table.

- `StatusBand.jsx`: 32px sticky band with data-testid attributes. Click toggles expansion panel. No CTA element anywhere — the comment in JSX explicitly names the v1 constraint and points to design Decision 2.

- `DecisionTimelineStrip.jsx`: Bumped `top: 0` → `top: 32` and `zIndex: 10` → `zIndex: 20` so the TIMELINE strip stacks below STATUS when both render.

- `VisionTracker.jsx`: Mounted `<StatusBand>` unconditionally (renders the no-feature message when featureCode is null) BEFORE `<DecisionTimelineStrip>`. Added `useEffect` to hydrate the snapshot via `GET /api/lifecycle/status` on feature selection change if not already cached.

**Chunk C — Integration + Activation:**

- Extended `wave-6-integration.test.js` with a "COMP-OBS-STATUS" describe block covering: lifecycle advance emits snapshot, gate create → Holding sentence, sentence transition flow (start → advance → gate → resolve), iterationUpdate emits statusSnapshot (Decision 4 verification), and REST route round-trip.

- Un-skipped the STATUS placeholder in `wave-6-contract-compliance.test.js` with a full StatusSnapshot round-trip test including the `drift_alerts breached:true` closure regression guard.

Full suite: **1747 pass, 0 fail, 3 skips** (baseline was 1677+4 — gained 70 tests, consumed 1 skip).

## What We Built

**New files:**
- `compose/server/status-snapshot.js` — 160 lines
- `compose/server/status-emit.js` — 32 lines
- `compose/src/components/vision/StatusBand.jsx` — 115 lines
- `compose/src/components/vision/statusBandLogic.js` — 75 lines
- `compose/test/status-snapshot.test.js` — 340 lines
- `compose/test/status-emit.test.js` — 100 lines
- `compose/test/status-route.test.js` — 115 lines
- `compose/test/status-band-logic.test.js` — 100 lines
- `compose/test/ui/status-band.test.jsx` — 130 lines

**Modified files:**
- `compose/server/vision-routes.js` — 11 emit sites + 1 GET route + 2 imports
- `compose/server/cc-session-watcher.js` — optional deps + post-lineage emit
- `compose/server/vision-server.js` — inject emitStatusSnapshot into CCSessionWatcher
- `compose/src/components/vision/useVisionStore.js` — statusSnapshots slice + setStatusSnapshot
- `compose/src/components/vision/visionMessageHandler.js` — statusSnapshot handler
- `compose/src/components/vision/DecisionTimelineStrip.jsx` — top: 32, zIndex: 20
- `compose/src/components/vision/VisionTracker.jsx` — mount StatusBand + useEffect hydration
- `compose/test/wave-6-integration.test.js` — STATUS describe block appended
- `compose/test/wave-6-contract-compliance.test.js` — STATUS skip → real test

## What We Learned

1. **The null-phase guard is architectural, not cosmetic.** Branches 4–7 all assume a known phase to compose their sentence around. Letting an unknown phase fall into branch 4 would produce nonsense like "Holding widgetization. Next: approve gate-abc." The guard surfaces schema/UI drift explicitly, which is more useful than silent nonsense.

2. **`_openLoopsCount` injection into iterationState is a leaky abstraction.** We injected `_openLoopsCount` as a private field on the iterationState reference to thread it into `buildStatusSentence`'s branch 8 without adding a new parameter. This works but is fragile — if `buildStatusSentence` were ever extracted, the caller would need to remember to inject the count. A cleaner v2 would pass it as a separate parameter.

3. **The cc-session-watcher optional-dep pattern is the right call.** The watcher already used `broadcastMessage = () => {}` as a default no-op. Extending that pattern to `emitStatusSnapshot = null` keeps all existing tests passing without any changes — the watcher simply doesn't call it when not injected.

4. **StatusBand mounts unconditionally (even when featureCode is null).** The design says "render the no-feature message" rather than "hide the band." This means VisionTracker always has a 32px band at the top, which is the right UX — it's always there, it just says something useful.

5. **The iterationUpdate STATUS emit was the most important divergence to get right.** Design Decision 4 explicitly calls out that STATUS broadcasts on `iterationUpdate` even though TIMELINE does not. Without this, the "Iterating review (attempt N)" sentence would freeze at attempt 1 for the entire loop. The integration test verifies this asymmetry explicitly.

## Open Threads

- [ ] `gate_load_24h` is hardcoded to 0 — real value waits for COMP-OBS-GATELOG
- [ ] `drift_alerts` is always `[]` — real values wait for COMP-OBS-DRIFT
- [ ] `open_loops_count` is length-of-array only — COMP-OBS-LOOPS owns the producer
- [ ] CTA is always null — needs a shipped routing/anchor system before adding
- [ ] Per-band collapse persistence in localStorage not yet added — flag if users want it
- [ ] StatusBand not mounted in `CockpitView` (the main app path) — only in VisionTracker (PopoutView). The main app uses CockpitView; the same mounting pattern should be applied there after review.

Seventy tests, one feature shipped. The band is up.

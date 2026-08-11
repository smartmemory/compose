---
date: 2026-08-11
session_number: 108
slug: agent-lanes-shipped
summary: COMP-AGENT-LANES shipped — per-subagent lanes for parallel fan-outs; the E2E smoke caught a vacuously-passing stamping contract
feature_code: COMP-AGENT-LANES
closing_line: The test that proved the feature was the one that ran all three layers for real — everything green before it was green about the wrong thing.
---

# Session 108 — COMP-AGENT-LANES

**Date:** 2026-08-11
**Feature:** `COMP-AGENT-LANES`

## What happened

We resumed COMP-AGENT-LANES at Phase 6 off a status.md left by the design/blueprint session, transcribed the verified blueprint's task order into plan.md, and executed the five slices in order — lane envelope at the fanout dispatch site, stream stamping in the normalizer, bridge forwarding, the UI lane reducer, and the LaneStrip mount. TDD held at every slice: each touch point got its red test first, and the settled rulings from the two Codex design rounds (identity `flowId:stepId:itemIndex`, version `(generation, attempt)`, terminal-only-on-explicit-status) were implemented without re-litigating.

The arc of the session was the E2E smoke. Rather than a browser run (compose has no Playwright), we wrote a golden-flow integration test wiring the REAL producer through the REAL bridge tail into the REAL reducer — and it failed. Not on a bug in the new code, but on a false assumption the unit tests had quietly blessed: on the isolation:none path (review fanouts — the headline use case for lanes), the local claude connector accumulates assistant text and never streams it. "Stamp the relay writes" passed vacuously because there were no writes to stamp. The fix was a lane-gated `onAssistantText` seam in the local connector — engine-path parity when a lane rides the run, byte-identical silence when not.

Codex review (terra/high) returned one P2 — the bridge dropped `laneTerminal`, so a terminal error could never actually close a lane — fixed in-loop with a test; per the standing review budget the one-line mechanical fix took no second round. Full suite green; completion recorded @c060ef8a through the guard path.

## What we built

- `lib/build.js` — `buildLaneEnvelope` (identity/version/label/agent), stamped on the `∥` build_step_start, both parallel done variants (with explicit `status`/`outcome` on the success path — C4 was real), passed into `runAndNormalize`.
- `lib/result-normalizer.js` — lane spread onto all five streamWriter.write sites; back-compat byte-identical without the opt.
- `lib/local-claude-connector.js` — `onAssistantText` relay seam (lane-gated).
- `server/build-stream-bridge.js` — `laneOf` forwarding on six cases + done status/outcome + error stepId/laneTerminal.
- `src/components/agent-stream-lanes.js` (new) — pure lane reducer, node-tested (40 tests incl. sweep edges).
- `src/components/AgentStream.jsx` — lane map wiring; legacy `parallelTasks` now derived (failed workers finally count failed); lanes in the `compose:agent-status` payload.
- `src/components/cockpit/LaneStrip.jsx` (new) + `AgentBar.jsx` mount — tabs, status dots, attempt badge, joined-mid-build marker, collapsible to the legacy counter.
- `test/integration/agent-lanes-pipeline.test.js` — the golden flow that caught the local-path gap.

## What we learned

1. **A stamping contract passes vacuously when the writes don't exist.** Unit tests asserted "every write carries the lane" and were green while the headline use case produced zero assistant writes to stamp. Only the cross-layer golden flow — real producer, real bridge, real reducer — surfaced it. Contract tests need an existence assertion, not just a shape assertion.
2. **Deriving the legacy shape from the new store beats maintaining both.** `parallelTasks` derived from the lane map made the old "every done = complete" bug structurally impossible to preserve, and AgentBar needed zero changes.
3. **A contract only one side implements is a latent defect.** The reducer honored `laneTerminal` that nothing could deliver (bridge dropped it) — Codex caught it. When a marker spans producer→transport→consumer, the transport hop needs its own forwarding test per field.
4. **The resume-point file worked.** status.md's ten-line ruling summary let a fresh session implement a two-Codex-round design without re-deriving any of it.

## Open threads

- [ ] Live cockpit verification — lanes have never been observed in a browser; the `AgentStream.jsx` processMessage glue is the one untested seam. Next real parallel build is the proof.
- [ ] Stratum bind (POST /api/stratum/bind, flow 4384da22) skipped — :4001 server not running.
- [ ] Replayable build-event log (full lane rebuild on reconnect) — parked follow-up feature.
- [ ] Path 2: Agent-tool / stratum_agent_run fan-outs from the orchestrating agent (design Open Question 4).
- [ ] No producer emits `laneTerminal` yet — the path is tested and ready for one.

---

*The test that proved the feature was the one that ran all three layers for real — everything green before it was green about the wrong thing.*

# COMP-AGENT-LANES — Implementation Report

**Status:** COMPLETE (pending ship)
**Date:** 2026-08-11
**Plan:** [`plan.md`](plan.md) · **Blueprint:** [`blueprint.md`](blueprint.md) · **Design:** [`design.md`](design.md)

## Summary

Per-subagent lanes for parallel fanouts shipped compose-only, exactly along the blueprint's four touch points: a `lane` envelope built at the fanout dispatch site rides every lifecycle write and (via `runAndNormalize` opts) every relayed output write; the bridge forwards it plus explicit terminal status; a new pure lane reducer in the UI keys one lane per worker slot; `LaneStrip` renders tabs + per-lane feeds in the AgentBar, collapsing to the legacy counter.

## Delivered vs Planned

All six plan tasks delivered. One addition beyond plan (found by the E2E smoke, folded in): the local-claude connector gained an `onAssistantText` seam so isolation:none workers (review fanouts — the headline use case) stream relay text at all. Without it, lanes on the local path showed only tool calls. The seam is lane-gated: lane-less local runs keep their historical no-assistant-writes shape.

## Architecture Deviations

None from the design's settled rulings. Identity `flowId:stepId:itemIndex`, version `(generation, attempt)` reset/reject, terminal-only-on-explicit-status, forward-only reconnect, module-state (not zustand) — all implemented as ruled.

C2 resolved with precision: the "local relay writes" the blueprint said to locate turned out not to exist — the local connector accumulated assistant text without streaming it. The `onAssistantText` seam is the minimal fix (see above).

## Key Implementation Decisions

- `reportConsumerStepDone` derives its own lane (`deriveConsumerLane`, pure from descriptor+flowId) instead of threading a param through the three call sites, keeping recovery-path skipped-dones stamped identically.
- The lane reducer is a pure module (`src/components/agent-stream-lanes.js`) following the tested-pure-helper pattern of `agent-stream-helpers.js`, so the behavioral core runs under `node --test` without React.
- Legacy `parallelTasks` is now *derived* from the lane map when lanes are active; the lane-less aggregate path is preserved verbatim for old streams. Failed workers now count failed (fixes the pre-existing "every done = complete" reducer bug).
- `laneTerminal` marker distinguishes lane-closing errors from advisory ones end to end (producer contract → bridge → reducer). No producer emits it yet; the path is tested and ready.

## Test Coverage

- `test/build-emission.test.js` — envelope shape, defaults, lens label, lifecycle-write stamping, explicit statuses (16).
- `test/result-normalizer.test.js` — both stamping paths, byte-identical back-compat, lane-gated local assistant relay (16).
- `test/build-stream-bridge.test.js` — per-case forwarding incl. laneTerminal, lane-less pass-through (29).
- `test/agent-stream-build.test.js` — reducer identity/version/terminal rules, routing, caps, summary parity, sweep edges (40).
- `test/ui/LaneStrip.test.jsx` — tabs, dots, attempt badge, mid-build marker, collapsed counter parity (8).
- `test/integration/agent-lanes-pipeline.test.js` — golden flow: real producer → real bridge tail → real reducer, one failing worker, zero cross-lane leakage.

## Files Changed

- `lib/build.js` — `buildLaneEnvelope` + stamped lifecycle writes, explicit status (C4)
- `lib/result-normalizer.js` — lane stamping on all five write sites; local assistant relay
- `lib/local-claude-connector.js` — `onAssistantText` seam
- `server/build-stream-bridge.js` — lane/status/outcome/stepId/laneTerminal forwarding
- `src/components/agent-stream-lanes.js` (new) — pure lane reducer
- `src/components/AgentStream.jsx` — lane map wiring, payload lanes, legacy path preserved
- `src/components/cockpit/LaneStrip.jsx` (new), `src/components/cockpit/AgentBar.jsx` — lanes UI

## Known Issues & Tech Debt

- Reconnect is forward-only (v1 scope ruling): a cockpit joining mid-build sees lanes from that point, marked `(joined mid-build)`. Full replay needs a persisted build-event log — parked follow-up feature.
- Path 2 (Agent-tool / `stratum_agent_run` fan-outs from the orchestrating agent) remains out of scope — design Open Question 4.
- `usage` stream writes carry the lane but the bridge drops the `usage` type entirely (pre-existing); lane-scoped cost display would need a bridge case first.
- Review (Codex, terra/high): one P2 — bridge dropped `laneTerminal` — fixed in-loop. Otherwise clean.

## Lessons Learned

- The E2E smoke over real components caught what unit-level stamping tests could not: the local path had *nothing to stamp* for assistant text. "Stamp the relay writes" silently passes when the writes don't exist.
- Deriving the legacy summary from the new store (instead of maintaining both) made the old failed-count bug impossible to preserve by accident.

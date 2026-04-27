# Session 28 — COMP-AGENT-CAPS-5: Capability Enforcement Polish

**Date:** 2026-04-27
**Feature:** COMP-AGENT-CAPS-5
**Parent:** COMP-AGENT-CAPS-4 (commit `03ebfff`, 2026-04-10)

## What happened

The ask was to close three polish gaps left by COMP-AGENT-CAPS-4 in one commit. The gaps were: no integration test for `block` enforcement mode, the enforcement setting not exposed in the UI, and the build stream `capability_violation` events having no `severity` field and never reaching the UI.

We started by reading the design doc and all affected source files before touching anything — `build.js` enforcement block, `capability-checker.js` predicate, `build-stream-writer.js` writeViolation, `cross-model-review.test.js` for test patterns, `SettingsPanel.jsx` for UI patterns, `settings-store.js` to verify the settings mutation path, and the `build-stream-bridge.js` + `visionMessageHandler.js` + `ContextStepDetail.jsx` chain for D3.

Key discovery before writing code: `writeViolation` had no `severity` param (the field was simply missing from emitted events), and `capability_violation` events fell to `default: return null` in the bridge switch statement — meaning they never reached the frontend at all. The "build summary bucketing" work in D3 wasn't moot, but it required fixing the entire pipeline first.

D1 was straightforward: inline the `build.js:763-794` enforcement block (same pattern as `cross-model-review.test.js` inlines its own logic) and drive it with synthetic `observedTools` arrays. 9 tests covering block mode throws, log mode no-throw, violation vs warning severity, missing settings file fallback, and multiple violations.

D2 was clean: `onSettingsChange({ capabilities: { enforcement: value } })` already worked — `capabilities` is a supported section in `settings-store.update()` and has validation for `'log'|'block'`. Radio group with two options, mirrors the theme/defaultView select pattern.

D3 required four files: add `severity` param to `writeViolation`, pass it from `build.js`, add bridge case, accumulate in `visionMessageHandler`, render bucketed in `ContextStepDetail`. The rendering matches the Retries section style (amber text, hidden when no findings).

Full suite: 1920 node + 87 UI, 0 failures.

## What we built

**New files:**
- `test/capability-enforcement-block.test.js` — 9 integration tests for enforcement block/log modes

**Modified files:**
- `lib/build-stream-writer.js` — `writeViolation` gains `severity` param (default `'violation'`)
- `lib/build.js` — passes `check.severity` to `writeViolation`
- `server/build-stream-bridge.js` — adds `capability_violation` case forwarding all fields
- `src/components/vision/visionMessageHandler.js` — accumulates `capability_violation` into `activeBuild.capabilityEvents`
- `src/components/cockpit/ContextStepDetail.jsx` — `capabilityEvents` prop + bucketed rendering
- `src/App.jsx` — passes `activeBuild?.capabilityEvents` to `ContextStepDetail`
- `src/components/vision/SettingsPanel.jsx` — Capability Enforcement radio group section
- `CHANGELOG.md` — entry under 2026-04-27

## What we learned

1. `capability_violation` events had been silently dropped by the bridge since CAPS-4 shipped. The `default: return null` case swallows unknown event types. Any new JSONL event type also needs a bridge case.
2. The `writeViolation` signature gap (no `severity`) was a quiet API regression — callers had the data but no way to emit it. Adding an optional param with a default preserved backward compatibility.
3. The SettingsPanel mutation path via `onSettingsChange({ capabilities: { enforcement } })` worked immediately — the settings store's `update()` deep-merges by section, and `capabilities` was already supported with proper validation.

## Open threads

- [ ] VisionTracker.jsx also renders SettingsPanel (line 338/385) — it passes `capabilityEvents` indirectly via `activeBuild` from `useVisionStore`. Verify that path also works when the settings view opens from the graph view.
- [ ] The bridge now forwards `capability_violation` events but `capability_profile` events (also written by build.js) still fall to `default: return null`. File as CAPS-6 if per-step template display is wanted.

Three quiet gaps closed, the data pipeline is end-to-end.

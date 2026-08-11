# COMP-AGENT-LANES — Implementation Blueprint

**Status:** BLUEPRINT
**Date:** 2026-08-11
**Design:** [`design.md`](design.md) (approved through 2 Codex rounds, committed @052aba2)

All file:line references below were read in this session, after the design's sizing spike, immediately before authoring. Compose-only; no Stratum change (spike verdict, design §"The load-bearing assumption").

---

## Grounded reading log (what the code actually does today)

### Producer side (lib)

- `lib/build.js:757-763` — `onAgentEvent` closure built per fanout item (stuck detector). `:807-830` — the `runAndNormalize(null, prompt, dispatch, {...})` call; in scope at this site: `descriptor.id`, `descriptor.itemIndex`, `descriptor.do`, `descriptor.agent`, `descriptor.stage`, `descriptor.generation`, `descriptor.attempt`, `flowId` (used at `:797`), `streamWriter`. The telemetry option already carries `step_id`/`attempt` (`:820-826`) but telemetry does not reach the stream.
- `lib/build.js:788-801` — the `∥${descriptor.itemIndex}` `build_step_start` write; already carries `stepId`, `stepNum`, `agent`, `intent: descriptor.do`, `flowId`, `consumer: true`, `parallel: true`, `itemIndex`, `stage`, `generation` **at source**. The H6 comment (`:781-787`) documents the UI-keying contract.
- `lib/build.js:607-624` — a `build_step_done` variant (skipped path) with `status`/`outcome`/`itemIndex`/`stage`/`generation` at source; `:973-983` — the success-path parallel done (`parallel: true`, keyed by stepId).
- `lib/result-normalizer.js:254-268` — `runAndNormalize(_connectorIgnored, prompt, stepDispatch, opts)`; opts destructured at top (`progress`, `streamWriter`, `onToolUse`, `maxDurationMs`, `stratum`).
- `lib/result-normalizer.js:352-401` — **path 1 (engine events):** per-run subscription `stratum.onEvent(correlationId, subStepId, (env) => {...})`; the closure writes `{type:'assistant', content}` (`:363`), `{type:'tool_use', tool, input}` (`:370`), `{type:'tool_use_summary', summary, output}` (`:380`), `{type:'usage', ...}` (`:400`). Each fanout item has its OWN subscription and closure — stamping here is naturally per-worker.
- `lib/result-normalizer.js:444-455` — **path 2 (local claude connector, V2/V3 review fanout):** `localOnToolUse` writes `{type:'tool_use', ...}` (`:450`). Assistant text on the local path funnels through the same result assembly; the local connector's relay writes must be located during implementation (grep `type: 'assistant'` in the local branch) and stamped identically.

### Transport (server)

`server/build-stream-bridge.js` — per-case forwarding, with what's DROPPED today:

| Case | Line | Forwards | Drops (needed by lanes) |
|---|---|---|---|
| `build_step_start` | `:298-308` | stepId, stepNum, totalSteps, agent, intent, flowId, parentFlowId?, parallel? | `itemIndex`, `stage`, `generation`, `attempt` |
| `tool_use` | `:310-315` | tool name, input (as assistant content block) | everything (no ids at all) |
| `tool_use_summary` | `:317-322` | summary, output | everything |
| `assistant` | `:331-336` | text content | everything |
| `build_step_done` | `:338-352` | stepId, summary, retries, violations, flowId, cost fields, parallel? | `status`, `outcome`, `itemIndex`, `stage`, `generation` |
| `build_error` | `:373-377` | message | `stepId` (present on some writers), lane, terminal-vs-advisory |

### UI (src)

- `src/components/AgentStream.jsx:60-75` — module singleton `_state` (`parallelTasks: null` at `:75`). `:171-180` — status publication: `setAgentStatus` builds `payload` (includes `parallelTasks` `:176`), invokes `_state.onAgentStatusChange`, dispatches `compose:agent-status` CustomEvent (`:180`).
- `src/components/AgentStream.jsx:200-226` — `processMessage`: initializes/updates `parallelTasks` off `parallel: true` + `∥`-prefixed `stepNum` (`:203-210`), marks every parallel done "complete" (`:211-215` — the bug the design fixes), decrements/fails off `type:'error'` + known stepId (`:222-226`), clears on idle (`:235`).
- `src/components/cockpit/AgentBar.jsx:42-48` — listens to `compose:agent-status`, reads `parallelTasks` for the counter line; `:175` mounts `<AgentStream />`.
- `src/components/vision/AgentPanel.jsx:91-150` — the tab pattern to borrow: tab bar over `spawnedAgents`, status dot with pulse animation, per-agent `AgentLogViewer` + `AgentRelayFeed` drill-down. **Pattern only — different data pipe (zustand/WS), do not wire lanes into it.**
- `src/components/vision/visionMessageHandler.js:120-121` — terminal-state guard precedent (killed cannot be downgraded) → generalize to the `(generation, attempt)` staleness rule.

---

## Corrections table (design/spec assumption vs code reality)

| # | Assumption (design text) | Reality | Disposition |
|---|---|---|---|
| C1 | Relay stamping happens in a flat "stream relay" section of `result-normalizer.js:359-401` | The writes live inside a per-run `stratum.onEvent(correlationId, …)` subscription closure (`:352`) — per-item by construction, which makes stamping trivially race-free | Favorable; blueprint targets the closure |
| C2 | One relay path to stamp | TWO: engine-events closure (`:352-401`) AND the local-claude connector path (`localOnToolUse` `:444-455`, used by isolation:none review fanouts) | Both stamped; a lane test must cover the local path too |
| C3 | `attempt` available as `descriptor.attempt` | Confirmed (`build.js:826` spreads it into telemetry when numeric) but may be `undefined` on first dispatch | Lane envelope defaults `attempt: descriptor.attempt ?? 1` |
| C4 | Done events carry `status`/`outcome` at source | True on the skipped variant (`:607-624`); the success path (`:973-983`) must be checked/extended for explicit `status` during implementation | Task 1 acceptance box |
| C5 | Design cites `AgentStream.jsx:200-226` for the reducer | Verified; the "every done = complete" bug is `:211-215`, error handling is `:222-226` and only fires for `type:'error'` events that carry a known `stepId` — `build_error` bridge case drops `stepId` today (`:373-377`) | Bridge must forward stepId+lane on errors for lane-scoped failure to work |

No stale references found; design line citations verified within ±5 lines (drift noted inline above where it exists).

---

## File Plan

| File | Action | What |
|---|---|---|
| `lib/build.js` | edit | Build `lane` envelope at the fanout dispatch site (`~:788`): `{flowId, stepId: descriptor.id, itemIndex, generation: descriptor.generation ?? 0, attempt: descriptor.attempt ?? 1, label, agent}` where `label` = lens/stage id when present else truncated `descriptor.do`. Pass `lane` into `runAndNormalize` opts (`:807`); attach the same `lane` object onto the `∥` `build_step_start` (`:791-801`), the parallel `build_step_done`s (`:607-624`, `:973-983` — ensure explicit `status` on the success path), and fanout-item `build_error` writes. |
| `lib/result-normalizer.js` | edit | Accept `opts.lane`; in the `stratum.onEvent` closure (`:352-401`) and the local path (`:444-455` + local relay writes), spread `...(lane ? { lane } : {})` onto every `streamWriter.write`. Absent `lane` → byte-identical output (back-compat gate). |
| `server/build-stream-bridge.js` | edit | Forward `lane` when present on: `build_step_start` (`:298`), `tool_use` (`:310`), `tool_use_summary` (`:317`), `assistant` (`:331`), `build_step_done` (`:338` — also forward `status`/`outcome`), `build_error` (`:373` — also forward `stepId`). One helper: `...(event.lane ? { lane: event.lane } : {})`. |
| `src/components/AgentStream.jsx` | edit | Replace `_state.parallelTasks` bookkeeping (`:200-226`) with `_state.lanes`: `Map` keyed `flowId:stepId:itemIndex`, entries `{lane, status, version: [generation, attempt], messages: [], joinedMidBuild}`. Version rule: higher `(generation, attempt)` resets entry; lower → event rejected. Terminal rule: close only on done-with-status or lane-terminal error; advisory errors append as diagnostics. Route lane-stamped `assistant`/`tool_use`/`tool_use_summary` messages into the entry's buffer (cap per lane, mirror `MAX_ACTIVITY_LOG` pattern `:157`). Publish a derived summary (today's counter shape) PLUS the lanes in the `compose:agent-status` payload (`:171-180`). Keep emitting the legacy `parallelTasks` summary shape so `AgentBar:42-48` works unchanged until step 5's UI lands. Clear lanes on `build_end`/idle as `parallelTasks` clears today (`:235`). |
| `src/components/cockpit/LaneStrip.jsx` | new | Lane tabs + per-lane feed. Borrow `AgentPanel.jsx:91-150` tab pattern (status dot, pulse on working, label, attempt badge, `(joined mid-build)` marker). Collapsed = today's counter line; expanded = tabs + selected lane's message feed. Fed from the `compose:agent-status` payload / an `AgentStream` lanes accessor — NOT from zustand. |
| `src/components/cockpit/AgentBar.jsx` | edit | Mount `LaneStrip` where the counter renders (`:42-48` consumption site); counter becomes `LaneStrip`'s collapsed state. |
| `test/result-normalizer.test.js` | edit | Lane stamping on both paths; back-compat: no `lane` opt → writes byte-identical (snapshot the write objects). |
| `test/build-stream-bridge.test.js` | edit | Lane + status/outcome + error-stepId forwarding per case; absent-lane pass-through unchanged. |
| `test/agent-stream-build.test.js` | edit | Reducer: lane creation from `∥` start, output routing by lane key, failed-done → `failed` (the `:211-215` bug), advisory error does not close, stale `(generation, attempt)` rejected, retry resets with attempt badge state, run-scoping (same stepId different flowId → different lane). |
| `test/ui/LaneStrip.test.jsx` | new | Render: tabs per lane, status dots, attempt badge, mid-build marker, collapsed counter parity. |

## Boundary Map

### S01: lane envelope production (lib)
Produces:
  lib/build.js → buildLaneEnvelope (function)
  lib/result-normalizer.js → runAndNormalize (function)

Consumes: nothing (leaf node)

### S02: bridge forwarding (server)
Produces:
  server/build-stream-bridge.js → BuildStreamBridge (class)

Consumes:
  from S01: lib/build.js → buildLaneEnvelope

### S03: cockpit lanes (UI)
Produces:
  src/components/AgentStream.jsx → processMessage (function)
  src/components/cockpit/LaneStrip.jsx → LaneStrip (component)

Consumes:
  from S01: lib/result-normalizer.js → runAndNormalize
  from S02: server/build-stream-bridge.js → BuildStreamBridge

## Task order

1. **S01a** `build.js` lane envelope + step_start/done/error unification (incl. C4 explicit status on success-path done). TDD against `test/agent-stream-build.test.js` fixtures + a new focused producer test.
2. **S01b** `result-normalizer.js` stamping, both paths (C2). Back-compat snapshot test first.
3. **S02** bridge forwarding. Table-driven per-case test.
4. **S03a** `AgentStream` lanes reducer (identity/version/terminal rules). This is the behavioral core — test heaviest here.
5. **S03b** `LaneStrip` + `AgentBar` mount. Vitest UI tree.
6. E2E smoke: run a real parallel fanout (review fanout is the cheapest trigger) and verify lanes in the cockpit; then review loop + coverage sweep per Phase 7.

## Verification Table

| Check | Result |
|---|---|
| All file:line refs re-read this session | PASS (reading log above; drift ±5 lines noted in Corrections) |
| Corrections table complete | PASS — C1-C5, all dispositioned |
| Boundary Map validated (`validateBoundaryMap`, lib/boundary-map.js) | PASS 2026-08-11 — `{ok: true, violations: [], warnings: []}` |
| Overlapping in-flight features (`docs/features/*/blueprint.md` shared files) | PASS 2026-08-11 — 10 features share files; all COMPLETE (or planned-not-started: COMP-DESIGN); none in-flight |

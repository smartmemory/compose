# COMP-AGENT-LANES — Implementation Plan

**Status:** PLAN
**Date:** 2026-08-11
**Blueprint:** [`blueprint.md`](blueprint.md) (verified 2026-08-11; boundary map PASS, no in-flight overlaps)
**Design:** [`design.md`](design.md) (approved through 2 Codex rounds @052aba2)

## Related Documents

- Backward: `blueprint.md` (File Plan + task order are the source of this plan), `design.md` (settled rulings).
- Forward: `report.md` (Phase 8, written after execution).

## Settled rulings (do not re-derive)

- Lane **identity** = `flowId:stepId:itemIndex`; lane **version** = `(generation, attempt)` — higher resets the lane, lower is rejected as stale.
- **Terminal rule:** a lane closes only on done-with-explicit-`status` or an error explicitly marked lane-terminal; advisory `build_error`s render as in-lane diagnostics without closing.
- **Reconnect:** forward-only in v1; lanes joined mid-build are marked, no replay.
- **No Stratum change** (sizing-spike verdict). UI lanes live in AgentStream module state + `compose:agent-status` payload — NOT zustand.
- **Back-compat contract:** absent `lane` opt, every stream write is byte-identical to today.

## Tasks (dependency-ordered, sequential)

### Task 1 — S01a: lane envelope production in `lib/build.js` (existing)

Pattern: the existing `∥` `build_step_start` write at `build.js:788-801` already carries the loose fields; unify under `lane`.

- [ ] `buildLaneEnvelope(descriptor, flowId)` helper: `{flowId, stepId: descriptor.id, itemIndex, generation: descriptor.generation ?? 0, attempt: descriptor.attempt ?? 1, label, agent}`; `label` = lens/stage id when present else truncated `descriptor.do`
- [ ] `lane` attached to the `∥` `build_step_start` (`:791-801`), parallel `build_step_done`s (`:607-624`, `:973-983`), and fanout-item `build_error` writes
- [ ] **C4:** success-path parallel done (`:973-983`) checked and extended to carry explicit `status` — resolve before writing this task's tests
- [ ] `lane` passed into `runAndNormalize` opts at `:807`
- [ ] Test: focused producer test (envelope shape, defaulting of `generation`/`attempt`, label fallback) — `test/agent-stream-build.test.js` fixtures + new producer assertions

### Task 2 — S01b: stream stamping in `lib/result-normalizer.js` (existing)

- [ ] Back-compat snapshot test FIRST: no `lane` opt → write objects byte-identical (both paths)
- [ ] **C2:** locate the local-claude path's assistant relay writes (grep `type: 'assistant'` in the local branch) before stamping — both paths get stamped
- [ ] Engine-events closure (`:352-401`): spread `...(lane ? { lane } : {})` onto `assistant`, `tool_use`, `tool_use_summary`, and the `:400` usage write
- [ ] Local path (`:444-455` + located relay writes): identical stamping
- [ ] Test: lane stamping on both paths — `test/result-normalizer.test.js` (existing)

### Task 3 — S02: bridge forwarding in `server/build-stream-bridge.js` (existing)

- [ ] Forward `lane` when present on: `build_step_start` (`:298`), `tool_use` (`:310`), `tool_use_summary` (`:317`), `assistant` (`:331`), `build_step_done` (`:338`), `build_error` (`:373`)
- [ ] `build_step_done` also forwards `status`/`outcome`; `build_error` also forwards `stepId` (C5 — lane-scoped failure needs it)
- [ ] Absent-lane pass-through unchanged (table-driven per-case test)
- [ ] Test: `test/build-stream-bridge.test.js` (existing)

### Task 4 — S03a: lanes reducer in `src/components/AgentStream.jsx` (existing)

The behavioral core — test heaviest here.

- [ ] `_state.lanes`: Map keyed `flowId:stepId:itemIndex`, entries `{lane, status, version: [generation, attempt], messages: [], joinedMidBuild}`
- [ ] Version rule: higher `(generation, attempt)` resets entry (clears content, status → working); lower → event rejected
- [ ] Terminal rule: close only on done-with-status or lane-terminal error; advisory errors append as diagnostics
- [ ] Failed done → `failed` (fixes the `:211-215` "every done = complete" bug)
- [ ] Lane-stamped `assistant`/`tool_use`/`tool_use_summary` routed into the entry's buffer (per-lane cap, mirroring `MAX_ACTIVITY_LOG` `:157`)
- [ ] Legacy `parallelTasks` summary shape still emitted (AgentBar unchanged until Task 5); lanes added to `compose:agent-status` payload (`:171-180`)
- [ ] Lanes cleared on `build_end`/idle as `parallelTasks` clears today (`:235`)
- [ ] Run-scoping: same stepId, different flowId → different lane
- [ ] Test: `test/agent-stream-build.test.js` (existing) — creation from `∥` start, output routing, failed-done, advisory error, stale rejection, retry reset, run-scoping

### Task 5 — S03b: `src/components/cockpit/LaneStrip.jsx` (new) + `AgentBar.jsx` mount (existing)

- [ ] `LaneStrip`: lane tabs + per-lane feed, borrowing `AgentPanel.jsx:91-150` tab pattern (status dot, pulse on working, label, attempt badge, `(joined mid-build)` marker) — pattern only, fed from `compose:agent-status` payload, not zustand
- [ ] Collapsed state = today's counter line; expanded = tabs + selected lane feed
- [ ] `AgentBar.jsx` mounts `LaneStrip` at the counter consumption site (`:42-48`)
- [ ] Test: `test/ui/LaneStrip.test.jsx` (new, vitest tree) — tabs per lane, status dots, attempt badge, mid-build marker, collapsed counter parity

### Task 6 — E2E + review loop + coverage sweep (Phase 7 steps 2-4)

- [ ] E2E smoke: run a real parallel fanout (review fanout is the cheapest trigger), verify lanes in the cockpit
- [ ] Codex review loop to REVIEW CLEAN (~3 rounds budget; round 2 reviews the fixes)
- [ ] Coverage sweep to TESTS PASSING
- [ ] One full-suite run at the end (`npm test`, known proof-run hang → `--test-timeout=90000` where needed)

## Acceptance criteria (firmed from design draft)

- [ ] During a build with a parallel fanout, the cockpit shows one lane per worker (not just a counter)
- [ ] Each lane shows a human-readable label, live status, and that worker's own streamed output
- [ ] Relay text from worker A never appears in worker B's lane
- [ ] A failed worker's lane shows **failed** — terminal status explicit on done/error events
- [ ] A retried worker resets its lane (attempt badge); a stale terminal event from a superseded attempt cannot close the new attempt's lane
- [ ] Absent `lane`, behaviour degrades to today's aggregate counter and byte-identical stream writes
- [ ] A cockpit connecting mid-build shows lanes forward-only, marked `(joined mid-build)`

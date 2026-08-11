# COMP-AGENT-LANES: Per-subagent lanes for parallel fan-outs — Design

**Status:** DESIGN
**Date:** 2026-08-10

## Related Documents

- Completes the deferred scope of `docs/features/ITEM-25a/design.md` ("agent_run / parallel tracking" + "drill-down into subagent output" — both listed Out of Scope there).
- Cockpit event plumbing: `server/build-stream-bridge.js`, `src/components/AgentStream.jsx`, `src/components/vision/AgentPanel.jsx`, `src/components/vision/visionMessageHandler.js`.
- Stratum references (read-only evidence, NO Stratum change needed — see spike verdict): `stratum/ts/src/engine/engine.ts:2578` (defaultConnector drops agent events), `stratum/ts/src/connectors/claude.ts:66,77,137` (step-agnostic emission).

---

## Problem

When the Compose lifecycle fans out work across multiple agents at once — Phase-1 exploration (2-3 `compose-explorer`), Phase-3 competing mandates (2-3 `compose-architect`), or any spec with parallel steps — the cockpit shows a single **aggregate counter**: "3 running". A human driving a build sees a number, not the individual agents, what each was told to do, or what each is producing. To actually follow the work they must drop to a terminal or read raw logs. This is the one remaining "can't drive it from the cockpit" gap: gate approval and error/tool-result streaming are already inline and live.

## Goal

Replace the aggregate parallel counter with **one live lane per parallel worker**, each showing:
- a human-readable **label** (the worker's mandate / step intent, not a cryptic spec id),
- live **status** (working / complete / failed),
- the worker's own **streamed output** (relay text + tool calls), attributable to that worker and no other.

**Non-goals (this slice):**
- The Agent-tool fan-out path (see "Two parallel paths" below) — deferred pending the verification in Open Questions.
- Reordering / re-running / cancelling individual lanes (control, not visibility).
- Any change to how parallel work is *scheduled* — this is a display/attribution slice only.

---

## Current architecture (grounded)

**The events already reach the cockpit.** Parallel execution is Stratum's fanout model (`engine.ts:1192` `scheduleFanout`, `:1386` `executeFanout`), and workers get **scoped step ids** (`engine.ts:2239` `scopedId(scope, stepId)` → `prefix/stepId`). During a build, step lifecycle events stream through `build-stream-bridge.js`:
- `build_step_start` / `build_step_done` carry `stepId`, `stepNum`, and a `parallel` flag (`build-stream-bridge.js:298-350`).
- The UI aggregate counter keys off exactly these: `AgentStream.jsx:203-210` initialises `parallelTasks = {total, completed, failed, active, tasks: {stepId: 'working'}}` when it sees a `build_step` whose `stepNum` starts with `∥`, and decrements on `build_step_done` (`:211-219`).

**So step *lifecycle* is already attributable by `stepId`.** The gap is the *output*:
- Agent output events (`agent_started`, `agent_relay`) are emitted by the connectors with metadata `{agent, model}` / `{text, role}` and **no step id** (`connectors/claude.ts:66,77`; `codex.ts:361,379`).
- **On the cockpit-visible path they never traverse the bridge's generic `build_stream_event` case** (`build-stream-bridge.js:462-475` — that case serves other envelopes). `runAndNormalize` consumes the connector envelopes and normalizes them into plain `assistant` / `tool_use` / `tool_use_summary` stream writes *before* the bridge (`result-normalizer.js:359-401`), which then hit the bridge's `assistant` (`:331`) and `tool_use`/`tool_use_summary` (`:310`/`:317`) cases. **The normalizer's direct writes are the lane contract to stamp and test — not the `build_stream_event` passthrough.** (Codex design review 2026-08-11, finding 4.)
- Result: when N workers run at once, their relay text interleaves into one flat stream with no way to route each line to its owning lane.

**The renderer we need already exists.** `AgentPanel.jsx:94-145` renders per-agent tabs with a log drill-down (`AgentLogViewer`) — but it is fed only by the `/api/agent/spawn` HTTP path (`server/agent-spawn.js:78-158`, the sole `agentSpawned` emitter). The parallel-step path never produces those records, so the panel stays dark for fan-outs. Reducers to mirror: `visionMessageHandler.js:102-141`.

---

## The load-bearing assumption — RESOLVED by sizing spike (2026-08-11)

**Question:** does a parallel worker's output stream carry its owning step id by the time it reaches the bridge?

**Answer: no — but the loss happens inside COMPOSE, so the fix is compose-only. No Stratum change.** The full trace:

1. **Stratum's engine-internal fanout path is irrelevant to the cockpit.** `defaultConnector` (`stratum ts/src/engine/engine.ts:2578-2588`) calls `runAgent` with **no `onEvent`**, so on that path the connector's `agent_started`/`agent_relay` events are dropped outright (`connectors/claude.ts:137` — `this.onEvent?.()` no-ops). Nothing the cockpit shows comes through there.
2. **The cockpit-visible parallel executor is compose's own consumer fanout.** `lib/build.js:788` is the code that writes the `∥${itemIndex}` `build_step_start` events the aggregate counter keys on (the H6 comment at `:781-787` documents the contract). At dispatch time compose holds the full lane identity: `descriptor.id` (stepId), `descriptor.itemIndex`, `descriptor.do` (intent — the human label), `descriptor.agent`, stage, generation.
3. **The attribution is dropped one call deeper.** `build.js:807` calls `runAndNormalize(...)`, and `lib/result-normalizer.js:359-401` relays the worker's stream envelopes to the shared `streamWriter` as bare writes — `agent_relay` → `{type:'assistant', content}` (`:363`), `tool_use` → `{type:'tool_use', tool, input}` (`:370`), `tool_use_summary` (`:380`) — stamping **none** of the caller's per-item context. Only the `telemetry` option gets `step_id` (`build.js:823`), and telemetry does not reach the stream.

**Consequence:** Approach A wins, with the attribution point moved from the bridge to `runAndNormalize`'s stream writes. Approach B (Stratum stamp) is dead — struck, not needed for the in-scope path.

## Two parallel paths (scope boundary)

There are two distinct "multiple agents at once" experiences, and this slice targets exactly one:

1. **Stratum parallel steps (IN SCOPE).** A build runs a spec whose steps fan out; the Stratum engine executes them through connectors; events flow through `build-stream-bridge`. This is the path the aggregate counter tracks today, and the one with a clear in-repo event flow. **This slice fixes this path.**
2. **Skill-driven Agent-tool fan-out (DEFERRED).** The compose SKILL tells the *orchestrating* agent to launch 2-3 `compose-explorer` / `compose-architect` subagents via the Agent tool / `stratum_agent_run`. These are agent-initiated MCP dispatches that may not flow through `build-stream-bridge` at all. Whether their events reach the cockpit is a separate, murkier question — filed as an Open Question, not built here.

Picking path 1 keeps the slice well-bounded and verifiable; path 2 risks an unbounded "make agent-initiated subagents observable" investigation.

---

## The approach (post-spike, post-review; single repo, four touch points)

**The lane-identity envelope (one shape, stamped on ALL lane events — start, output, error, done):**

```
lane: {
  flowId,        // the run — stepId/itemIndex RECUR across builds (build.js:2618); without this a
                 //   retained store merges an old run's lane into a new run (round-2 finding 2)
  stepId,        // descriptor.id — the fanout step
  itemIndex,     // descriptor.itemIndex — which worker slot
  generation,    // descriptor.generation — supersession epoch (consumer-fanout.js:450)
  attempt,       // descriptor.attempt — retry counter
  label,         // human mandate: lens/stage id when present, else descriptor.do (truncated)
  agent,         // 'claude' | 'codex'
}
```

**Identity vs version (round-2 finding 1 — do not conflate):**
- Lane **identity** (the store key, one lane per worker slot per run) = `flowId:stepId:itemIndex`. `generation` is NOT in the key — a key that includes the version cannot reset or reject across versions and leaves superseded lanes rendered beside the current one.
- Lane **version** = the ordered tuple `(generation, attempt)`. An event with a higher version **resets** the lane (clears content, status → working, badge); an event with a lower version than the lane's current is **stale and rejected** — a late terminal event from a superseded attempt must not close the new attempt.

**Terminal rule (round-2 finding 3):** a lane closes ONLY on (a) a done event with explicit `status`/`outcome` (`succeeded`/`failed`/`skipped` — written at source, e.g. `build.js:610-618`), or (b) an error event explicitly marked lane-terminal. `build_error` is NOT inherently terminal — some are advisory while the build continues (`build.js:3059`); advisory errors render as in-lane diagnostics without closing the lane. Today's reducer marks every parallel done "complete" (`AgentStream.jsx:211-215`) — a pre-existing bug this slice fixes in passing.

1. **`lib/build.js` (fanout dispatch, ~`:807`):** build the `lane` envelope (all fields already in scope) and (a) pass it into `runAndNormalize` opts, (b) include it on the fanout's own `build_step_start`/`build_step_done`/error writes (they already carry `itemIndex`/`stage`/`generation` at source — `:791-801` — but as loose fields; unify under `lane`).
2. **`lib/result-normalizer.js` (stream relay, `:359-401`, `:450`):** when `opts.lane` is present, stamp it onto every `streamWriter.write` (`assistant`, `tool_use`, `tool_use_summary`, and the `:400` block). Absent `lane` → byte-identical writes (back-compat: single-step runs unchanged). **These direct normalizer writes are the lane contract** (see architecture note above) — tests target them, not the `build_stream_event` passthrough.
3. **`server/build-stream-bridge.js`:** forward `lane` (and terminal `status`/`outcome` on done) through the `assistant` (`:331`), `tool_use` (`:310`), `tool_use_summary` (`:317`), `build_step_start` (`:298`), `build_step_done` (`:338`), and `build_error` (`:373`) cases — today the bridge forwards only `stepId`/`stepNum`/`parallel` and drops `itemIndex`/`stage`/`generation`/outcome (Codex finding 2).
4. **UI:** a `parallelLanes` store slice keyed as above; lifecycle from the `∥` start/done/error events, output routed by the stamped `lane`. Render as per-worker tabs/lanes reusing `AgentPanel`'s tab + `AgentLogViewer` pattern (`AgentPanel.jsx:94-145`); the aggregate counter (`AgentStream.jsx:200-226`) becomes the collapsed summary of the same slice. Preserve the terminal-state guard pattern (`visionMessageHandler.js:120-121`) generalized to the `(generation, attempt)` staleness rule.

**Reconnect (scope-honest, Codex finding 1):** the build stream is broadcast live — the bridge keeps a cursor, not an event snapshot, and SSE hydration replays only recent interactive messages (`build-stream-bridge.js:25`, `agent-server.js:103`). So v1 lanes are **forward-only after a reconnect**: a cockpit that connects mid-build shows lanes from that point on and marks them `(joined mid-build)`; it does not reconstruct prior output. Full rebuild needs a persisted/replayable build-event log — real, useful platform work (it would fix all build-stream UI, not just lanes), **parked as a follow-up feature, not smuggled into this slice**.

**Struck: Stratum-side stamping.** The spike proved the engine-internal connector path never feeds the cockpit; stamping there would instrument a stream nobody renders. If a future slice ever routes engine-owned fanouts to the cockpit, that becomes its own feature.

---

## Open questions (for the blueprint gate)

1. ~~[Blocking] Is the stream step-attributable / does it need a Stratum stamp?~~ **RESOLVED 2026-08-11 by the sizing spike** — see "The load-bearing assumption" above. Compose-only; attribution point is `runAndNormalize`.
2. ~~Label source~~ **RESOLVED** — lens/stage id when present, else truncated `descriptor.do` (folded into the lane envelope).
3. ~~Lane identity across retries/reconnect~~ **RESOLVED 2026-08-11 (r1 findings 1+3, refined by r2 findings 1+2)** — identity `flowId:stepId:itemIndex`, version `(generation, attempt)` resets/rejects, reconnect forward-only in v1 (replayable build log parked as follow-up).
4. Should path 2 (Agent-tool fan-out) be folded in later, or is per-step lanes sufficient for the felt "3 running" pain? (Depends on which path the user actually watches during a build.)

## Acceptance criteria (draft — firmed in plan)

- [ ] During a build with a parallel fanout, the cockpit shows one lane per worker (not just a counter).
- [ ] Each lane shows a human-readable label, live status, and that worker's own streamed output.
- [ ] Relay text from worker A never appears in worker B's lane.
- [ ] A failed worker's lane shows **failed** (not "complete") — terminal status is explicit on done/error events.
- [ ] A retried worker resets its lane (attempt badge); a stale terminal event from a superseded attempt cannot close the new attempt's lane.
- [ ] Absent the `lane` field, behaviour degrades to today's aggregate counter and byte-identical stream writes (back-compat).
- [ ] A cockpit connecting mid-build shows lanes forward-only, marked as joined mid-build (full replay is a parked follow-up, not silently promised).

# COMP-GSD-5: Stuck Detection for Autonomous `gsd` Runs — Design

**Status:** DESIGN (Phase 1 — not implemented; intent doc, reviewed as a design not as shipped code)
**Date:** 2026-06-02
**Roadmap:** COMP-GSD-5 (parent COMP-GSD, "Autonomous Long-Run Mode"), complexity M
**Depends on:** COMP-GSD-2 (per-task dispatch — shipped); **STRAT-PAR-STREAM-TOOLDETAIL** (Stratum telemetry enrichment — prerequisite, built first this cycle, `stratum/docs/features/STRAT-PAR-STREAM-TOOLDETAIL/`)

## Related Documents
- `ROADMAP.md` → COMP-GSD-5; sibling safety rail to COMP-GSD-4 (budget); pause-state contract shared with COMP-GSD-6 (crash-recovery)
- Stratum prerequisite: `stratum/docs/features/STRAT-PAR-STREAM-TOOLDETAIL/design.md`
- Reuses `lib/debug-discipline.js`, `lib/build.js` `executeParallelDispatchServer` + `--resume` pattern, `lib/build-stream-schema.js`, `lib/gsd.js`, `lib/gsd-blackboard.js`

---

## Problem

`compose gsd <feature>` dispatches each blueprint task as a fresh-context agent and polls to completion. Nothing detects an agent **spinning** — editing the same file repeatedly without progress, hitting the same error over and over, or making no file changes for a long stretch. A stuck task burns tokens/wall-clock until the Stratum per-task timeout fires or a human notices. This is the missing autonomy-safety rail (paired with GSD-4 budget ceilings).

## Goal

Detect, in real time during per-task dispatch, the three stuck patterns; **halt with a structured diagnostic**; let a human **resume-or-abort**.

- **In scope:** detect (1) same file edited ≥3×, (2) same error recurring, (3) no file-changing tool use across K consecutive tool calls (+ wall-clock stall); structured stuck diagnostic; clean halt with `stuck` status; user-triggered `compose gsd <feature> --resume`.
- **Non-scope (v1):** *automatic* crash/auto-resume + `--headless` (GSD-6, built on GSD-5's pause-state shape); budget ceilings (GSD-4); cross-task aggregate health.

## Prerequisite (decided at the design gate): STRAT-PAR-STREAM-TOOLDETAIL

Codex review + source verification found the existing per-task telemetry insufficient for two of three signals: the claude connector's `tool_use_summary` (`connectors/claude.py:191`) emits only `{tool, summary(80-char), ok:true (hardcoded), duration_ms}` on the tool *call* — no raw input, no tool *result*, no error. So "same error reappearing" was **not derivable** and "same file 3×" was fragile (path buried in a truncated summary). Per the chosen path we enrich the Stratum telemetry first (its own stratum-owned feature), then build GSD-5 on the richer stream. **Telemetry contract GSD-5 consumes** (delivered by STRAT-PAR-STREAM-TOOLDETAIL, schema 0.2.6→0.2.7):
- `tool_use_summary.metadata.input` — the raw (sanitized/capped) tool input dict, so `input.file_path` is structured (signals 1 & 3).
- a tool-**result** event (new `kind:"tool_result"` or enriched follow-up) carrying `{tool_use_id, ok:boolean, output:<capped error/result text>}` — so a failed tool's error text is observable per call (signal 2).

---

## Decision 1: Observe the tool-use event stream (call + result), not just poll state

The detector subscribes through the **existing** `stratum.onEvent(flowId, stepId, …)` handler in `executeParallelDispatchServer` (`lib/build.js:2986`) and keeps per-task rolling state. With STRAT-PAR-STREAM-TOOLDETAIL the stream now carries structured input (call) and ok/error (result). gsd's `execute` step is `max_concurrent: 1` (`pipelines/gsd.stratum.yaml:93`) → one task at a time, so events attribute unambiguously even where `task_id` is absent (and the enriched envelope carries `task_id` anyway, `parallel_exec.py:_mint`).

## Decision 2: New `lib/gsd-stuck.js`, composing `debug-discipline.js` primitives

`GsdStuckDetector` (keyed by `taskId`), reusing `debug-discipline.js`'s per-key counter + `toJSON/fromJSON`:
- **same-file-edited:** reuse `FixChainDetector` (per-key file-hit, `count>=3` critical), fed `input.file_path` from each `Edit`/`Write`/`MultiEdit` `tool_use_summary`.
- **error-recurrence:** normalize + hash `output` from each `tool_result` with `ok:false`; fire at repeats ≥ threshold.
- **no-progress:** count consecutive `tool_use_summary` events with no file-changing tool; fire at ≥ K (a concrete event count — **not** an ill-defined "turn"); wall-clock stall (poll elapsed) is a parallel guard.

We do **not** wire gsd into bug-fix escalation (Codex/fresh-agent) — that path is bug-specific. We reuse primitives, not the remediation pathway.

## Decision 3: "Stuck" → clean halt + structured diagnostic

On first stuck verdict for a task: (1) write `.compose/gsd/<feature>/stuck.md` + `stuck.json` (schema `contracts/gsd-stuck.json`): signal fired, offending file/error, attempt counts, task id, partial diff, resume/abort guidance; (2) emit a `gsd_stuck` stream event; (3) halt the run loop cleanly with status `stuck`, cancelling the in-flight task via the existing parallel cascade-cancel.

## Decision 4: Thresholds, tunable via `.compose/compose.json` → `gsd.stuck.*`

| Key | Default | Rationale |
|---|---|---|
| `same_file_edits` | 3 | spec "3+" + `FixChainDetector` critical level |
| `error_repeats` | 3 | same error 3× = not converging |
| `no_progress_calls` | 8 | 8 consecutive tool calls with no file-changing tool |
| `wall_clock_ms` | 600000 | 10-min per-task stall guard (coarse backstop; full budgets are GSD-4) |

## Decision 5: Resume via `compose gsd <feature> --resume` — blackboard-driven step re-dispatch (NOT mid-task re-entry)

Codex Finding 1 (confirmed against `docs/features/T2-F5-CONSUMER-MERGE-STATUS-COMPOSE/design.md:27`): `stratum.resume(flowId)` **cannot** cleanly re-enter a *cancelled* `parallel_dispatch` task — it lands in the wrong next-step dispatch. So resume is **not** mid-task re-entry. Instead:
1. On stuck-halt, persist `.compose/gsd/<feature>/pause.json`: `{ flowId, stepId, stuckTaskId, completedTaskIds[], reason, signal, stuckSince, detectedAt, pid, mode:"gsd" }`. `completedTaskIds` comes from the blackboard (`lib/gsd-blackboard.js`) — tasks that already produced a VALIDATED result.
2. `compose gsd <feature> --resume`: read `pause.json`; validate ownership (no live `pid`) + `mode==="gsd"` (same guard as `compose fix --resume`, `lib/build.js:820`); re-run the gsd flow **skipping `completedTaskIds`** (decompose filters them; only the stuck + remaining tasks re-dispatch into fresh worktrees). Clear `pause.json` on clean continuation.
3. This is Compose-side completed-task tracking + re-dispatch — **no Stratum resume-into-task primitive required**, sidestepping the documented fragility. **GSD-6 reuses this same `pause.json` shape** for automatic crash-recovery (it adds dead-pid detection + backoff) — built once, extended, not reworked.

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `lib/gsd-stuck.js` | new | `GsdStuckDetector` — consume call+result events, 3 signals, verdict + diagnostic, serializable |
| `contracts/gsd-stuck.json` | new | schema for `stuck.json` + `pause.json` |
| `lib/build.js` | existing | wire detector into `executeParallelDispatchServer` onEvent + poll; halt-on-stuck |
| `lib/gsd.js` | existing | surface `stuck` status; write `stuck.md`/`stuck.json` + `pause.json`; `--resume` re-entry with completed-task skip |
| `bin/compose.js` | existing | `compose gsd <feature> --resume` flag → resume path; ownership/mode guard |
| `lib/gsd-blackboard.js` | existing | source of `completedTaskIds` for resume skip |
| `test/gsd-stuck.test.js` | new | each signal, thresholds, reset, serialization, diagnostic shape |
| `test/gsd-resume.test.js` | new | pause.json persistence, ownership/mode guard, completed-task skip on resume |

## Codex design-review findings — disposition

- **F1 resume (confirmed):** fixed — Decision 5 is blackboard-driven step re-dispatch, no mid-task re-entry, no Stratum change.
- **F2 telemetry (confirmed):** addressed by the STRAT-PAR-STREAM-TOOLDETAIL prerequisite (user chose enhance-first); all 3 signals now first-class.
- **F3 "turn" undefined (confirmed):** fixed — signal 3 is `no_progress_calls` (concrete consecutive-tool-call count) + wall-clock.

## Resolved Decisions

1. **Scope:** v1-full — detection + diagnostic + halt + user-triggered `--resume`; auto/headless remain GSD-6 on the same pause-state shape.
2. **Telemetry:** enrich Stratum first (STRAT-PAR-STREAM-TOOLDETAIL), then GSD-5 on the richer stream.
3. **Thresholds:** 3 / 3 / 8 / 600000ms, overridable via `gsd.stuck.*`.

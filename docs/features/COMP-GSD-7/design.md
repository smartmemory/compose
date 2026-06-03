# COMP-GSD-7 — Milestone Report Generator: Design

**Status:** DESIGN (Phase 1 — not yet implemented; this is intent, not shipped code)
**Date:** 2026-06-03
**Parent:** COMP-GSD (Autonomous Long-Run Mode)
**Depends on:** COMP-GSD-2 (decompose), COMP-GSD-6 (headless run + state primitives)

## Related Documents

- Roadmap row: `COMP-GSD-7` in `ROADMAP.md` (phase "COMP-GSD: Autonomous Long-Run Mode")
- Sibling: `docs/features/COMP-GSD-6/report.md` (run-state primitives this builds on)
- Memory: `~/.claude/projects/-Users-ruze-reg-my-forge/memory/project_comp_gsd.md`

---

## Problem

A GSD (autonomous long-run) feature build runs unattended — decompose → parallel-dispatch
tasks → merge → complete — with **no human in the loop**. When it finishes there is no single
artifact a human can open to see *what happened*: which tasks ran, how the budget was spent
against its caps, how long each task took, and what each task actually changed. The raw data is
scattered across `state.json`, `blackboard.json`, the budget ledger, and (for diffs) thrown away
when worktrees are cleaned up.

## Goal

On GSD feature completion, generate a **single self-contained HTML milestone report** that a
human can open from the cockpit's docs view. One report per feature, regenerated on each
completion, plus a CLI path to (re)generate retroactively.

**In scope (Full v1):**
- Per-task summary table: id, status, attempts, files-changed count, **elapsed time**
- **Budget actuals vs caps** (iterations / actions / wall-clock, per loop-type and feature-total)
- Decision/event log for the run (status transitions, resumes, stuck/budget pauses)
- **Per-task diff snapshots** captured before worktree cleanup, linked from the report
- Total run wall-clock, completion rate, phase

**Non-goals:**
- No live/streaming report (generated once, post-completion; CLI re-runs on demand)
- No cross-feature rollup dashboard (single feature per report)
- No new cockpit server route — the report rides the existing `docs/` discovery path

---

## Decision 1: Output location — `docs/gsd-reports/<feature>.html`

The roadmap row originally said `.compose/gsd/reports/<feature>.html` "rendered via the existing
cockpit asset pipeline." Investigation found **there is no asset pipeline for `.compose/`** — the
cockpit's `file-watcher` only serves files under `config.paths.docs` (default `docs/`). `.compose/`
is control-plane state and is never exposed to the UI.

**Decision:** write the report to **`docs/gsd-reports/<feature>.html`**. It is then auto-discovered
by the existing `GET /api/files` + `GET /api/file` plumbing and renders in `DocsView` (which
already handles `.html`) with **zero server changes**. The roadmap row is updated to match.

Rejected: a new `/api/gsd-report` route serving `.compose/` — more code, no benefit, and splits
report discovery from every other doc artifact.

## Decision 2: HTML shape — self-contained template literal

Follow the precedent in `server/graph-export.js:120` (roadmap-graph export): a single
`<!DOCTYPE html>` string built with template literals, inline `<style>`, inline data via
`JSON.stringify`. **No templating library, no external assets** — the file opens standalone and
survives being moved. Diffs render inline in `<pre>`/`<details>` blocks so the report has no link
dependencies.

## Decision 3: Atomic write, regenerate-always

Reuse the tmp+rename atomic-write pattern from `lib/gsd-state.js:40` / `lib/bug-index-gen.js:109`
(write `<file>.tmp`, `renameSync` into place, clean stale tmp first). The report is **derived
data** — regenerated wholesale on every completion, never hand-edited, same model as `roadmap.md`
and bug `INDEX.md`.

## Decision 4: Trigger — automatic on complete + CLI retroactive

- **Automatic:** at `lib/gsd.js:271` (after `clearPauseFile`, inside `if (response.status ===
  'complete')`), call the generator **best-effort** — wrapped so a report failure never fails the
  GSD run (`.catch` → warn).
- **CLI:** add `compose gsd report <feature-code>` (in `bin/compose.js`, next to the existing
  `gsd query` sub-route ~L1987) to (re)generate from already-persisted `state.json` /
  `blackboard.json` / diffs / budget ledger — for runs that predate this feature, or archival.

## Decision 5: Capturing the two un-persisted inputs (the "Full v1" work)

These two inputs flow through compose at run time but are discarded today. Both are persisted
**compose-side** — no Stratum change required. Neither rides the blackboard (see why below).

**(a) Per-task diff snapshots.** When a parallel task runs in a worktree with `capture_diff:true`,
Stratum returns the unified diff in the poll payload (`ts.diff`), consumed at
`lib/build.js:3352` inside `applyServerDispatchDiffsCore` and then dropped after the merge. We
persist it there to **`.compose/gsd/<feature>/diffs/<taskId>.diff`** (atomic write, `mkdirSync`
recursive). The report inlines each task's diff. Requires `capture_diff`/`isolation:worktree` to
be set for GSD dispatch — verify in blueprint; if a task ran without worktree isolation, its diff
section degrades to "no diff captured" + the `files_changed` list.

**(b) Per-task elapsed time — via a timing sidecar, NOT the blackboard.** Stratum's `parallel_poll`
response does not carry per-task timing. Compose derives it from data it already owns: it records
each task's dispatch time (`stuckDetector.startTask(taskId, now)`, `build.js:3043`) and its own
poll loop (`build.js:3027`) observes the first poll where each task reaches a terminal state.

**Codex-gate correction:** the blackboard is *not* a usable carrier for this. `blackboard.json`
is rebuilt by `collectBlackboard` (`gsd.js:~341`) from agent-written `.compose/gsd/<feature>/
results/<taskId>.json` files validated against `contracts/task-result.json` (which forbids extra
fields), then batch-written by `gsd-blackboard.writeAll` (whole-file replace). Compose's
poll-observed timing never enters those agent-written files, so it cannot survive into the
blackboard without changing the task-result contract *and* the agent production path.

Instead, persist poll-observed timing to a dedicated **sidecar** `.compose/gsd/<feature>/timing.json`
(a `{ [taskId]: { startedAt, completedAt, durationMs } }` map, atomic write) at the dispatch
site in `build.js`. The report assembler reads the sidecar directly and joins it to the blackboard
by `taskId`. This keeps the task-result contract untouched and the blackboard write path
unchanged. **Caveat:** completion time is bounded by the poll interval (seconds), so durations are
approximate-to-poll-granularity — documented in the report footer.

---

## Architecture (folded — single module + small touchpoints)

New module **`lib/gsd-milestone-report.js`**, split assemble/render/write so the data model is
unit-testable without parsing HTML:

```
assembleReportModel(featureCode, cwd) -> { feature, status, tasks[], budget, timeline[], totals }
  reads: gsd-state.readGsdState, gsd-blackboard.read,
         gsd-budget (budget.json) + recorded usage (budget actuals vs caps),
         timing.json sidecar (per-task elapsed), diffs/<taskId>.diff (filesystem),
         pause.json/stuck.json/budget.json presence+contents (timeline)
renderReportHtml(model) -> string            // self-contained HTML
writeReport(cwd, featureCode, html) -> path  // atomic tmp+rename into docs/gsd-reports/
generateGsdMilestoneReport(featureCode, cwd, opts) -> { ok, path, model, html }  // orchestrates
```

**Budget source (Codex-gate correction).** Actuals-vs-caps come from the **GSD** budget surface,
not `budget-ledger.readBudget` (that helper exposes review/coverage loop iterations — a different,
non-GSD axis). The report reads GSD's enforced axes — tokens, agent-dispatches, usd, ms — from
`lib/gsd-budget.js` / the persisted `budget.json` and the usage recorded on completion via
`recordGsdUsageFromState(cwd, featureCode, response.budget_state)` (`gsd.js:~269`). Confirm exact
read API + persisted shape in blueprint.

Touchpoints:
| File | Change |
|------|--------|
| `lib/gsd-milestone-report.js` (new) | the generator (assemble + render + write) |
| `lib/build.js` (~3352) | persist `ts.diff` → `.compose/gsd/<f>/diffs/<taskId>.diff` |
| `lib/build.js` (~3027/3043) | write poll-observed timing → `.compose/gsd/<f>/timing.json` sidecar |
| `lib/gsd.js` (~267) | persist `completedAt` into `state.json` on terminal `complete` flush |
| `lib/gsd.js` (~271) | best-effort call to generator on `complete` |
| `bin/compose.js` (~1987) | `gsd report <feature>` sub-route |

No `contracts/task-result.json` change — timing rides the sidecar, not the task-result schema.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `lib/gsd-milestone-report.js` | new | assemble model + render HTML + atomic write |
| `lib/build.js` | edit | persist per-task diffs; write timing sidecar |
| `lib/gsd.js` | edit | persist `completedAt` to state.json; auto-generate report on completion (best-effort) |
| `bin/compose.js` | edit | `compose gsd report <feature>` CLI |
| `test/gsd-milestone-report.test.js` | new | model assembly + render + atomic-write + degrade paths |
| `ROADMAP.md` / `feature.json` | edit | fix output path; status → COMPLETE at ship |

## Open Questions

1. **Diff size cap?** A large task diff could bloat the HTML. Proposed: inline up to N KB per
   task in a collapsed `<details>`, truncate with a note + pointer to the `.diff` file. (Resolve
   in blueprint; default N = 200 KB.)
2. **Timeline scope (Codex-gate correction).** There is **no append-only run-event log** for GSD —
   neither `feature-events.jsonl` (feature-management mutations only) nor `gate-log.jsonl` (GSD is
   non-interactive; empty) is fed by the GSD runtime. GSD persists only *snapshots*:
   `state.json` (status/phase/startedAt/completedAt), `pause.json`, `stuck.json`, `budget.json`.
   **v1 timeline** is reconstructed from those snapshots — start, completion, terminal status/phase,
   and any pause/stuck/budget markers present with their reasons — not a true event stream. A
   richer append-only GSD run-event log is **filed as follow-up COMP-GSD-7-EVENTLOG**, not built
   here.
3. **Retroactive total wall-clock (Codex-gate correction).** `state.json` persists `startedAt` but
   the terminal flush never writes a completion timestamp, and the ledger only records `timeMs`
   when `budget_state` was present — so an unbudgeted past run has no end time, and `gsd report`
   run later cannot recover total wall-clock. **Fix:** the terminal `complete` flush (`gsd.js:~267`)
   persists `completedAt` into `state.json`. Both auto and retroactive paths then have it; runs
   that completed before this feature show "completion time not recorded."

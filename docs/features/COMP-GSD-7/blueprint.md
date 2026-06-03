# COMP-GSD-7 — Milestone Report Generator: Implementation Blueprint

**Status:** BLUEPRINT (Phase 4 — verified against source 2026-06-03; not yet implemented)
**Date:** 2026-06-03
**Design:** [design.md](design.md)

All file:line anchors below were read directly from source in this session. Verification table
(Phase 5) at the end.

---

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| `lib/gsd-milestone-report.js` | **new** | `assembleReportModel` + `renderReportHtml` + `writeGsdReport` + `generateGsdMilestoneReport` |
| `lib/gsd-timing.js` | **new** | `writeTimingSidecar` / `readTimingSidecar` — atomic `timing.json` I/O (kept out of build.js to stay testable) |
| `lib/build.js` | edit | (a) capture poll-observed per-task timing in the dispatch loop; (b) persist `ts.diff` at the merge site |
| `lib/gsd.js` | edit | on terminal `complete`: persist `completedAt` to state.json, write `budget-final.json` when `budget_state` present, best-effort report generation |
| `bin/compose.js` | edit | `compose gsd report <feature>` sub-route (mirror `gsd query`) |
| `test/gsd-milestone-report.test.js` | **new** | model assembly + render + atomic-write + degrade paths |
| `test/gsd-timing.test.js` | **new** | sidecar round-trip + atomic write |

No `contracts/task-result.json` change (timing rides the sidecar, confirmed: blackboard validates
against that schema with `strict:false` but extra fields would still need declaring — sidecar avoids it).

---

## Verified anchors (read this session)

### Auto-generation hook — `lib/gsd.js:267-286`
The `complete` branch is `gsd.js:267-272`; the terminal `flushState` is `gsd.js:278`; the function
returns at `282-286`. Plan:
```js
// 267  if (response.status === 'complete') {
//        recordGsdUsageFromState(cwd, featureCode, response.budget_state);
//        clearPauseFile(cwd, featureCode);
// NEW:   if (response.budget_state) writeBudgetFinalSnapshot(stepCtx, response.budget_state);
//      }
// 274  const terminalStatus = response.status === 'complete' ? 'complete' : 'failed';
// 278  flushState(stepCtx, { status: terminalStatus, phase: 'done',
//                            completedAt: new Date().toISOString() });   // completedAt added
// NEW (after flush, before return):
//      if (terminalStatus === 'complete') {
//        try { await generateGsdMilestoneReport(featureCode, cwd); }
//        catch (e) { console.warn(`[gsd] milestone report failed: ${e.message}`); }
//      }
```
- `flushState(ctx, patch)` (`gsd.js:712`) merges `patch` into `ctx.runState` and calls
  `writeGsdState` — adding `completedAt` to the patch persists it into `state.json`. Harmless on the
  `failed` terminal (it records when it ended).
- `writeBudgetFinalSnapshot` = thin local writer: `composeBudgetDiagnostic(budgetState, {feature,
  decomposedTasks: ctx.runState.decomposedTasks, completedTaskIds: ctx.runState.completedTaskIds}).json`
  → atomic write to `.compose/gsd/<f>/budget-final.json`. **Distinct filename** from the halt
  artifact `budget.json` (which carries `kind:'budget'` halt semantics and is read by
  `buildGsdQuery` precedence at `gsd-state.js:131`) — must not collide.

### Budget actuals-vs-caps source — `lib/gsd-budget.js`
- Shape: `budget_state = { caps, consumed: { tokens, dispatches, wall_s, dollars } }`
  (`gsd-budget.js:143`). Enforced axes: `max_tokens`, `max_agent_dispatches`, `ms`, `usd`
  (`gsd-budget.js:17,116-121`).
- `composeBudgetDiagnostic(budgetState, meta)` → `{ json, md }` with caps/consumed and
  `remainingTaskIds` (`gsd-budget.js:147-205`). The report's budget section reuses `json` directly.
- **NOT** `budget-ledger.readBudget` (review/coverage axes — wrong substrate, per design Decision 5
  and the Codex gate).
- **Source precedence in the report:** (1) `budget_state` passed in-process by the auto hook →
  (2) persisted `budget-final.json` (clean complete) → (3) `budget.json` (halt case) →
  (4) `null` ⇒ render "unbudgeted run — no caps enforced".

### Per-task timing — `lib/build.js:3021-3069` (the dispatch poll loop)
- The poll loop reads `pollResult.tasks[taskId].state ∈ {running, complete, failed, cancelled}`
  (`build.js:3027,3042-3044`). `stuckDetector.startTask(taskId, now)` already stamps first-sight
  for *running* tasks (`build.js:3043`) but that's private to the detector.
- Add a local `taskTiming = {}` accumulator in `executeParallelDispatchServer`: on first sight of
  any `taskId`, set `startedAt = nowIso`; when a task is first seen in a terminal state, set
  `completedAt = nowIso`, `durationMs`. After the loop resolves, if a gsd context is present
  (`context.featureCode` truthy), `writeTimingSidecar(cwd, featureCode, taskTiming)`.
- `executeParallelDispatchServer(response, stratum, { cwd, featureCode }, …, baseCwd, { stuckDetector, … })`
  — called from `gsd.js:341` with `{ cwd, featureCode }`; in the plain build path `featureCode` is
  absent ⇒ sidecar write is skipped (build mode produces no report). **Caveat (documented in
  footer):** `completedAt` is poll-granularity-bounded (`SERVER_DISPATCH_POLL_MS`).

### Per-task diff persistence — `lib/build.js:3352`
- `applyServerDispatchDiffsCore(taskList, pollTasks, baseCwd, streamWriter, stepId, context)`
  collects `ts.diff` into `diffMap` at `build.js:3352` (only `state==='complete'`,
  skips `diff_error`). Persist each `ts.diff` to `.compose/gsd/<featureCode>/diffs/<taskId>.diff`
  (atomic, `mkdirSync` recursive) **at this point**, guarded on `context?.featureCode`.
- **RESOLVED (was C1).** `context` is `executeParallelDispatchServer`'s 3rd param
  (`build.js:2946`); gsd.js calls it (`gsd.js:341`) with `{ cwd, featureCode }`, and the same
  `context` reaches `applyServerDispatchDiffsCore` at both call sites (`build.js:3152`, `3180`). So
  `context.featureCode` and `context.cwd` ARE in scope at the diff site. **Subtlety:** build mode's
  context (`build.js:948`) *also* carries `featureCode`, so `featureCode` alone can't gate gsd-only
  persistence. **Resolution:** gsd.js passes `context = { cwd, featureCode, gsd: true }`; both the
  timing write (in `executeParallelDispatchServer`) and the diff write (in
  `applyServerDispatchDiffsCore`) gate on `context.gsd === true`. Build mode (no `gsd` marker, and
  `opts.stuckDetector == null`) stays byte-identical.

### Blackboard / task records — `lib/gsd-blackboard.js`, `lib/gsd.js:568`
- `read(code,{cwd})` → `{ [taskId]: TaskResult }` (`gsd-blackboard.js:98`). TaskResult fields:
  `status, files_changed[], summary, produces{}, gates[], attempts` (`contracts/task-result.json`).
  The report's per-task table joins this map with `timing.json` and `diffs/<taskId>.diff` by `taskId`.
- `collectBlackboard` (`gsd.js:568`) rebuilds the blackboard from
  `.compose/gsd/<f>/results/<taskId>.json`; `writeAll` (`gsd-blackboard.js:105`) is whole-file
  replace. The report does **not** touch this path — read-only join.

### Run state — `lib/gsd-state.js`
- `readGsdState(cwd,featureCode)` → `state.json` (`gsd-state.js:55`): `status, phase, startedAt,
  heartbeatAt, pid, flowId, decomposedTasks[], completedTaskIds[], budget`, + new `completedAt`.
- Atomic write helper to copy for sidecars/report: `writeGsdState` tmp+rename (`gsd-state.js:44-53`).
- Timeline is built from these snapshot fields + presence of `pause.json`/`stuck.json`/`budget.json`
  in `.compose/gsd/<f>/` — there is **no** append-only event log (design Open Question 2; follow-up
  `COMP-GSD-7-EVENTLOG`).

### HTML shape — `server/graph-export.js:120`
- Precedent: a single `<!DOCTYPE html>` template literal, inline `<style>`, data inlined via
  `JSON.stringify`. No external assets. `renderReportHtml(model)` follows this; diffs in collapsed
  `<details><pre>` blocks, truncated past 200 KB with a pointer to the `.diff` file
  (design Open Question 1, resolved: cap = 200 KB).

### Output write — `docs/gsd-reports/<feature>.html`
- `writeGsdReport(cwd, featureCode, html)`: `mkdirSync(docs/gsd-reports, {recursive})`, write
  `<file>.html.tmp`, `renameSync` into place (clean stale tmp first) — pattern from
  `gsd-state.js:44` / `lib/bug-index-gen.js:109`. Auto-discovered by the cockpit `DocsView`
  (`GET /api/files` + `/api/file`), which already renders `.html`. Zero server change.

### CLI — `bin/compose.js`, insert after line 1987 (after the `gsd query` block)
```js
if (args[0] === 'report') {
  const rCode = args.find((a, i) => i > 0 && !a.startsWith('-'))
  if (!rCode) { console.error('Usage: compose gsd report <feature-code> [--cwd <path>]'); process.exit(1) }
  const { root: rRoot } = resolveCwdWithWorkspace(args.slice(1))
  const rCwdIdx = args.indexOf('--cwd')
  const rCwd = rCwdIdx !== -1 ? resolve(args[rCwdIdx + 1]) : rRoot
  const { generateGsdMilestoneReport } = await import('../lib/gsd-milestone-report.js')
  const r = await generateGsdMilestoneReport(rCode, rCwd)
  if (!r.ok) { console.error(`gsd report: ${r.error}`); process.exit(1) }
  console.log(`Report written: ${r.path}`)
  process.exit(0)
}
```
Also add a usage line at `bin/compose.js:1995`. Retroactive path: reads persisted
`state.json`/`blackboard.json`/`timing.json`/`diffs`/`budget-final.json` — `budget_state` arg omitted.

---

## Boundary Map

> Cross-slice contract symbols. `from S##` references an earlier slice.

- **`writeTimingSidecar(cwd, featureCode, timingMap)`** — function, `lib/gsd-timing.js`. Producer.
  Writes atomic `.compose/gsd/<f>/timing.json` = `{ [taskId]: { startedAt, completedAt, durationMs } }`.
- **`readTimingSidecar(cwd, featureCode)`** — function, `lib/gsd-timing.js`. Returns the map or `{}`.
  Consumed by `assembleReportModel` (from S1).
- **`assembleReportModel(featureCode, cwd, opts)`** — function, `lib/gsd-milestone-report.js`.
  Returns `{ feature, status, phase, startedAt, completedAt, tasks[], budget, timeline[], totals }`.
  Consumes `readTimingSidecar` (from S1), `gsd-blackboard.read`, `readGsdState`,
  `composeBudgetDiagnostic`. `opts.budgetState` optional (auto path).
- **`renderReportHtml(model)`** — function, `lib/gsd-milestone-report.js`. Pure: model → HTML string.
- **`writeGsdReport(cwd, featureCode, html)`** — function, `lib/gsd-milestone-report.js`. Atomic
  write to `docs/gsd-reports/<feature>.html`, returns the path.
- **`generateGsdMilestoneReport(featureCode, cwd, opts)`** — function, `lib/gsd-milestone-report.js`.
  Orchestrates assemble→render→write; returns `{ ok, path, model, html } | { ok:false, error }`.
  Consumed by `gsd.js` auto-hook and `bin/compose.js` CLI (both from S-impl).

---

## Corrections Table

| # | Spec / design assumption | Reality (verified) | Resolution |
|---|--------------------------|--------------------|------------|
| C1 | Persist diff at `build.js:3352` keyed by `context.featureCode` | **Resolved.** `context` is the dispatch fn's 3rd param; gsd.js passes `{cwd, featureCode}`, reaches the diff site at `3152`/`3180`. But build mode's context also has `featureCode` | gsd.js passes `context = { cwd, featureCode, gsd: true }`; timing + diff writes gate on `context.gsd === true` |
| C2 | Timing persists onto the blackboard / task-result | Blackboard is rebuilt from agent-written `results/*.json` validated against `contracts/task-result.json`; compose's poll-observed timing never enters those files | Use a **separate `timing.json` sidecar** (`lib/gsd-timing.js`); report joins by `taskId`. No contract change |
| C3 | Budget actuals from `budget-ledger.readBudget` | That helper exposes review/coverage loop axes, not GSD's enforced budget | Read `budget_state`/`composeBudgetDiagnostic` (`gsd-budget.js`); precedence `budget_state → budget-final.json → budget.json → unbudgeted` |
| C4 | `budget.json` available for retroactive budget on a clean complete | Only written on a budget **halt** (`writeBudgetArtifacts`); a clean complete persists nothing | Auto hook writes `budget-final.json` (distinct from the `kind:'budget'` halt artifact) when `budget_state` present |
| C5 | Total wall-clock reconstructable retroactively | `state.json` has `startedAt`; no completion timestamp is ever persisted | Terminal `flushState` persists `completedAt` into `state.json` |
| C6 | Run timeline from `feature-events.jsonl` (`readEvents`) | Not fed by the GSD runtime; GSD has only snapshots | v1 timeline reconstructed from `state.json` + `pause/stuck/budget.json` presence; richer log deferred to `COMP-GSD-7-EVENTLOG` |

---

## Verification Table (Phase 5)

| Anchor | Claim | Status |
|--------|-------|--------|
| `gsd.js:267-272` | `complete` branch with `recordGsdUsageFromState` + `clearPauseFile` | ✅ verified |
| `gsd.js:278` | terminal `flushState({status, phase:'done'})` | ✅ verified |
| `gsd.js:712` | `flushState(ctx,patch)` merges patch → `writeGsdState` | ✅ verified |
| `gsd.js:568` | `collectBlackboard` reads `results/*.json` | ✅ verified |
| `gsd-budget.js:143-205` | `budget_state` shape + `composeBudgetDiagnostic` | ✅ verified |
| `gsd-state.js:44-63` | `writeGsdState`/`readGsdState` atomic tmp+rename | ✅ verified |
| `gsd-blackboard.js:98-135` | `read`/`writeAll` whole-file replace | ✅ verified |
| `build.js:3026-3069` | poll loop; `pollResult.tasks[id].state`; `startTask` | ✅ verified |
| `build.js:3352` | `ts.diff` collected in `applyServerDispatchDiffsCore` | ✅ verified |
| `build.js:2943-2951` | `executeParallelDispatchServer(_, _, context, …)` 3rd param is `context` | ✅ verified |
| `build.js:3146-3180` | both diff call sites pass `context` through | ✅ verified |
| `gsd.js:341` | gsd passes `{cwd, featureCode}` as context (→ add `gsd:true`) | ✅ verified |
| `bin/compose.js:1974-1987` | `gsd query` sub-route pattern to mirror | ✅ verified |
| `server/graph-export.js:120` | self-contained HTML template-literal precedent | ✅ verified (per earlier exploration) |

All anchors verified. Zero stale references, zero unresolved items. Boundary Map: all `from S#`
references point to earlier slices; producers/consumers matched. Ready for Phase 6 (plan).

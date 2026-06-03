# COMP-GSD-7-EVENTLOG — Implementation Blueprint

**Status:** BLUEPRINT (Phase 4 — verified vs source 2026-06-03)
**Design:** [design.md](design.md)

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| `lib/gsd-events.js` | new | `appendGsdEvent` / `readGsdEvents` / `clearGsdEvents` |
| `lib/gsd-state.js` | edit | `clearGsdHaltArtifacts(cwd, feature)` (rm stuck.{json,md}, budget.{json,md}) |
| `lib/gsd.js` | edit | seed `emittedCompletions`; fresh-truncate + clear-halt + `run_started` at planning checkpoint; `phase` events; `emitCompletionDeltas` at execute-merge + stuck + budget; `completed`/`failed` |
| `lib/gsd-milestone-report.js` | edit | `buildTimeline` reads events first; snapshot fallback on zero events |
| `test/gsd-events.test.js` | new | append/read/clear, bad-line tolerance, kind/detail spread |
| `test/gsd-milestone-report.test.js` | edit | timeline-from-events; fallback on absent/empty/corrupt |

## Verified anchors (lib/gsd.js, current line numbers)

- **Seed dedupe** — `initialState.completedTaskIds = collectCompletedTaskIds(...)` at **:203**;
  `stepCtx` created at :205-212. Add `emittedCompletions: new Set(initialState.completedTaskIds)`.
- **Planning checkpoint** — `flushState(stepCtx, {})` at **:217**. Immediately after:
  ```js
  if (!opts.resume) { clearGsdEvents(cwd, featureCode); clearGsdHaltArtifacts(cwd, featureCode); }
  appendGsdEvent(cwd, featureCode, 'run_started', { mode: opts.resume ? 'resume' : 'fresh', attempt: opts.attempt ?? 1 });
  ```
  (truncate BEFORE the append, so run_started survives.)
- **Decompose phase** — `flushState(stepCtx, { flowId, phase: 'decompose' })` at **:244**. After it:
  `appendGsdEvent(cwd, featureCode, 'phase', { phase: 'decompose' })`.
- **Execute merge (normal)** — `flushState(ctx, { phase: 'execute', completedTaskIds: collectCompletedTaskIds(...) })`
  at **:423** (inside `runOneStep`, `ctx` in scope). Refactor to compute once + emit:
  ```js
  const wasExecute = ctx.runState?.phase === 'execute';
  const completed = collectCompletedTaskIds(cwd, featureCode);
  flushState(ctx, { phase: 'execute', completedTaskIds: completed });
  if (!wasExecute) appendGsdEvent(cwd, featureCode, 'phase', { phase: 'execute' });
  emitCompletionDeltas(ctx, completed);
  ```
- **Stuck halt** — `writeStuckArtifacts(ctx, response, outcome.stuck)` at **:413** (runOneStep). Before/after it:
  `emitCompletionDeltas(ctx)` then `appendGsdEvent(cwd, featureCode, 'paused', { pauseKind: 'stuck', taskId: outcome.stuck?.taskId ?? null })`.
- **Budget halt** — `writeBudgetArtifacts(stepCtx, response, budgetState)` at **:276** (runGsd main loop). After it:
  `emitCompletionDeltas(stepCtx)` then `appendGsdEvent(cwd, featureCode, 'paused', { pauseKind: 'budget', axis })`.
- **Complete** — `if (response.status === 'complete')` at **:292**. Inside: `emitCompletionDeltas(stepCtx)`
  then `appendGsdEvent(cwd, featureCode, 'completed', {})`.
- **Failed** — the terminal `failed` (non-complete) is decided at **:316**; the catch is at **:337**.
  Emit `appendGsdEvent(cwd, featureCode, 'failed', { reason })` on both the non-complete-terminal
  branch (reason: the raw status) and in the catch (reason: `err.message`). Best-effort (it's already
  inside try/catch territory; appendGsdEvent itself swallows errors).

### CRITICAL: kind/detail spread collision
`appendGsdEvent(cwd, feature, kind, detail)` writes `{ ts, kind, ...detail }`. A `paused` event must
NOT put its stuck/budget discriminator under the key `kind` (the spread would overwrite the event
`kind`). Use **`pauseKind`**. `appendGsdEvent` writes `kind` AFTER spreading detail is wrong too —
it must write `{ ts, ...detail, kind }` OR forbid a `kind` key in detail. Chosen:
`{ ts: <iso>, kind, ...detail }` with the contract that `detail` never contains `ts`/`kind`
(callers use `pauseKind`, `taskId`, `phase`, `mode`, `axis`, `reason`, `attempt`).

## lib/gsd-events.js (new)

```js
import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
function gdir(cwd, f) { return join(cwd, '.compose', 'gsd', f); }
export function gsdEventsPath(cwd, f) { return join(gdir(cwd, f), 'events.jsonl'); }
export function appendGsdEvent(cwd, f, kind, detail = {}) {
  try {
    mkdirSync(gdir(cwd, f), { recursive: true });
    appendFileSync(gsdEventsPath(cwd, f), JSON.stringify({ ts: new Date().toISOString(), kind, ...detail }) + '\n');
  } catch { /* best-effort — never affect the run */ }
}
export function readGsdEvents(cwd, f) {
  const p = gsdEventsPath(cwd, f);
  if (!existsSync(p)) return [];
  let lines;
  try { lines = readFileSync(p, 'utf-8').split('\n'); } catch { return []; }
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip torn/corrupt line */ }
  }
  return out;
}
export function clearGsdEvents(cwd, f) {
  try { if (existsSync(gsdEventsPath(cwd, f))) writeFileSync(gsdEventsPath(cwd, f), ''); } catch { /* best-effort */ }
}
```

## lib/gsd-state.js — clearGsdHaltArtifacts
Next to `clearGsdPause`: best-effort `rmSync` of `stuck.json`, `stuck.md`, `budget.json`, `budget.md`
under `gsdDir`. (Same pattern as `clearGsdPause`.)

## lib/gsd-milestone-report.js — timeline from events
```js
import { readGsdEvents } from './gsd-events.js';
function eventLabel(e) {
  switch (e.kind) {
    case 'run_started': return `Run started (${e.mode ?? 'fresh'})`;
    case 'phase': return `Phase: ${e.phase ?? '?'}`;
    case 'task_completed': return `Task completed: ${e.taskId ?? '?'}`;
    case 'paused': return `Paused (${e.pauseKind ?? '?'})`;
    case 'completed': return 'Run completed';
    case 'failed': return `Run failed${e.reason ? `: ${e.reason}` : ''}`;
    default: return String(e.kind ?? 'event');
  }
}
function buildTimeline(state, cwd, featureCode) {
  const events = readGsdEvents(cwd, featureCode);
  if (events.length > 0) return events.map((e) => ({ label: eventLabel(e), ts: e.ts ?? null }));
  /* ...existing snapshot fallback unchanged... */
}
```

## Boundary Map

- **`appendGsdEvent(cwd, feature, kind, detail)`** — function, `lib/gsd-events.js`. Producer.
- **`readGsdEvents(cwd, feature)`** — function, `lib/gsd-events.js`. Returns `Event[]` (skips bad lines).
  Consumed by `buildTimeline` (from S-report).
- **`clearGsdEvents(cwd, feature)`** — function, `lib/gsd-events.js`. Fresh truncate.
- **`clearGsdHaltArtifacts(cwd, feature)`** — function, `lib/gsd-state.js`. Fresh halt-artifact clear.
- **`emitCompletionDeltas(ctx, completedIds?)`** — function, `lib/gsd.js` (internal). Fires
  `task_completed` for new ids vs `ctx.emittedCompletions`.

## Corrections Table

| # | Assumption | Reality | Resolution |
|---|------------|---------|------------|
| C1 | truncate events where state.json clears | state clears early, pre-preconditions (`:49`) | truncate at planning checkpoint `:217` |
| C2 | task_completed only at execute-merge | stuck returns early (`:413`) before merge checkpoint | `emitCompletionDeltas` at execute-merge + stuck + budget |
| C3 | empty emitted-set ok | resume preloads completions (`:203`) | seed `emittedCompletions` from initial snapshot |
| C4 | report falls back only when file absent | torn/empty file parses to 0 events | fall back on `readGsdEvents().length === 0` |
| C5 | snapshot fallback safe | `buildTimeline` reads stale stuck/budget.json | fresh start `clearGsdHaltArtifacts` |
| C6 | paused detail `{kind}` | spread overwrites event `kind` | use `pauseKind` |

## Verification Table (Phase 5)

| Anchor | Claim | Status |
|--------|-------|--------|
| `gsd.js:203` | initial `completedTaskIds` snapshot (seed source) | ✅ |
| `gsd.js:217` | planning checkpoint flush | ✅ |
| `gsd.js:244` | decompose phase flush | ✅ |
| `gsd.js:413` | `writeStuckArtifacts` (stuck path, early return) | ✅ |
| `gsd.js:423` | execute-merge `completedTaskIds` flush | ✅ |
| `gsd.js:276` | `writeBudgetArtifacts` (budget halt) | ✅ |
| `gsd.js:292` | complete branch | ✅ |
| `gsd.js:316/337` | failed terminal + catch | ✅ |
| `gsd-milestone-report.js:54` | `buildTimeline` snapshot fallback to preserve | ✅ |

All anchors verified.

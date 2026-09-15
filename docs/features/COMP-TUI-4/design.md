<!-- wasGeneratedBy: explore_design -->
# COMP-TUI-4 — Parallel Task Grid

**Status:** DESIGN
**Date:** 2026-09-15
**Complexity:** S
**Depends on:** COMP-TUI-3 (shipped `b61f1b8e`)

## Related Documents

- `lib/cli-progress.js` — the entire TUI lives here (483 lines). This is the primary change target.
- `lib/build.js:1768–1775` — where `parallelStepNum` is formed and `progress.stepStart` is called for fanout items.
- `lib/build.js:2011` — where `progress.stepDone` is called on item completion.
- `lib/build.js:1781` — `descriptor.agent ?? 'claude'` is already available at the call site but not forwarded to progress.
- `src/components/agent-stream-lanes.js` — web-cockpit analogue (already has per-task lane state; unrelated to this feature).
- ROADMAP row: COMP-TUI-4 (Phase: COMP-TUI: CLI Terminal UI)

---

## Problem

During `parallel_dispatch` (fanout execution), `compose build` runs 2–4 agent tasks
concurrently. The CLI currently calls `progress.stepStart('∥N', '?', stepId)` for each
item, which prints one flat banner per task — producing overlapping `[∥0/?] T01...`,
`[∥1/?] T02...` lines that scroll away immediately and give no live status. There is
no stable on-screen indicator showing which tasks are running, which finished, and how long
each has taken.

The cockpit already tracks per-task lane state (`agent-stream-lanes.js`). The CLI does
not.

---

## Goal

Render a live 2–4 row grid at the bottom of the terminal whenever a parallel fanout is
active, showing per-task: row index (∥N), status icon (working / done / failed), agent
name, task ID (truncated), and elapsed seconds. The grid redraws on the existing 5s
heartbeat. No new dependencies. No behavior change for single-step (non-parallel) builds.

**Non-goals:** spinner animation faster than the 5s heartbeat; surfacing tool-call
detail per row (too noisy in parallel); changes to the GSD headless path
(`NOOP_PROGRESS` stays unchanged); changes to the web cockpit.

---

## Scope assessment (quick-path guardrail)

This feature touches exactly **two files**:

| File | Change |
|---|---|
| `lib/cli-progress.js` | New grid state + grid renderer; extend two method signatures |
| `lib/build.js` | Two call-site changes: pass `agent` to `stepStart`, pass `status` to `stepDone` |

No new modules, no architecture changes, no protocol changes. The quick path is correct.

---

## Architecture: how the parallel path currently works

1. `build.js:1768` computes `parallelStepNum = '∥' + descriptor.itemIndex`.
2. `build.js:1775` calls `progress.stepStart(parallelStepNum, '?', descriptor.id)`.
   At this point `descriptor.agent ?? 'claude'` is available (line 1781) but not forwarded.
3. During execution, `runAndNormalize` calls `progress.toolUse()` / `progress.toolSummary()`
   concurrently from multiple in-flight items — these currently each trigger a full erase-redraw
   of the single-task collapsed view (safe for one task, chaotic for N concurrent ones).
4. `build.js:2011` calls `progress.stepDone(descriptor.id)` — no status forwarded.
   The actual success/failure value is `localFailure ? 'failed' : 'succeeded'` (line 2025).

---

## Design

### 1. New private state in `CliProgress`

```js
// Keyed by stepId. itemIndex is stored for stable display order.
#parallelGrid = new Map(); // Map<stepId, { itemIndex, agent, status, startMs }>
```

`status` values: `'working'` | `'done'` | `'failed'`.

### 2. `stepStart` signature extension (backward-compatible)

```js
// Before (current):
stepStart(stepNum, totalSteps, stepId)

// After:
stepStart(stepNum, totalSteps, stepId, opts = {})
// opts.agent — string, e.g. 'codex' | 'claude'. Defaults to '' if absent.
```

When `stepNum` starts with `∥`:
- **Do not** print the `[∥N/?] stepId...` banner.
- **Do not** call `#drawPipelineBar` (the pipeline bar is not meaningful per-item).
- Add an entry to `#parallelGrid`: `{ itemIndex: N, agent: opts.agent ?? '', status: 'working', startMs: Date.now() }`.
- Call `#drawGrid()` to render the updated grid.

When `stepNum` does NOT start with `∥` (normal single-step path):
- Clear `#parallelGrid` (fanout is over).
- Behave exactly as today (pipeline bar + banner + collapsed view + heartbeat).

### 3. `stepDone` signature extension (backward-compatible)

```js
// Before:
stepDone(stepId)

// After:
stepDone(stepId, status = 'succeeded')
// status: 'succeeded' | 'failed'
```

If `#parallelGrid` has an entry for `stepId`, update it:
- `status = status === 'succeeded' ? 'done' : 'failed'`
- Call `#drawGrid()` to re-render.

If all entries are terminal (`done` or `failed`), keep the grid up — it will be
cleared by the next non-parallel `stepStart` call (the merge/triage step that follows
the fanout), or by `finish()`.

### 4. `toolUse` / `toolSummary` / `toolProgress` in parallel mode

When `#parallelGrid.size > 0` (i.e. a fanout is active):
- **Do not trigger a redraw.** Internal `#toolHistory` still accumulates (for toggle-expand), but `#drawCollapsed()` is not called. This prevents flicker from N concurrent tasks each triggering erase-redraw.
- The heartbeat (`#startHeartbeat`) continues to fire every 5s and calls `#drawGrid()`.

The heartbeat is shared — the first `stepStart` of a fanout starts it; it keeps ticking until the next `#stopHeartbeat()` call (which happens on the next sequential `stepStart`). No change needed to heartbeat mechanics.

### 5. `#drawGrid()` — the new renderer

```
  parallel · N tasks
  ∥0  ⋯  codex    T01-auth-validation-fix        14s
  ∥1  ✓  claude   T02-add-coverage-tests           8s
  ∥2  ✗  codex    T03-refactor-build-logic         4s
  keys: t=toggle  s=skip  r=retry  Ctrl+C=abort
```

**Row format** (one line per entry, sorted ascending by `itemIndex`):

```
  ∥N  <icon>  <agent padded to 6>  <stepId truncated>  <elapsed>s
```

Column widths:
- Row prefix `∥N`: fixed 4 chars + 2 padding = 6.
- Icon: 1 char + 2 spaces.
- Agent: padded to 6 chars (covers 'claude', 'codex ').
- StepId: `cols - 6 - 3 - 8 - 8` (remaining space, min 12, max 40).
- Elapsed: right-aligned in remaining space.

Status icons and colors:
- `working`: `⋯` in cyan — task in flight.
- `done`: `✓` in green.
- `failed`: `✗` in red.

Header line: `  ${DIM}parallel · ${N} tasks${RESET}` — gives context without being intrusive.

Erase-redraw uses the same `#eraseCollapsedBlock` / `#drawnCollapsedLines` mechanism
already in place. The total lines drawn = 1 (header) + N (rows) + 1 (hint bar) = N+2.

Non-TTY path: skip ANSI erase/draw; print a plain-text update on each status change
(same guard as today: `if (!this.#isTTY) return`).

### 6. Build.js call-site changes (two lines)

**Line 1775** — pass agent:
```js
// Before:
progress.stepStart(parallelStepNum, '?', descriptor.id);

// After:
progress.stepStart(parallelStepNum, '?', descriptor.id, { agent: descriptor.agent ?? 'claude' });
```

**Line 2011** — pass status:
```js
// Before:
progress.stepDone(descriptor.id);

// After:
progress.stepDone(descriptor.id, localFailure ? 'failed' : 'succeeded');
```

No other call sites are affected. The `stepDone` change is backward-compatible because
the existing single-step path ignores the second argument (it only pushes to
`#stepHistory`, which the grid check guards).

---

## Data flow summary

```
build.js: runConsumerIssuance (N concurrent)
  │
  ├─ progress.stepStart('∥0', '?', 'T01', { agent: 'codex' })
  │    → #parallelGrid.set('T01', { itemIndex:0, agent:'codex', status:'working', startMs })
  │    → #drawGrid()
  │
  ├─ progress.stepStart('∥1', '?', 'T02', { agent: 'claude' })
  │    → #parallelGrid.set('T02', { ... })
  │    → #drawGrid() (erases 3 lines, redraws 3 lines)
  │
  ├─ progress.toolUse('Bash', '...') [from T01] → no redraw (grid mode)
  ├─ progress.toolUse('Read', '...') [from T02] → no redraw (grid mode)
  │
  ├─ heartbeat (5s) → #drawGrid() → elapsed counters update
  │
  ├─ progress.stepDone('T02', 'succeeded')
  │    → #parallelGrid.get('T02').status = 'done'
  │    → #drawGrid() (T02 row shows ✓)
  │
  └─ progress.stepDone('T01', 'succeeded')
       → #parallelGrid.get('T01').status = 'done'
       → #drawGrid()

build.js: next sequential step (e.g. 'triage')
  └─ progress.stepStart('10', '17', 'triage')
       → #parallelGrid.clear()
       → normal single-step path resumes
```

---

## Acceptance criteria

- [ ] During a `parallel_dispatch` fanout, a stable N-row grid is shown at the bottom of the terminal (not a scrolling stream of banners).
- [ ] Each row shows: `∥N`, status icon (⋯/✓/✗), agent name, task ID (truncated to fit terminal width), elapsed seconds.
- [ ] Status icon updates when a task completes (done) or fails (failed).
- [ ] Elapsed seconds update on every heartbeat tick (≤5s intervals).
- [ ] After the fanout, the grid is cleared by the next sequential `stepStart` and normal single-step display resumes.
- [ ] Builds with no parallel steps are unaffected (no change in visual output).
- [ ] Non-TTY path (CI, pipes) is unaffected: no ANSI written, no behavior change.
- [ ] The `t`/`s`/`r`/Ctrl+C keys continue to work during parallel grid display.
- [ ] `NOOP_PROGRESS` (GSD headless path) is unaffected.

---

## Open questions

1. **stepId truncation length**: The step IDs in GSD fanouts are task IDs like `T01-auth-fix`. Should the display label come from `descriptor.id` (the step ID) or from a `label` field available on `descriptor`? Explorer finding: `descriptor.do` carries the human intent string (up to 80 chars). Could be shown instead of the raw ID, but the raw ID is more useful for cross-referencing timing.json. **Default: use `descriptor.id`.**

2. **Expanded mode during grid**: When the user presses `t` to expand, should all task output be dumped to screen? Current plan: dump `#toolHistory` as today (the concatenated events from all tasks, in arrival order). This is potentially confusing but is consistent with the existing contract. If unacceptable, gate the toggle with a message "toggle unavailable during parallel dispatch".

3. **Grid teardown timing**: If all tasks finish but the next sequential step hasn't started yet (brief gap), the grid shows all-done rows. This is correct — it is an accurate summary. No change needed.

---

## Implementation notes for Codex

- Primary file: `lib/cli-progress.js` (existing file, read before editing)
- Secondary file: `lib/build.js` (two lines only: 1775 and 2011)
- The `#parallelGrid` Map uses `stepId` as key, not `itemIndex`
- `#drawGrid()` must call `#eraseCollapsedBlock()` first (same as `#drawCollapsed()`) and update `#drawnCollapsedLines`
- In `toolUse()`, add a guard: `if (this.#parallelGrid.size > 0) { this.#toolHistory.push(...); return; }` before the draw path
- Non-TTY: `#drawGrid()` should short-circuit with `if (!this.#isTTY) return` at the top, just like `#drawCollapsed()`
- Heartbeat already handles grid via the existing `if (!this.#expanded) this.#drawCollapsed()` path — replace that call with a unified `#drawActive()` helper that dispatches to `#drawGrid()` or `#drawCollapsed()` depending on `#parallelGrid.size`

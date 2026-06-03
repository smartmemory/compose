# COMP-GSD-6 — Headless CLI + Crash Recovery: Implementation Blueprint

**Status:** BLUEPRINT
**Date:** 2026-06-03
**Design:** [design.md](design.md)
**Feature:** `COMP-GSD-6`

All line numbers re-verified against current `lib/gsd.js`, `lib/build.js`, `bin/compose.js` (Phase 4 seam verification).

---

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| `lib/gsd-state.js` | new | `writeGsdState`/`readGsdState`/`gsdStatePath`/`deriveRunStatus`/`pidAlive` — atomic tmp+rename state.json I/O + reader-side status derivation. Mirrors `writeActiveBuild` (`lib/build.js:404-412`). |
| `contracts/gsd-state.json` | new | JSON Schema: `state` def (status `running\|complete\|stuck\|budget\|failed`) + `query` envelope def (adds derived `crashed\|absent` + `heartbeatStale`). `$ref`s the `pause.decomposedTasks` item shape from `gsd-stuck.json`. |
| `lib/gsd.js` | modify | (1) `run.lock` atomic claim + `run.lock/owner.json` write between L153–155; (2) pre-plan `planning` `state.json` before L155, then `flowId` update after `stratum.plan` (L159); (3) per-task heartbeat via `opts.onHeartbeat`; (4) `resumeReady:true` + per-turn checkpoint flush in the while loop (L182); (5) `failed`-flush catch wrapping the dispatch try; (6) state.json fallback in `loadResumeTaskGraph` at L665–670 (only when `decomposedTasks` non-empty); (7) stale-pid takeover in `claimResumeLock` EEXIST branch — `pause.lock` ownership from a holder-written `pause.lock/owner.json`→mtime (NOT `pause.json.pid`, which is the original crashed writer — would always look dead; symmetric with `run.lock/owner.json`); (8) `releaseRunLock` in finally (L233); (9) import `pidAlive` from gsd-state, add `releaseRunLock`. |
| `lib/build.js` | modify | Thread an optional `opts.onHeartbeat` callback into `executeParallelDispatchServer` (sig L2943); invoke it inside the `stratum.onEvent` callback (L2996–3001), next to `stuckDetector.record`. Build-mode passes nothing → no-op. |
| `lib/gsd-supervisor.js` | new | `runGsdHeadless(feature, opts)` — spawn child `compose gsd <feature> [--resume]`, classify exit via terminal state.json status, exponential backoff + per-kind maxAttempts. Spawn/backoff template = `server/supervisor.js:142-169`. |
| `lib/gsd-headless-config.js` | new | `readHeadlessConfig(cwd)` — read+default `gsd.headless.*` from `.compose/compose.json`, validate overrides. (May fold into supervisor; kept separate for unit-testability.) |
| `bin/compose.js` | modify | `gsd query` sub-route at top of gsd block (after L1967, before `gsdCode`); `--headless` flag parse (by L1973); `runGsdHeadless` branch at L2002; usage text (L1982–1987). |
| `test/gsd-state.test.js` | new | state read/write/atomicity + `deriveRunStatus` matrix (running/crashed/failed/stuck/budget/complete/absent). |
| `test/gsd-query-cli.test.js` | new | `spawnSync` CLI snapshot — fixtures for running/crashed/complete/stuck/budget/absent (no `paused` — see D-F). Harness = `test/gates-report-cli.test.js` (NOT a gsd test — see C16). |
| `test/gsd-supervisor.test.js` | new | classify+backoff+maxAttempts; **budget never auto-resumes** unless overridden; failed=non-recoverable. |
| `test/gsd-headless-crash-recovery.test.js` | new | golden flow: stubbed run writes running state.json → kill → resume synthesizes from state.json → completes. Harness = in-process `runGsd` stub pattern from `test/gsd-resume.test.js`. |

---

## Boundary Map

Work units (slices) in dependency order. `pidAlive` lives canonically in `gsd-state.js` (S01) and is imported by `gsd.js` to avoid a circular import (D-C). The contract `decomposedTasks` item `$ref`s the existing `gsd-stuck.json` pause shape — an external, already-shipped dependency, so it is described in prose here rather than as a `from S##` consume.

### S01: gsd-state foundation
Produces:
  lib/gsd-state.js → gsdStatePath, writeGsdState, readGsdState, deriveRunStatus, pidAlive (function)
Consumes: nothing

### S02: state contract
Produces:
  contracts/gsd-state.json → state, query (type)
Consumes: nothing

### S03: build.js heartbeat seam
Produces:
  lib/build.js → executeParallelDispatchServer (function)
Consumes: nothing

### S04: gsd.js runtime wiring
Produces:
  lib/gsd.js → releaseRunLock (function)
Consumes:
  from S01: lib/gsd-state.js → writeGsdState, readGsdState, deriveRunStatus, pidAlive (function)
  from S02: contracts/gsd-state.json → state (type)
  from S03: lib/build.js → executeParallelDispatchServer (function)

### S05: headless config
Produces:
  lib/gsd-headless-config.js → readHeadlessConfig (function)
Consumes: nothing

### S06: supervisor
Produces:
  lib/gsd-supervisor.js → runGsdHeadless (function)
Consumes:
  from S05: lib/gsd-headless-config.js → readHeadlessConfig (function)
  from S01: lib/gsd-state.js → readGsdState, deriveRunStatus, pidAlive (function)

### S07: CLI wiring
Produces: nothing
Consumes:
  from S06: lib/gsd-supervisor.js → runGsdHeadless (function)
  from S01: lib/gsd-state.js → readGsdState, deriveRunStatus (function)
  from S02: contracts/gsd-state.json → query (type)

## Key structural decisions (resolved during verification)

### D-A: scope of the `failed`-flush catch (refines Codex C3)
Codex flagged that dirty-workspace (L98–104), boundary-map (L44–66), and the cumulative-budget early-`return` (L128) all sit **before** the inner `try` (L146), so a naive inner catch wouldn't cover them. **Resolution:** the first `running` `state.json` is the **pre-plan `planning` checkpoint** (Decision 1 flush point 0), written inside the try just after the `run.lock` claim (L153–155), *before* `stratum.plan`. The dividing line is therefore that checkpoint, not `flowId`:
- A throw **before** the planning checkpoint (all preconditions L44–145, and the cumulative-budget early-`return` at L128) → no `running` state.json exists → the supervisor classifier reads exit≠0 + no running-state as **fatal**. No `failed` flush needed.
- A throw **after** the planning checkpoint (during plan/decompose/execute/ship) → `state.json` says `running` → an orderly exception must be converted to `failed` so the supervisor doesn't mistake it for a hard crash.

So the catch wraps the **dispatch try** (L146 → L228) and writes `failed` *iff* a `running` `state.json` was already initialized (guard on `readGsdState()?.status === 'running'`). A true SIGKILL after the checkpoint runs no catch → state stays `running` + dead pid → `crashed` (supervisor then uses `resumeReady` to pick `--resume` vs fresh, D-E). The cumulative-budget early-return (L128) stays a clean pre-dispatch `budget` terminal — `query` reports it via `budget.json` (D-F precedence). Narrower and cleaner than wrapping from L42.

### D-B: `run.lock` placement + provable ownership (refined per Codex review #1)
Atomic `mkdirSync` claim inserted **between L153 and L155** (inside the try, after the resume `pause.lock` claim, before the first side effect `stratum.plan` at L155). Preconditions L44–130 are read-only, so claiming here is correct. Loser gets `EEXIST` → refuse. Released via ownership-guarded `releaseRunLock` (new `runLockClaimed` flag, mirroring `lockClaimed`) at L233.

**Closing the claim→state.json gap (Codex #1):** `flowId` (and thus the first full `state.json`) doesn't exist until *after* `stratum.plan` returns, so a crash in the `mkdir(run.lock)`→`state.json` window would leave a lock with no PID to prove staleness. Fix: **immediately after winning the `mkdir`, write a minimal owner record `run.lock/owner.json {pid, startedAt}`** (the mkdir is the atomic gate; the owner write is best-effort right after). Takeover then keys on: owner pid **dead** ⇒ stale; **or** no `owner.json` **and** lock-dir mtime older than `heartbeatStaleMs` ⇒ stale (covers the sub-millisecond gap before `owner.json` lands). Also write the first `state.json` with `phase:"planning"` **before** `stratum.plan` (pid known, `decomposedTasks:[]`), so even a plan-phase crash yields a dead-pid `state.json` — this doubles as the `resumeReady:false` marker in D-E.

### D-C: `isPidAlive` export + EPERM semantics (Codex C10)
`lib/gsd.js:839 isPidAlive` returns **true** on `EPERM` (alive-but-not-ours) — correct for crash detection. `lib/build.js:438 isProcessAlive` returns **false** on EPERM — wrong for our purpose. **Resolution:** export `isPidAlive` from `lib/gsd.js` and reuse it everywhere (gsd-state, supervisor); do not use `isProcessAlive`. `gsd-state.js` re-exports it as `pidAlive` to avoid a circular import (gsd.js→gsd-state.js→gsd.js): put the canonical impl in `gsd-state.js`, and have `gsd.js` import it from there (one direction only).

### D-D: heartbeat threading
`executeParallelDispatchServer` is shared with build mode, so the heartbeat hook is injected as `opts.onHeartbeat` and called inside the existing `stratum.onEvent` callback (L2996, next to `stuckDetector.record` at L3001). gsd passes `onHeartbeat: () => touchHeartbeat(cwd, feature)`; build passes nothing → zero behavior change for build. Takeover still keys on **dead pid**, never heartbeat staleness alone.

### D-E: crash-bridge in `loadResumeTaskGraph` + `resumeReady` gate (refined per Codex review #2)
At L665–670 (the throw-if-`pause.json`-absent), add: if absent but `readGsdState` returns `status:"running"` with a **dead pid** *and* non-empty `decomposedTasks`, synthesize `{decomposedTasks, completedTaskIds, pid, mode:'gsd'}` from state.json and continue through the existing filtering (L701–712), which needs full enriched task objects — `state.json.decomposedTasks` stores exactly those (mirrors pause.json L586/L773, confirmed full objects, not IDs).

**`resumeReady` gate (Codex #2):** a crash *during* `stratum.plan` or `decompose_gsd` — before the first post-decompose flush — has **no task graph to resume**. `loadResumeTaskGraph` would (correctly) throw on empty `decomposedTasks` (L697), but the **supervisor must not call `--resume` in that case** or it burns a retry on a guaranteed failure. So `state.json` carries `resumeReady: boolean` (true once `decomposedTasks` is flushed post-decompose, i.e. `phase` advanced past `planning`/`decompose`). The supervisor's crash branch (D-C of design Decision 3):
- `resumeReady === true` → re-spawn **`--resume`** (synthesize from state.json).
- `resumeReady === false` (early crash, nothing decomposed/merged yet) → re-spawn **fresh** (no `--resume`); the worktree dispatch hasn't merged anything, so a clean restart is safe. Still bounded by the crash `maxAttempts`.

This makes "crashed" always actionable: resume the work that exists, or cleanly restart work that hadn't begun.

### D-F: `query` status precedence — one vocabulary (refined per Codex review #3)
The `query` derivation must read sources in a fixed precedence so the cumulative-budget refusal (which writes `budget.json` but **no** `state.json`, since it returns pre-dispatch at L128) doesn't get mislabeled `absent`:
1. `state.json` present → `deriveRunStatus(state)` (`running`+dead-pid ⇒ `crashed`; else the persisted terminal `complete|stuck|budget|failed`; `running`+live+stale-heartbeat ⇒ `running`+`heartbeatStale:true`).
2. else `pause.json` present → its `kind` (`stuck`|`budget`).
3. else `budget.json` present (cumulative refusal) → `budget` (with `axis:"cumulative"`).
4. else → `absent` (exit 3).

The single status vocabulary is **`running | crashed | complete | stuck | budget | failed | absent`** — used identically by `query`, the supervisor, and the tests. There is **no** `paused` status (the test fixture is renamed to the real `stuck`/`budget` halts).

---

## Corrections Table

| Spec/Design assumption | Reality (verified) | Resolution |
|---|---|---|
| `failed`-flush catch must wrap from top of `runGsd` (Codex C3) | `running` state.json only exists after L159; pre-L159 throws have no running state | Narrow the catch to the dispatch try (L146–228); flush `failed` only if running-state was initialized (D-A) |
| state.json fallback "same shape `loadResumeTaskGraph` consumes"; design cited `:699-712` | throw-if-absent is at **L665–670**; **L701–712** is the *filtering* (the shape to match), not the throw | Fallback edit at L665–670; replicate enriched-task shape from L701–712 (C6) |
| `isPidAlive` reusable at `:839` | exists at L839 but **not exported**; `build.js:438 isProcessAlive` has **opposite EPERM** semantics | Canonical impl moves to `gsd-state.js`, exported; gsd.js imports it; never use `isProcessAlive` (C10, D-C) |
| gsd CLI-spawn test precedent (design File table) | **no gsd test uses `spawnSync`** — all are in-process `runGsd` | `gsd-query-cli.test.js` mirrors `test/gates-report-cli.test.js`; crash-recovery mirrors `test/gsd-resume.test.js` stub (C16) |
| `decomposedTasks` carries full task objects | confirmed at L586 (stuck) / L773 (budget): `sourceTasks.map(t => ({...t}))` from `ctx.lastTaskGraph.tasks` | state.json mirrors this; source = `ctx.lastTaskGraph` (set L345 / L322) |
| heartbeat hook on the streamWriter | streamWriter is no-op (L274); the live event path is `stratum.onEvent` (L2996) feeding `stuckDetector` | Inject `opts.onHeartbeat`, call at L2996 alongside `stuckDetector.record` (D-D) |
| poll loop at `lib/build.js:3016` | L3016 is the interval constant; the poll loop body is **L3017-3018** | cosmetic; heartbeat comes from the event callback, not the poll loop |
| run.lock "before stratum.plan" | first side effect `stratum.plan` at **L155**, flowId **L159** | claim between L153–155 (D-B) |
| supervisor spawn = "`compose start`/`server/supervisor.js` pattern" | `server/supervisor.js:142-169` = spawn/fork + `on('exit')` backoff + give-up cap | valid template for `runGsdHeadless` |

**Net:** design is structurally sound; the only material refinements are D-A (catch scope — actually simpler than first thought), D-C (pid-liveness helper choice + circular-import-safe placement), and C16 (test precedents). Ready for Phase 5 verification.

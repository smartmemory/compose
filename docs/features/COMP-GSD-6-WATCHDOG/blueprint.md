# COMP-GSD-6-WATCHDOG — Implementation Blueprint

**Status:** BLUEPRINT (Phase 4 — verified vs source 2026-06-03)
**Design:** [design.md](design.md)

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| `lib/gsd-headless-config.js` | edit | `autoResume.hung` + `watchdogPollMs`/`watchdogKillGraceMs`/`watchdogHeartbeatMs` defaults + merge |
| `lib/gsd-state.js` | edit | export `clearGsdPause(cwd, feature)` (rm pause.json, best-effort) |
| `lib/gsd.js` | edit | independent wall-clock heartbeat timer (Decision 5) |
| `lib/gsd-supervisor.js` | edit | race exit vs `watch`; `defaultWatch` (confirm-poll), `defaultKillChild`; clear pause.json + classify `hung` |
| `test/gsd-headless-config.test.js` | edit | new defaults + override merge |
| `test/gsd-supervisor.test.js` | edit | hung-path (inject `watch`/`killChild`), exit-path unchanged, confirm-poll, cap exhaustion |
| `test/gsd-watchdog.test.js` | new | `defaultWatch` confirm-poll logic + `defaultKillChild` SIGTERM→grace→SIGKILL (injected `sleep`/`isAlive`/`kill`) |

## Verified anchors

### `lib/gsd-headless-config.js` — config
- `HEADLESS_DEFAULTS` (`:14-22`): add `hung: { enabled: true, maxAttempts: 3 }` to `autoResume`, and
  top-level `watchdogPollMs: 15000`, `watchdogKillGraceMs: 5000`, `watchdogHeartbeatMs: 30000`.
- `resolveHeadlessConfig` (`:41-59`): add `hung: mergeKind(ar.hung, d.autoResume.hung)` and three
  `num(h.watchdog*Ms, d.watchdog*Ms)` lines. `mergeKind`/`num` already exist.

### `lib/gsd.js` — Decision 5 heartbeat timer
- `stepCtx.runState` is created at `:205-212`; `flushState(stepCtx, {})` writes the planning
  checkpoint at `:213`. **Start the timer immediately after `:213`** (runState exists + first flush
  done):
  ```js
  // outer scope, alongside runLockClaimed/lockClaimed/stepCtx:
  let heartbeatTimer = null;
  // after flushState(stepCtx, {}) at :213
  const hbMs = readHeadlessConfig(cwd).watchdogHeartbeatMs;
  heartbeatTimer = setInterval(() => {
    try { if (stepCtx?.runState) flushState(stepCtx, {}); } catch { /* best-effort */ }
  }, hbMs);
  heartbeatTimer.unref?.();
  ```
- Clear in the existing `finally` (`:323`): `if (heartbeatTimer) clearInterval(heartbeatTimer);`
- `flushState(ctx, {})` (`:712` region) is the same empty-patch restamp `onHeartbeat` already uses —
  behavior-compatible. `writeGsdState` is atomic (tmp+rename); single-threaded JS ⇒ no torn writes
  between the timer tick and a main-path flush. `readHeadlessConfig` already imported? No — **add the
  import** from `./gsd-headless-config.js` (currently only the supervisor imports it).

### `lib/gsd-state.js` — Decision 6 helper
- Add `export function clearGsdPause(cwd, featureCode)` next to `gsdStatePath` (`:22`): build
  `join(gsdDir(cwd, featureCode), 'pause.json')`, `if (existsSync) rmSync(..., {force:true})`
  best-effort. (`gsdDir` already private here at `:18`; `rmSync` import needed — add to the
  `node:fs` import at `:13`.)

### `lib/gsd-supervisor.js` — the race + watch + kill
- Loop body `:102-126`. Replace the single `await spawnRun(...)` (`:105`) + classify (`:110-111`):
  ```js
  const exitP = spawnRun({ feature, resume: mode === 'resume', cwd, attempt });
  let snap, outcome, exit;
  const wd = cfg.autoResume.hung;
  if (wd && wd.enabled) {
    const ac = new AbortController();
    const watchP = watch({ feature, cwd, cfg, signal: ac.signal, sleep, buildQuery });
    const raced = await Promise.race([
      exitP.then((e) => ({ type: 'exit', exit: e })),
      watchP.then((s) => (s ? { type: 'hung', snap: s } : { type: 'idle' })),
    ]);
    if (raced.type === 'hung') {
      log(`watchdog: hung run (heartbeat frozen, pid ${raced.snap.pid}) — killing`);
      await killChild(raced.snap.pid, cfg);
      exit = await exitP;                 // reap the killed child
      clearGsdPause(cwd, feature);        // Decision 6: crash-bridge uses current state.json
      const m = raced.snap.resumeReady ? 'resume' : 'fresh';
      outcome = retryDecision('hung', 'hung', m, cfg, counts);
      snap = raced.snap;
    } else {
      ac.abort();
      exit = raced.exit;
      snap = buildGsdQuery(cwd, feature, { staleMs: cfg.heartbeatStaleMs });
      outcome = classifyOutcome(snap.status, snap, cfg, counts);
    }
  } else {
    exit = await exitP;                   // watchdog off ⇒ today's byte-identical path
    snap = buildGsdQuery(cwd, feature, { staleMs: cfg.heartbeatStaleMs });
    outcome = classifyOutcome(snap.status, snap, cfg, counts);
  }
  ```
- `counts` (`:97`) gains `hung: 0`.
- `defaultWatch({ feature, cwd, cfg, signal, sleep, buildQuery })` — **confirm-poll**:
  ```js
  let prevHb = null;
  while (!signal.aborted) {
    await sleep(cfg.watchdogPollMs);
    if (signal.aborted) return null;
    const s = buildQuery(cwd, feature, { staleMs: cfg.heartbeatStaleMs });
    if (s.status === 'running' && s.heartbeatStale) {
      if (prevHb !== null && s.heartbeatAt === prevHb) return s; // frozen across 2 polls → hung
      prevHb = s.heartbeatAt;
    } else {
      prevHb = null; // healthy / advanced → reset confirmation
    }
  }
  return null;
  ```
  Injectable `buildQuery` defaults to `buildGsdQuery`; `sleep` reuses the loop's `sleep`.
- `defaultKillChild(pid, cfg, { sleep, isAlive, kill } = {})`:
  ```js
  if (!pid) return;
  const k = kill ?? process.kill.bind(process);
  try { k(pid, 'SIGTERM'); } catch { /* gone */ }
  await (sleep ?? defaultSleep)(cfg.watchdogKillGraceMs);
  if ((isAlive ?? pidAlive)(pid)) { try { k(pid, 'SIGKILL'); } catch { /* gone */ } }
  ```
- Imports: add `pidAlive`, `clearGsdPause` from `./gsd-state.js`. `opts.watch`/`opts.killChild`
  injectable (default the two functions). `retryDecision` is already module-internal (`:55`) — the
  `hung` branch calls it directly; `'hung'` cap exhaustion returns terminal `hung`/not-ok (Open Q1 ✓).
- History entry (`:112`) unchanged shape; `derived: 'hung'` on the hung branch.

## Boundary Map

- **`clearGsdPause(cwd, featureCode)`** — function, `lib/gsd-state.js`. Producer. rm pause.json.
  Consumed by `gsd-supervisor` hung branch (from S-impl).
- **`resolveHeadlessConfig(raw)`** — function, `lib/gsd-headless-config.js` (existing, extended). Adds
  `autoResume.hung`, `watchdog{Poll,KillGrace,Heartbeat}Ms`. Consumed by supervisor + `gsd.js` timer.
- **`defaultWatch({feature,cwd,cfg,signal,sleep,buildQuery})`** — function, `lib/gsd-supervisor.js`.
  Resolves the hung snapshot or null. Consumed by `runGsdHeadless` (same file).
- **`defaultKillChild(pid,cfg,deps)`** — function, `lib/gsd-supervisor.js`. SIGTERM→grace→SIGKILL.
- **`runGsdHeadless(feature,opts)`** — function (existing). `opts.watch`/`opts.killChild` new seams.

## Corrections Table

| # | Assumption | Reality | Resolution |
|---|------------|---------|------------|
| C1 | `heartbeatStale` ⇒ hung | Advisory only; event-driven heartbeat (`gsd.js:~376`) → quiet healthy task looks stale | Decision 5 timer + Decision 1 confirm-poll |
| C2 | hung-kill resumes via crash-bridge | `loadResumeTaskGraph` prefers pause.json (`gsd.js:~896`) | Decision 6 `clearGsdPause` on hung-kill |
| C3 | supervisor holds child handle to kill | `defaultSpawnRun` discards it (`:80`) | kill by pid via `process.kill` (`defaultKillChild`) |
| C4 | `clearPauseFile` reusable | internal to gsd.js (`:1154`), not exported | new `clearGsdPause` in gsd-state.js (low coupling) |

## Verification Table (Phase 5)

| Anchor | Claim | Status |
|--------|-------|--------|
| `gsd-supervisor.js:102-126` | loop: spawn→await→classify→backoff | ✅ |
| `gsd-supervisor.js:55-65` | `retryDecision(policyKey,...)` reusable for `hung` | ✅ |
| `gsd-supervisor.js:70-83` | `defaultSpawnRun` returns `{code,signal}`, no handle | ✅ |
| `gsd-state.js:75-86` | `deriveRunStatus` → `{status,heartbeatStale}`; running+stale only when pid alive | ✅ |
| `gsd-state.js:93-142` | `buildGsdQuery` surfaces `heartbeatStale` + `heartbeatAt` + `pid` + `resumeReady` | ✅ |
| `gsd-state.js:30-38` | `pidAlive` EPERM=alive | ✅ |
| `gsd-headless-config.js:14-59` | `HEADLESS_DEFAULTS` + `resolveHeadlessConfig` merge shape | ✅ |
| `gsd.js:205-213` | runState created + first `flushState` (timer start point) | ✅ |
| `gsd.js:323` | `finally` (timer clear point) | ✅ |
| `gsd.js:896` | `loadResumeTaskGraph` prefers pause.json over state crash-bridge | ✅ (Codex-confirmed) |

All anchors verified.

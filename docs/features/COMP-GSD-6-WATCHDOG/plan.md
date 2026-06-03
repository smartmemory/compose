# COMP-GSD-6-WATCHDOG — Plan

**Status:** PLAN (Phase 6) · **Blueprint:** [blueprint.md](blueprint.md)

TDD per slice. Order: W1 → W2 → W3 → W4 (config/helpers first, then timer, then the supervisor race).

## W1: headless config defaults (`lib/gsd-headless-config.js`)
- [ ] `HEADLESS_DEFAULTS.autoResume.hung = { enabled: true, maxAttempts: 3 }`
- [ ] `watchdogPollMs: 15000`, `watchdogKillGraceMs: 5000`, `watchdogHeartbeatMs: 30000`
- [ ] `resolveHeadlessConfig` merges `hung` + the three numeric fields (reuse `mergeKind`/`num`)
- **Test** (`test/gsd-headless-config.test.js`): defaults present; user override merges; malformed → default.

## W2: pause clear helper (`lib/gsd-state.js`)
- [ ] `export function clearGsdPause(cwd, featureCode)` — best-effort rm `.compose/gsd/<f>/pause.json`
- **Test** (`test/gsd-watchdog.test.js`): clears an existing pause.json; no-throw when absent.

## W3: child heartbeat timer (`lib/gsd.js`)
- [ ] outer-scope `let heartbeatTimer = null`; start after the planning-checkpoint `flushState` (`:213`) using `readHeadlessConfig(cwd).watchdogHeartbeatMs`; `.unref()`; clear in `finally` (`:323`)
- [ ] add `readHeadlessConfig` import
- **Test:** assert `runGsd` starts and clears an interval — verified indirectly (config import + the supervisor suite exercising real children is heavy); cover the timer wiring via a focused check that the interval restamps `state.json.heartbeatAt` (use a fake clock / short interval) OR keep it minimal and rely on the supervisor integration. Pragmatic: a unit that the timer callback (extracted as a tiny `makeHeartbeatTick(ctx)` or inline) restamps. Keep light.

## W4: supervisor watchdog (`lib/gsd-supervisor.js`)
- [ ] `counts.hung = 0`; `opts.watch`/`opts.killChild` seams (default `defaultWatch`/`defaultKillChild`)
- [ ] `defaultWatch` confirm-poll (two consecutive stale polls with unchanged `heartbeatAt`)
- [ ] `defaultKillChild` SIGTERM → `watchdogKillGraceMs` → SIGKILL if `pidAlive`
- [ ] loop body: race `exitP` vs `watch`; hung → `killChild` + reap + `clearGsdPause` + `retryDecision('hung',...)`; exit → today's path; watchdog-off → byte-identical `await spawnRun`
- [ ] imports `pidAlive`, `clearGsdPause`
- **Tests** (`test/gsd-supervisor.test.js` + `test/gsd-watchdog.test.js`):
  - hung → kill (killChild called w/ pid) → resume (next spawn `--resume` when resumeReady) → complete
  - hung cap exhaustion → terminal `hung` not-ok
  - exit-path tests unchanged (existing suite green)
  - `defaultWatch`: frozen heartbeat across 2 polls → hung; advanced heartbeat → no kill (suspend/clock-jump); abort → null
  - `defaultKillChild`: SIGTERM then SIGKILL after grace when still alive; no SIGKILL when dead after grace

## W5: review + docs + ship
- Codex impl review loop → CLEAN; full suite; CHANGELOG/ROADMAP/feature.json COMPLETE; report.md; journal; commit.

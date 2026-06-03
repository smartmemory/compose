# COMP-GSD-6-WATCHDOG — Hung-Child Watchdog: Design

**Status:** DESIGN (Phase 1 — intent, not yet implemented)
**Date:** 2026-06-03
**Parent:** COMP-GSD · **Depends on:** COMP-GSD-6 (headless supervisor + state.json heartbeat)

## Problem

The `--headless` supervisor (`lib/gsd-supervisor.js`) recovers a GSD run from **exit**: it
`await spawnRun(...)` (blocks until the child process exits), then classifies the terminal
`state.json` status and re-spawns. A child that **hangs** — wedged in a syscall, deadlocked, or
spinning without progress — never exits, so the supervisor blocks forever. `deriveRunStatus`
already computes a `heartbeatStale` advisory (live pid + `heartbeatAt` older than
`heartbeatStaleMs`, default 90s), but nothing acts on it.

## Goal

Give the supervisor a watchdog that, **while a child runs**, watches the child's `state.json`
heartbeat; when it goes stale on a still-alive pid, the watchdog kills the child and lets the
existing recovery loop resume it. Off-by-config, on-by-default, consistent with crash/stuck recovery.

**Non-goals:** no in-child progress tracking (the watchdog is purely external, heartbeat-based);
no change to non-headless `compose gsd` (the heartbeat already exists; only the supervisor gains
the watcher); no distinction between "deadlocked" and "slow" beyond the existing `heartbeatStaleMs`
threshold.

## Decision 1: Race child-exit against a heartbeat poll

The supervisor's blocking `await spawnRun()` becomes a race. Each attempt:

```
exitP = spawnRun(...)                       // resolves on child exit (unchanged contract)
watchP = watch({feature, cwd, cfg, signal}) // resolves with the hung snapshot, or never (aborted)
raced = await Promise.race([exitP→{exit}, watchP→{hung,snap}])
  hung  → killChild(snap.pid); await exitP (reap); clear pause.json; classify as 'hung'
  exit  → ac.abort() (stop watcher); buildGsdQuery + classifyOutcome (today's path)
```

`watch` is a poll loop: every `watchdogPollMs`, `buildGsdQuery(cwd, feature, {staleMs})`. It declares
hung only on **two consecutive confirming polls** — `status === 'running' && heartbeatStale` AND
`heartbeatAt` **unchanged** since the prior stale poll. Any healthy/fresh poll, or an *advanced*
`heartbeatAt`, resets the confirmation. An `AbortSignal` ends the loop when the child exits first.

Two reasons for the confirm-poll rather than "one stale observation":
- It depends on Decision 5 (the child's wall-clock heartbeat timer) to make `heartbeatStale` a sound
  signal at all — without it, quiet-but-healthy tasks look stale.
- **(Codex gate) host suspend / forward clock jump:** during machine sleep both the child timer and
  the supervisor freeze; on wake `now - heartbeatAt` can momentarily exceed `staleMs` before the
  child's next timer tick refreshes `state.json`. A single stale reading would false-kill. Requiring
  the heartbeat to stay *frozen at the same `heartbeatAt`* across two polls lets a just-woken healthy
  child advance its heartbeat and clear the alarm; only a truly wedged child keeps it identical.
Worst-case detection latency ≈ `staleMs` + `2 × watchdogPollMs` — acceptable for an unattended run.

Rejected: a separate watchdog *process*. Over-engineered — the supervisor is already the long-lived
owner of the child and can poll the child's `state.json` directly.

## Decision 5 (CRITICAL — Codex design gate): independent wall-clock heartbeat timer

**Problem the gate surfaced:** today the GSD-6 design treats `heartbeatStale` as *advisory only*,
precisely because the heartbeat **only advances on accepted agent push-events**
(`gsd.js` `onHeartbeat` → `build.js:~2963`). A genuinely-healthy task that is quiet for >90s (a long
compile, a long test run, an agent thinking without emitting tool events) would go stale and be
**false-killed**. Stale-heartbeat is NOT currently evidence of a hang.

**Fix:** the gsd child runs an **independent wall-clock heartbeat timer** — a `setInterval`
(unref'd, cleared in `finally`) that flushes `state.json`'s heartbeat every `watchdogHeartbeatMs`
(default 30s, must be `< heartbeatStaleMs`) regardless of task events. This changes the semantics of
a stale heartbeat into a real signal:

- Event loop **turning** (awaiting a long subprocess / network / poll) → the timer fires → heartbeat
  fresh → **not killed**. This is the healthy-but-quiet case the GSD-6 note worried about.
- Event loop **wedged** (sync deadlock, blocked main thread) or process dead → the timer can't fire →
  heartbeat goes stale → **correctly detected as hung**.

So the timer is what makes `heartbeatStale && pidAlive` a trustworthy "the run is wedged" verdict.
It reuses the existing `flushState(ctx, {})` (the same empty-patch restamp `onHeartbeat` uses), so
it's behavior-compatible; `.unref()` keeps it from holding the process open. Dead-pid remains the
sole *crash* signal — the timer only sharpens the *hang* signal.

## Decision 6 (Codex design gate): clear `pause.json` on hung-kill so the crash-bridge wins

A hung kill leaves `state.json` `status:"running"` + dead pid (the crash signature), but
`loadResumeTaskGraph` (`gsd.js:~896`) prefers `pause.json` and only synthesizes from `state.json`
when `pause.json` is **absent** — and a fresh run clears only `state.json`, not `pause.json`. So a
**stale `pause.json`** from an earlier stuck/budget halt (consumed by an intervening `--resume` but
never cleared) would shadow the killed run's current `state.json`, re-dispatching the wrong task
set. **Fix:** the supervisor clears `pause.json` immediately after killing+reaping a hung child, so
the hung `--resume` recovers from the current `state.json` via the crash-bridge. (The existing
`crashed` path shares this latent precedence issue against a stale `pause.json`; it's GSD-6's
accepted behavior and out of scope here — noted as a follow-up.)

## Decision 2: Kill is pid-based (SIGTERM → grace → SIGKILL)

`defaultSpawnRun` discards the child handle after registering the exit listener, so the supervisor
kills by **pid** (from the snapshot): `process.kill(pid, 'SIGTERM')`, wait `watchdogKillGraceMs`
(default 5s), then `process.kill(pid, 'SIGKILL')` if `pidAlive(pid)`. The killed child exits →
`exitP` resolves → we reap it before resuming. (`pidAlive` is the canonical EPERM=alive probe from
`gsd-state.js`.)

## Decision 3: `hung` is a new recovery kind, mechanically identical to `crash`

A hung kill leaves `state.json` `status:"running"` + a now-dead pid — exactly the crash signature.
So resume reuses the crash path: `mode = snap.resumeReady ? 'resume' : 'fresh'`; the next
`compose gsd --resume` child recovers via `loadResumeTaskGraph`'s crash-bridge (running + dead-pid +
`decomposedTasks` → synthesized resume graph). The classification just gets its own policy key so
caps/telemetry are separate from real crashes:

- `autoResume.hung = { enabled: true, maxAttempts: 3 }` in `HEADLESS_DEFAULTS`.
- Resolved through the existing `retryDecision('hung', 'hung', mode, cfg, counts)`.

## Decision 4: Default-on, fully configurable

New `gsd.headless.*` fields (merged in `resolveHeadlessConfig`):
- `autoResume.hung: { enabled: true, maxAttempts: 3 }`
- `watchdogPollMs: 15000`
- `watchdogKillGraceMs: 5000`
- `watchdogHeartbeatMs: 30000` (child timer cadence; must be `< heartbeatStaleMs`)

When `autoResume.hung.enabled === false`, the watcher is never started — the race degrades to
today's plain `await spawnRun()` (byte-identical supervisor behavior). `heartbeatStaleMs` (existing,
90s) is the staleness threshold, shared with `buildGsdQuery`. The child heartbeat timer (Decision 5)
runs whenever `runState` exists, independent of the headless flag (harmless for non-headless gsd —
just keeps `gsd query`'s heartbeat fresh).

## Files

| File | Action | Purpose |
|------|--------|---------|
| `lib/gsd.js` | edit | **independent wall-clock heartbeat timer** (Decision 5): `setInterval`/`flushState({})`, unref'd, cleared in `finally` |
| `lib/gsd-supervisor.js` | edit | race exit vs `watch`; `defaultWatch`, `defaultKillChild`; clear `pause.json` on hung-kill; `hung` classification |
| `lib/gsd-headless-config.js` | edit | `autoResume.hung`, `watchdogPollMs`, `watchdogKillGraceMs`, `watchdogHeartbeatMs` defaults + merge |
| `test/gsd-supervisor.test.js` | edit | hung-path tests (inject `watch`/`killChild`); confirm exit-path unchanged |
| `test/gsd-headless-config.test.js` | edit | new defaults + overrides |
| `test/gsd-state.test.js` or `test/gsd-runner.test.js` | edit | heartbeat-timer fires + is cleared |

## Open Questions

1. **Should a hung run that exhausts `maxAttempts` be `failed` or `aborted`?** Proposed: terminal
   `hung` (not ok) via `retryDecision`'s `capExhausted` path — same as stuck/crash exhaustion.
   (Resolve in blueprint; default = reuse `retryDecision` verbatim.)
2. **Watcher poll vs `heartbeatStaleMs`.** Poll (15s) is finer than the 90s threshold, so detection
   latency ≤ ~90s + one poll. Acceptable; documented.
3. **Heartbeat-timer placement in `runGsd`.** Must start once `ctx.runState` exists (post initial
   flush) and clear in the existing `finally`. Confirm it can't fire with a half-built `runState`
   (resolve in blueprint by anchoring the start point after the first `flushState`).

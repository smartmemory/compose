---
date: 2026-06-03
session_number: 51
slug: gsd-6-watchdog
summary: "COMP-GSD-6-WATCHDOG: hung-child detection for the headless supervisor"
feature_code: COMP-GSD-6-WATCHDOG
closing_line: A watchdog is only as honest as the heartbeat it watches — so first we made the heartbeat tell the truth.
---

# Session 51 — COMP-GSD-6-WATCHDOG

**Date:** 2026-06-03
**Feature:** `COMP-GSD-6-WATCHDOG`

## What happened

First of two back-to-back follow-ups the human asked for in full-auto. The headless GSD supervisor (`runGsdHeadless`) recovers a run from *exit* — it blocks on `await spawnRun()` and classifies the terminal state. A child that *hangs* never exits, so the supervisor waits forever. COMP-GSD-6 had already computed a `heartbeatStale` advisory but nothing acted on it; this feature makes the supervisor act.

The design looked simple — poll the child's state.json, kill on stale heartbeat, resume. The Codex design gate dismantled that in one pass: `heartbeatStale` is **advisory on purpose**, because GSD-6 deliberately made dead-pid the sole crash signal — the heartbeat only advances on agent push-events, so a quiet-but-healthy task (a long compile, an agent thinking without tool calls) would exceed 90s and get **false-killed**. The naive watchdog was a child-killer.

The fix reframed the feature: add an **independent wall-clock heartbeat timer** to the child. A `setInterval` fires whenever the event loop is turning (including during healthy async waits on subprocesses/network) but stops when the loop is actually wedged. That makes a *frozen* heartbeat a sound 'this run is stuck' verdict. The same gate also caught that a stale `pause.json` would shadow the crash-bridge on resume, and a third pass caught that host suspend / clock jumps could momentarily look stale — fixed with a two-confirming-poll rule (heartbeat frozen at the same value across two polls). Then the impl gate caught three more: a ref'd poll timer holding the process open after a clean exit, an unenforced `hb<stale` invariant, and a non-byte-identical disabled path; a follow-up caught `heartbeatStaleMs:0` defeating the clamp. Seven Codex findings total, all real, none caught by tests first.

## What we built

- `lib/gsd.js` — independent wall-clock heartbeat `setInterval` (unref'd, cleared in finally), gated on `GSD_HEADLESS_ATTEMPT` so only supervised children pay for it and interactive runs are byte-identical.
- `lib/gsd-supervisor.js` — each attempt races `exitP` vs `watch`. `defaultWatch` confirm-polls (two consecutive stale polls, unchanged `heartbeatAt`) with an abort-aware unref'd sleep. `defaultKillChild` kills by pid (SIGTERM→`watchdogKillGraceMs`→SIGKILL). Hung → kill + reap + `clearGsdPause` + `retryDecision('hung', …)`; watchdog-off → plain `await spawnRun`.
- `lib/gsd-headless-config.js` — `autoResume.hung {enabled:true,maxAttempts:3}` + `watchdogPollMs`/`watchdogKillGraceMs`/`watchdogHeartbeatMs`, with the `watchdogHeartbeatMs < heartbeatStaleMs` invariant enforced (degenerate stale → default, then clamp to floor(stale/2)).
- `lib/gsd-state.js` — exported `clearGsdPause`.
- Tests: `test/gsd-watchdog.test.js` (11), `test/gsd-supervisor.test.js` (+4 hung-path), `test/gsd-headless-config.test.js` (+4). Full suite 3201/3201.

## What we learned

1. **A watchdog is only as good as its liveness signal.** The whole feature hinged on a fact the design gate surfaced: `heartbeatStale` was never meant as a hang verdict. The independent timer is the real feature; the kill+resume plumbing is the easy part.
2. **An event-loop timer is a perfect wedge detector.** A `setInterval` distinguishes 'healthy but waiting on async work' (timer fires) from 'main thread blocked / process dead' (timer can't fire) — exactly the line a hang watchdog needs, and it falls out of Node's model for free.
3. **Confirm before you kill.** A single stale reading is fragile against host suspend and clock jumps; requiring the heartbeat to stay *frozen at the same value* across two polls costs one poll of latency and removes a whole class of false-kills.
4. **'Off' must mean off.** The impl gate's byte-identical finding mattered: gating the timer on `GSD_HEADLESS_ATTEMPT` means a user who never opted into headless supervision sees zero behavior change.
5. **Clamp invariants at the source.** Documenting `hb < stale` wasn't enough — `resolveHeadlessConfig` now enforces it (including the `0` corner), so no downstream code has to trust the config.

## Open threads

- [ ] The existing `crashed` recovery path shares the same latent stale-`pause.json` precedence issue this feature fixes for `hung` — out of scope (GSD-6 accepted behavior), possible follow-up.
- [ ] No full real-spawn E2E (kill a genuinely-hung `compose gsd` child, observe resume); the loop, `defaultWatch`, and `defaultKillChild` are unit-tested with injected seams.
- [ ] Next: COMP-GSD-7-EVENTLOG (the second of the two requested follow-ups).

---

*A watchdog is only as honest as the heartbeat it watches — so first we made the heartbeat tell the truth.*

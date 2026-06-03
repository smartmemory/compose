# COMP-GSD-6-WATCHDOG — Implementation Report

**Status:** COMPLETE · **Date:** 2026-06-03

## Summary

The headless GSD supervisor now detects a **hung** child — one whose `state.json` heartbeat freezes
while its pid is still alive — and kills + resumes it. Previously the supervisor only reacted to a
child *exiting*, so a wedged child blocked it forever. Off-by-config, on-by-default, resumes like a
crash.

## Delivered vs Planned

| Planned | Delivered | Notes |
|---|---|---|
| W1 config (`hung` + watchdog timings) | ✅ `lib/gsd-headless-config.js` | + invariant clamp (review) |
| W2 `clearGsdPause` | ✅ `lib/gsd-state.js` | |
| W3 child heartbeat timer | ✅ `lib/gsd.js` | gated to supervised children (review) |
| W4 supervisor race/watch/kill | ✅ `lib/gsd-supervisor.js` | `defaultWatch` confirm-poll, `defaultKillChild` |
| W5 review/docs/ship | ✅ | this report + below |

## Key Decisions

1. **Independent wall-clock heartbeat (the load-bearing fix).** The pre-existing heartbeat only
   advanced on agent push-events, so a quiet-but-healthy task looked stale — `heartbeatStale` was
   advisory, not a hang verdict. A `setInterval` (unref'd, cleared in `finally`) restamps the
   heartbeat whenever the event loop is turning, so a *frozen* heartbeat now genuinely means the
   loop is wedged (or the process dead). Gated on `GSD_HEADLESS_ATTEMPT` → interactive runs are
   byte-identical.
2. **Confirm-poll, not single-shot.** `defaultWatch` declares hung only after two consecutive stale
   polls with an unchanged `heartbeatAt` — surviving host suspend / forward clock jumps (a just-woken
   healthy child advances its heartbeat and clears the alarm).
3. **Kill by pid.** The supervisor doesn't hold the child handle (`defaultSpawnRun` discards it), so
   `defaultKillChild` is pid-based: SIGTERM → `watchdogKillGraceMs` → SIGKILL if still alive.
4. **`hung` resumes like `crash`.** A hung kill leaves the crash signature (running + dead pid);
   `clearGsdPause` ensures `loadResumeTaskGraph`'s crash-bridge recovers from the current
   `state.json` rather than a stale `pause.json`. New `autoResume.hung` policy for separate caps.

## Test Coverage

- `test/gsd-watchdog.test.js` (11) — `defaultWatch` confirm-poll (frozen→hung, advancing→safe,
  reset, abort), `defaultKillChild` (SIGTERM→SIGKILL, grace-death, no-pid, ESRCH), `clearGsdPause`.
- `test/gsd-supervisor.test.js` (+4) — hung→kill→resume→complete, pause.json cleared, cap
  exhaustion, watchdog-disabled byte-identical. Existing exit-path tests unchanged (via an idle
  injected watch).
- `test/gsd-headless-config.test.js` (+4) — `hung` defaults/overrides, `hb<stale` clamp incl. the
  degenerate-zero case.
- Full suite **3201/3201**.

## Files Changed

| File | Action |
|---|---|
| `lib/gsd-headless-config.js` | `autoResume.hung` + watchdog timings + invariant clamp |
| `lib/gsd-state.js` | exported `clearGsdPause` |
| `lib/gsd.js` | independent heartbeat timer (supervised-gated) |
| `lib/gsd-supervisor.js` | race + `defaultWatch` + `defaultKillChild` + `hung` classification |
| 3 × `test/gsd-*.test.js` | 19 tests |

## Known Issues & Tech Debt

- The existing `crashed` path shares the same latent `pause.json`-precedence issue this feature
  fixes for `hung` (a stale `pause.json` could shadow a crash's `state.json` crash-bridge). Out of
  scope here (GSD-6's accepted behavior); noted as a possible follow-up.
- A full real-spawn E2E (kill a genuinely-hung `compose gsd` child and observe resume) is not
  covered — the supervisor loop, `defaultWatch`, and `defaultKillChild` are unit-tested with injected
  seams; the real heartbeat-timer ↔ watchdog interaction is verified by construction + Codex review.

## Lessons Learned

- The Codex design gate caught the feature's central flaw before any code: `heartbeatStale` was
  never a sound hang signal. The fix (an independent timer) is what makes the whole feature correct —
  it would have shipped as a child-killer otherwise.
- The Codex implementation gate then caught three runtime issues no unit test surfaced: a ref'd poll
  timer holding the process open, an unenforced timing invariant, and a non-byte-identical disabled
  path — plus the `heartbeatStaleMs:0` corner on the follow-up.

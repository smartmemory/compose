# COMP-GSD-6 — Headless CLI + Crash Recovery: Implementation Report

**Status:** REPORT
**Date:** 2026-06-03
**Feature:** `COMP-GSD-6`

## Summary

`compose gsd` can now run **unattended** and be **observed from outside the process**. Three capabilities landed: a continuously-flushed `state.json` checkpoint that makes a hard crash recoverable, a `compose gsd query` instant JSON snapshot for status pollers, and a `--headless` supervisor that auto-resumes crashes/stuck-halts with backoff under a per-pause-kind policy. Two pre-existing gaps were closed along the way: live-run concurrency exclusion (`run.lock`) and the explicitly-deferred stale `pause.lock` takeover (`gsd.js:728-732`).

## Delivered vs Planned

| Planned (blueprint slice) | Delivered | Notes |
|---|---|---|
| S01 `lib/gsd-state.js` | ✅ | `gsdStatePath`/`writeGsdState`/`readGsdState`/`deriveRunStatus`/`pidAlive` + `buildGsdQuery` (query precedence) |
| S02 `contracts/gsd-state.json` | ✅ | `state` + `query` definitions; ajv-valid; closed status vocabulary |
| S03 `lib/build.js` heartbeat seam | ✅ | opt-in `opts.onHeartbeat` in `executeParallelDispatchServer`; build mode byte-identical |
| S04 `lib/gsd.js` runtime wiring | ✅ | run.lock + owner.json, state flushes, failed-catch, crash-bridge, stale-lock takeover |
| S05 `lib/gsd-headless-config.js` | ✅ | per-kind auto-resume policy + backoff; every field overridable |
| S06 `lib/gsd-supervisor.js` | ✅ | `runGsdHeadless` loop + pure `classifyOutcome`; budget-never-resume default |
| S07 `bin/compose.js` | ✅ | `gsd query` sub-route + `--headless` dispatch |

## Architecture Deviations

- **`--headless` ≠ prompt suppression.** The spec implied suppressing interactive prompts, but `gsd` was already non-interactive — so `--headless` became *supervised auto-resume*, not prompt handling. Documented in design's reality-corrections table.
- **`state.json` is standalone, not "an extension of the journal."** gsd never journaled; there was nothing to extend. `state.json` is a new continuously-flushed checkpoint (still plain JSON, no SQLite — honoring the spec's constraint).
- **`pidAlive` moved canonical to `gsd-state.js`** (EPERM=alive) to keep the `gsd.js`↔`gsd-state.js` dependency one-directional; `gsd.js`'s old local copy was removed. `build.js`'s `isProcessAlive` (EPERM=dead) was deliberately *not* reused for crash detection.

## Key Implementation Decisions

1. **Pre-plan `planning` checkpoint as the failed-vs-fatal boundary.** A throw before it leaves no running state → the supervisor reads `absent` → fatal. A throw after it → the dispatch-try catch writes `failed`. A true SIGKILL after it → `running`+dead-pid → `crashed`. Fresh runs clear any prior `state.json` up front so a stale `complete` can't masquerade as success.
2. **Two locks, both with holder-written `owner.json`.** `run.lock` gives live-run exclusivity (claimed before `stratum.plan`); `pause.lock` is the existing resume claim. Stale takeover keys on the lock-local `owner.json` pid (NOT `pause.json.pid`, the original crashed writer) and uses an **atomic rename-aside** (`takeoverStaleLock`) so two reclaimers can't delete each other's fresh lock.
3. **`resumeReady` gates `--resume` vs fresh restart.** A crash after decompose → `--resume` (synthesize from `state.json` when `pause.json` is absent). A crash during plan/decompose → fresh restart (nothing merged yet).
4. **Per-pause-kind policy, budget opt-in.** Defaults: crash✓ + bounded-stuck✓ + budget✗ (protects the GSD-4 ceiling); every field overridable via `gsd.headless.*`.
5. **One status vocabulary** (`running|crashed|complete|stuck|budget|failed|absent`) shared by `query`, the supervisor, and the contract; non-complete terminals (incl. stratum `killed`) normalize to `failed`.

## Test Coverage

48 new tests (3110 → 3158 in the `node --test` suite, 0 fail):
- `test/gsd-state.test.js` (14) — I/O atomicity + `deriveRunStatus` matrix (crashed/stale/terminal).
- `test/gsd-crash-recovery.test.js` (9) — run.lock exclusion/takeover, crash-bridge, fresh-run stale-state clear, resume-preserves-state.
- `test/gsd-headless-config.test.js` (5) — policy defaults/overrides/malformed-fallback + backoff.
- `test/gsd-supervisor.test.js` (12) — classify + loop: crash→resume, crash-pre-decompose→fresh, budget-never-resume (+opt-in), stuck cap, failed/fatal, stale-complete-not-false-success, budget.json precedence.
- `test/gsd-query-cli.test.js` (6) — real CLI spawn: absent/running/crashed/complete/pause/budget.
- `test/gsd-resume.test.js` (+1) — killed→failed normalization.

**Codex review:** design gate (2 rounds → CLEAN), blueprint gate (coherence loop → CLEAN), implementation review (3 rounds: stale-state/lock-race/killed + supervisor-budget + killed-coverage → CLEAN).

## Files Changed

| File | Action |
|---|---|
| `lib/gsd-state.js` | new |
| `contracts/gsd-state.json` | new |
| `lib/gsd-headless-config.js` | new |
| `lib/gsd-supervisor.js` | new |
| `lib/gsd.js` | modified (run.lock, state flushes, failed-catch, crash-bridge, stale-lock takeover, pidAlive import) |
| `lib/build.js` | modified (`opts.onHeartbeat`) |
| `bin/compose.js` | modified (`gsd query` + `--headless`) |
| 6 test files | new/modified |

## Known Issues & Tech Debt

- **Supervisor real-spawn path is not E2E-tested.** The loop is unit-tested with an injected `spawnRun`; the real child spawner is thin (mirrors `server/supervisor.js`). A full headless E2E (spawn a real gsd run, kill it, observe resume) is a reasonable follow-up.
- **Heartbeat-watchdog deferred** (`COMP-GSD-6-WATCHDOG`): the supervisor reacts to child *exit*, not to a heartbeat going stale while the child is still alive (a hung, not crashed, run). v1 is exit-code + on-death-status only.
- **No live cockpit telemetry** (still `COMP-GSD-4-OPSSTRIP-LIVE`): gsd uses a no-op streamWriter; `query` polling is the v1 observability surface.

## Lessons Learned

1. **Verify-first reshaped the spec twice** — `--headless` wasn't about prompts, and `state.json` couldn't "extend" a journal that didn't exist. The recon agents earned their keep before a line of code.
2. **The concurrent-resume test caught a real design bug** — `pause.json.pid` is the *original crashed writer's* pid (always dead at resume), so using it for stale-detection would have broken mutual exclusion. The fix (holder-written `owner.json`) is symmetric for both locks.
3. **Codex's impl review caught what tests didn't** — a stale `complete` state.json masquerading as success, a racy lock takeover, and a `killed` terminal escaping the closed vocabulary — none of which the initial tests exercised. The review loop (3 rounds) was load-bearing.

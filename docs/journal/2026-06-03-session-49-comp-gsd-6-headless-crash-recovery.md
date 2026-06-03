---
date: 2026-06-03
session_number: 49
slug: comp-gsd-6-headless-crash-recovery
summary: COMP-GSD-6 headless gsd + crash recovery — state.json checkpoint, query snapshot, --headless supervisor; closed run.lock + stale pause.lock gaps
feature_code: COMP-GSD-6
closing_line: "The spec said \"headless\"; the work was discovering that gsd was already headless, and what unattended actually needed was to survive its own death."
---

# Session 49 — COMP-GSD-6

**Date:** 2026-06-03
**Feature:** `COMP-GSD-6`

## What happened

Continued the COMP-GSD umbrella with GSD-6 (headless CLI + crash recovery), the autonomy-completeness rail after GSD-4 (budget) and GSD-5 (stuck). Two parallel recon agents mapped the gsd runtime and CLI before any code — and verify-first reshaped the one-line spec twice: `gsd` is *already* non-interactive (no gates/readline), so `--headless` means supervised auto-resume, not prompt suppression; and there is no journal to 'extend' (gsd never journals), so `state.json` is a standalone checkpoint. The recon also surfaced the real crash gap: `pause.json` is written ONLY on clean stuck/budget halts, so a hard crash mid-execute left nothing resumable, plus a possibly-orphaned `pause.lock` (whose stale takeover the GSD-5 code had explicitly deferred to this ticket). Design + blueprint went through Codex gates (design 2 rounds; a blueprint coherence loop to CLEAN). Implementation was 7 dependency-ordered slices behind a validated Boundary Map. The Codex implementation review (3 rounds) was the MVP of the session: it caught a stale `complete` state.json masquerading as success, a racy `rmSync+mkdirSync` lock takeover, a `killed` terminal escaping the closed status vocabulary, and the supervisor classifying without the `budget.json` precedence — none caught by tests first. A concurrent-resume unit test independently caught a real design bug: using `pause.json.pid` (the original crashed writer, always dead at resume) for stale-detection would have broken mutual exclusion.

## What we built

lib/gsd-state.js (new): atomic state.json I/O + deriveRunStatus (dead-pid = sole crash signal) + buildGsdQuery (state->pause->budget->absent precedence) + canonical pidAlive. contracts/gsd-state.json (new): state + query defs, closed vocab. lib/gsd-headless-config.js (new): per-pause-kind auto-resume policy (crash+stuck on, budget off) + backoff; every field overridable, malformed falls back. lib/gsd-supervisor.js (new): runGsdHeadless outer loop + pure classifyOutcome; spawns plain children (no recursion); resumeReady gates --resume vs fresh. lib/gsd.js: run.lock+owner.json claimed before plan, continuous state flushes (pre-plan planning checkpoint -> flowId -> per-task heartbeat -> resumeReady -> terminal), failed-on-catch, loadResumeTaskGraph crash-bridge, atomic rename-aside stale-lock takeover for both locks, fresh-run stale-state clear, killed->failed normalization. lib/build.js: opt-in opts.onHeartbeat (build mode byte-identical). bin/compose.js: `gsd query` sub-route + `--headless` dispatch. 48 tests across 6 files; full suite 3158, 0 fail.

## What we learned

1. Verify-first against the live substrate beats the spec text: `--headless` and `state.json-extends-journal` were both wrong premises that recon corrected before a line of code. 2. Lock ownership must be the HOLDER's record, not the original writer's: `pause.json.pid` is the crashed run's pid (dead by resume), so reusing it for liveness would make takeover fire unconditionally and break exclusion — the fix (holder-written owner.json) is symmetric for run.lock and pause.lock. 3. `rmSync+mkdirSync` is NOT a TOCTOU-safe takeover; renameSync (atomic) is — only one racer can rename the stale dir aside. 4. A closed status vocabulary needs a normalization choke-point: a stratum `killed` terminal slipped through both the state flush AND the return envelope until normalized in both. 5. The failed-vs-fatal-vs-crashed distinction hinges on WHEN the first running checkpoint exists — making the pre-plan planning checkpoint the boundary (and clearing stale state on fresh runs) is what lets the supervisor tell a deterministic failure from a hard crash.

## Open threads

- [ ] COMP-GSD-6-WATCHDOG: kill+resume a HUNG child (heartbeat goes stale while still alive) — v1 is exit-code + on-death-status only.
- [ ] Full headless real-spawn E2E (kill a real gsd child, observe resume) — the loop is unit-tested with an injected spawner.
- [ ] COMP-GSD umbrella still IN_PROGRESS: GSD-7 (milestone HTML reports — owns budget actuals-vs-caps) is the last planned ticket; GSD-3 residual stays with COMP-PAR-MERGE-QUEUE.
- [ ] Carried from GSD-4: COMP-GSD-4-OPSSTRIP-LIVE (live burn pill) still blocked on a gsd build-stream telemetry surface; query polling is the v1 observability.

---

*The spec said "headless"; the work was discovering that gsd was already headless, and what unattended actually needed was to survive its own death.*

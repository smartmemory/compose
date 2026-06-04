# Resume Context — COMP-GSD umbrella (compose)

## Where things stand

**COMP-GSD-6 (headless CLI + crash recovery) is COMPLETE and shipped to `main`** (8 commits, design→ship, full `/compose` lifecycle). Feature.json + ROADMAP = COMPLETE (fixed-point verified), journal session 49 written, memory updated. Full suite **3158/3158, 0 fail**.

The **COMP-GSD umbrella stays IN_PROGRESS**. Only one planned ticket remains:
- **COMP-GSD-7** — Milestone HTML report generator (per-feature: task summaries, decision log, gate outcomes, **budget actuals-vs-caps**, agent-time, worktree-diff links → `.compose/gsd/reports/<feature>.html` via the cockpit asset pipeline). PLANNED, empty scaffold at `docs/features/COMP-GSD-7/`.
- **COMP-GSD-3** residual stays PARTIAL, carried by **COMP-PAR-MERGE-QUEUE** (forge-top row) — per-task pre-merge lint/build/test gating + conflict-bounce-with-context. Not part of the umbrella's remaining build.

## First action

Ask the user which to do next: **(a) COMP-GSD-7** (closes the umbrella to all-but-GSD-3), **(b) COMP-GSD-6-WATCHDOG** (the follow-up just filed), or **(c) something else**. Do not start building without that pick. If GSD-7: run `/compose build COMP-GSD-7` (the lifecycle skill drives it).

## Follow-ups filed this session (documented in report.md/CHANGELOG/journal, NOT yet scaffolded as feature folders)

- **COMP-GSD-6-WATCHDOG** — supervisor kill+resume a *hung* child whose heartbeat goes stale while the pid is still alive. v1 only reacts to child *exit*, not a stalled heartbeat. `deriveRunStatus` already returns `heartbeatStale` advisory; the watchdog would act on it.
- Full headless real-spawn E2E (kill a real `compose gsd` child, observe resume). The supervisor loop is unit-tested with an injected `spawnRun`; the real spawner (`lib/gsd-supervisor.js` `defaultSpawnRun`) is thin/untested E2E.
- Carried from GSD-4: **COMP-GSD-4-OPSSTRIP-LIVE** (live burn pill) still blocked on a gsd build-stream telemetry surface — gsd uses a **no-op streamWriter**, emits no telemetry. `query` polling is the v1 observability.

## GSD-6 landmines / decisions (don't re-litigate; the next session will likely build ON these)

- **`gsd` is non-interactive** — no gates, no readline. `--headless` = supervised auto-resume, NOT prompt suppression.
- **`state.json` is the run-state primitive** (`.compose/gsd/<f>/state.json`, plain JSON, atomic tmp+rename). Status vocabulary is CLOSED: `running|complete|stuck|budget|failed` (runner-written) + `crashed|absent` (reader-derived). Any non-complete terminal (incl. stratum `killed`) → `failed`, in BOTH the state flush AND the `runGsd` return + CLI exit 1.
- **Dead-pid is the SOLE crash signal.** A stale heartbeat on a *live* pid is advisory (`heartbeatStale`), never a crash verdict (long tasks sit in the dispatch poll loop). `pidAlive` is canonical in `lib/gsd-state.js` (EPERM=alive); do NOT use `build.js` `isProcessAlive` (EPERM=dead — wrong for crash detection).
- **Two locks, both with holder-written `owner.json`:** `run.lock` (live-run exclusivity, claimed before `stratum.plan`) and `pause.lock` (resume claim). Stale takeover keys on `owner.json` pid — **NOT `pause.json.pid`** (= original crashed writer, always dead at resume → would break exclusion). Takeover uses **atomic `renameSync`-aside** (`takeoverStaleLock`), never `rmSync+mkdirSync` (racy).
- **Failed-vs-fatal-vs-crashed boundary = the pre-plan `planning` checkpoint.** Fresh runs clear any prior `state.json` up front (so a stale `complete` can't fake success). Throw before the checkpoint → no running state → `absent`/fatal. Throw after → catch writes `failed`. SIGKILL after → `running`+dead-pid → `crashed`.
- **`resumeReady` gates `--resume` vs fresh restart** in the supervisor: crash with task graph → `--resume`; crash during plan/decompose → fresh.
- **Query precedence is `state.json → pause.json → budget.json → absent`** (`buildGsdQuery`). The supervisor classifies via `buildGsdQuery`, not raw `readGsdState`, so a cumulative-budget refusal reads `budget` not `absent`.

## File inventory (GSD-6, for reference / extension)

```
lib/gsd-state.js            # state I/O, deriveRunStatus, buildGsdQuery, pidAlive  (S01)
contracts/gsd-state.json    # state + query JSON Schema defs                        (S02)
lib/build.js                # opt-in opts.onHeartbeat (~L2960, ~L2996)              (S03)
lib/gsd.js                  # run.lock/owner.json, state flushes, failed-catch,     (S04)
                            #   loadResumeTaskGraph crash-bridge, claimResumeLock
                            #   stale takeover, takeoverStaleLock helper
lib/gsd-headless-config.js  # readHeadlessConfig, backoffMs, HEADLESS_DEFAULTS      (S05)
lib/gsd-supervisor.js       # runGsdHeadless, classifyOutcome, defaultSpawnRun      (S06)
bin/compose.js              # `gsd query` sub-route + `--headless` (~L1967 block)   (S07)
test/gsd-{state,crash-recovery,headless-config,supervisor,query-cli}.test.js
test/gsd-resume.test.js     # +killed→failed test at EOF
```

`gsd.headless.*` config shape (compose.json): `{ autoResume:{crash,stuck,budget:{enabled,maxAttempts}}, backoff:{baseMs,factor,maxMs}, heartbeatStaleMs }`. Defaults: crash 5 / stuck 2 / **budget 0+off**.

## Operational kit

```bash
cd /Users/ruze/reg/my/forge/compose          # the git repo (forge root is NOT git)
node --test test/gsd-*.test.js               # GSD suite (~148 tests, ~1.4s)
node --test test/*.test.js                   # full lib suite (~3158, ~58s) — run before merge
node bin/compose.js roadmap check            # verify ROADMAP/feature.json fixed point
node bin/compose.js gsd query <CODE>         # the new snapshot command
```

- **Commit directly to `main`** (default for this repo). End commit messages with NO `Co-Authored-By` (user rule).
- **Codex review** at each gate: `mcp__stratum__stratum_agent_run` type `codex`, `cwd` = compose root. Keep prompts minimal/open-ended; loop to `REVIEW CLEAN` (impl review reliably catches wiring bugs tests miss — it caught all 4 real GSD-6 defects). Stop at 5 iters / if not converging.
- **Roadmap/status:** `feature.json` is canonical; ROADMAP regen preserves row prose (manual rich rows survive `roadmap check`). `set_feature_status` MCP blows the token cap (mutation still succeeds — verify on disk, don't retry). `validate_feature` always warns `COMPLETION_WITHOUT_CHANGELOG` + `UNREFERENCED_FOLLOWUP` for COMPLETE GSD features (checks a structured changelog store, not CHANGELOG.md text) — known false-positives, GSD-4/5 carry them too.

## Reading list (skim before acting on GSD-7)

1. `docs/features/COMP-GSD-6/report.md` — what just shipped, deferred items, lessons.
2. Memory `~/.claude/projects/-Users-ruze-reg-my-forge/memory/project_comp_gsd.md` — full umbrella state + GSD-4/5/6 gotchas.
3. `docs/features/COMP-GSD-7/feature.json` (+ empty scaffolds) — the target.
4. `lib/budget-ledger.js` (`readBudget`) + `lib/gsd-budget.js` — GSD-7's budget-actuals source; and the cockpit asset pipeline for HTML rendering.

## Ambient working-tree noise (leave alone)

`.claude/session-context.md`, `.compose/breadcrumbs.log`, `docs/product/ideabox.md` are ambient/uncommitted. `docs/features/COMP-ROADMAP-GRAPH-1/plan.md` is an untracked stray (pre-existing, not GSD work) — not mine, don't touch.

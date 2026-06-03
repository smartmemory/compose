# COMP-GSD-6 — Headless CLI + Crash Recovery: Design

**Status:** DESIGN
**Date:** 2026-06-03
**Feature:** `COMP-GSD-6`
**Complexity:** L

## Related Documents

- Parent umbrella: `COMP-GSD` (Autonomous Long-Run Mode) — `docs/features/COMP-GSD/`
- Depends on: `COMP-GSD-2` (per-task fresh-context dispatch — the dispatch loop this builds on)
- Reuses machinery from: `COMP-GSD-4` (budget pause/`pause.json`/`--resume`) and `COMP-GSD-5` (stuck pause/`--resume`)
- ROADMAP row: `compose/ROADMAP.md` → `COMP-GSD: Autonomous Long-Run Mode` (position 7)

---

## Problem

`compose gsd <feature>` runs autonomously across many context windows, but today it cannot run **unattended** in CI/cron, and it cannot **survive a crash**:

1. **No crash recovery.** `pause.json` (the only resume state) is written **exclusively on clean stuck/budget halts** (`lib/gsd.js:613`, `:791`). A hard crash mid-`execute` (OOM, SIGKILL, host reboot, agent-dispatch panic) leaves **no resume state** — the run is unrecoverable and may strand a `results/` dir plus an orphaned `pause.lock`. The lock comment at `lib/gsd.js:728-732` *explicitly defers* stale-lock recovery to this ticket.
2. **No unattended operation.** A run that hits a stuck/budget pause exits code 2 and stops, waiting for a human `--resume`. There is no policy-driven auto-resume for CI/cron.
3. **No status surface.** There is no way to ask "how is run X doing?" without attaching to the process. No `compose gsd query`, no live progress file. (`grep` confirms neither exists.)
4. **No concurrent-run safety.** A *fresh* `gsd` run takes **no lock** (only `--resume` does, via `pause.lock`). Two `compose gsd <same-feature>` invocations race the same `results/` dir and worktrees.

## Goal

Make `compose gsd` safe to run unattended and observable from outside the process:

- **In scope:** continuous crash-recoverable state, an outer `--headless` supervisor with configurable auto-resume + backoff, a fast read-only `compose gsd query` snapshot, a live-run lock, and stale `pause.lock` takeover.
- **Non-goals (v1):** SSE/web telemetry streaming (gsd uses a no-op streamWriter — deferred, see `COMP-GSD-4-OPSSTRIP-LIVE`), the HTML milestone report (that is `COMP-GSD-7`), per-task token cutoffs (`COMP-GSD-4-PERTASK-TOKENS`), and any change to the decompose→execute→ship pipeline itself.

### Reality corrections (from recon — supersede the original one-line spec)

| Spec assumption (feature.json) | Reality | Resolution |
|---|---|---|
| "`--headless` for CI/cron" implies suppressing interactive prompts | gsd is **already** non-interactive — no gates, no readline (`lib/gsd.js`); it halts to disk + exits | `--headless` instead means *auto-resume policy + supervision*, not prompt suppression |
| "State persisted to `state.json` (extends existing journal)" | gsd makes **no journal writes**; there is no journal to extend | Introduce `.compose/gsd/<f>/state.json` as a standalone continuously-flushed checkpoint (the spec's intent, minus the non-existent journal coupling) |
| "Auto-resume on crash with backoff" | A crash leaves **no `pause.json`** — nothing to resume from today | `state.json` is the missing primitive that makes crash-resume possible |
| "no new SQLite" | Honored — all state is plain JSON, atomic tmp+rename | Keep |

---

## Decision 1: Continuous `state.json` checkpoint + heartbeat

**Decision:** Write `.compose/gsd/<feature>/state.json` continuously during a run — initialized at dispatch start and re-flushed after every task completes and on every loop turn. This is the load-bearing primitive for crash detection, `query`, and the live-run lock.

**Shape** (plain JSON, atomic tmp+rename like `writeActiveBuild` at `lib/build.js:404`):

```jsonc
{
  "feature": "COMP-GSD-6",
  "flowId": null,                  // null in the pre-plan "planning" checkpoint; set after stratum.plan
  "pid": 12345,
  "mode": "gsd",
  "phase": "execute",              // planning | decompose | execute | ship | done
  "status": "running",             // running | complete | stuck | budget | failed
  "startedAt": "<iso>",
  "heartbeatAt": "<iso>",          // bumped on every flush AND from the push-event path
  "headless": true,
  "attempt": 1,                    // supervisor attempt counter (resume generation)
  "resumeReady": false,            // true once decomposedTasks is flushed (post-decompose);
                                   // gates whether a crash re-spawns --resume vs fresh (Decision 3)
  // decomposedTasks holds FULL enriched task objects (NOT bare IDs) — resume needs
  // id + depends_on + repaired description because --resume bypasses re-decompose.
  "decomposedTasks": [
    { "id": "t1", "depends_on": [],     "description": "..." },
    { "id": "t2", "depends_on": ["t1"], "description": "..." }
  ],
  "completedTaskIds": ["t1"],
  "lastTaskId": "t1",
  "lastStepId": "execute",
  "budget": { "caps": {...}, "consumed": {...} }  // mirror of live budget, optional
}
```

**Rationale:**
- A crash leaves the last checkpoint on disk. The supervisor reconstructs `remaining = decomposedTasks − completedTaskIds` and strips completed deps — exactly the math `loadResumeTaskGraph` already does (`lib/gsd.js:699-712`).
- **`decomposedTasks` stores full enriched task objects, not IDs** (Codex finding #4). `--resume` bypasses re-decompose (`lib/gsd.js:315`) and `loadResumeTaskGraph` filters *task objects* with `id`/`depends_on`/repaired descriptions (`lib/gsd.js:699`). Persisting bare IDs would make the crash-bridge unable to feed resume. Source is `ctx.lastTaskGraph` (already held in memory, cached at the decompose step).
- `pid` liveness (`isPidAlive`, `lib/gsd.js:839`) is the **authoritative** crash signal; `heartbeatAt` is corroborating/advisory only (see Decision 4 — long tasks legitimately sit in the dispatch poll loop, so stale heartbeat alone must never authorize takeover).

**Status taxonomy & the crash-vs-fatal distinction (Codex finding #3):** there is no self-written `crashed` status (a live process can't observe its own SIGKILL). Instead:
- Terminal statuses the runner **writes**: `complete | stuck | budget | failed`. `failed` is new — the dispatch-try catch flushes `state.json` `status:"failed"` on an orderly throw **iff a `running` checkpoint already exists** (guard on `readGsdState()?.status === 'running'`). The dividing line is the pre-plan `planning` checkpoint (flush point 0), **not** `flowId` (see blueprint D-A): a throw *before* that checkpoint — preconditions like dirty-workspace (`lib/gsd.js:98-104`) or the cumulative-budget early-return (`:128`) — writes **no** `running` state, so it is classified **fatal** by absence (exit≠0 + no running state), not `failed`. A throw *after* the checkpoint (plan/decompose/execute/ship) is converted to `failed`.
- `crashed` is a **derived** reader status: `status === "running"` persisted **and** pid dead. Because every orderly *post-checkpoint* throw writes `failed` and every pre-checkpoint throw leaves no running state, a `running`+dead-pid state now reliably means a *hard* crash (SIGKILL/OOM/reboot) — so the supervisor won't auto-retry deterministic failures.

**Heartbeat from the dispatch loop (Codex finding #2):** the long-running work is inside `executeParallelDispatchServer`, which can poll for minutes before `runGsd` regains control (`lib/gsd.js:176`, `lib/build.js:3016`). Flushing the heartbeat only at loop turns would mark a healthy long task "stale". Fix: bump `heartbeatAt` from the **push-event callback** that already fires per task event (the `stratum.onEvent` subscription at `lib/build.js:2992` feeding `stuckDetector.record`) — piggyback a lightweight `touchHeartbeat()` there. Even so, takeover keys on **dead pid**, not stale heartbeat (heartbeat staleness is only a *query* hint that a run *may* be wedged).

**Flush points (in `lib/gsd.js`):** **(0)** a pre-plan `planning` checkpoint written *before* `stratum.plan` — `{pid, flowId:null, phase:"planning", status:"running", resumeReady:false}` — so even a plan-phase crash leaves a dead-pid `state.json` (pairs with `run.lock/owner.json`, Decision 4); **(1)** update with `flowId` right after `stratum.plan` (~`:159`); **(2)** per-task heartbeat via the push-event path; **(3)** post-decompose checkpoint sets `resumeReady:true` once `decomposedTasks` is populated; **(4)** checkpoint after each task-complete / `ctx.filesChanged` capture; **(5)** terminal flush (`complete|stuck|budget`) at the existing halt branches; **(6)** `failed` flush in the dispatch-try catch (only when a `running` checkpoint already exists — blueprint D-A).

**Crash-recovery bridge (resume load):** on `--resume`, `loadResumeTaskGraph` (`lib/gsd.js:663`) currently reads `pause.json` and throws if absent. Add a fallback: if `pause.json` is missing **but** a `state.json` with persisted `status:"running"` and a dead pid exists, synthesize the resume input from `state.json.decomposedTasks`/`completedTaskIds` (same enriched-task-object shape the function already filters). This is the only path by which a hard crash — which never wrote `pause.json` — becomes resumable.

---

## Decision 2: `compose gsd query <feature>` — instant JSON snapshot

**Decision:** Add a `query` subcommand to the existing `gsd` CLI block (`bin/compose.js:1967`), branching on `args[0] === 'query'` before the feature-code path (mirrors the `roadmap`/`gates` sub-routers). Pure synchronous reads, no LLM, no server, no Stratum — target ~50ms.

**Synthesizes from** (all already on disk except `state.json` from Decision 1):
Status is derived by a **fixed source precedence** (blueprint D-F) so the pre-dispatch cumulative-budget refusal — which writes `budget.json` but **no** `state.json` (it returns at `:128`) — isn't mislabeled `absent`:
1. `state.json` present → `deriveRunStatus` (phase, progress `completed/total`, heartbeat, pid-liveness → `running | crashed | complete | stuck | budget | failed`; `running`+live+stale-heartbeat ⇒ `running` + advisory `heartbeatStale`).
2. else `pause.json` present → its `kind` (`stuck | budget`) + detail.
3. else `budget.json` present (cumulative refusal) → `budget` (`axis:"cumulative"`).
4. else → `absent`.

Cross-checks: `results/*.json` count (completed tasks); `budget-ledger.json` (`readBudget`, `lib/budget-ledger.js:186`) for cumulative spend. The full vocabulary `running | crashed | complete | stuck | budget | failed | absent` is exactly the runner/supervisor taxonomy plus the two reader-only states (`crashed`, `absent`) — one shared vocabulary across `query`, supervisor, and tests.

**Output:** single `JSON.stringify` to stdout, exit 0 (or exit 3 + `{status:"absent"}` only when **all four** sources are absent). Follows the `compose items --json` precedent (`bin/compose.js:2775`). A `--watch` flag is deferred (pollers can loop the command themselves).

**Crash detection rule (dead-pid authoritative — heartbeat never alone):** with `state.json status === "running"`:
- `!isPidAlive(pid)` ⇒ `"crashed"` (the only crash signal).
- pid alive **but** `now − heartbeatAt > staleThreshold` ⇒ still `"running"`, with an advisory `heartbeatStale: true` flag (the run *may* be wedged — a hint for the poller, **not** a crash verdict). This avoids reporting a healthy long task as crashed.

---

## Decision 3: `--headless` supervisor with configurable auto-resume + backoff

**Decision:** `compose gsd <feature> --headless` runs an **outer supervisor loop** that owns child run attempts. A self-resuming in-process loop cannot survive a hard crash, so the supervisor spawns each attempt and re-spawns `--resume` on a recoverable non-clean exit, with exponential backoff and a max-attempts cap.

**Loop:**
1. Spawn the run. Attempt 1: fresh. Attempt N>1: **`--resume`** when the prior state was `crashed`+`resumeReady`; otherwise **fresh** (see the crashed branch below).
2. On child exit, classify outcome from exit code + the **terminal `state.json` status** (not exit code alone — finding #3):
   - **complete** (`state.status==complete`, exit 0) → done, exit 0.
   - **stuck** (`state.status==stuck`, exit 2) → if policy allows and under retry cap, backoff + resume; else exit 2.
   - **budget** (`state.status==budget`, exit 2) → policy default **halt** (exit 2); never resume unless explicitly overridden.
   - **failed** (`state.status==failed`, exit 1) → **non-recoverable**, exit 1. The orderly-exception path; never auto-retried (a dirty workspace or parse error would just re-fail).
   - **fatal / no-state** (exit≠0 **and no `running` `state.json`** — a *pre-checkpoint* failure: bad args, dirty workspace before the planning checkpoint) → **non-recoverable**, exit with the child's code. Distinct from `crashed`: there is no running state to recover.
   - **crashed** (`state.status==running` persisted **and** child pid dead — no terminal status written) → genuine hard crash; if policy allows, backoff then re-spawn: **`--resume`** when `state.resumeReady` (task graph exists), or **fresh** when `!resumeReady` (crashed during plan/decompose — nothing merged yet, clean restart is safe).
3. Backoff: `base · 2^(attempt−1)`, capped; `maxAttempts` overall (separate cap per kind).

**Configurable policy** (per the decision to make *every* pause kind overridable) under `gsd.headless.*` in `.compose/compose.json`, with conservative defaults:

```jsonc
"gsd": {
  "headless": {
    "autoResume": {
      "crash":  { "enabled": true,  "maxAttempts": 5 },
      "stuck":  { "enabled": true,  "maxAttempts": 2 },
      "budget": { "enabled": false, "maxAttempts": 0 }   // opt-in only — protects the GSD-4 ceiling
    },
    "backoff": { "baseMs": 2000, "factor": 2, "maxMs": 60000 },
    "heartbeatStaleMs": 90000
  }
}
```

Defaults match the chosen policy (crash + bounded-stuck, never budget). Every field is overridable — a user *may* set `budget.enabled: true` for a fully-unattended burn, accepting the tradeoff. Unset ⇒ defaults ⇒ behavior is a plain run plus supervision (consistent with the GSD-4 "absent ⇒ identical" principle).

**Where it lives:** a new `lib/gsd-supervisor.js` (`runGsdHeadless(feature, opts)`), invoked from the `gsd` CLI block when `--headless` is present; the non-headless path calls `runGsd` directly as today. The supervisor spawns `process.execPath bin/compose.js gsd <feature> [--resume]` as a child (the `compose start` → `server/supervisor.js` spawn pattern is the precedent).

---

## Decision 4: Live-run lock — atomic claim, not `state.json` (revised per Codex finding #1)

**Decision:** `state.json` is **status only**, never the lock — tmp+rename gives durability, not mutual exclusion, so two fresh runs could both observe "no owner" and both start. Exclusivity needs an **atomic claim primitive acquired before any side effect** (before `stratum.plan`).

Reuse the same atomic `mkdirSync` pattern `claimResumeLock` already uses (`lib/gsd.js:733`): a `run.lock` directory under `.compose/gsd/<feature>/`, claimed at the **top of the dispatch try, before `stratum.plan`** (currently the first side-effecting call is at `lib/gsd.js:155-159`, with no fresh-run claim before it — the gap). `mkdirSync` is atomic on POSIX: the loser gets `EEXIST` and refuses. **Immediately after winning the `mkdir`, write `run.lock/owner.json {pid, startedAt}`** — the lock-local owner record (and write the pre-plan `planning` `state.json` per Decision 1 flush point 0).

**Stale-claim takeover** — ownership precedence (keyed on **dead pid**, authoritative; heartbeat advisory only): read the owning pid from **`run.lock/owner.json` first**, falling back to **`state.json`** if `owner.json` is absent. Takeover (remove + re-claim, TOCTOU-safe re-attempt of the atomic `mkdirSync`; a concurrent winner still wins) when: that pid is **dead**, OR **neither owner record exists** and the lock-dir mtime is older than `heartbeatStaleMs` (covers the sub-ms window before `owner.json` lands). Released in the `finally` that already guards `pause.lock` (`lib/gsd.js:228-237`).

So: `run.lock` = exclusivity (atomic, pre-plan); `state.json` = observable status + resume payload; `pause.lock` = the existing resume-claim lock (unchanged, but its stale-takeover is Decision 5). A fresh `--headless` run that finds a live `run.lock` refuses; one that finds a dead-pid `run.lock` takes over and re-spawns per the Decision 3 crashed branch — **`--resume`** when `state.resumeReady`, else a **fresh** restart (early plan/decompose crash, nothing merged).

## Decision 5: Stale `pause.lock` takeover (the deferred `gsd.js:728-732` item)

**Decision:** `claimResumeLock` currently throws on `EEXIST` with no recovery. Add a stale check. **Crucial correction (caught by the concurrent-resume test):** the holder pid must come from a **`pause.lock/owner.json`** record that the *current holder* writes on claim — **not** from `pause.json.pid`, which is the *original crashed run's* pid (always dead by resume time, so it would make takeover fire unconditionally and break mutual exclusion between two live resumes). Takeover when the holder pid (from `pause.lock/owner.json`) is dead, **or** no owner record exists and the lock-dir mtime is older than the stale window. TOCTOU-safe: remove + re-attempt the atomic `mkdirSync`; a concurrent winner still wins. A crashed `--resume` no longer wedges the feature permanently. (Symmetric with `run.lock/owner.json` in Decision 4 — both locks carry a holder-written owner record.)

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `lib/gsd-state.js` | new | `writeGsdState`/`readGsdState`/`deriveRunStatus`/`gsdStatePath` — atomic state.json read/write + crash-status derivation |
| `lib/gsd.js` | existing | flush `state.json` (init + per-task + terminal + `failed`-on-catch); push-event heartbeat hook; crash-bridge in `loadResumeTaskGraph`; atomic `run.lock` claim before `stratum.plan` + dead-pid takeover; stale-`pause.lock` takeover in `claimResumeLock` |
| `lib/gsd-supervisor.js` | new | `runGsdHeadless` — spawn/backoff/auto-resume loop + policy classification |
| `lib/gsd-headless-config.js` | new (may fold into gsd-supervisor) | read+default `gsd.headless.*` policy, validate overrides |
| `bin/compose.js` | existing | `gsd query` sub-route; `--headless` flag → `runGsdHeadless`; usage text |
| `contracts/gsd-state.json` | new | JSON Schema for `state.json` (and `query` output envelope) |
| `test/gsd-state.test.js` | new | state read/write/atomicity + status derivation |
| `test/gsd-query-cli.test.js` | new | `spawnSync` CLI snapshot incl. crashed/absent/running fixtures |
| `test/gsd-supervisor.test.js` | new | policy classification + backoff + maxAttempts + budget-never-resume |
| `test/gsd-headless-crash-recovery.test.js` | new | golden flow: simulated crash (kill child) → state.json present → resume completes |

## Open Questions

1. **`query` output schema stability** — should the `query` envelope be a published contract (so external pollers can depend on it)? Leaning yes (`contracts/gsd-state.json` covers both). *Default: yes.*
2. **Supervisor heartbeat-watchdog vs. exit-code-only** — should the supervisor also kill+resume a child whose heartbeat goes stale *while still running* (hung, not crashed)? v1 leans **exit-code + on-death-status only**; a live watchdog is a clean follow-up (`COMP-GSD-6-WATCHDOG`). *Default: defer watchdog.*
3. **`crashed` status persistence** — confirmed we never *write* `crashed` from the runner (can't observe own death); it is always *derived* by readers. Documented in Decision 1.

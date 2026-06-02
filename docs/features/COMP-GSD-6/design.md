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
  "flowId": "<stratum-flow-id>",
  "pid": 12345,
  "mode": "gsd",
  "phase": "execute",              // decompose | execute | ship | done
  "status": "running",             // running | complete | stuck | budget | failed
  "startedAt": "<iso>",
  "heartbeatAt": "<iso>",          // bumped on every flush AND from the push-event path
  "headless": true,
  "attempt": 1,                    // supervisor attempt counter (resume generation)
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
- Terminal statuses the runner **writes**: `complete | stuck | budget | failed`. `failed` is new — the top-level `runGsd` body is wrapped so any thrown/orderly error (dirty workspace `lib/gsd.js:92`, parse/flow errors `lib/gsd.js:331`, etc.) flushes `state.json` `status:"failed"` before the process exits 1.
- `crashed` is a **derived** reader status: `status === "running"` persisted **and** pid dead. Because `failed` is written on every orderly throw, a `running`+dead-pid state now reliably means a *hard* crash (SIGKILL/OOM/reboot), not a deterministic exception — so the supervisor won't auto-retry non-recoverable failures.

**Heartbeat from the dispatch loop (Codex finding #2):** the long-running work is inside `executeParallelDispatchServer`, which can poll for minutes before `runGsd` regains control (`lib/gsd.js:176`, `lib/build.js:3016`). Flushing the heartbeat only at loop turns would mark a healthy long task "stale". Fix: bump `heartbeatAt` from the **push-event callback** that already fires per task event (the `stratum.onEvent` subscription at `lib/build.js:2992` feeding `stuckDetector.record`) — piggyback a lightweight `touchHeartbeat()` there. Even so, takeover keys on **dead pid**, not stale heartbeat (heartbeat staleness is only a *query* hint that a run *may* be wedged).

**Flush points (in `lib/gsd.js`):** init before the dispatch loop (after `flowId`, ~`:159`); per-task heartbeat via the push-event path; checkpoint after each task-complete / `ctx.filesChanged` capture; terminal flush (`complete|stuck|budget`) at the existing halt branches; `failed` flush in the new top-level catch.

**Crash-recovery bridge (resume load):** on `--resume`, `loadResumeTaskGraph` (`lib/gsd.js:663`) currently reads `pause.json` and throws if absent. Add a fallback: if `pause.json` is missing **but** a `state.json` with persisted `status:"running"` and a dead pid exists, synthesize the resume input from `state.json.decomposedTasks`/`completedTaskIds` (same enriched-task-object shape the function already filters). This is the only path by which a hard crash — which never wrote `pause.json` — becomes resumable.

---

## Decision 2: `compose gsd query <feature>` — instant JSON snapshot

**Decision:** Add a `query` subcommand to the existing `gsd` CLI block (`bin/compose.js:1967`), branching on `args[0] === 'query'` before the feature-code path (mirrors the `roadmap`/`gates` sub-routers). Pure synchronous reads, no LLM, no server, no Stratum — target ~50ms.

**Synthesizes from** (all already on disk except `state.json` from Decision 1):
- `state.json` → phase, status, progress (`completed/total`), heartbeat, pid-liveness → derived `running | crashed | complete | stuck | budget | failed | absent`.
- `pause.json` → halt kind + detail if paused.
- `results/*.json` count → cross-check of completed tasks.
- `budget-ledger.json` (`readBudget`, `lib/budget-ledger.js:186`) → cumulative spend.

`query`'s derived status set is exactly the runner/supervisor taxonomy plus the two reader-only states — `crashed` and `absent` — so external pollers see the same terminal vocabulary the supervisor acts on (including `failed`).

**Output:** single `JSON.stringify` to stdout, exit 0 (or exit 3 + `{status:"absent"}` if no run state). Follows the `compose items --json` precedent (`bin/compose.js:2775`). A `--watch` flag is deferred (pollers can loop the command themselves).

**Crash detection rule (dead-pid authoritative — heartbeat never alone):** with `state.json status === "running"`:
- `!isPidAlive(pid)` ⇒ `"crashed"` (the only crash signal).
- pid alive **but** `now − heartbeatAt > staleThreshold` ⇒ still `"running"`, with an advisory `heartbeatStale: true` flag (the run *may* be wedged — a hint for the poller, **not** a crash verdict). This avoids reporting a healthy long task as crashed.

---

## Decision 3: `--headless` supervisor with configurable auto-resume + backoff

**Decision:** `compose gsd <feature> --headless` runs an **outer supervisor loop** that owns child run attempts. A self-resuming in-process loop cannot survive a hard crash, so the supervisor spawns each attempt and re-spawns `--resume` on a recoverable non-clean exit, with exponential backoff and a max-attempts cap.

**Loop:**
1. Spawn the run (attempt 1: fresh; attempt N>1: `--resume`).
2. On child exit, classify outcome from exit code + the **terminal `state.json` status** (not exit code alone — finding #3):
   - **complete** (`state.status==complete`, exit 0) → done, exit 0.
   - **stuck** (`state.status==stuck`, exit 2) → if policy allows and under retry cap, backoff + resume; else exit 2.
   - **budget** (`state.status==budget`, exit 2) → policy default **halt** (exit 2); never resume unless explicitly overridden.
   - **failed** (`state.status==failed`, exit 1) → **non-recoverable**, exit 1. This is the orderly-exception path; never auto-retried (a dirty workspace or parse error would just re-fail).
   - **crashed** (`state.status==running` persisted **and** child pid dead — i.e. no terminal status was ever written) → genuine hard crash; if policy allows, backoff + resume.
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

Reuse the same atomic `mkdirSync` pattern `claimResumeLock` already uses (`lib/gsd.js:733`): a `run.lock` directory under `.compose/gsd/<feature>/`, claimed at the **top of the dispatch try, before `stratum.plan`** (currently the first side-effecting call is at `lib/gsd.js:155-159`, with no fresh-run claim before it — the gap). `mkdirSync` is atomic on POSIX: the loser gets `EEXIST` and refuses.

**Stale-claim takeover** (keyed on **dead pid**, authoritative — heartbeat is advisory): if `run.lock` exists but the owning pid (read from `state.json`) is dead, remove and re-claim (TOCTOU-safe: re-attempt the atomic `mkdirSync`; a concurrent winner still wins). Released in the `finally` that already guards `pause.lock` (`lib/gsd.js:228-237`).

So: `run.lock` = exclusivity (atomic, pre-plan); `state.json` = observable status + resume payload; `pause.lock` = the existing resume-claim lock (unchanged, but its stale-takeover is Decision 5). A fresh `--headless` run that finds a live `run.lock` refuses; one that finds a dead-pid `run.lock` takes over (and resumes from `state.json`).

## Decision 5: Stale `pause.lock` takeover (the deferred `gsd.js:728-732` item)

**Decision:** `claimResumeLock` (`lib/gsd.js:733`) currently throws on `EEXIST` with no recovery. Add a stale check: if `pause.lock` exists but the owning pid (from `pause.json`/`state.json`) is dead **and** the lock dir mtime is older than `heartbeatStaleMs`, remove and re-claim (TOCTOU-safe: re-attempt the atomic `mkdirSync` after removal; loser still throws). A crashed `--resume` no longer wedges the feature permanently.

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

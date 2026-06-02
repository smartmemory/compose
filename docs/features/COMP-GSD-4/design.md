# COMP-GSD-4: Budget Ceilings + Stop Conditions for Autonomous `gsd` Runs — Design

**Status:** DESIGN (Phase 1 — not implemented; intent doc, reviewed as a design, not as shipped code)
**Date:** 2026-06-03
**Roadmap:** COMP-GSD-4 (parent COMP-GSD, "Autonomous Long-Run Mode"), complexity M
**Depends on:** COMP-GSD-2 (per-task dispatch — shipped); **STRAT-WORKFLOW-BUDGET** (flow-execution-wide run budget on the MCP path — shipped 2026-05-29, the enforcement substrate this adopts); COMP-GSD-5 (stuck detection — shipped; shares the `pause.json` resume shape)

## Related Documents
- `ROADMAP.md` → COMP-GSD-4; sibling autonomy-safety rail to COMP-GSD-5 (stuck detection); the per-feature/per-task stop-condition counterpart.
- Stratum substrate: `stratum/docs/features/STRAT-WORKFLOW-BUDGET/{design,report}.md` (enforced axes, `budget_exhausted` terminal, cascade-cancel).
- Reuses: `pipelines/gsd.stratum.yaml` (flow def), `lib/gsd.js` (run loop + `stuck`/terminal handling + `--resume`), `lib/gsd-blackboard.js` (completed-task source), `lib/budget-ledger.js` (cumulative cross-session tracking, COMP-BUDGET-2), `contracts/gsd-stuck.json` (`pause.json` shape), the build-stream `step_usage`/`build_end` cost events (COMP-OBS-COST), and the OpsStrip budget pill (COMP-BUDGET-3 / COMP-OBS-STEPDETAIL).

---

## Problem

`compose gsd <feature>` dispatches each blueprint task as a fresh-context agent and runs the flow to completion. There is **no aggregate ceiling** on a whole gsd run. COMP-GSD-5 halts a *single spinning task* (same-file/error/no-progress/wall-clock); it does **not** bound the run as a whole. A run can: fan out many tasks, each individually "making progress," and still burn far more tokens / wall-clock / dispatches than intended (retry storms across tasks, a decomposition that's too large, a slow grind that never trips the per-task stuck signals). The missing rail is a **hard run-wide stop** with diagnostics, paired with the existing `idea_budget_ceilings` intent: "hard caps on iteration count, wall-clock time, action count for runaway agents."

## Goal

Give a `compose gsd` run an **opt-in, configurable budget** across tokens / agent-dispatches / wall-clock, enforced as a **hard stop with a structured diagnostic** (not a runaway), with a **`--resume`** path identical to the GSD-5 stuck path, and **surface burn in the cockpit OpsStrip**.

- **In scope (v1):**
  - Per-**feature** (= per-gsd-run) caps on `max_tokens`, `max_agent_dispatches`, wall-clock (`ms`), **and `usd`**, via the **already-shipped** stratum flow budget — adopted by the gsd flow, configured from `.compose/compose.json` → `gsd.budget.*`.
  - Compose-side handling of the `budget_exhausted` terminal: write `budget.md` + `budget.json` diagnostics (populated from the `budget_state` carried in the terminal envelope), persist `pause.json` (GSD-5 shape, `kind:"budget"`), halt cleanly with status `budget`.
  - **Cumulative cross-session** feature budget (tokens / cost / wall-clock) recorded in `lib/budget-ledger.js`; `--resume` refuses when the cumulative cap is already exhausted (mirrors COMP-BUDGET-2 `checkCumulativeBudget`), pointing the user to raise the cap.
  - `compose gsd <feature> --resume` works for a budget halt exactly as for a stuck halt (skip `completedTaskIds`, re-dispatch the rest).
  - Surface gsd budget burn via the **`budget.json` diagnostic** (written on halt) and the **cumulative ledger** — both sourced from `budget_state` at the terminal. (See Decision 6 for why the *live* cockpit pill is deferred.)
  - **Opt-in:** absent `gsd.budget.*` config ⇒ no budget block injected ⇒ `budget_state` is `None` ⇒ plain `compose build` and un-budgeted `compose gsd` are **byte-identical**.

- **Non-scope (v1) — documented scope cuts:**
  - **Per-*task* token caps as a *hard cutoff*.** Stratum's run budget is flow-aggregate; it has no per-task token ceiling. A runaway *single* task is already bounded by (a) the stratum per-task `timeout` (wall-clock) and (b) the GSD-5 stuck detector. We expose per-task **wall-clock** via the existing task `timeout` (config `gsd.budget.per_task_ms`), and defer a true per-task token cutoff to a follow-up (`COMP-GSD-4-PERTASK-TOKENS`) — building it means a stratum-side change, and the two existing per-task rails cover the runaway case. (Decision 5.)
  - **Live OpsStrip gsd-burn pill.** `compose gsd` runs with a **no-op `streamWriter`** (`lib/gsd.js:210`) — it emits no `step_usage`/`build_end` build-stream events and no active-build state, and the existing budget pill / `/api/lifecycle/budget` are iteration-loop-specific (review/coverage). A *live* gsd-burn readout therefore needs new gsd build-stream telemetry that does not exist yet. Deferred to `COMP-GSD-4-OPSSTRIP-LIVE`; v1 surfaces burn via the `budget.json` diagnostic + cumulative ledger instead (Decision 6). The substrate gap (gsd no-op streamWriter) is broader than budget and is the real prerequisite.
  - Auto/adaptive cap tuning, milestone budget reports (that's COMP-GSD-7), and budget across non-gsd lifecycles (build/fix iteration loops already have COMP-BUDGET-1..4).

---

## Verified substrate (read the source, don't infer)

The roadmap row reads as "build budget ceilings." Source verification shows the **enforcement mechanism already ships** — GSD-4 is *adoption + compose-side stop-handling + cumulative ledger + surface*, not a new budget engine. This is the same shape as COMP-GSD-3 (core shipped via the Stratum substrate).

| Capability | Where it lives today | GSD-4's relationship |
|---|---|---|
| Flow-wide budget axes `{ms, max_agent_dispatches, max_tokens, usd}` — **all four enforced** | `spec.py:IRBudgetDef` (flow-level `budget:` block); `run_budget.py:budget_exhausted()` hard-stops on each | **Adopt** — inject the block into the gsd flow from config. |
| `usd` enforced via token→USD pricing table (unpriced models under-count) | `run_budget.py` (STRAT-WORKFLOW-**BUDGET-DOLLARS**, shipped after the 2026-05-29 base) | **Adopt** as a real cost cap; `max_tokens` is the reliable backstop for unpriced models. |
| Per-task + flow usage accumulation (tokens, dollars) | `parallel_exec.py` `self._task_usage`, `run_budget.py` `accumulate_usage`/`debit_budget` | **Reuse** — no new instrumentation. |
| Hard cutoff on exhaustion → terminal `budget_exhausted` + cascade-cancel siblings | `run_budget.py` `budget_exhausted()`, `server.py:174/283/402/3823` returns `{"status":"budget_exhausted", … , "budget_state": {caps, consumed}}` | **Consume** — branch on the terminal status; read `budget_state` for the diagnostic. |
| `budget_state` (`{caps, consumed:{tokens,dispatches,wall_s,dollars}}`) carried in the terminal envelope | `server.py:181` (agent-run), `:3839` (advance/step path) | **Reuse** as the diagnostic + ledger data source (no build-stream needed). |
| Cumulative per-feature ledger (iterations/actions/timeMs) | `lib/budget-ledger.js` (COMP-BUDGET-2) | **Extend** with tokens/cost; reuse `checkCumulativeBudget` pattern for resume refusal. |
| `pause.json` + `--resume` (skip `completedTaskIds`, re-dispatch rest) | `lib/gsd.js`, `contracts/gsd-stuck.json` (COMP-GSD-5) | **Reuse** with a `kind` discriminator. |
| ~~OpsStrip budget pill / `step_usage`,`build_end` telemetry~~ | iteration-loop-specific; **gsd emits none** (no-op `streamWriter`, `gsd.js:210`) | **NOT reusable for a live gsd pill** — deferred (Decision 6). |

**Two facts that shape the design:**
1. **No stratum prerequisite is needed** (unlike GSD-5, which needed STRAT-PAR-STREAM-TOOLDETAIL). `budget_exhausted` is already a first-class terminal status in the advance/step responses `compose` consumes — verified at `server.py:402` (advance path), `:174`/`:283` (parallel paths), `:3823` (bg poll) — **and it carries `budget_state` (`:3839`/`:181`)**, so the diagnostic is fully populated from the envelope. `grep budget_exhausted compose/lib` is empty today only because the gsd loop branches on `complete`/`killed`/`stuck` and never on `budget_exhausted`.
2. **The gsd flow declares no budget.** `pipelines/gsd.stratum.yaml` has no `budget:` block, so `budget_state` is `None` and nothing is enforced. The whole feature turns on *conditionally* adding that block.

---

## Decision 1: Adopt the stratum flow budget — inject the `budget:` block from config, do not rebuild

`gsd.stratum.yaml` is a static shipped file; hardcoding a `budget:` block would impose a cap on *every* gsd run. Instead, `runGsd` injects the block into the in-memory spec string **only when `gsd.budget.*` config is present** — exactly how it already injects `gateCommands` from `loadProjectConfig()`. The flow-level block (verified shape, `test_workflow_budget_state.py:50`):

```yaml
flows:
  gsd:
    input: {…}
    output: PhaseResult
    budget: {ms: <per_run_ms>, max_agent_dispatches: <n>, max_tokens: <n>}   # injected iff configured
    max_rounds: 10
    steps: [...]
```

No config ⇒ no block ⇒ `budget_state is None` ⇒ identical to today. This is the opt-in guarantee, enforced by construction.

## Decision 2: `budget_exhausted` terminal → clean halt + structured diagnostic (mirror the GSD-5 `stuck` path)

In `lib/gsd.js`, add `budget_exhausted` to the run loop's terminal set and a terminal branch symmetric to `stuck`:
- The status loop (`gsd.js:139`) gains `&& response.status !== 'budget_exhausted'`; `runOneStep`'s advance calls already *return* the `budget_exhausted` envelope from stratum, so the loop exits cleanly (stratum has already cascade-cancelled in-flight siblings).
- On a budget halt: (1) write `.compose/gsd/<feature>/budget.md` + `budget.json` (schema in `contracts/gsd-stuck.json`, extended with a `budget` diagnostic block): which axis tripped, consumed vs cap on each axis, completed/remaining tasks, partial diff, resume/raise-cap guidance; (2) persist `pause.json` (Decision 4); (3) return `{ status: 'budget', flowId, axis, consumed, caps }`.
- A clean (`complete`) finish still clears `pause.json` (existing GSD-5 behavior).

## Decision 3: Cumulative cross-session feature budget in the ledger; `--resume` refuses on a spent ceiling

Stratum's `budget_state` is **per-flow-run** — it resets each `compose gsd` invocation. A hard *ceiling that survives across sessions* (the point of a budget) needs compose-side persistence. Extend `lib/budget-ledger.js`:
- `recordGsdUsage(composeDir, featureCode, { tokens, costUsd, dispatches, timeMs })` — append to the existing per-feature ledger entry (new `totalTokens`/`totalCostUsd` fields alongside the existing `totalIterations`/`totalActions`/`totalTimeMs`; back-compatible — missing fields read as 0). Recorded at each gsd terminal (complete, budget, stuck), sourced from the **terminal envelope's `budget_state.consumed`** (`{tokens, dispatches, wall_s, dollars}`) — *not* from build-stream, which gsd does not emit. (When un-budgeted, `budget_state` is `None` and nothing is recorded — preserving the byte-identical guarantee.)
- `checkGsdCumulativeBudget(composeDir, featureCode, { maxTotalTokens, maxTotalCostUsd })` — mirrors `checkCumulativeBudget`. `runGsd` (and `--resume`) calls it **before dispatch**; if exhausted, it refuses to start with the same structured `budget.md` diagnostic and a "raise `gsd.budget.cumulative.*` or `--reset-budget`" hint, rather than burning a run that will immediately re-trip.
- **Resume semantics (the real decision):** cumulative **tokens/cost** persist across sessions (hard ceiling — resume refuses if spent); per-run **wall-clock** and **dispatch** windows **reset** each invocation (they bound a single run, not the lifetime). This matches COMP-BUDGET-2 (cumulative iterations block start; per-loop wall-clock is per-run).

## Decision 4: `pause.json` gains a `kind` discriminator; `--resume` is shared

GSD-5's `pause.json` is `{ flowId, stepId, stuckTaskId, completedTaskIds[], reason, signal, … , mode:"gsd" }`. Add `kind: "stuck" | "budget"` (default `"stuck"` when absent, for back-compat with any existing pause files). The `--resume` machinery is **unchanged** — it reads `pause.json`, validates ownership (no live `pid`) + `mode==="gsd"`, skips `completedTaskIds`, and re-dispatches the rest into fresh worktrees. A budget halt resumes identically; the only added step is the Decision-3 cumulative pre-check (which a stuck resume also benefits from, harmlessly). **COMP-GSD-6** (crash-recovery) already plans to reuse this shape — the `kind` field is what lets it tell a budget pause from a stuck pause without re-deriving it.

## Decision 5: Per-task scope — wall-clock via the existing `timeout`, token cutoff deferred

The roadmap says "per task and per feature." Per-feature maps cleanly to the flow budget (Decision 1). For per-task:
- **Wall-clock:** expose `gsd.budget.per_task_ms` → the per-task `timeout` on the `execute` step (already enforced by `parallel_exec`). No new mechanism.
- **Tokens / dispatches per task:** **not** a v1 hard cutoff. Stratum's budget is flow-aggregate; a per-task token ceiling is a stratum-side change with no current consumer demand, and a runaway *single* task is already caught by the per-task `timeout` + the GSD-5 stuck detector. Deferred to `COMP-GSD-4-PERTASK-TOKENS` (filed at ship). Documented here so the gate reviews a scope cut, not a silent gap.

## Decision 6: Surface burn via `budget.json` + ledger in v1; defer the *live* OpsStrip pill

The roadmap row asks to "surface budget burn in cockpit OpsStrip." A *live* pill would need consumed-vs-cap streaming **during** the run — but `compose gsd` runs with a no-op `streamWriter` (`gsd.js:210`) and emits no build-stream telemetry, and the existing pill / `/api/lifecycle/budget` are iteration-loop-specific (review/coverage `per_loop_type`). Building a live gsd pill therefore means first giving gsd a real build-stream/active-build surface — a substrate change broader than budget and out of proportion for this ticket.

**v1 honest scope:** surface burn from the data that genuinely exists at a terminal — the `budget.json` diagnostic (consumed-vs-cap per axis, written on halt) and the cumulative ledger entry (already readable via the budget endpoint/ledger). **Defer the live cockpit pill** to `COMP-GSD-4-OPSSTRIP-LIVE`, which depends on a gsd-telemetry follow-up. This avoids overclaiming reuse of an iteration-loop surface that does not fit the gsd run. (Filed at ship; noted in the report.)

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `lib/gsd-budget.js` | new | Build the injected `budget:` block from `gsd.budget.*` config; compose the `budget.md`/`budget.json` diagnostic from the terminal envelope's `budget_state` (`caps` + `consumed`); thin helpers (no token-counting — that's stratum's). |
| `lib/gsd.js` | existing | Inject budget block into spec before `stratum.plan`; add `budget_exhausted` to terminal set + terminal branch (write diagnostics + `pause.json` `kind:"budget"`); cumulative pre-check on start/resume; record usage at each terminal. |
| `pipelines/gsd.stratum.yaml` | existing | No static budget block (opt-in by injection); optional `# budget injected at runtime` doc comment + per-task `timeout` plumbing for `per_task_ms`. |
| `lib/budget-ledger.js` | existing | `recordGsdUsage` + `checkGsdCumulativeBudget`; extend per-feature entry with `totalTokens`/`totalCostUsd` (back-compatible). |
| `contracts/gsd-stuck.json` | existing | Add the `budget` diagnostic block + `pause.json` `kind` enum. (Rename mention only; file stays the gsd pause/diagnostic contract.) |
| `bin/compose.js` | existing | `--resume` already routes to the gsd resume path; add `--reset-budget` (clear the feature's cumulative ledger entry) and surface budget-refusal messaging. |
| `test/gsd-budget.test.js` | new | block injection from config (present/absent → byte-identical), diagnostic shape from `budget_state`, ledger record/extend, `checkGsdCumulativeBudget`, resume-refusal-on-spent-ceiling, per-run reset of wall-clock/dispatch, usd cap. |
| `test/gsd-resume.test.js` | existing | extend: `kind:"budget"` pause round-trips and resumes via the same path. |

*(OpsStrip `src/components/cockpit/*` and `test/ui/ops-strip-budget.test.jsx` are **not** touched in v1 — the live gsd-burn pill is deferred to `COMP-GSD-4-OPSSTRIP-LIVE`; see Decision 6.)*

## Open Questions

*(none — Open Question 1 resolved at the gate; see Resolved Decision 7.)*

## Codex design-review findings — disposition

- **F1 — `usd` is enforced, not recorded-only (confirmed against source).** The 2026-05-29 STRAT-WORKFLOW-BUDGET report I leaned on is stale; `run_budget.py:budget_exhausted()` now hard-stops on `usd` (STRAT-WORKFLOW-BUDGET-DOLLARS, dollars derived from a token→USD pricing table; unpriced models under-count). **Disposition:** embraced — `gsd.budget.usd` is a real enforced cost cap; `max_tokens` documented as the reliable backstop for unpriced models. (Goal, Verified-substrate table, Decision 1.)
- **F2 — telemetry/UI reuse overclaimed (confirmed).** `compose gsd` runs with a no-op `streamWriter` (`gsd.js:210`), emits no `step_usage`/`build_end`, and the existing pill/endpoint are iteration-loop-specific. **Disposition (two parts):** (a) the diagnostic + ledger source from the terminal envelope's `budget_state` (`server.py:3839`/`:181`), *not* build-stream — verified present, so no stratum prerequisite; (b) the *live* OpsStrip pill is deferred to `COMP-GSD-4-OPSSTRIP-LIVE` (needs a gsd-telemetry surface that doesn't exist); v1 surfaces burn via `budget.json` + ledger (Decision 6).
- **Propagation claim — confirmed by Codex:** `budget_exhausted` is returned through the advancement chokepoints `runGsd`/`executeParallelDispatchServer` use once the loop adds it to its terminal set.

## Resolved Decisions
1. **Adopt, don't rebuild:** stratum's flow budget is the enforcement engine, all four axes (`ms`/`max_agent_dispatches`/`max_tokens`/`usd`) enforced (Decision 1).
2. **No stratum prerequisite:** `budget_exhausted` already propagates to the compose consumer *and carries `budget_state`* (Verified substrate, fact 1).
3. **Opt-in by injection:** absent config ⇒ no block ⇒ byte-identical (Decision 1).
4. **Per-feature enforced, per-task wall-clock via `timeout`, per-task tokens deferred** (Decision 5).
5. **Cumulative ceiling persists; per-run windows reset; resume refuses on spent ceiling** (Decision 3).
6. **Burn surfaced via `budget.json` + ledger in v1; live cockpit pill deferred** (Decision 6).
7. **Fully opt-in, no default caps** (gate decision, 2026-06-03): a gsd run is unbounded unless `gsd.budget.*` is set. Reinforces the byte-identical guarantee; GSD-5's wall-clock stuck guard is the coarse backstop.

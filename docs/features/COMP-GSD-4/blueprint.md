# COMP-GSD-4: Implementation Blueprint

**Status:** BLUEPRINT (Phase 4) — verified against source 2026-06-03
**Design:** [design.md](./design.md)
**Mirrors:** COMP-GSD-5 (`lib/gsd-stuck.js`, the `stuck` halt/pause/`--resume` path) — budget is the substrate-detected sibling of the compose-detected stuck signal.

## Related Documents
- `design.md` (this feature) · `contracts/gsd-stuck.json` (the pause/diagnostic contract, extended here) · `stratum/docs/features/STRAT-WORKFLOW-BUDGET{,-DOLLARS}/`.

---

## Corrections table (design assumption → verified reality)

| # | Design said | Reality (verified) | Resolution |
|---|---|---|---|
| 1 | "inject the `budget:` block into the spec string" | compose ships `yaml@^2.8.2`; `build.js:693/712` already does `YAML.parse(specYaml)` → mutate → `YAML.stringify`. | Inject **structurally**: `parsed.flows.gsd.budget = {...}` then re-stringify. No string/regex surgery. |
| 2 | budget arrives as `response.status==='budget_exhausted'` in the run loop | Stratum sets `terminal_status=BUDGET_EXHAUSTED` during the **parallel debit** (`server.py:283`); the *next* `parallelPoll`/`parallelAdvance` return carries `{status:'budget_exhausted', budget_state}`. For non-parallel steps it comes back from `stepDone` (`server.py:402/407`). | Add a guarded budget **short-circuit** inside `executeParallelDispatchServer` (mirrors the `stuckVerdict` short-circuit at `build.js:3069`) **and** add `budget_exhausted` to the run-loop terminal set. Belt-and-suspenders: handle both carriers. |
| 3 | per-task wall-clock via `gsd.budget.per_task_ms` → task `timeout` | The `execute` step in `gsd.stratum.yaml` declares no `timeout`; `parallel_exec` enforces a per-task `timeout` when present. | Inject `timeout` onto the `execute` step structurally too (same parse/stringify pass), iff `per_task_ms` configured. |
| 4 | diagnostic sourced from `budget_state` in the envelope | Confirmed: `server.py:181` (agent-run), `:3839` (advance/step) return `"budget_state": state.budget_state` = `{caps, consumed:{tokens,dispatches,wall_s,dollars}}`. | `writeBudgetArtifacts` reads `response.budget_state`. |
| 5 | `pause.json` gains `kind` | Current contract **requires** stuck-only fields (`stuckTaskId`,`signal` w/ stuck enum,`detail`). JSON-Schema `default` does **not** populate missing fields at validation. | `kind` stays **optional** (NOT added to `required`). Base `required` = kind-agnostic fields only. `if {kind:const "budget"}` then require the `budget` block; **`else`** (kind absent OR `stuck`) require the stuck fields — so existing kind-less `pause.json` files still validate. `--resume` reads only kind-agnostic fields (`decomposedTasks`,`completedTaskIds`,`pid`,`mode`), so the resume path is unchanged. (Codex blueprint-gate finding 2.) |
| 6 | resume lock is fine | **Codex blueprint-gate finding 1 (High):** `pause.lock` is an atomic `mkdirSync` claim made *inside* `loadResumeTaskGraph` (`gsd.js:598`), released by `clearPauseFile` **only on `complete`** (`gsd.js:166/691`). A resume that re-halts on budget/stuck, or a cumulative refusal *after* the claim, strands `pause.lock` and blocks future resumes (a **latent bug for stuck-on-resume today**, not new to budget). **Re-review refinement:** the claim at `:75` is *before* the existing `try` (`:119`), so a throw in the pre-`try` window (dirty-check `:87`, spec read `:108`, `connect` `:118`) would still strand it. | Add `releasePauseLock(cwd, feature)` (removes only `pause.lock`, keeps `pause.json`; idempotent `rmSync(..., {recursive,force})`) **and widen the `try`** so it opens immediately before the `loadResumeTaskGraph` claim (`:75`); the `finally` calls `releasePauseLock` **and** the existing stratum disconnect. Then *every* post-claim exit (complete/stuck/budget/refusal/throw, incl. the pre-dispatch window) is inside the cleanup scope. `pause.json` is still cleared by outcome (`clearPauseFile` on `complete` only). |
| — | `import YAML` at `build.js:34` | Now `build.js:37` (file shifted). | Cite generically: "`build.js` top-of-file `import YAML from 'yaml'`". |

No design contradictions — corrections are mechanism refinements, not scope changes.

---

## Implementation slices

### S1 — `lib/gsd-budget.js` (new) — config → budget block + diagnostic compositor
Pure, side-effect-free helpers (no token-counting; that's stratum's). Exports:
- `readGsdBudgetConfig(cwd)` — reads `.compose/compose.json` `gsd.budget`; returns `{}` if absent/unparseable (mirror `readGsdStuckConfig`, `gsd.js:467`). **No defaults** (gate decision 7): only keys the user set are returned.
- `buildBudgetBlock(cfg)` → `{ budget?: {ms,max_agent_dispatches,max_tokens,usd}, perTaskMs?: number }`. Maps snake_case config (`max_tokens`,`max_agent_dispatches`,`ms`/`per_run_ms`,`usd`,`per_task_ms`) → the stratum block. Returns `budget: undefined` when no run-level axis is set ⇒ caller injects nothing ⇒ byte-identical.
- `injectBudget(specYaml, cfg)` → string. When `buildBudgetBlock(cfg)` yields **nothing**, return `specYaml` **verbatim — no parse/stringify round-trip** (a round-trip can reorder/reformat YAML even with no semantic change, breaking byte-identity). Only when there IS something to inject: `YAML.parse` → set `flows.gsd.budget` (iff present) and `flows.gsd.steps[execute].timeout` (iff `per_task_ms`) → `YAML.stringify`. Test asserts `injectBudget(spec, {}) === spec` (exact string equality).
- `composeBudgetDiagnostic(budgetState, { feature, decomposedTasks, completedTaskIds })` → `{ json, md }`. Determines the tripped axis by comparing `consumed` vs `caps` (the axis where `consumed>=cap`), renders consumed-vs-cap per axis + remaining tasks + "raise `gsd.budget.*` or `--reset-budget`" guidance.

### S2 — `lib/budget-ledger.js` (existing) — cumulative gsd usage + check
Extend, back-compatible (new fields read as 0 when absent; existing iteration fields untouched):
- `recordGsdUsage(composeDir, featureCode, { tokens=0, costUsd=0, dispatches=0, timeMs=0 })` — adds `totalTokens`/`totalCostUsd` to the per-feature entry (alongside `totalIterations`/`totalActions`/`totalTimeMs`); pushes a `sessions[]` entry tagged `{ kind:'gsd', ... }`. Mirrors `recordIteration` (`budget-ledger.js:42`).
- `checkGsdCumulativeBudget(composeDir, featureCode, { maxTotalTokens, maxTotalCostUsd })` → `{exceeded, reason, usage}`. Mirrors `checkCumulativeBudget` (`:68`). **Cumulative tokens/cost only** — wall-clock/dispatch are per-run windows (design Decision 3), so they are NOT cumulative-checked.

### S3 — `lib/gsd.js` (existing) — wire injection, terminal handling, resume pre-check, recording
- **Inject** (after `specYaml` load, `gsd.js:108`): `specYaml = injectBudget(specYaml, readGsdBudgetConfig(cwd))`. Absent config ⇒ unchanged.
- **Cumulative pre-check** (before `stratum.plan`, ~`gsd.js:115`; also on the resume path): if `checkGsdCumulativeBudget(...)` exceeded → write the budget refusal diagnostic, return `{status:'budget', flowId:null, axis:'cumulative', reason}` **without dispatching**.
- **Terminal set** (`gsd.js:139`): add `&& response.status !== 'budget_exhausted'`.
- **Terminal branch** (after the loop, beside the `stuck` branch at `:147`): on `response.status==='budget_exhausted'` → `writeBudgetArtifacts(stepCtx, response, response.budget_state)`; `recordGsdUsage(...)` from `budget_state.consumed`; return `{status:'budget', flowId, axis, consumed, caps}`.
- **Record on clean finish** (`:166`): also `recordGsdUsage` from the run's final `budget_state` when present (so cumulative ledger tracks successful runs too), then `clearPauseFile`.
- **Release the resume lock — widen the `try/finally` to cover the claim** (correction #6): add `releasePauseLock(cwd, featureCode)` (new, beside `clearPauseFile` at `:691`; `rmSync(pause.lock, {recursive,force})` — removes the lock dir ONLY, keeps `pause.json`). **Move the `try {` opening (currently `:119`) up to immediately before the `loadResumeTaskGraph` claim (`:75`)** so the dirty-check/spec-read/connect window is inside it; the `finally` (`:175`) calls `releasePauseLock` **and** the existing `if (ownsStratum) disconnect`. Idempotent no-op when no lock was claimed (non-resume runs). Guarantees no `pause.lock` strand on *any* post-claim exit (budget/stuck re-halt, cumulative refusal, or a pre-dispatch throw) — and fixes the latent stuck-on-resume strand. `clearPauseFile` (complete-only) still removes both.
- **`writeBudgetArtifacts`** (new, beside `writeStuckArtifacts` at `:517`): writes `budget.json` + `budget.md` (via S1 `composeBudgetDiagnostic`) + `pause.json` with `kind:'budget'`, `decomposedTasks` (from `ctx.lastTaskGraph`), `completedTaskIds` (reuse `collectCompletedTaskIds`, `:494`), `pid`, `mode:'gsd'`. **Reuses** the GSD-5 persistence shape verbatim except `kind` + the `budget` block. (Does NOT touch `pause.lock` — that's the `finally`'s job.)

### S4 — `lib/build.js` (existing) — guarded budget short-circuit in `executeParallelDispatchServer`
Mirror the `stuckVerdict` short-circuit (`build.js:3069`). After the poll loop and after each `parallelAdvance`, if `pollResult.outcome?.status === 'budget_exhausted'` (or `advanceResult.status===...`): return the outcome envelope verbatim (it already carries `budget_state`) **without** the merge/advance bookkeeping. Guard makes it a no-op for build mode (build flows declare no budget ⇒ never terminal ⇒ branch never taken). No new args — the envelope itself signals it.

### S5 — `contracts/gsd-stuck.json` (existing) — `kind` + budget block
Per correction #5. Keep `_source`/`_roadmap` (add a `_also: "COMP-GSD-4"` note + extend the top-level description). Concretely on `definitions.pause`:
- Add `kind` to `properties` (enum `["stuck","budget"]`); **do NOT add it to `required`** (existing kind-less files must validate).
- Remove `stuckTaskId`,`signal`,`detail` from the base `required` array (leaving `flowId`,`stepId`,`decomposedTasks`,`completedTaskIds`,`pid`,`mode`,`ts`).
- Add a `budget` property: `{axis: enum["ms","max_agent_dispatches","max_tokens","usd"], consumed: object, caps: object}`.
- Add `if: {properties:{kind:{const:"budget"}}, required:["kind"]}` / `then: {required:["budget"]}` / `else: {required:["stuckTaskId","signal","detail"]}`. The `else` fires when `kind` is absent or `"stuck"` ⇒ existing stuck pauses keep their requires; budget pauses require the `budget` block instead.
- Set `additionalProperties:false` still holds — `kind` and `budget` are now declared, so no validation regression.

### S6 — `bin/compose.js` (existing) — `budget` result branch + `--reset-budget`
At the gsd result handling (`bin/compose.js:1993`): add `result.status==='budget'` → print `.compose/gsd/<code>/budget.md` path + `compose gsd <code> --resume` hint (or "raise caps" when `axis==='cumulative'`). Add `--reset-budget` flag → clear the feature's cumulative ledger entry before run (thread into `runGsd` opts).

---

## Boundary Map

### Produces (S1 `lib/gsd-budget.js`)
- `readGsdBudgetConfig(cwd) -> object` (function)
- `injectBudget(specYaml: string, cfg: object) -> string` (function) — identity when cfg is empty
- `buildBudgetBlock(cfg) -> {budget?, perTaskMs?}` (function)
- `composeBudgetDiagnostic(budgetState, meta) -> {json, md}` (function)

### Produces (S2 `lib/budget-ledger.js`)
- `recordGsdUsage(composeDir, featureCode, usage) -> entry` (function)
- `checkGsdCumulativeBudget(composeDir, featureCode, limits) -> {exceeded, reason, usage}` (function)

### Produces (S5 `contracts/gsd-stuck.json`)
- `pause.kind: "stuck"|"budget"` (const/enum) — consumed by S3 + the `--resume` reader
- `budget` definition `{axis, consumed, caps}` (type)

### Consumes
- S3 `gsd.js` consumes all of S1 + `recordGsdUsage`/`checkGsdCumulativeBudget` from S2.
- S3 + S1 consume the **stratum envelope** `budget_state = {caps, consumed:{tokens,dispatches,wall_s,dollars}}` (from S4's propagated outcome) — the cross-substrate contract, owned by stratum `run_budget.py`, not redefined here.
- S6 `bin/compose.js` consumes the `{status:'budget', axis, ...}` return shape from S3.
- S4 `build.js` consumes nothing new — it pattern-matches `outcome.status==='budget_exhausted'`.

---

## Phase 5 — Verification table

| Ref | Claim | Verified |
|---|---|---|
| `gsd.js:108` | `specYaml` loaded as string before `stratum.plan` | ✅ |
| `gsd.js:120` | `stratum.plan(specYaml, 'gsd', {...})` is the injection consumer | ✅ |
| `gsd.js:139-145` | run-loop terminal set (`complete`/`killed`/`stuck`) | ✅ |
| `gsd.js:147-155` | `stuck` terminal branch to mirror | ✅ |
| `gsd.js:467` | `readGsdStuckConfig` pattern to mirror for budget config | ✅ |
| `gsd.js:494` | `collectCompletedTaskIds` reusable for budget pause | ✅ |
| `gsd.js:517` | `writeStuckArtifacts` pattern to mirror | ✅ |
| `build.js` top + `:693/712` | `import YAML from 'yaml'` (top-of-file); parse→mutate→stringify precedent | ✅ |
| `gsd.js:74/598` | `loadResumeTaskGraph` claims `pause.lock` via atomic `mkdirSync` | ✅ |
| `gsd.js:175` | `runGsd` `finally` (stratum disconnect) — host for `releasePauseLock` | ✅ |
| `gsd.js:691` | `clearPauseFile` removes both `pause.json` + `pause.lock` (complete-only) | ✅ |
| `build.js:3069` | `stuckVerdict` short-circuit `return {...outcome, stuck}` to mirror | ✅ |
| `build.js:2992-3010` | `onEvent` subscription is stuck-only; budget needs **no** stream hook (substrate-side) | ✅ |
| `budget-ledger.js:42/68` | `recordIteration`/`checkCumulativeBudget` patterns to mirror | ✅ |
| `contracts/gsd-stuck.json#pause` | required fields incl. stuck-only `signal`/`detail`/`stuckTaskId` | ✅ |
| `bin/compose.js:1991-1999` | gsd result handling incl. `stuck` branch | ✅ |
| stratum `run_budget.py:budget_exhausted` | all four axes (`ms`,`max_agent_dispatches`,`max_tokens`,`usd`) enforced | ✅ |
| stratum `server.py:181/3839` | terminal envelope carries `budget_state` | ✅ |
| stratum `spec.py:IRBudgetDef` | flow-level `budget:` block shape | ✅ |

Zero stale refs. No Boundary Map violations (all produced symbols are new; consumed `budget_state` is an upstream-owned contract referenced, not declared).

## Tests (Phase 7)
- `test/gsd-budget.test.js` (new): `injectBudget` identity when unconfigured (byte-identical guarantee), block + per-task `timeout` injection when configured, `composeBudgetDiagnostic` axis detection + shape, `recordGsdUsage` extend/back-compat, `checkGsdCumulativeBudget` (tokens & cost), resume-refusal on spent ceiling, per-run reset of wall-clock/dispatch, `usd` cap.
- `test/gsd-resume.test.js` (extend): `kind:'budget'` pause round-trips + resumes via the unchanged path; **`pause.lock` is released on a budget/stuck re-halt and on cumulative refusal** (no strand — assert next resume can claim); existing kind-less pause file still resumes.
- Contract test (`test/contracts-gsd-stuck.test.js` or new): a kind-less (legacy) stuck pause validates; a `kind:'stuck'` pause validates; a `kind:'budget'` pause requires the `budget` block; a `budget` pause WITHOUT the block fails.

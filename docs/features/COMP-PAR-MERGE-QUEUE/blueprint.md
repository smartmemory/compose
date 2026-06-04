# COMP-PAR-MERGE-QUEUE — Implementation Blueprint

**Status:** BLUEPRINT (Phase 4 — verified anchors, not yet implemented).
**Date:** 2026-06-04 · **Design:** [design.md](design.md) · **Scope:** server-dispatch v1.
**Repos:** `stratum/stratum-mcp/` (primary) + `compose/` (consumer). Anchors verified against on-disk
source 2026-06-04 (load-bearing ones read directly; rest from a verification sweep — see §Verification).

## Two discoveries from blueprint verification (beyond the design)

1. **GSD `execute` lacks `defer_advance: true`.** `pipelines/gsd.stratum.yaml:89-97` has
   `isolation: worktree` + `capture_diff: true` + `merge: sequential_apply` but **no `defer_advance`**.
   In `build.js`, the structured-advance channel (`parallelAdvance`) fires **only** on the deferred
   path (`build.js:3160-3187`, gated on `outcome.status === 'awaiting_consumer_advance'`). Without
   `defer_advance`, GSD takes the **legacy path** (`build.js:3188-3210`) which **throws** on merge
   conflict — `parallelAdvance` is never reached. **⇒ This feature adds `defer_advance: true` to GSD
   `execute`.** Side effect (improvement): GSD conflict handling changes from hard-throw to
   report→re-dispatch-with-context. The *gate-failed* bounce does **not** need this (it flows through
   `ensure_failed` server-side regardless).
2. **Worktree gate has no `node_modules`.** `create_worktree` (`worktree.py:30-55`) does a bare
   `git worktree add --detach HEAD` at `~/.stratum/worktrees/<flow>/<task>`; `node_modules` (gitignored)
   is absent, so `pnpm lint`/`pnpm build` fail on missing deps. **⇒ The gate runner best-effort symlinks
   `node_modules` from the base repo into the worktree before running gate commands** (the dominant JS
   case; other ecosystems needing self-contained worktrees are a documented limitation). This also means
   GSD's *instructed* per-task gate isn't reliably runnable in the worktree today — the enforced gate is
   net-new capability, not just enforcement of an existing one.

## Corrections table (spec assumption vs reality)

| Design claim | Status | Anchor |
|---|---|---|
| Stratum applies no diffs; Compose owns merge | CONFIRMED | no `git apply` in `parallel_exec.py`; `build.js:3240` `applyTaskDiffsToBaseCwd` |
| No per-task gate field on `parallel_dispatch` today | CONFIRMED | `spec.py:132-164` model, `:596-648` schema — none |
| `source` JSONPath resolution exists to mirror for `pre_merge_verify` | CONFIRMED | `executor.py` `resolve_ref` (`$.input.*`→any type); used for `source` at the parallel-start resolve site |
| `_run_one` has a clean pre-capture insertion point | CONFIRMED (w/ caveat) | else-arm `parallel_exec.py:945-998`; capture in `finally` at `:1086` needs an added `and ts.gate_bounce is None` guard |
| `parallelAdvance` carries only `clean\|conflict` | CONFIRMED | `server.py` advance validates `not in ("clean","conflict")`; client `stratum-mcp-client.js:450-456` |
| Bounce is blind (`buildRetryPrompt` has no merge-conflict case) | CONFIRMED | `step-prompt.js:174-204`; `conflicts` param = decompose `no_file_conflicts` only |
| GSD uses server-dispatch | CONFIRMED | `gsd.js:435` calls `executeParallelDispatchServer` unconditionally |
| GSD `execute` has `defer_advance:true` | **FALSE** | absent at `gsd.stratum.yaml:89-97` → **add it** (discovery #1) |
| Worktree has deps to run the gate | **FALSE** | `worktree.py` bare `git worktree add`, no `node_modules` → **symlink** (discovery #2) |
| `gateCommands` default includes `pnpm test` per-task | CONFIRMED | `gsd.js:40` `['pnpm lint','pnpm build','pnpm test']` |

---

## STRATUM work units

### S1 — IR field `pre_merge_verify` (`spec.py`)
- **Model** (`IRStepDef`, after `defer_advance` ~`spec.py:154`): add
  `pre_merge_verify: list | str | None = None` (accept a literal list OR a `$.input.*` string).
- **Schema** (`_IR_SCHEMA_V03` StepDef props, after `"defer_advance"` ~`spec.py:648`):
  ```python
  "pre_merge_verify": {"oneOf": [
      {"type": "array", "items": {"type": "string", "minLength": 1}},
      {"type": "string"},  # JSONPath ref e.g. "$.input.pre_merge_gate"
  ]},
  ```
- **Builder** (`_build_step` return `IRStepDef(...)` ~`spec.py:1281-1327`): add
  `pre_merge_verify=s.get("pre_merge_verify"),`.
- **Fingerprint** (`_step_fingerprint` inclusion list ~`spec.py:1111-1163`, after `defer_advance`):
  add `"pre_merge_verify": getattr(step, "pre_merge_verify", None),` so a mid-run edit is tamper-detected.

### S2 — Resolution + executor plumbing (`executor.py` / `parallel_exec.py`)
- **Resolve at dispatch** (same site `source` resolves, the parallel-start path in `executor.py`):
  ```python
  pmv = step.pre_merge_verify
  if isinstance(pmv, str) and pmv.startswith("$"):
      pre_merge_verify = resolve_ref(pmv, state.inputs, state.step_outputs) or []
  elif isinstance(pmv, list):
      pre_merge_verify = pmv
  else:
      pre_merge_verify = []
  ```
  Pass `pre_merge_verify=pre_merge_verify` into `ParallelExecutor(...)`.
- **`ParallelExecutor.__init__`** (`parallel_exec.py:188-223`, after `capture_diff`): add
  `pre_merge_verify: list | None = None` → `self.pre_merge_verify = pre_merge_verify or []`.
- **`ParallelTaskState`** (`executor.py:925-964`, after `diff_error`): add
  `gate_bounce: dict | None = None`.

### S3 — Gate execution in the worktree (`parallel_exec.py` + `worktree.py`)
- **New helper** `run_pre_merge_gate(worktree_path, commands, timeout) -> dict | None` (in `worktree.py`,
  mirroring `capture_worktree_diff`'s subprocess pattern, `worktree.py:80-109`):
  - Best-effort symlink `node_modules`: if `<base>/node_modules` exists and `<worktree>/node_modules`
    doesn't, `os.symlink`. (Base = `self.state.cwd`; pass it in.) Failure is non-fatal (gate may still
    run for ecosystems that don't need it).
  - For each command: `subprocess.run(shlex.split(cmd), cwd=worktree_path, capture_output=True,
    check=False, timeout=timeout, env=env)`. First non-zero exit ⇒ return a bounce record
    `{task_id, reason:"gate_failed", command, exit_code, files: git diff --name-only HEAD,
    excerpt: (stdout+stderr)[-2048:]}`. All pass ⇒ return `None`.
- **Call site** (`parallel_exec.py` else-arm, after cert resolves, ~`:970`, before `finally`):
  ```python
  if ts.state == "complete" and self.pre_merge_verify and worktree_path_obj is not None:
      bounce = await asyncio.to_thread(
          run_pre_merge_gate, worktree_path_obj, self.pre_merge_verify, _eff_timeout, self.state.cwd)
      if bounce is not None:
          bounce["task_id"] = tid
          ts.gate_bounce = bounce
          ts.state = "failed"
          ts.error = "pre_merge_verify failed"
  ```
- **Capture guard** (`finally`, `parallel_exec.py:1086`): change `if self.capture_diff:` →
  `if self.capture_diff and ts.gate_bounce is None:` (skip capturing a gate-failed diff).

### S4 — Surface bounce records server-side (`server.py`)
- **Collect gate bounces** in `_evaluate_parallel_results` (`server.py:816-948`): walk
  `state.parallel_tasks`; for each `ts.gate_bounce`, append to a new `bounced_tasks: list[dict]` in the
  `evaluation` dict (alongside `per_task_cert_strs`, the existing pattern at `:843,:880-882`).
- **Widen advance/done input** to accept a structured merge result:
  - `stratum_parallel_advance` (`server.py` advance tool): accept `merge_status: str | dict`. Relax the
    `not in ("clean","conflict")` guard to also allow a dict `{status, bounced_tasks?}`. Derive the bare
    status (`merge_status["status"]` if dict) for the existing `merge_ok` check; merge any
    `merge_status["bounced_tasks"]` into the evaluation's `bounced_tasks`.
  - `_evaluate_parallel_results` `merge_status` param → `str | dict`; `merge_ok` computed from the
    derived status string.
- **Envelope**: add `"bounced_tasks": evaluation["bounced_tasks"]` to every `ensure_failed` /
  `retries_exhausted` / routed return (the `{**step_info, status:"ensure_failed", violations}` sites).
  Keep `violations` (strings) for back-compat; `bounced_tasks` is additive.

---

## COMPOSE work units (server-dispatch path)

### C1 — Build the `merge_conflict` bounce record (`build.js`)
- In `applyTaskDiffsToBaseCwd` (`build.js:3240`), conflict branch (sets `conflictedTaskId`/`conflictError`):
  also extract conflicting files from the git-apply error (`/patch failed: (.+?):\d+/g` over
  `conflictError`, fallback to the task's owned files). Surface them in the return alongside
  `conflictedTaskId`/`conflictError` (return shape already carries these — add `conflictFiles`).
- New tiny helper `buildMergeConflictBounce(taskId, error, files)` →
  `{task_id, reason:"merge_conflict", files, command:null, exit_code:null, excerpt: error.slice(-2048)}`.

### C2 — Pass structured conflict context through advance (`build.js`)
- DEFER PATH (`build.js:3160-3187`): replace `parallelAdvance(flowId, stepId, mergeStatus)` (`:3181`) with:
  ```js
  const advancePayload = mergeStatus === 'conflict'
    ? { status: 'conflict', bounced_tasks: [buildMergeConflictBounce(conflictedTaskId, conflictError, conflictFiles)] }
    : 'clean';
  const advanceResult = await stratum.parallelAdvance(flowId, stepId, advancePayload);
  ```
- The stuck-detector advance (`build.js:3068`, bare `'conflict'`) stays a bare string (back-compat).
- `stratum-mcp-client.js:450-456` `parallelAdvance` passes `merge_status` verbatim — **no client change**
  (JSON-serializes a dict fine). Update its JSDoc type to `'clean'|'conflict'|{status,bounced_tasks}`.

### C3 — Inject bounce context into the retry prompt (`step-prompt.js` + `build.js`)
- `buildRetryPrompt(stepDispatch, violations, context, conflicts, bouncedTasks = [])`
  (`step-prompt.js:174`): after the `conflicts` block (`:181`), add
  `if (bouncedTasks?.length) sections.push(buildBounceSection(bouncedTasks));`.
- New `buildBounceSection(bounced)`: per record render
  `Task <id> bounced (<reason>): files <files>; <command? "cmd: <command> (exit <code>)">\n<excerpt>`.
- Call sites: `build.js:1694` and `:2831` — pass `response.bounced_tasks` / `resp.bounced_tasks` as the
  5th arg.

### C4 — Flow input `pre_merge_gate` + YAML wiring (`gsd.js`, `gsd.stratum.yaml`)
- `gsd.js`: split the fast list — `const DEFAULT_FAST_GATE = ['pnpm lint','pnpm build'];` and
  `resolvePreMergeGate(cwd, override)` (mirror `resolveGateCommands:407`, default `DEFAULT_FAST_GATE`,
  honor `.compose/compose.json#preMergeGate` else fall back to lint+build subset of `gateCommands`).
  Pass it on `stratum.plan(... , { featureCode, gateCommands, pre_merge_gate })` (`gsd.js:260-263`).
- **Single-source instruction:** the per-task instructed gate (`decompose_gsd` injection +
  `validateAndRepairTaskGraph`, `gsd.js:558/581`) uses the **same fast list**; full `pnpm test` is
  instructed only at `ship_gsd`. (`gateCommands` retained for `ship_gsd`.)
- `gsd.stratum.yaml`:
  - declare `pre_merge_gate: {type: array}` in `workflow.input` (~`:18`) **and** `flows.gsd.input` (~`:38`).
  - `execute` step (`:89-97`): add `defer_advance: true` and `pre_merge_verify: "$.input.pre_merge_gate"`.
  - `ship_gsd` (`:113-141`): unchanged (already runs full suite); ensure its instruction names `pnpm test`.

### C5 — (optional) `build.stratum.yaml`
- `execute` already has `defer_advance: true`. Optionally add `pre_merge_verify: "$.input.pre_merge_gate"`
  guarded by a build-mode input. **Deferred unless trivial** — GSD is the closing target; keep v1 focused.

### C6 — Contract `contracts/par-merge-bounce.json` (new)
Per `contracts/review-result.json` convention: `$schema` draft-07, `$id`, `_source`
(`docs/features/COMP-PAR-MERGE-QUEUE/design.md`), `_roadmap` (`COMP-PAR-MERGE-QUEUE`), `title`
`ParMergeBounce`, `required: [task_id, reason, files, excerpt]`, props per the design's bounce record,
`additionalProperties: true`.

---

## Boundary Map

| Produces | Kind | Consumed by | Contract |
|---|---|---|---|
| `pre_merge_verify` field | `const` (IR field, `spec.py`) | `ParallelExecutor` resolve + gate | v0.3 schema |
| `gate_bounce` on task state | `type` (`ParallelTaskState.gate_bounce`) | `_evaluate_parallel_results` → `bounced_tasks` | `par-merge-bounce.json` |
| `bounced_tasks[]` on `ensure_failed` | `interface` (server envelope key) | compose `buildRetryPrompt` (5th arg) | `par-merge-bounce.json` |
| `pre_merge_gate` flow input | `const` (gsd.js `resolvePreMergeGate` → `plan` input) | Stratum `resolve_ref($.input.pre_merge_gate)` | array of strings |
| `parallelAdvance(dict)` structured payload | `function` (compose → MCP) | `stratum_parallel_advance` | `{status, bounced_tasks}` |
| `buildMergeConflictBounce()` | `function` (`build.js`) | `parallelAdvance` payload | `par-merge-bounce.json` |

Topology: S1→S2→S3→S4 (stratum, each depends on prior) ; C1→C2 and C3 depend on **S4** (envelope shape) ;
C4 depends on **S1/S2** (field + resolution) ; C6 (contract) gates C1/C3/S4 shape — author first.

## Phase 5 verification (load-bearing anchors directly verified 2026-06-04)

- [x] `gsd.stratum.yaml:89-97` execute lacks `defer_advance` (read) → S-discovery #1
- [x] `build.js:3142/3160-3210` defer vs legacy advance branch (read) → conflict-bounce needs defer
- [x] `parallel_exec.py:843-857` worktree setup, no node_modules (read) → S-discovery #2
- [x] `parallel_exec.py:945-998` else-arm gate insertion point + `:1086` capture guard (read)
- [x] `executor.py` `resolve_ref` handles `$.input.*`→list (verification sweep)
- [x] Re-confirm exact `server.py` advance-validation + `ensure_failed` return line(s) at edit time
- [x] Re-confirm `_step_fingerprint` field-list line at edit time

### Edit-time anchor re-verification (2026-06-04, dual read-only sweep) — 4 corrections

Both unverified anchors confirmed, plus four load-bearing location corrections vs the work units above:

| # | Blueprint said | Actual current location | Affects |
|---|---|---|---|
| K1 | `_step_fingerprint` field list in `spec.py` (~1111-1163) | **`executor.py:1103` (def), `:1142` `"defer_advance": getattr(step,...)`** | S1 fingerprint edit → **executor.py**, not spec.py |
| K2 | `ParallelTaskState` in `parallel_exec.py` (~925-964) | **`executor.py:947` `diff_error: str \| None = None`** | S2 `gate_bounce` field → **executor.py**, insert after `:947` |
| K3 | active pipelines at `pipelines/*.stratum.yaml` | **`compose/pipelines/`** (loaded via `gsd.js:127` `join(PACKAGE_ROOT,'pipelines','gsd.stratum.yaml')`); root `/forge/pipelines/` has **no** gsd file | C4/C5 edits → **compose/pipelines/** |
| K4 | `ensure_failed`/`retries_exhausted` returns "the sites" | **5 sites across two fns**: main eval `server.py:1107,1113-1125,1140-1150`; `_advance_after_parallel` `:1224-1236,:1249-1259` | S4 — add `bounced_tasks` to all 5 |

Confirmed-precise anchors (no change): `spec.py:154` (`defer_advance` field), `:648` (schema), `:1326` (`_build_step`); `parallel_exec.py:203/222` (`capture_diff`), gate insertion **after `:977`** (before fanout split `:983`), `:1086` capture guard; `executor.py:481/506` (`resolve_ref`), `:1856` (`source` resolve call site); `worktree.py:42` (bare worktree add), `:94` (`hooksPath=/dev/null`); `server.py:843` (`per_task_cert_strs`), `:1644` (advance guard). Compose: `build.js:3240/3301-3302/3334-3339` (conflict return), `:3161-3187` (defer advance `:3181`), `:3188-3210/3421` (legacy throw), `:3068` (stuck-detector bare), `:1694/:2831` (retry call sites, 4 args), `:3356` (`applyServerDispatchDiffsCore`); `step-prompt.js:174/180-182`; `gsd.js:40/127/260-263/407/435/528-529/558`; `compose/pipelines/gsd.stratum.yaml:14-20/36-38/89-111`; `compose/pipelines/build.stratum.yaml:347` (has `defer_advance`); `stratum-mcp-client.js:450-456`; `compose/contracts/review-result.json`.

## Test plan (TDD)

**Stratum (`stratum-mcp/tests/`):** (1) gate pass ⇒ diff captured, task complete; (2) gate fail ⇒
task failed, `gate_bounce` populated, diff NOT captured; (3) `$.input.pre_merge_gate` resolves to the
list; (4) absent `pre_merge_verify` ⇒ byte-identical (no gate, capture as before); (5) `bounced_tasks`
appears in `ensure_failed`; (6) advance accepts dict `{status:'conflict',bounced_tasks}` and bare
`'conflict'` (back-compat); (7) `_step_fingerprint` includes the field.

**Compose (`test/`):** (8) `buildMergeConflictBounce` shape + file extraction from git-apply error;
(9) defer-path advance sends structured payload on conflict, `'clean'` otherwise; (10) `buildRetryPrompt`
renders `bounced_tasks` (reason/files/excerpt); (11) `resolvePreMergeGate` default = lint+build, honors
override; (12) gsd plan passes `pre_merge_gate` input.

**Integration (server-dispatch):** (13) end-to-end gate-fail → bounce record → retry prompt carries it;
(14) end-to-end merge-conflict → structured advance → ensure_failed → retry prompt carries it.

## Open risks (for Codex review / impl)
- node_modules symlink portability (Windows, monorepo nested node_modules) — best-effort, documented.
- `defer_advance:true` on GSD interacts with GSD-5 stuck detector / GSD-6 heartbeat — cover in tests.
- File extraction from `git apply` stderr is heuristic — fall back to task `files_owned`.
- Excerpt must not leak secrets from gate stdout — bounded tail only; note in review.

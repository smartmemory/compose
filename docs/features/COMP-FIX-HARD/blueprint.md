# COMP-FIX-HARD: Implementation Blueprint

**Status:** BLUEPRINT
**Date:** 2026-05-01
**Design:** [`design.md`](./design.md)

## Corrections Table

Design assumptions that turned out wrong, with the real picture and corrective action.

| Design assumption | Reality | Evidence | Action |
|---|---|---|---|
| `emit_checkpoint` and `escalation` are new Stratum IR directives | No such IR fields. Stratum `retries: N` is the only retry primitive; failure paths handled in Compose. | `lib/build.js:1209-1230` (ensure_failed handler), no IR for either directive | **Implement entirely Compose-side.** No `bug-fix.stratum.yaml` schema additions for these — only the `bisect` step is YAML. Resolves Open Q1. |
| `test` step uses `on_failure_after_retries: emit_checkpoint` (YAML directive) | YAML doesn't support that. **Stratum** decides when retries are truly exhausted — it returns a terminal failure response status (exact string TBD in Phase 5, see Correction B). The `ensure_failed` log in `build.js` is per-iteration, not terminal. | `lib/build.js:1209-1230` (per-iteration log only), Correction B below | **Hook checkpoint emission in `build.js` on Stratum's terminal-failure response, guarded by `mode === 'bug'` and step in `{test, fix}`.** No YAML change. |
| `Agent(subagent_type="general-purpose", isolation="worktree")` is callable from Compose JS for Tier 2 escalation | No such Compose API exists. `isolation: worktree` is a Stratum IR field for `parallel_dispatch` specs, not an imperative JS dispatch. | `lib/build.js:2208-2210` (isolation field is read from Stratum spec response, not constructed) | **Tier 2 uses raw `git worktree add` + `stratum.runAgentText('claude', prompt, {cwd: wtPath})` + cleanup in `finally`.** Same pattern as parallel-dispatch worktrees at `lib/build.js:2676-2825`. |
| Hypothesis ledger I/O is bespoke | Pattern already exists. `gate-log-store.js` has the canonical idempotent-append + malformed-tolerance helpers. | `server/gate-log-store.js:46-102` | **`bug-ledger.js` is a near-clone of `gate-log-store.js`** — same idempotency check (compare `attempt`+`ts`), same malformed-line tolerance. |
| Ledger read injects into `buildRetryPrompt` at `lib/build.js:1244` | `buildRetryPrompt` is defined in `lib/step-prompt.js:158`; it is *called* from two sites in `build.js` (lines 1244 and 2133). Editing either call site misses the other. | `lib/step-prompt.js:158` (definition), `lib/build.js:1244` and `lib/build.js:2133` (call sites — Correction C) | **Inject hypothesis context inside `buildRetryPrompt` itself** (`lib/step-prompt.js:158`), not at the call sites. Single injection point covers both retry paths. |
| INDEX.md is the truth source for bugs | Compose convention is JSONL/JSON truth + markdown rendered. `roadmap-gen.js` does this for ROADMAP.md from `feature.json`. | `lib/roadmap-gen.js:34-80` | **Per-bug `checkpoint.md` + `hypotheses.jsonl` are truth; `INDEX.md` is rendered.** Add `bug-index-gen.js` mirroring `roadmap-gen.js`. Resolves Open Q3. |
| Worktree cleanup is TTL-based | No TTL anywhere. Cleanup is deterministic in `finally` blocks immediately after task completion. | `lib/build.js:2818-2825` (worktree remove), `lib/build.js:2864-2866` (parDir cleanup) | **Tier 2 worktrees clean up in `finally` after agent returns or checkpoint emits.** No daemon, no TTL. Resolves Open Q4. |
| `compose fix --resume` is a small addition | `runBuild` does support resume via `stratum.resume(flowId)` but the `fix` CLI handler doesn't parse `--resume` and doesn't load the flowId from active-build state. | `bin/compose.js:1080-1127` (fix handler), `lib/stratum-mcp-client.js:252-254` (resume API) | **Add `--resume` parsing + flowId loader in `bin/compose.js`. Pass through to `runBuild` as `opts.resumeFlowId`.** Resume semantics: re-run the failed step from scratch with ledger context (Open Q2 resolved by precedent — Stratum's resume re-enters the failed step). |
| `diagnose` retry can simply read `hypotheses.jsonl` | `buildRetryPrompt` (defined at `lib/step-prompt.js:158`, called from `lib/build.js:1244` and `lib/build.js:2133`) doesn't currently have `context.bug_code` threaded through. | `lib/step-prompt.js:158` (definition); `lib/build.js:1244, :2133` (call sites) | **Thread `bug_code` into `context` once at flow start (`lib/build.js:~485`) when `mode === 'bug'`.** The injection lives inside `buildRetryPrompt` (Correction C), so both call sites benefit automatically. |
| Bisect cost estimator is trivial | No estimator exists. Need a heuristic for N (commits to bisect across) × M (test run time). | N/A | **`bug-bisect.js` includes `estimateBisectCost(cwd, testCmd)`:** `N = log2(commits_since_last_known_good)`; `M` = run the test once and measure. Surface `~N × M sec` in the gate prompt. |

## File:Line Reference Map

Every modification point with the exact location and surrounding context.

### `compose/pipelines/bug-fix.stratum.yaml`

The ONLY YAML change is the new `bisect` step (per Q1 resolution: no other directives go in YAML).

| Line | Action | Diff |
|---|---|---|
| 71 (after contracts block) | ADD contract | `BisectResult: { skipped: bool, bisect_commit: str?, estimate_minutes: number, log_path: str?, summary: str }` |
| 115 (in functions block) | ADD function def | `bisect:` with `mode: compute`, `intent` describing classify→estimate→gate→run, `input: {task, diagnosis}`, `output: BisectResult`, `retries: 1` |
| 188-200 (between diagnose & scope_check in flow) | INSERT step | `- id: bisect, function: bisect, depends_on: [diagnose], inputs: {task: $.input.task, diagnosis: $.steps.diagnose.output}` |
| 199 | MODIFY | `scope_check.depends_on` → `[bisect]` (was `[diagnose]`) |

### `compose/lib/build.js`

> **Note:** Earlier instructions in this section that pointed at `ensure_failed`'s "after maxIter check" and `buildRetryPrompt` at line 1244 are SUPERSEDED by Corrections B and C below. The authoritative integration plan is in the Round 1 Corrections section. The table below documents only the call sites and contract changes that are still accurate.

| Location | Action | Detail |
|---|---|---|
| `runBuild` signature / entry | MODIFY | Accept `opts.mode: 'feature' \| 'bug'` (default `'feature'`). When `'bug'`, see Correction A for behavior diff. |
| `runBuild` opts handling | ADD | If `opts.resumeFlowId`, skip `stratum.plan()` and call `stratum.resume(opts.resumeFlowId)` instead. Same loop body. |
| `context` initialization in `runBuild` | ADD | `context.mode = opts.mode \|\| 'feature'`; `context.bug_code = (context.mode === 'bug') ? itemCode : null` |
| `startFresh` (`build.js:2884`) | MODIFY | When `mode === 'bug'`, call `stratum.plan(specYaml, flowName, { task: description })` instead of `{ featureCode, description }`. See Correction A. |
| Folder paths (`build.js:348` and similar) | MODIFY | Branch on `mode`: `'feature'` → `docs/features/<code>/`, `'bug'` → `docs/bugs/<code>/`. |
| Stratum terminal-failure response | ADD | (Anchor TBD in Phase 5 — see Correction B and Open Q6.) Emit checkpoint via `emitCheckpoint(context, stepId, terminalResult)` when Stratum signals retry-exhaustion-terminal AND `mode === 'bug'`. |
| After `diagnose` step completes | ADD | `appendHypothesisEntry(context.cwd, context.bug_code, {attempt, ts, hypothesis: result.root_cause, verdict: 'accepted', evidence_for: result.trace_evidence})` |
| After `retro_check` step completes | ADD | Read `attemptCounter.getIntervention()` for this bug. If `'escalate'`, run Tier 1 (Codex). If Tier 1 surfaces a hypothesis not present in ledger with `verdict: rejected`, gate Tier 2 (worktree + claude). |

### `compose/lib/bug-ledger.js` (NEW)

API mirrors `server/gate-log-store.js`:

```js
export function getHypothesesPath(cwd, bugCode)
export function appendHypothesisEntry(cwd, bugCode, entry)  // idempotent on (attempt, ts)
export function readHypotheses(cwd, bugCode)                // returns [], tolerates malformed lines
export function formatRejectedHypotheses(entries)            // returns markdown for prompt prefix
```

Entry shape (required: `attempt`, `ts`, `hypothesis`, `verdict`; optional: `evidence_for[]`, `evidence_against[]`, `next_to_try`, `agent`, `tokens_used`, `findings[]`).

### `compose/lib/bug-checkpoint.js` (NEW)

```js
export function emitCheckpoint(context, stepId, buildState, stepOutput)
  // Writes docs/bugs/<bug-code>/checkpoint.md
  // Calls regenerateBugIndex() to refresh INDEX.md

function getCurrentDiff(cwd)        // git diff --no-color HEAD, capped at 5000 chars
```

`checkpoint.md` template includes: timestamp, step that failed, retries exhausted count, current diff (capped), last failure (from `buildState.violations[0]`), pointer to `hypotheses.jsonl`, resume command (`compose fix <code> --resume`), and a "next steps" prompt.

### `compose/lib/bug-index-gen.js` (NEW)

Mirrors `lib/roadmap-gen.js`. Reads `docs/bugs/*/checkpoint.md`, extracts `Time` and metadata, renders `docs/bugs/INDEX.md` with columns: Bug | Last attempt | Open since | Status. Sorted by last-attempt desc.

```js
export function regenerateBugIndex(cwd)
```

### `compose/lib/bug-bisect.js` (NEW)

```js
export function classifyRegression(cwd, diagnosisResult, reproTestPath)
  // returns true iff: test exists in main branch AND
  //   diagnosis.affected_layers files were touched in last 10 commits

export function estimateBisectCost(cwd, testCmd, knownGoodRange)
  // N = log2(commits in knownGoodRange)
  // M = time the test takes (single run sample)
  // returns { test_runs: N, seconds_per_run: M, total_minutes: ~N*M/60 }

export async function runBisect(cwd, testCmd)
  // Driver for `git bisect start && git bisect bad HEAD && git bisect good <last-known-good> && git bisect run <testCmd>`
  // returns { bisect_commit, log_path }
```

### `compose/lib/bug-escalation.js` (NEW)

```js
export async function tier1CodexReview(stratum, context, bug, reproTest, currentDiff, hypotheses)
  // Constructs codexPrompt with hypotheses block, dispatches via stratum.runAgentText('codex', prompt, {cwd}),
  // parses to canonical ReviewResult shape, appends to ledger as { verdict: 'escalation_tier_1', agent: 'codex' },
  // returns the ReviewResult.

export async function tier2FreshAgent(stratum, context, codexReview, hypotheses, checkpointPath)
  // Creates worktree: git worktree add <wtPath> --detach HEAD
  // Dispatches: stratum.runAgentText('claude', prompt, {cwd: wtPath}) — fresh context, no prior reasoning
  // Mandate: produce docs/bugs/<bug-code>/escalation-patch-<N>.md (diagnosis + proposed patch as text)
  // Cleanup in finally: git worktree remove <wtPath> --force
  // NEVER commits — patch artifact only, original session decides whether to apply.
```

`tier1CodexReview` reuses the canonical `ReviewResult` schema from `lib/review-normalize.js:140-221` and the codex dispatch pattern from `lib/build.js:1768-1795`.

### `compose/bin/compose.js`

| Line | Action |
|---|---|
| 1098 (after `const abort = ...`) | ADD: `const resume = filteredArgs.includes('--resume')` |
| 1100-1108 (usage help) | ADD: `--resume` line |
| 1118-1121 (runBuild call) | MODIFY: if `resume`, load flowId from `<cwd>/.compose/data/active-build.json` and pass `opts.resumeFlowId = flowId` |

### Tests

| File | Coverage |
|---|---|
| `test/bug-ledger.test.js` | append idempotency on `(attempt, ts)`; malformed-line tolerance; `formatRejectedHypotheses` output shape |
| `test/bug-checkpoint.test.js` | emit → file exists with right fields → INDEX.md regenerated → resume reads it back |
| `test/bug-index-gen.test.js` | scan dir of fake bug folders → INDEX.md sorted, formatted |
| `test/bug-bisect.test.js` | classifier on synthetic git repo (regression detected vs not) — uses tmpdir + `git init` + scripted commits |
| `test/bug-escalation.test.js` | Tier 1 dispatch shape (mock `stratum.runAgentText`); Tier 2 worktree create + cleanup in finally on both success and error paths |
| `test/bug-fix-pipeline.integration.test.js` | full flow: simulated hard bug → diagnose retries → ledger persists → test fails → checkpoint emits → resume → ledger context shows up in retry prompt → escalation fires |

## Open Question Resolutions

> Authoritative table is in the **Updated Open Questions** section under Codex Round 1 Corrections. The earlier draft of this table (Q5 marked OPEN, Q6 marked confirmed) has been removed to eliminate the contradiction Codex Round 3 flagged.

## New Findings (Beyond the Original Design)

1. **`bug_code` threading risk.** `buildRetryPrompt` (defined at `lib/step-prompt.js:158`, called from `lib/build.js:1244` and `lib/build.js:2133`) is generic across pipelines. Threading `context.bug_code` through requires passing it via the existing `context` object — already plumbed to both call sites. Set on context once at flow start when `mode === 'bug'`.

2. **INDEX.md write contention.** If two `compose fix` invocations run concurrently in the same project (rare but possible), both regenerate `INDEX.md`. Mitigation: `regenerateBugIndex()` reads-then-writes atomically via temp-file rename. Standard pattern; not blocking.

3. **Bisect baseline ("last known good") needs a source.** Options: (a) git tag matching `v*` or `release-*`, (b) the commit before any file in `affected_layers` was last touched, (c) human-supplied via gate prompt. Recommend (a) with fallback to (c). Default range = last 50 commits if no tag found.

4. **Tier 2 prompt construction is the load-bearing piece.** The fresh agent must get: bug description, repro test, current diff, full `hypotheses.jsonl`, Codex's Tier-1 finding, and **explicit instructions not to commit**. The prompt template lives in `bug-escalation.js`; needs review in Phase 6 plan.

5. **Stratum's `resume` API confirmed working.** `lib/stratum-mcp-client.js:252-254` shows `resume(flowId)` is callable. No new Stratum work needed for `--resume`.

## Codex Review Round 1 — Corrections

Codex review surfaced 4 findings, all verified against the code. Each is a real blocker.

### Correction A: `compose fix` is currently broken end-to-end (also affects shipped COMP-FIX)

**Finding:** `runBuild()` at `lib/build.js:2886` calls `stratum.plan(specYaml, flowName, { featureCode, description })`. The `bug_fix` flow at `pipelines/bug-fix.stratum.yaml:179-181` expects input `{ task: string }`. `$.input.task` is therefore `undefined` when the bug-fix flow runs — every step that references `$.input.task` (every step) gets nothing.

Beyond input plumbing: `runBuild` hardcodes `docs/features/<code>/` (`lib/build.js:348`), uses feature-JSON semantics (`lib/feature-json.js:4`), and ship logic at `lib/build.js:1392, 1584` is feature-shaped, not bug-shaped.

**Implication:** The `cmd === 'fix'` handler shipped in commit `8cb858b` plumbs the CLI but the underlying pipeline never receives a usable input. COMP-FIX-HARD must include the runner-level "bug mode" that COMP-FIX assumed but didn't deliver.

**Action:** Add to file list:
- `lib/build.js` (modify): `runBuild` accepts an `opts.mode` parameter (`'feature' | 'bug'`). When `mode === 'bug'`, `stratum.plan` is called with `{ task: description }` instead of `{ featureCode, description }`; folder paths use `docs/bugs/<code>/`; ship logic skips feature-JSON updates.
- `bin/compose.js` (modify): The current `cmd === 'fix'` handler at `bin/compose.js:1080` accepts only `<bug-code>`. Extend the CLI surface so a description is available as the flow's `task` input. Three options, picking (b):
  - (a) `compose fix <bug-code> "<description>"` — additional positional arg
  - **(b) `compose fix <bug-code>` reads description from `docs/bugs/<bug-code>/description.md`** (mirrors how feature mode reads `docs/features/<code>/description.md` or feature.json's `description` field). If the file doesn't exist, prompt user to create it before running, with a one-line scaffold (`# <bug-code>: <one-sentence symptom>` + sections for repro steps / expected vs actual). This matches feature-mode UX and keeps the bug folder as the single source of truth.
  - (c) `compose fix <bug-code> --description-file <path>` — flexible but verbose
- `lib/feature-json.js` (no change) — bug mode skips this entirely.

Not a refactor of `runBuild`; an additive mode flag with branched behavior at the documented divergence points.

### Correction B: Checkpoint emit anchor doesn't exist where blueprint claimed

**Finding:** `lib/build.js:1209-1230` is the `ensure_failed` handler, but it only **logs** `iterN/maxIter` — there is no `if (iterN > maxIter)` decision branch. The displayed `maxIter = 3` is hardcoded (line 1224) and ignores the YAML's `retries: 5` on the `test` step. Stratum, not Compose, decides when retries are truly exhausted: it returns a different terminal status when the retry budget is gone.

**Action:** Anchor checkpoint emission to **Stratum's terminal-failure response**, not a Compose-side iteration count. Search `build.js` for the response status that fires when Stratum has given up (likely `'failed'` or `'retries_exhausted'` — confirmed in Phase 5 verification by reading the response handling block fully). Wire `emitCheckpoint` there, gated on `mode === 'bug'`. The blueprint's earlier "after line 1229" instruction is replaced.

Also: file a separate ticket `COMP-MAXITER-DRIFT` to fix the hardcoded `maxIter = 3` log when the YAML declares more — log message is misleading. Not blocking COMP-FIX-HARD.

### Correction C: `buildRetryPrompt` injection has two call sites

**Finding:** `buildRetryPrompt` is defined at `lib/step-prompt.js:158`, not `lib/build.js`. It is called from:
- `lib/build.js:1244` (top-level retry path)
- `lib/build.js:2133` (child-flow retry path inside `executeChildFlow`)

The blueprint's "modify line 1244" instruction misses the second site, so child-flow diagnose retries would not see the ledger.

**Action:** Inject hypothesis context **inside `buildRetryPrompt` itself** (`lib/step-prompt.js:158`), not at the call sites. The function already receives `context` — add a check: if `context.mode === 'bug'` and the step being retried is `diagnose`, prepend `formatRejectedHypotheses(readHypotheses(context.cwd, context.bug_code))`. Single injection point, both retry paths covered.

### Correction D: Existing `debug-discipline.js` already does most of what the design proposed

**Finding:** `lib/debug-discipline.js` already implements:
- `FixChainDetector` (line ~30) — same as design's "fix chain detection"
- `AttemptCounter` (line 69) — escalates visual bugs at attempt 2 and all bugs at attempt 5 (the design proposed `≥ 3` for visual; this is a design revision — see Threshold reconciliation below)
- `DebugLedger` (separate class) — global persistence
- `CrossLayerAudit` — already implements `scope_check`'s cross-layer audit

State persists in `.compose/debug-state.json`, loaded at `lib/build.js:351`, saved at `:856, :892, :1313, :1349`. The counters are **project-global**, not per-bug.

**Implication:** The design's "hypothesis ledger" and "checkpoint INDEX" cannot live alongside `debug-state.json` as a parallel system — they must integrate. Two options:

| Option | Approach | Tradeoff |
|---|---|---|
| **D1: Extend `debug-discipline.js`** | Add per-bug keying to `AttemptCounter` and `FixChainDetector`. `debug-state.json` becomes `{ [bug_code]: { attempt, fixChain, ... } }`. New `HypothesisLedger` class lives alongside. | Touches existing code; need to migrate `debug-state.json` schema. Single source of truth. |
| **D2: Per-bug folder owns its own state** | `docs/bugs/<code>/hypotheses.jsonl` is truth for that bug; `debug-state.json` stays project-global for *cross-bug* signals only. `retro_check` reads both. | No migration. But two systems to keep in sync; double bookkeeping on attempt count. |

**Recommendation: D1.** Single source of truth is worth the migration cost. `debug-state.json` schema becomes per-bug-keyed; reads/writes get the bug code.

**Threshold reconciliation — design change accepted:** the design at `design.md` Decision 5 referenced `attempt_count ≥ 3` for visual/CSS escalation; the existing `AttemptCounter.getIntervention()` at `lib/debug-discipline.js:69-90` escalates visual at attempt 2 and all bugs at attempt 5. Adopt the existing thresholds (visual@2, all@5) verbatim — they are battle-tested and the design's `≥ 3` was a guess. **This is a design revision, not pre-existing alignment.** The `design.md` Decision 5 should be updated in Phase 9 (docs) to reflect the actual thresholds.

**Action:**
- `lib/debug-discipline.js` (modify): `AttemptCounter` and `FixChainDetector` gain `bugCode` keying; serialize as `{ [bug_code]: state }`
- `lib/debug-discipline.js` (extend): new `HypothesisLedger` class wraps `bug-ledger.js` JSONL ops, exposes `appendHypothesis`, `readHypotheses`, `formatRejected`
- Schema migration: read old format on load; if no `bug_code` keys, treat the whole object as the entry for `__legacy__` and continue
- `bug-ledger.js` (NEW, simpler than original blueprint): pure JSONL helpers, no policy. `HypothesisLedger` in `debug-discipline.js` is the policy layer.
- `lib/build.js` retro_check post-processing: call `attemptCounter.getIntervention()` with the bug's per-bug state; route `'escalate'` to Tier 1 + maybe Tier 2 (existing logic, just now bug-keyed)

### Updated File List

| File | Action | Updated purpose |
|---|---|---|
| `lib/build.js` | Modify | Add `mode: 'bug'` branch in `runBuild`; bug-keyed state load/save; checkpoint emit on Stratum terminal failure (anchor TBD in Phase 5); call `attemptCounter.getIntervention()` keyed by bug |
| `lib/debug-discipline.js` | Modify | Per-bug keying on `AttemptCounter` and `FixChainDetector`; new `HypothesisLedger` class; schema migration |
| `lib/feature-json.js` | No change | Bug mode skips it entirely |
| `lib/step-prompt.js` | Modify | `buildRetryPrompt` prepends rejected-hypothesis block when `context.mode === 'bug'` and step is `diagnose` |
| `pipelines/bug-fix.stratum.yaml` | Modify | Add `bisect` step + contract (unchanged from earlier blueprint section) |
| `lib/bug-ledger.js` | New | Pure JSONL append/read helpers — no policy |
| `lib/bug-checkpoint.js` | New | `emitCheckpoint(context, stepId, terminalResult)` writes `checkpoint.md`, calls `regenerateBugIndex` |
| `lib/bug-index-gen.js` | New | Mirrors `roadmap-gen.js` for `INDEX.md` |
| `lib/bug-bisect.js` | New | Classify, estimate, run |
| `lib/bug-escalation.js` | New | Tier 1 (codex via `stratum.runAgentText`) + Tier 2 (raw worktree + claude). Trigger from existing `attemptCounter.getIntervention() === 'escalate'`. |
| `bin/compose.js` | Modify | `--resume` flag; pass `mode: 'bug'` to `runBuild` |

Test files unchanged from earlier section.

### Updated Open Questions

| Q | Status | Resolution |
|---|---|---|
| Q1 (Stratum vs Compose) | **RESOLVED** | Compose-side. |
| Q2 (`--resume` semantics) | **RESOLVED** | Stratum's `resume` re-enters failed step. |
| Q3 (truth model) | **RESOLVED** | JSONL truth, INDEX rendered. **But:** `debug-state.json` is also truth for project-global counters — both coexist after Correction D. |
| Q4 (worktree cleanup) | **RESOLVED** | `finally` block, no TTL. |
| Q5 (escalation cost ceiling) | **RESOLVED via Correction D** | Existing `AttemptCounter.getIntervention()` returns `'escalate'` at visual@2 / all@5. Tier 1 fires on first escalate; Tier 2 fires only if Tier 1 surfaces something materially new (per design Decision 5). No new ceiling needed; existing thresholds become the policy. |
| **NEW Q6 (checkpoint anchor)** | **OPEN — resolve in Phase 5 verification** | The exact response status from Stratum that signals retry-exhaustion-terminal needs to be confirmed by reading `build.js` response-handling block end-to-end. Likely `'failed'` or `'retries_exhausted'`. |

## Phase 5 Verification

All file:line references spot-checked against actual code. Key matches confirmed:
- `lib/step-prompt.js:158` — `buildRetryPrompt` definition ✓
- `lib/build.js:1244, :2133` — two call sites ✓
- `lib/debug-discipline.js:85-90` — `AttemptCounter.getIntervention()` thresholds (visual@2, all@5) ✓
- `lib/build.js:2886` — `stratum.plan(specYaml, flowName, { featureCode, description })` ✓
- `lib/build.js:618, :1398` — main loop terminates on `'complete' | 'killed'` ✓
- `lib/build.js:1209` — `ensure_failed` handler ✓
- `server/gate-log-store.js:46-102` — JSONL append/read pattern ✓

### Q6 Resolution — Stratum does NOT enforce retry caps

**Critical finding:** `stratum-mcp/src/stratum_mcp/executor.py` declares `retries: dict[str, int]` (lines 101, 111) on flow state but **the field is never read or written by the executor**. The pipeline YAML's `retries: 5` on the `test` step is parsed by `spec.py:71` (validated as a known field) but never enforced. Stratum returns `'ensure_failed'` indefinitely until the agent's output passes the postcondition, OR the consumer (Compose) stops calling `stepDone`.

Compose's `maxIter = 3` log at `build.js:1224` is **purely cosmetic** — it's a display string, not an enforced cap. (File `COMP-MAXITER-DRIFT` follow-up.)

**Implication:** there is no Stratum-side terminal-failure-from-retry-exhaustion status to detect. The checkpoint anchor must be **Compose-side enforcement**.

### Q6 Resolution — Compose-side retry enforcement design

Add to scope of COMP-FIX-HARD (or split as a sibling ticket — recommend in-scope since this work is needed for the feature to function as designed):

1. **Parse `retries` from the loaded YAML spec.** The spec is already in memory at `lib/build.js:428` (`specYaml = readFileSync(specPath, 'utf-8')`). Extract per-step `retries` values once into a `Map<stepId, retriesCap>`.
2. **Per-step iteration counter in `runBuild`.** `currentState.retries` already increments per ensure_failed at `build.js:1218-1222`. Use it.
3. **Enforcement check inside the `ensure_failed` branch.** After incrementing, if `iterN > retriesCap.get(stepId)`, emit checkpoint (when `mode === 'bug'` and step in `{test, fix, diagnose}`) and **force-terminate** the flow:
   - Call a new `stratum.killFlow(flowId, reason)` if Stratum exposes it (verify in `stratum-mcp-client.js`)
   - OR break out of the while loop with `buildStatus = 'failed'` set, falling through to the existing failed-build terminal handler at `build.js:1407-1417`
4. **Surface the cap in logs.** Replace the hardcoded `maxIter = 3` at `build.js:1224` with `retriesCap.get(stepId) ?? 3` so users see the real cap.

This is an additive enforcement layer, not a rewrite. The retry loop body is unchanged; only the exit condition gains a real cap.

**File-list addition:**
- `lib/build.js` (modify): parse retries cap from spec at flow start; per-step counter; enforce cap in `ensure_failed` branch; emit checkpoint on cap exceeded for bug mode.

**New consideration:** this enforcement applies to feature-mode builds too (the cap was always silently absent there as well). For feature mode, the cap-exceeded path should still terminate with `buildStatus = 'failed'` — same outcome as today, just with an explicit cause. Checkpoint emit only fires for bug mode. Document this in the design.md update during Phase 9.

### Other Phase 5 spot-checks

- `lib/build.js:485` — confirmed `context` object initialization site for adding `context.mode` and `context.bug_code`.
- `lib/feature-json.js:4` — confirmed feature-JSON helpers; bug mode skips entirely.
- `lib/stratum-mcp-client.js:252-254` — confirmed `resume(flowId)` is callable for `--resume`.
- `lib/stratum-mcp-client.js:509-516` — confirmed `runAgentText('codex', prompt, {cwd})` for Tier 1 escalation.
- `lib/build.js:2818-2825` — confirmed worktree cleanup in `finally` block (Tier 2 will reuse this pattern).

### Open Questions (post-verification)

- Q6: **RESOLVED** as above (Compose-side enforcement, not Stratum-side detection).
- All other open questions resolved earlier remain resolved.

## Implementation Sequence (input to Phase 6 plan)

1. New helpers (`bug-ledger.js`, `bug-checkpoint.js`, `bug-index-gen.js`) — pure, easy to TDD
2. Wire ledger read into `buildRetryPrompt` in `lib/step-prompt.js` (single injection point covers both `build.js:1244` and child-flow `build.js:2133` call sites — Correction C)
3. Wire checkpoint emit into Stratum's terminal-failure response handling in `lib/build.js` (anchor confirmed in Phase 5)
4. New `bisect` step in YAML + `bug-bisect.js` driver
5. `--resume` flag in `bin/compose.js`
6. Tier 1 escalation in `bug-escalation.js` + wire-up in `retro_check` post-processing
7. Tier 2 escalation (worktree pattern) in `bug-escalation.js`
8. Integration test through the full pipeline

Steps 1–3 unblock the bulk of the value; 4–7 layer on. 8 closes the gate.

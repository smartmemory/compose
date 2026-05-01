# COMP-FIX-HARD: Implementation Plan

**Status:** PLAN
**Date:** 2026-05-01
**Design:** [`design.md`](./design.md) · **Blueprint:** [`blueprint.md`](./blueprint.md)

## Approach

Layered build, TDD per task, sequential where dependencies require it, parallel where independent. Tasks 1–3 are pure helpers and can be developed in parallel. Tasks 4–5 (runner bug-mode + retry-cap enforcement) are the load-bearing prerequisites for everything downstream. Tasks 6–10 layer on. Task 11 is the integration test that closes the gate.

Total: 11 tasks. Estimated 2–3 days for the 8-step pipeline value (tasks 1–7); +1–2 days for escalation tiers + integration (tasks 8–11).

## Tasks

### T1 — `lib/bug-ledger.js` (parallel-safe)

**File:** `compose/lib/bug-ledger.js` (new)
**Pattern reference:** `compose/server/gate-log-store.js:46-102`

Pure JSONL helpers for `docs/bugs/<bug-code>/hypotheses.jsonl`.

**Acceptance criteria:**
- [ ] `getHypothesesPath(cwd, bugCode)` returns `docs/bugs/<bugCode>/hypotheses.jsonl`
- [ ] `appendHypothesisEntry(cwd, bugCode, entry)` appends one JSON line; idempotent on `(attempt, ts)`; creates parent dir if missing
- [ ] `readHypotheses(cwd, bugCode)` returns array; tolerates malformed lines with stderr warn (matches `gate-log-store.js` pattern)
- [ ] `formatRejectedHypotheses(entries)` returns markdown block with header `## Previously Rejected Hypotheses`; empty string when no rejected entries
- [ ] Required entry fields: `attempt`, `ts`, `hypothesis`, `verdict`. Optional: `evidence_for[]`, `evidence_against[]`, `next_to_try`, `agent`, `tokens_used`, `findings[]`

**Test:** `compose/test/bug-ledger.test.js` (new) — golden flow: append → read → idempotent re-append → malformed-line tolerance → formatter output shape.

---

### T2 — `lib/bug-checkpoint.js` (parallel-safe with T1)

**File:** `compose/lib/bug-checkpoint.js` (new)
**Pattern reference:** none specific; standard fs writes

Emits `checkpoint.md` and triggers index regeneration.

**Acceptance criteria:**
- [ ] `emitCheckpoint(context, stepId, terminalResult)` writes `docs/bugs/<bug_code>/checkpoint.md`
- [ ] Checkpoint contains: timestamp, step that failed, retries-exhausted count, current diff (capped at 5000 chars via `git diff --no-color HEAD`), last failure summary from `terminalResult.violations[0]`, hypothesis ledger pointer, resume command (`compose fix <code> --resume`), "next steps" section
- [ ] Calls `regenerateBugIndex(context.cwd)` after writing
- [ ] If `git diff` fails, fall back to `(unable to get diff)` placeholder; never throws
- [ ] `getCurrentDiff(cwd)` is a private helper; no exports beyond `emitCheckpoint`

**Test:** `compose/test/bug-checkpoint.test.js` (new) — emit → file exists with all required sections → diff capped at limit → graceful fallback when no git repo.

---

### T3 — `lib/bug-index-gen.js` (parallel-safe with T1, T2)

**File:** `compose/lib/bug-index-gen.js` (new)
**Pattern reference:** `compose/lib/roadmap-gen.js:34-80`

Renders `docs/bugs/INDEX.md` from per-bug `checkpoint.md` files.

**Acceptance criteria:**
- [ ] `regenerateBugIndex(cwd)` scans `docs/bugs/*/checkpoint.md`, extracts metadata, writes `docs/bugs/INDEX.md`
- [ ] Output table columns: Bug | Last attempt | Open since | Status. Sorted by last-attempt desc.
- [ ] Atomic write: temp file + rename (handles concurrent invocations from blueprint Finding #2)
- [ ] No-op when `docs/bugs/` doesn't exist
- [ ] Bugs with no checkpoint (e.g. just a description.md) appear in INDEX with status `OPEN` and `(no attempts yet)` for the time columns

**Test:** `compose/test/bug-index-gen.test.js` (new) — populate fake bugs dir → render → verify sort order, format, atomic write.

---

### T4 — `runBuild` bug-mode branch (blocks T6, T7, T8, T9, T10)

**File:** `compose/lib/build.js` (existing)
**Pattern reference:** Existing feature-mode flow as template; branch on `mode`.

Adds `mode: 'feature' | 'bug'` to `runBuild` and threads it through.

**Acceptance criteria:**
- [ ] `runBuild(itemCode, opts)` reads `opts.mode` (default `'feature'`)
- [ ] When `mode === 'bug'`: `startFresh` (`build.js:2884`) calls `stratum.plan(specYaml, flowName, { task: description })` — NOT `{ featureCode, description }`
- [ ] Folder paths branch on mode at **all three `featureDir` binding sites**: `build.js:348` (top-level `const featureDir`), `build.js:612` (inside `const context = { ... featureDir: ... }`), and `build.js:1584` (separate string used for staging at line 1616). All three must read from a single `itemDir` resolver: `mode === 'bug' ? join(cwd, 'docs', 'bugs', code) : join(cwd, 'docs', 'features', code)`. Missing any one site causes downstream code reading `context.featureDir` to still resolve to features/ in bug mode.
- [ ] `context` object (verified at `build.js:609` — `const context = { ... }`) gains `context.mode` and `context.bug_code` (when `mode === 'bug'`)
- [ ] Bug mode skips `feature-json.js` ship-time updates entirely; vision-item update still fires (bugs are valid vision items)
- [ ] `lib/feature-json.js` (existing) — NO CHANGES
- [ ] Bug description source: `bin/compose.js` reads `docs/bugs/<bug-code>/description.md` and passes content as `description` to `runBuild`. If missing, scaffold a minimal one and prompt user to fill before proceeding.

**Test extensions:** existing `runBuild` tests stay green; one new test in `compose/test/run-build-bug-mode.test.js` (new) — verify input shape passed to `stratum.plan` differs by mode.

---

### T5 — Compose-side retry-cap enforcement + checkpoint emit (blocks T7, T9; depends on T2, T4)

**File:** `compose/lib/build.js` (existing)
**Anchor:** `ensure_failed` branch at `build.js:1209`

Resolves Phase 5 finding: Stratum doesn't enforce `retries`. Compose must.

**Acceptance criteria:**
- [ ] At flow start (`runBuild`, after spec parsed at `build.js:428`), build `retriesCap: Map<stepId, number>` from the YAML's per-step `retries` fields.
- [ ] Replace `const maxIter = 3` at `build.js:1224` with `const maxIter = retriesCap.get(stepId) ?? 3` so the displayed cap matches the YAML.
- [ ] In the `ensure_failed` branch (`build.js:1209-1230`), after incrementing the per-step counter, check `iterN > maxIter`. When exceeded:
  - [ ] If `context.mode === 'bug'` AND `stepId in {'test', 'fix', 'diagnose'}`: call `emitCheckpoint(context, stepId, response)` (from T2)
  - [ ] Force-terminate the flow: set `buildStatus = 'failed'` and break out of the while loop. The existing failed-build terminal handler at `build.js:1407-1417` runs unchanged.
- [ ] Feature-mode builds also benefit from cap enforcement (currently silent absence) — same force-terminate path, no checkpoint emit.

**Test:** `compose/test/retry-cap-enforcement.test.js` (new) — mock stratum to return `ensure_failed` more times than the YAML's `retries`; verify Compose force-terminates and emits checkpoint in bug mode only.

---

### T6 — Hypothesis ledger read in `buildRetryPrompt` (depends on T1, T4)

**File:** `compose/lib/step-prompt.js` (existing) — `buildRetryPrompt` definition at line 158
**Pattern reference:** the function already accepts `context`; just thread the ledger through.

**Acceptance criteria:**
- [ ] Inside `buildRetryPrompt(stepDispatch, violations, context, conflicts)`: when `context.mode === 'bug'` AND `stepDispatch.step_id === 'diagnose'` AND `context.bug_code`:
  - [ ] Read ledger via `readHypotheses(context.cwd, context.bug_code)` (from T1)
  - [ ] Format with `formatRejectedHypotheses(entries)` (from T1)
  - [ ] Prepend the result to the existing prompt content (before the existing RETRY header)
- [ ] When ledger is empty or guard conditions fail: function behaves exactly as today (no regression)
- [ ] After every successful `diagnose` step completion, call `appendHypothesisEntry(context.cwd, context.bug_code, {...})` with `verdict: 'accepted'`, the diagnosis result's root_cause, and trace_evidence as `evidence_for`. **Anchor:** there are multiple `stratum.stepDone` call sites in `build.js` (top-level `execute_step` success at ~`:848`, child-flow success near `:2012`/`:2145`/`:2160`, parallel-dispatch). Wrap the ledger-append in a single helper `recordDiagnoseSuccessIfBugMode(context, response, result)` and call it from BOTH the top-level success branch AND the child-flow success branch — exactly the same kind of two-call-site issue Correction C addressed for retry. Single helper, two call sites; covers both paths.

**Test:** `compose/test/diagnose-retry-with-ledger.test.js` (new) — populate ledger with rejected entries → trigger diagnose retry → verify prompt contains "Previously Rejected" block.

---

### T7 — `bisect` step + `lib/bug-bisect.js` (depends on T4, T5)

**Files:**
- `compose/pipelines/bug-fix.stratum.yaml` (existing) — add bisect step + contract per blueprint section "File:Line Reference Map"
- `compose/lib/bug-bisect.js` (new)

**Acceptance criteria — YAML changes (blueprint-spec'd):**
- [ ] New `BisectResult` contract with fields `{ skipped: bool, bisect_commit: string?, estimate_minutes: number, log_path: string?, summary: string }`
- [ ] New `bisect` function definition with `mode: compute`, `intent` describing classify→estimate→gate→run, `input: {task, diagnosis}`, `output: BisectResult`, `retries: 1`
- [ ] Step inserted between `diagnose` and `scope_check` in the flow steps list, with `depends_on: [diagnose]`
- [ ] `scope_check.depends_on` updated from `[diagnose]` to `[bisect]`

**Acceptance criteria — `bug-bisect.js`:**
- [ ] `classifyRegression(cwd, diagnosisResult, reproTestPath)` returns `true` iff: repro test exists in main branch's test suite AND files in `diagnosisResult.affected_layers` were touched in last 10 commits on main
- [ ] `estimateBisectCost(cwd, testCmd, knownGoodRange)` returns `{ test_runs, seconds_per_run, total_minutes }`. `test_runs = log2(commits_in_range)`. `seconds_per_run` = single test run sample (run once, measure).
- [ ] `runBisect(cwd, testCmd)` drives `git bisect start && git bisect bad HEAD && git bisect good <last-known-good> && git bisect run <testCmd>`, captures log to `docs/bugs/<bug-code>/bisect.log`, returns `{ bisect_commit, log_path }`
- [ ] Last-known-good baseline source: try git tag matching `v*` or `release-*` first; fall back to last 50 commits if no tag; surface for human approval in the gate prompt
- [ ] `bisect` step gate fires when `classifyRegression() === true`. Gate prompt format: `"Looks like a regression. Run git bisect? Estimate: <test_runs> runs × <seconds_per_run>s = ~<total_minutes> min. approve / skip / kill"`
- [ ] On gate skip OR `classifyRegression === false`: return `{ skipped: true, bisect_commit: null, estimate_minutes: 0 }`. Pipeline continues normally.
- [ ] **Decision 6 contract reconciliation:** design.md Decision 6 listed `regression_class: boolean` as a new field on `TriageResult`. T7 implements this as a **runtime check inside the `bisect` step's gate** (`classifyRegression()`) rather than as a triage-time YAML contract field. Cheaper, no schema migration, and the bisect step already gates on the result. Update design.md Decision 6 in Phase 9 to reflect this.

**Test:** `compose/test/bug-bisect.test.js` (new) — synthetic git repo via tmpdir+`git init`+scripted commits → classifier detects regression vs not → runBisect drives `git bisect run` correctly.

---

### T8 — `--resume` flag (depends on T4)

**File:** `compose/bin/compose.js` (existing) — `cmd === 'fix'` handler at line 1080+

**Acceptance criteria:**
- [ ] `compose fix <bug-code> --resume` flag parsed (mirror `--abort` parsing at current line ~1098)
- [ ] Help text updated to document `--resume`
- [ ] When `--resume`: load `flowId` from `<cwd>/.compose/data/active-build.json` (use existing `readActiveBuild` helper). If no active build for this bug, error with `No active build to resume for <bug-code>`.
- [ ] Pass `opts.resumeFlowId = flowId` to `runBuild`
- [ ] In `runBuild` (existing modifications from T4): when `opts.resumeFlowId` is present, skip `stratum.plan()` and call `stratum.resume(opts.resumeFlowId)` instead. Loop body unchanged.
- [ ] Resume re-enters the failed step from scratch (Stratum's existing semantics) — the hypothesis ledger from T6 ensures prior rejected hypotheses inform the retry.

**Test:** `compose/test/compose-fix-resume.test.js` (new) — write fake `active-build.json` → invoke `compose fix --resume` → verify `stratum.resume` called instead of `stratum.plan`.

---

### T9 — `lib/debug-discipline.js` per-bug keying (depends on T1, T4)

**File:** `compose/lib/debug-discipline.js` (existing)

Resolves Correction D from blueprint: integrate with existing `AttemptCounter`, `FixChainDetector`, `DebugLedger` rather than building parallel state.

**Acceptance criteria:**
- [ ] `AttemptCounter.toJSON()` and `fromJSON()` schema becomes `{ [bug_code]: { count, isVisual } }` (from `{ count, isVisual }` global)
- [ ] New methods: `recordForBug(bugCode, opts)`, `getInterventionForBug(bugCode)`, `resetForBug(bugCode)`. Existing global `record`/`getIntervention` preserved for feature mode (write to `__feature_mode__` synthetic key).
- [ ] `FixChainDetector` similarly per-bug-keyed
- [ ] Schema migration on load: if `debug-state.json` has the old flat shape, treat the whole object as `{ __legacy__: <old> }` and continue. Persist new shape on next save.
- [ ] Existing `DebugLedger` class — no API change required for COMP-FIX-HARD; document that it remains project-global (it's not the same thing as the new hypothesis ledger).
- [ ] Build.js callers updated: `attemptCounter.record(...)` is called at exactly **two sites** (`build.js:855` and `build.js:1314` — verified). Both branch on `context.mode`: in bug mode, call `recordForBug(context.bug_code, ...)`. (Earlier draft cited `:856, :892, :1313, :1349`; those were save-state sites for `debug-state.json`, not record-call sites — the two are distinct operations.) Also branch the `debug-state.json` save sites in `build.js` (find via `writeFileSync(debugStatePath, ...)` grep, not by line number, since save sites may shift).

**Threshold note (from blueprint):** thresholds are unchanged — visual@2, all@5. The design's `≥3` for visual is being revised to match the existing code; design.md is updated in Phase 9.

**Test:** `compose/test/debug-discipline-per-bug.test.js` (new) — round-trip serialization with multiple bugs; legacy schema migration; per-bug intervention thresholds.

---

### T10 — Tier 1 + Tier 2 escalation (`lib/bug-escalation.js`, depends on T1, T4, T9)

**File:** `compose/lib/bug-escalation.js` (new)

**Acceptance criteria — Tier 1 (Codex second opinion, read-only):**
- [ ] `tier1CodexReview(stratum, context, bugDescription, reproTest, currentDiff, hypotheses)` callable
- [ ] Constructs prompt with: bug description, repro test, current diff, full hypothesis ledger as a "Previously attempted" block
- [ ] Dispatches via `stratum.runAgentText('codex', codexPrompt, { cwd: context.cwd })` (pattern from `lib/build.js:1768-1795`)
- [ ] Parses output to canonical `ReviewResult` shape (use `lib/review-normalize.js:140-221` `normalizeReviewResult`)
- [ ] Appends Codex's diagnosis to ledger as `{ verdict: 'escalation_tier_1', agent: 'codex', findings: [...] }` via `appendHypothesisEntry` (T1)
- [ ] Returns the `ReviewResult` to caller

**Acceptance criteria — Tier 2 (fresh agent in worktree, patch-only):**
- [ ] `tier2FreshAgent(stratum, context, codexReview, hypotheses, checkpointPath)` callable
- [ ] "Materially new" gate: only proceed if Codex's hypothesis is not present in `hypotheses.jsonl` with `verdict: 'rejected'`. Return `{ skipped: true, reason: 'no new hypothesis' }` otherwise.
- [ ] Worktree creation: `git worktree add <wtPath> --detach HEAD`. `wtPath` under `~/.stratum/worktrees/comp-fix-hard/<bug-code>-<timestamp>/` (mirrors existing parallel-dispatch pattern at `lib/build.js:2676`).
- [ ] Dispatch fresh agent: `stratum.runAgentText('claude', prompt, { cwd: wtPath })` with explicit instructions to produce a patch artifact at `docs/bugs/<bug-code>/escalation-patch-<N>.md` (where N is incremented per attempt) and **NEVER** commit.
- [ ] Cleanup in `finally` block (matches `lib/build.js:2818-2825`): `git worktree remove <wtPath> --force` always runs, even on agent error.
- [ ] Returns `{ patch_path, agent_reasoning }` for the original session to read and decide.

**Wire-up in `runBuild`:**
- [ ] After `retro_check` step completes (in the step-completion handler around `build.js:848+`), check `attemptCounter.getInterventionForBug(context.bug_code)`. If `'escalate'`:
  - [ ] Gate user with: `"Bug <code> has escalated. Run Codex second opinion (~30s, read-only)? approve / skip"`
  - [ ] If approved: call `tier1CodexReview`. Report findings.
  - [ ] If Tier 1 surfaces a materially-new hypothesis: gate `"Codex found a new angle. Dispatch fresh agent in worktree to draft a patch (no commits)? approve / skip"`. If approved: call `tier2FreshAgent`. Report patch path.

**Tests:**
- `compose/test/bug-escalation-tier1.test.js` (new) — mock `stratum.runAgentText`, verify prompt shape, verify ReviewResult parsing, verify ledger append
- `compose/test/bug-escalation-tier2.test.js` (new) — verify worktree create + agent dispatch + cleanup-on-success and cleanup-on-error paths

---

### T11 — Integration test (depends on T1–T10)

**File:** `compose/test/bug-fix-pipeline.integration.test.js` (new)
**Pattern reference:** existing integration tests in `compose/test/integration/` for shape

End-to-end smoke test that exercises the full hard-bug path.

**Acceptance criteria:**
- [ ] Set up tmpdir with `git init`, a buggy file, a failing test
- [ ] Invoke `runBuild('BUG-TEST-001', { mode: 'bug', stratum: mockStratum })` with a stratum mock that:
  - Simulates `diagnose` requiring multiple retries (verifies T6 ledger context shows up in retry prompts)
  - Simulates `test` exceeding retry cap (verifies T5 force-terminate + T2 checkpoint emit)
  - Simulates `retro_check` triggering escalation (verifies T10 Tier 1 fires; Tier 2 gates)
  - Simulates a regression-class diagnosis output (`affected_layers` files touched in last 10 commits) → verifies T7 bisect gate fires in approve and skip paths
- [ ] Bisect path is exercised in two scenarios: (a) gate-approved → `runBisect` invoked against the test git repo, returns a real commit; (b) gate-skipped → `bisect` step returns `{skipped: true}` and pipeline continues to `scope_check`
- [ ] Assert:
  - [ ] `docs/bugs/BUG-TEST-001/hypotheses.jsonl` exists with at least 2 entries (one diagnose attempt + one Tier 1 entry)
  - [ ] `docs/bugs/BUG-TEST-001/checkpoint.md` exists with current diff and resume command
  - [ ] `docs/bugs/INDEX.md` exists with BUG-TEST-001 row
  - [ ] Worktree created and removed during Tier 2 dispatch (no orphan dirs)
- [ ] Run `compose fix BUG-TEST-001 --resume` → verify it calls `stratum.resume` and re-enters the failed step with ledger context

This is the gate. If T11 passes, the feature is complete; the rest of Phase 7 (Codex review loop, coverage sweep) cleans up edges.

---

## Dependency Graph

```
T1 (bug-ledger) ─┐
T2 (checkpoint)  ├── parallel
T3 (index-gen)  ─┘
                  ↓
                T4 (runBuild bug-mode) ──┬── T5 (retry-cap enforce) ──┬── T7 (bisect)
                                          ├── T6 (ledger read in retry)│
                                          ├── T8 (--resume)             ├── T10 (escalation)
                                          └── T9 (debug-discipline)  ──┘
                                                                       ↓
                                                                     T11 (integration)
```

**Parallel batches:**
- Batch A: T1, T2, T3 (pure helpers, no shared state)
- Batch B: T4 alone (foundation for everything downstream)
- Batch C: T5, T6, T8, T9 (each depend on T4 only; pairwise independent)
- Batch D: T7, T10 (depend on T5/T9 respectively)
- Batch E: T11 (integration, depends on all)

Use `superpowers:dispatching-parallel-agents` for batches A and C. Sequential for B → D → E.

## Out of Scope

- COMP-MAXITER-DRIFT (cosmetic log fix) — file as separate ticket
- COMP-BUG-FORMATTER (`compose bug show <code>` formatter) — file as separate ticket
- Stratum-side retry enforcement (would belong in `stratum_mcp/executor.py` not Compose) — file as STRAT-RETRIES-ENFORCE follow-up; out of scope for COMP-FIX-HARD
- Tier 2 worktree TTL daemon — confirmed not needed (deterministic cleanup per blueprint Q4)

## Phase 7 Exit Criteria (from compose skill)

1. All 11 tasks executed with TDD per task — tests pass
2. E2E smoke test (T11 above)
3. Review loop clean — Codex `REVIEW CLEAN` on the implementation
4. Coverage sweep clean — full suite passes

## Phase 9 Doc Updates

- `CHANGELOG.md` — entry for COMP-FIX-HARD
- `compose/.claude/skills/compose/SKILL.md` — document hard-bug machinery (hypothesis ledger, checkpoint, INDEX, bisect, escalation, --resume)
- `compose/.claude/skills/bug-fix/SKILL.md` — same
- `ROADMAP.md` — COMP-FIX-HARD → COMPLETE; COMP-MAXITER-DRIFT and STRAT-RETRIES-ENFORCE filed as new entries
- `design.md` (this folder) — update Decision 5 threshold reference (visual@2 not ≥3) so the historical record matches what shipped
- `design.md` Decision 6 — replace `regression_class: boolean` field on `TriageResult` with a note that the bisect step performs the classification at runtime via `classifyRegression()` (no contract addition; per T7 acceptance criteria)

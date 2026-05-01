---
name: compose
description: Use when starting a non-trivial feature OR fixing a non-trivial bug — orchestrates the full lifecycle (build mode: idea → design → blueprint → implement; fix mode: triage → reproduce → root-cause → fix → verify) using existing skills and agents at each stage.
---

# Compose Lifecycle

## Overview

Orchestrates two lifecycles under one skill:

- **`/compose build <feature-ref>`** — feature lifecycle (idea → design → blueprint → implement → ship)
- **`/compose fix <bug-ref>`** — bug-fix lifecycle (triage → reproduce → root-cause → fix → verify → ship)

Both modes share Phase 6 (plan), Phase 7 (TDD execute + E2E + review loop + coverage sweep), Phase 9 (docs), and Phase 10 (ship). They diverge in the upstream phases. Claude Code's native tools (plan mode, tasks, sessions) handle within-session execution; this skill handles the cross-session lifecycle.

Before any phase begins, read project state via the `compose` MCP server (get_vision_items, get_phase_summary, get_blocked_items). Every feature OR bug maps to a vision item — check it exists, create it if not.

## Mode Selection

`/compose` with no verb defaults to `build` for back-compat. Explicit verbs:

| Verb | Use | Folder |
|---|---|---|
| `/compose build <feature-ref>` | New feature, 3+ files, 2+ phases, needs design | `docs/features/<feature-code>/` |
| `/compose fix <bug-ref>` | Non-trivial bug, test failure, regression, hotfix | `docs/bugs/<bug-code>/` |

**Skip Compose entirely for:** typos, one-line obvious fixes, cosmetic changes — just fix those directly.

## Partial Execution: `--through <phase>`

By default, `/compose` runs the full lifecycle. Use `--through` to stop after a specific phase's gate is approved:

```
/compose FEAT-1 --through design
/compose FEAT-1 --through prd
/compose FEAT-1 --through architecture
/compose FEAT-1 --through blueprint
/compose FEAT-1 --through plan
/compose FEAT-1 --through execute
/compose FEAT-1 --through report
/compose FEAT-1 --through docs
```

When `--through` is active:
1. Run phases normally up to and including the target phase
2. After the target phase's gate is approved, write `status.md` to the feature folder
3. Commit all artifacts and exit — do NOT propose the next phase
4. On next `/compose` invocation, `status.md` is read during entry scan and informs the resume point

## Feature Folder

Every feature gets a folder at `docs/features/<feature-code>/`. The folder name matches the vision item's semantic ID or tracker code (e.g. `FEAT-1`, `AUTH-3`). 1:1 mapping between vision items and feature folders.

```
docs/features/<feature-code>/
  design.md              # Feature-level design
  prd.md                 # PRD (skip for internal/technical work)
  architecture.md        # Architecture (skip for single-component)
  killed.md              # Present only if feature was abandoned
  sessions/              # Session transcripts
  phase-1-<slug>/        # Implementation phase subfolders
  phase-2-<slug>/
```

For small features, artifacts stay flat at root (no phase subfolders).

## Gate Protocol

Every phase transition is a gate. Three outcomes:

- **Approve** — artifact accepted, proceed
- **Revise** — loop back, improve, re-gate
- **Kill** — write `killed.md` with reason and phase; update vision item status to `killed`

At every gate, always propose whether to proceed, skip, or revise. The difference between dial modes:
- **Gate:** Agent proposes, human decides
- **Flag:** Agent decides, human gets notified
- **Skip:** Agent decides silently

### Codex Review

Any gate can include a Codex review pass. This is not limited to implementation — use it for design docs, PRDs, blueprints, plans, or code.

```
Call mcp__stratum__stratum_agent_run with:
  type: "codex"
  prompt: "Review <artifact>. Output REVIEW CLEAN if no actionable findings remain."
```

Fix all issues Codex flags. Re-run until REVIEW CLEAN. Max 5 iterations — if max hit, the problem is in the spec, surface to human.

If `mcp__stratum__stratum_agent_run` is unavailable (or returns a stream-chunk-size error — tracked as `STRAT-MCP-CHUNK-SIZE`), fall back options:

- **Programmatic / pipeline path:** dispatch a `general-purpose` Agent with an explicit reviewer prompt — the canonical `ReviewResult` schema (severity `must-fix`/`should-fix`/`nit`, confidence 1–10, gate `>= 7`) defined at `compose/contracts/review-result.json` is the contract for both paths.
- **Human-driven path:** invoke the OpenAI codex plugin's `/codex:review` (review-only) or `/codex:adversarial-review` (challenges design assumptions). These return Codex stdout verbatim and are not a drop-in for the canonical-JSON pipeline path, but they are the right tool when a human is in the loop.

## Lifecycle (build mode)

```
Phase 1:  Explore & Design ──── gate ──→
Phase 2:  PRD (skippable) ───── gate ──→
Phase 3:  Architecture (skip) ─ gate ──→
Phase 4:  Blueprint ─────────── gate ──→
Phase 5:  Blueprint Verification gate ──→
Phase 6:  Plan ──────────────── gate ──→
Phase 7:  Execute + E2E + Review + Sweep ──→
            ├─ Step 1: TDD execution
            ├─ Step 2: E2E smoke test
            ├─ Step 3: Review loop (till clean)
            └─ Step 4: Coverage sweep (till clean)
Phase 8:  Report (skippable) ── gate ──→
Phase 9:  Update Docs ──────── gate ──→
Phase 10: Ship ─────────────────────────→ Done
```

## Lifecycle (fix mode)

```
Phase F1: Triage ──────────────── gate ──→  (severity, scope, path: Quick/Standard/Hotfix)
Phase F2: Reproduce ───────────── gate ──→  (failing test or reliable repro)
Phase F3: Root Cause Investigate  gate ──→  (superpowers:systematic-debugging)
Phase 6:  Plan (often trivial) ── gate ──→
Phase 7:  Execute + E2E + Review + Sweep ──→  (same four steps as build)
Phase 9:  Update Docs ────────── gate ──→
Phase 10: Ship ────────────────────────────→ Done
```

Phase 7 includes all four steps as exit criteria — you cannot exit without all completing. Quick path (trivial bug, known root cause, single file) collapses F1–F3 into a single triage step and skips Phase 9 docs unless the bug had user-visible behavior.

## Phases

### Phase 1: Explore & Design

**Agent:** `compose-explorer` (2-3 instances in parallel)

- Check compose MCP for existing vision item; create one if absent
- Create `docs/features/<feature-code>/` folder
- Launch 2-3 `compose-explorer` agents in parallel:
  - "Find features similar to [feature] and trace their implementation"
  - "Map the architecture and abstractions for [area]"
  - "Analyze the current implementation of [related feature]"
- Understand the idea through one-question-at-a-time dialogue
- Explore 2-3 approaches with trade-offs
- Write to `docs/features/<feature-code>/design.md`
- Update vision item status to `in_progress`

**Gate checkpoint:** Does this design depend on unproven technical assumptions? If yes, list them. Spikes happen as roadmap tasks.

**Gate:** User approves design. Commit.

**Skip when:** Spec already exists.

### Phase 2: Write PRD

Formalize into a PRD at `docs/features/<feature-code>/prd.md`. Sections: Problem Statement, Goals & Non-Goals, Requirements (MUST/SHOULD/MAY), Success Criteria, User Stories, Constraints & Assumptions, Open Questions.

**Gate:** All open questions resolved or deferred with rationale.

**Skip when:** PRD exists, or feature is purely internal with no user-facing requirements.

### Phase 3: Architecture Doc

**Agent:** `compose-architect` (2-3 instances with competing mandates)

- **Minimal changes** — smallest possible change, maximum reuse
- **Clean architecture** — maintainability first, elegant abstractions
- **Pragmatic balance** — 80/20, good boundaries without over-engineering

Present all proposals, trade-offs, your recommendation. User picks. Write to `docs/features/<feature-code>/architecture.md`.

**Gate:** Component boundaries and interfaces clear enough for blueprint.

**Skip when:** Feature is small enough that design covers architecture.

### Phase 4: Implementation Blueprint

**Agent:** `compose-explorer` (targeted research)

- Check for overlapping in-flight features: scan other `docs/features/*/blueprint.md` for shared file references
- Launch `compose-explorer` targeting the specific area
- Read every critical file, note patterns with line references
- Build corrections table (spec assumption vs reality)
- Write to `docs/features/<feature-code>/blueprint.md`

**Gate:** Corrections table empty or all corrections documented.

### Phase 5: Blueprint Verification

For every file:line reference in the blueprint:
1. Read the actual file at that line — does it match?
2. Check function signatures
3. Verify pattern claims
4. Confirm imports/exports
5. Flag stale references

Produce a verification table, append to `blueprint.md`. If any stale/wrong, loop back to Phase 4.

**Gate:** All file:line references verified. Zero stale entries.

**Skip when:** Blueprint written in the same session immediately after reading all referenced files.

## Fix Mode Phases (F1–F3)

These replace Phases 1–5 when the entry verb is `/compose fix`. Phases 6, 7, 9, 10 are reused unchanged.

### Phase F1: Triage

Gather enough information to select a path. Determine from context or ask:

1. **What broke?** — observed vs expected behavior
2. **Reproduction** — steps or failing test
3. **Severity** — Trivial (cosmetic) / Normal (broken w/ workaround) / Critical (prod down, data loss, security)
4. **Scope** — single file / multi-file / unknown
5. **Root cause hypothesis** — already known?

**Path selection:**

| Path | When | Phases |
|---|---|---|
| **Quick** | Known root cause + single file | F1 → Phase 7 step 1 (TDD fix) → ship |
| **Standard** | Unknown root cause OR multi-file | F1 → F2 → F3 → 6 → 7 → 9 → 10 |
| **Hotfix** | Severity = Critical | F1 → F2 → F3 (time-boxed) → 7 → 10 (+cleanup follow-up) |

For Standard/Hotfix: create `docs/bugs/<bug-code>/` folder. Bug code matches vision item ID. Quick path skips the folder.

**Gate:** Agent proposes path with rationale. Human approves or redirects.

### Phase F2: Reproduce

**Skill:** `superpowers:test-driven-development` (write the failing test first — it IS the spec for "fixed")

1. Write a test that reproduces the bug deterministically
2. Run it — confirm it fails for the right reason (not a setup error)
3. Save artifacts to `docs/bugs/<bug-code>/repro.md` (steps, environment, test path)

**Gate:** Failing test exists and fails as expected. Stratum `ensure: failing_test_exists`.

**Skip when:** Quick path with obvious one-liner — but prefer not to skip; the test guards against regression.

### Phase F3: Root Cause Investigate

**Skill:** `superpowers:systematic-debugging`

Follow the methodology: Reproduce → Hypothesize → Verify → Repeat. Apply `~/.claude/rules/correct-over-quick.md` (contract → spec → code → test, in that order) and `~/.claude/rules/test-architecture-first.md` (understand test intent before changing).

Write findings to `docs/bugs/<bug-code>/diagnosis.md`: root cause, evidence, fix approach, files affected, risk level.

**For Hotfix:** time-box. If root cause not found, fix the symptom with a `// HOTFIX:` comment and file a follow-up task for proper RCA. Note this in `diagnosis.md`.

**Gate:** Root cause documented. Fix approach approved by human. Risk level called out.

**Skip when:** Quick path — root cause was clear at triage.



Uses `EnterPlanMode`. Plan writes to `docs/features/<feature-code>/plan.md`.

- Break blueprint into ordered tasks with dependencies
- Each task: file path, what to do, pattern to follow, test to write
- Identify parallelizable tasks

**Gate:** User approves plan via `ExitPlanMode`.

### Phase 7: Execute

**Execution skill selection:**

| Condition | Use |
|---|---|
| Independent tasks, parallelizable | `superpowers:dispatching-parallel-agents` |
| Sequential tasks with dependencies | `superpowers:executing-plans` |

- **REQUIRED:** TDD per task — write test first, watch fail, implement, watch pass
- **REQUIRED:** `superpowers:verification-before-completion` before marking any task done
- Use `superpowers:systematic-debugging` on any unexpected failure

**Blocker protocol:** If external blocker hit — record in feature folder, set vision item to `blocked`, surface to human.

**Gate:** All four steps complete:

1. **All tasks executed** — tests pass
2. **E2E smoke test** — start dev server (`npm run dev` from compose root — Vite on :5173, API on :3001, agent on :3002), run Playwright tests for affected flows
3. **Review loop clean** — Codex reviews via `codex_run`, confidence >= 80, loop until `REVIEW CLEAN`
4. **Coverage sweep clean** — loop until `TESTS PASSING`

**Step 3: Review Loop**

Run the Codex Review protocol (see Gate Protocol above) against the implementation.

**Step 4: Coverage Sweep**

```
Write and run tests for the implementation in docs/features/<feature-code>/plan.md.
Focus on edge cases, error paths, cross-component integration.
Fix failing tests. Output TESTS PASSING when all pass.
```

Max 15 iterations.

### Phase 8: Implementation Report

Write to `docs/features/<feature-code>/report.md`:

1. Summary
2. Delivered vs Planned
3. Architecture Deviations
4. Key Implementation Decisions
5. Test Coverage
6. Files Changed
7. Known Issues & Tech Debt
8. Lessons Learned

**Gate:** Report complete and honest.

**Skip when:** Feature had no PRD or architecture doc (too small to warrant a report).

### Phase 9: Update All Docs

- `CHANGELOG.md` — entry for this feature
- `README.md` — if setup, usage, or capabilities changed
- `CLAUDE.md` — if new commands, conventions, or architecture changed
- `ROADMAP.md` — update item status to `COMPLETE`
- Update vision item status to `complete`
- Bind the stratum flow to the vision item: `POST /api/stratum/bind` with the flow_id and vision item id

**Do NOT update** pre-implementation intent documents (PRD, architecture).

**Gate:** All doc surfaces reviewed and updated.

### Phase 10: Review & Ship

- Final `superpowers:verification-before-completion`
- Verify all Phase 9 docs committed
- Call `stratum_audit` with `flow_id`, include trace in commit description
- Present options: merge, PR, or cleanup

## Stratum Integration

Compose uses Stratum as the execution tracker. The `.stratum.yaml` spec is generated at invocation — never shown to the user. Claude Code is the executor; Stratum enforces that each phase produced a verifiable artifact before advancing.

### When to Call Each Tool

- **`stratum_plan`** — once, after entry scan, before Phase 1. Flow: `compose_feature`.
- **`stratum_step_done`** — after each step's gate is approved.
- **`stratum_audit`** — in Phase 10 before committing. Bind result to vision item via `POST /api/stratum/bind`.

If Stratum unavailable, continue with flat prompt chain.

### Step → Phase Mapping

**Build mode** uses flow `compose_feature`:

| Step | Phases |
|---|---|
| `research` | Phase 1 exploration. No human gate. |
| `write_design` | Phase 1 design + optional Phase 2 PRD + optional Phase 3 Architecture. Gate after Phase 1. |
| `write_blueprint` | Phase 4 + Phase 5 verification. Gate after Phase 5. |
| `implement` | Phase 7 — TDD, E2E, review loop, coverage sweep. Gate after all four steps. |

**Fix mode** uses flow `bug_fix` from `compose/pipelines/bug-fix.stratum.yaml` (8 steps, all already implemented):

| Step | Phase | Retries | Ensure | Iteration role |
|---|---|---|---|---|
| `reproduce` | F2 | 2 | — | failing test or repro confirmed |
| `diagnose` | F3 | 2 | `trace_evidence ≥ 2`, `root_cause != null`, `scope_hint in {single,cross-layer,unknown}` | forces real command output, not assumptions |
| `scope_check` | F3 | 1 | — | greps all configured project repos for cross-layer references |
| `fix` | 7 step 1 | 2 | — | minimal correct fix across all affected layers |
| `test` | 7 step 4 | **5** | `result.passing == true` | **inner fix-and-retest loop** — Stratum re-runs until all tests pass or cap hit |
| `verify` | 7 | 1 | — | original repro now passes |
| `retro_check` | — | 1 | — | scans git history for fix chains; **hard stop at attempt 2 for visual/CSS bugs**, triggers cross-agent escalation |
| `ship` | 10 | 1 | — | commit + CHANGELOG |

Triage is implicit on entry (severity, scope, path) — it gates which steps to run, not a Stratum step itself. Phases 6 (plan), 9 (docs) are folded into `fix` and `ship` respectively.

### Spec Template

```yaml
version: "0.1"
contracts:
  ResearchResult:
    findings: {type: array}
    relevant_files: {type: array}
  DesignResult:
    path: {type: string}
    word_count: {type: integer}
  BlueprintResult:
    path: {type: string}
  ImplementResult:
    files_changed: {type: array}
    tests_pass: {type: boolean}

functions:
  research:
    mode: compute
    intent: "Explore the codebase with compose-explorer agents and surface patterns relevant to the feature."
    input: {description: {type: string}}
    output: ResearchResult
    ensure:
      - "len(result.findings) > 0"
    retries: 2

  write_design:
    mode: compute
    intent: "Run Phase 1 (and optional Phases 2-3) — explore, gate, write design.md."
    input: {description: {type: string}}
    output: DesignResult
    ensure:
      - "file_exists(result.path)"
      - "result.word_count > 200"
    retries: 2

  write_blueprint:
    mode: compute
    intent: "Run Phases 4-5 — blueprint, verification. Gate before returning."
    input: {description: {type: string}}
    output: BlueprintResult
    ensure:
      - "file_exists(result.path)"
    retries: 2

  implement:
    mode: compute
    intent: "Run Phase 7 — TDD, E2E, review loop, coverage sweep."
    input: {description: {type: string}}
    output: ImplementResult
    ensure:
      - "result.tests_pass == True"
      - "len(result.files_changed) > 0"
    retries: 2

flows:
  compose_feature:
    input: {description: {type: string}}
    output: ImplementResult
    steps:
      - id: research
        function: research
        inputs: {description: "$.input.description"}
        output_schema:
          type: object
          required: [findings]
          properties:
            findings: {type: array, items: {type: string}}
            relevant_files: {type: array, items: {type: string}}

      - id: write_design
        function: write_design
        inputs: {description: "$.input.description"}
        depends_on: [research]
        output_schema:
          type: object
          required: [path, word_count]
          properties:
            path: {type: string}
            word_count: {type: integer}

      - id: write_blueprint
        function: write_blueprint
        inputs: {description: "$.input.description"}
        depends_on: [write_design]
        output_schema:
          type: object
          required: [path]
          properties:
            path: {type: string}

      - id: implement
        function: implement
        inputs: {description: "$.input.description"}
        depends_on: [write_blueprint]
        output_schema:
          type: object
          required: [files_changed, tests_pass]
          properties:
            files_changed: {type: array, items: {type: string}}
            tests_pass: {type: boolean}

```

The bugfix flow lives in `compose/pipelines/bug-fix.stratum.yaml` (8 steps + bisect, ships with compose). The CLI entry `compose fix <bug-code>` (in `bin/compose.js`) reads `docs/bugs/<code>/description.md` (scaffolds and exits if missing) and dispatches `runBuild(code, { mode: 'bug', template: 'bug-fix', description })`.

### Hard-bug machinery (COMP-FIX-HARD, 2026-05-01)

For genuinely hard bugs the pipeline gains persistent state across attempts and sessions, structured second opinions, and a fresh-context retry path:

- **Hypothesis ledger** at `docs/bugs/<code>/hypotheses.jsonl` (JSONL, idempotent on `(attempt, ts)`). `diagnose` retries see a "Previously Rejected" block prepended via `buildRetryPrompt` so they don't re-propose disproven theories. Every successful diagnose plus every Tier 1 escalation appends an entry.
- **Compose-side retry-cap enforcement.** Stratum's `retries:` field is declared-but-not-enforced in `executor.py` (tracked as `STRAT-RETRIES-ENFORCE`). Compose parses the YAML at flow start, builds a per-step cap map, and force-terminates when `iterN > maxIter`. In bug mode for `{test, fix, diagnose}`, terminal-failure also emits `docs/bugs/<code>/checkpoint.md` (current diff, last failure, ledger pointer, `compose fix <code> --resume` command).
- **`docs/bugs/INDEX.md`** rendered atomically from per-bug checkpoints (same pattern as `roadmap-gen.js`).
- **`bisect` step** sits between `diagnose` and `scope_check`. `classifyRegression` heuristic (test in main + affected files touched in last 10 commits) decides whether to gate the human; cost estimator samples one test run with a 5-min timeout; `runBisect` always calls `git bisect reset` in finally.
- **`compose fix --resume`** re-enters the failed step with full ledger context. Active-build state carries `mode` and `pid`; resume refuses if another live process owns the build or if the active mode mismatches.
- **Two-tier escalation**, both gated, neither auto-commits:
  - Tier 1: `stratum.runAgentText('codex', ...)` second opinion, parsed to canonical `ReviewResult`, appended to ledger as `verdict: 'escalation_tier_1'`.
  - Tier 2: only fires when Codex's hypothesis is materially new (Jaccard token-overlap < 0.7 vs prior rejected entries). `git worktree add <path> --detach HEAD`, fresh `claude` agent dispatched with explicit DO-NOT-COMMIT prompt, produces `docs/bugs/<code>/escalation-patch-N.md`. `git worktree remove --force` in finally; `rm -rf` fallback. Detached HEAD is the defense-in-depth: even if the agent ignores the prompt, commits orphan and never reach a branch.
- **`debug-discipline.js`** is per-bug-keyed. `AttemptCounter`/`FixChainDetector` use a `byBug` Map; legacy global API preserved via synthetic `__feature_mode__` key. Existing thresholds preserved verbatim: visual@2, all@5.

The CLI scaffold for `description.md` is the bug-mode equivalent of feature-mode's `description.md`/`feature.json`. Fields the agent should fill in: symptom, repro steps, expected vs actual, environment.

### Result Dict Shapes

```python
# research
{"findings": ["pattern A", "pattern B"], "relevant_files": ["server/index.js"]}

# write_design
{"path": "docs/features/FEAT-1/design.md", "word_count": 450}

# write_blueprint
{"path": "docs/features/FEAT-1/blueprint.md"}

# implement
{"files_changed": ["server/index.js", "src/components/Foo.jsx"], "tests_pass": True}
```

### Narration Pattern

Never mention `.stratum.yaml`, `stratum_plan`, or step IDs to the user:

```
Checking project state and exploring codebase...
Writing design doc...
Writing implementation blueprint...
Implementing...
```

## Entry: Scan First

When `/compose` is invoked, always scan first:

1. Read compose MCP: `get_vision_items` for the feature code, `get_current_session` for context
2. Check `docs/features/<feature-code>/`. If absent, start at Phase 1.
3. If folder exists, read every file. Summarize what's covered and what's missing.
4. If `status.md` exists, read it for resume point, then delete it.
5. Propose starting phase with rationale. Human approves.

## Phase Selection

| Folder State | Action |
|---|---|
| No folder | Start Phase 1 |
| `status.md` | Read for resume point, delete, start indicated phase |
| `design.md` | Review, fill gaps, gate |
| `prd.md` / `architecture.md` | Review completeness. If solid, proceed to Phase 4. |
| `blueprint.md` | Verify (Phase 5). Never skip verification. |
| `plan.md` | Review against current code. If accurate, execute (Phase 7). |
| Code + tests done | E2E, review, sweep (Phase 7 steps 2-4), then docs (Phase 9). |

**Phase 7's E2E and loops are never skipped.** They self-terminate on clean input.

## Cross-Cutting Agents & Skills

| Agent/Skill | When |
|---|---|
| `compose-explorer` | Phase 1 (2-3 parallel), Phase 4 (targeted) |
| `compose-architect` | Phase 3 (2-3 competing mandates) |
| `mcp__stratum__stratum_agent_run(type="codex")` | Any gate — Codex review pass (see Gate Protocol) |
| `general-purpose` Agent | Reviewer fallback when `stratum_agent_run` unavailable; prompt with canonical `ReviewResult` schema |
| `superpowers:systematic-debugging` | Phase F3 (fix mode) and any unexpected failure (build mode) |
| `superpowers:test-driven-development` | Phase F2 (fix mode), Phase 7 step 1 (both modes) |
| `superpowers:verification-before-completion` | Before any task/phase done |
| `superpowers:requesting-code-review` | Phase 7 review step (fallback when Codex unavailable) |
| `interface-design:init` | Phase 7 — new UI components |
| `interface-design:critique` | Phase 7 — after building UI |
| `interface-design:audit` | Phase 7 — check UI against design system |
| `refactor` | Phase 7 — when review finds large files |
| `update-docs` | Phase 9 |

**Note on dependencies:** these skills are referenced by name and must be installed on the user's machine. See `## Dependencies` below for the install contract — `compose setup` only ships compose-owned skills today; external deps are documented but not auto-installed.

## Memory

After completing a feature OR bug-fix lifecycle, update project memory:
- Architecture decisions made
- Patterns discovered during blueprint or diagnosis
- Corrections that apply broadly
- For bugfix: root-cause class (off-by-one, race, contract drift, etc.) — helps spot repeats

## Dependencies

`compose setup` (see `bin/compose.js` `syncSkills()`) installs compose-owned skills from `PACKAGE_ROOT/.claude/skills/` and `PACKAGE_ROOT/skills/` to `~/.claude/skills/` and tracks them in `~/.claude/skills/.compose-skills.json`.

### Vendored (ship with compose)

| Skill | Source | Why vendored |
|---|---|---|
| `compose` | `compose/.claude/skills/compose/` | Core lifecycle |
| `stratum` | `compose/skills/stratum/` (if present) | Execution substrate |
| `compose-explorer`, `compose-architect` | agents under `compose/.claude/agents/` | Required by Phases 1, 3, 4 |

### External dependencies (NOT auto-installed)

Authoritative list lives in `compose/.compose-deps.json`. Run `compose doctor` to see what's installed locally and `compose doctor --json` for machine-readable output. The manifest is the single source of truth for external dep IDs and per-dep `fallback` behavior — this SKILL.md never duplicates per-dep fallback strings.

The manifest declares 12 external skills/commands across `superpowers:*`, `interface-design:*`, `codex:review`, `refactor`, and `update-docs`. Each entry carries `id`, `required_for`, `install`, `fallback` (or null), and `optional`.

### Degrade pattern

At lifecycle entry (Phase 1), run `compose doctor --json`. For each missing dep:

- If `optional: false` and `fallback` is non-null → use the `fallback` value, surface a warning to the user, continue.
- If `optional: false` and `fallback` is null → block the lifecycle and surface the `install` command to the user.
- If `optional: true` → skip the affected step and log a warning in the phase report.

If the CLI is unavailable (PATH issue, sandbox), fall back to reading `~/.claude/skills/compose/.compose-deps.json` (copied alongside this SKILL.md by `compose setup`).

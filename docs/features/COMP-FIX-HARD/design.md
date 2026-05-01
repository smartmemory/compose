# COMP-FIX-HARD: Design

**Status:** DESIGN
**Date:** 2026-05-01
**Owner:** ruze

## Related Documents

- ROADMAP entry: `forge/ROADMAP.md` — Active Wave 5 → COMP-FIX-HARD
- Sibling (complete): COMP-FIX — `/compose fix` verb wiring (commit `8cb858b` on `compose/main`)
- Pipeline being extended: `compose/pipelines/bug-fix.stratum.yaml`
- Compose skill: `compose/.claude/skills/compose/SKILL.md` (fix-mode lifecycle)
- Vendored bug-fix skill: `compose/.claude/skills/bug-fix/SKILL.md` (deprecated, redirects to `/compose fix`)

---

## Problem

The current 8-step bug-fix pipeline (`reproduce → diagnose → scope_check → fix → test → verify → retro_check → ship`) handles the easy and medium cases well but fails silently on genuinely hard bugs:

1. **Wasted retries on disproven hypotheses.** `diagnose` retries with no memory of what was already ruled out. The 3rd attempt can re-propose what the 1st attempt rejected.
2. **Test step exhausts retries with no recovery path.** When `test` hits its 5-retry cap, the step fails and the human gets the failure but none of the partial state — current diff, last failure, hypotheses tried — that would let them resume intelligently.
3. **No bisection for regression-class bugs.** Bugs that are "this used to work" deserve `git bisect`; today there's no step for it.
4. **Fix-chain detection is session-scoped.** `retro_check` scans the current git log for repeat-touches, but a bug worked on across sessions (Monday's session, then Wednesday's session) shows up as "first attempt" each time.
5. **Escalation flags but doesn't act.** When `retro_check` decides to escalate, it logs the flag and exits. No fresh agent is dispatched, no second opinion is captured.

These are exactly the cases where Compose's iteration discipline is supposed to pay off — and exactly where it gives up.

## Goal

Extend the existing pipeline so that hard bugs get **persistent state across attempts and sessions, structured second opinions, and a fresh-context retry path** — without making the easy cases slower or noisier.

**In scope:**
- Hypothesis ledger (JSONL) read by `diagnose` on every retry
- Iteration checkpoint emitted when `test` exhausts retries
- Optional `bisect` step gated by triage classification
- Cross-session resume via per-project bug INDEX.md
- Two-tier escalation hook in `retro_check` (Codex second opinion → fresh general-purpose agent in worktree)

**Out of scope:**
- Changes to `compose build`'s feature lifecycle (this is fix-mode only)
- Changes to the `/compose fix` CLI surface — same verb, richer machinery underneath
- Cross-repo bug tracking — bugs stay scoped to one project
- Anything that requires changes to Stratum core IR — all extensions live as new IR fields with safe defaults

## Decisions

### Decision 1: Bug folder location

**Bugs live at `docs/bugs/<bug-code>/` in the consuming project**, mirroring how features live at `docs/features/<feature-code>/`. Same parent dir convention, same per-project ownership, same git-tracked or not status as the rest of the project's docs.

Rationale: the user picked this; it matches the feature-folder pattern users already understand. No new conventions to teach.

### Decision 2: Hypothesis ledger format — JSONL append-only

`docs/bugs/<bug-code>/hypotheses.jsonl` — one JSON object per line, one line per `diagnose` attempt.

```json
{"attempt": 2, "ts": "2026-05-01T14:23:00Z", "hypothesis": "race in cache invalidation between worker and frontend", "evidence_for": ["worker logs show write at T+0", "frontend reads at T+0.001"], "evidence_against": ["repro fails even with single-worker mode", "sleep(1) before read does not change behavior"], "verdict": "rejected", "next_to_try": "look at lifecycle of the cache key itself"}
```

`diagnose` reads `hypotheses.jsonl` (if present) before each retry and prepends to its prompt:

> Previously rejected hypotheses (do not re-propose without new evidence):
> - Attempt 1: <hypothesis> — rejected because <evidence_against summary>
> - Attempt 2: <hypothesis> — rejected because <evidence_against summary>

**Why JSONL:** matches `gate-log.jsonl` (compose already ships this pattern), no merge conflicts on retry, programmatically enumerable, append-only is crash-safe.

**Tradeoff accepted:** humans need `jq`/`less` to read raw. We'll add a `compose bug show <code>` formatter in a later ticket (filed as COMP-BUG-FORMATTER, not blocking).

**Required fields:** `attempt`, `ts`, `hypothesis`, `verdict` (one of: `rejected`, `accepted`, `inconclusive`). **Optional:** `evidence_for`, `evidence_against`, `next_to_try`, `agent` (model id), `tokens_used`.

### Decision 3: Bisect — hybrid auto-classify + gate

Triage adds a `regression_class: boolean` field to its output, set by heuristic:

- Reproduction test exists in the main branch's test suite (i.e. test was authored before the bug, not by us in F2), AND
- Files identified by `diagnose.affected_layers` were touched in the last 10 commits on main

When `regression_class: true`, the pipeline inserts a `bisect` step **between `diagnose` and `scope_check`**. The step itself is **gated** before running — it estimates `~N test runs at ~M seconds each = ~T minutes` and presents to human:

> COMP-BUG-FOO looks like a regression. Run git bisect? Estimate: 12 test runs × 30s = ~6 min.
> Approve / skip / kill

Default to skip if no human is present (headless mode). Output: `bisect_commit` field on `diagnose.md` plus the bisect log saved to `docs/bugs/<code>/bisect.log`.

**Why hybrid not full-auto:** bisect is expensive and a wrong classification wastes human time. The classifier's only job is to *suggest* — the human approves the cost.

**Why hybrid not full-opt-in:** users won't remember the flag. The whole point of the pipeline is to surface what to do; we should propose bisect when it'd help.

### Decision 4: Checkpoint scope — per-bug + thin INDEX

When `test` exhausts retries (or any irrecoverable step failure mid-flow), emit `docs/bugs/<bug-code>/checkpoint.md` containing:

- Current uncommitted diff (or pointer to a stash ref)
- Last failing test output (full stderr/stdout)
- Hypothesis ledger pointer
- Files touched so far this session
- "What I'd try next" — agent's stated next move
- Resume command: `compose fix <bug-code> --resume`

Plus update `docs/bugs/INDEX.md`, a project-wide one-line-per-open-bug roster:

```
| Bug | Last attempt | Open since | Next | Status |
|---|---|---|---|---|
| BUG-42 | 2026-05-01 14:23 | 2026-04-29 | bisect on cache layer | OPEN |
| BUG-91 | 2026-04-30 11:00 | 2026-04-30 | wait for upstream fix | BLOCKED |
```

`retro_check` reads `INDEX.md` to spot **cross-session fix chains** — if BUG-42 has 5 attempts across 3 sessions, that's a chain even though current-session git log shows only 1 attempt.

When a bug closes (`ship` succeeds), its INDEX row is removed but its folder + checkpoint stay for archival.

**Why two files:** the per-bug checkpoint is rich state for the agent to resume from; the INDEX is shallow state for cross-session detection. Conflating them either bloats INDEX or makes per-bug state hard to find.

### Decision 5: Escalation — two-tier, both gated, neither writes code

When `retro_check` triggers escalation (existing logic: 2+ commits on same file, OR attempt_count ≥ 3 for visual/CSS bugs, OR cross-session chain detected), run **Tier 1 unconditionally**, **Tier 2 conditionally**:

**Tier 1 — Codex second opinion (read-only):**
- Dispatch `mcp__stratum__stratum_agent_run(type=codex)` with structured prompt:
  - Bug description, repro test, current diff
  - Full `hypotheses.jsonl` (so Codex sees what's been tried)
  - `checkpoint.md` if present (cross-session resume)
- Output: canonical `ReviewResult` (severity / confidence / recommendations) treating the bug as the review target
- Cost: ~one Codex run, ~30s
- Outcome: append Codex's diagnosis to `hypotheses.jsonl` as a new entry with `agent: "codex"`

**Tier 2 — Fresh general-purpose agent in worktree (only if Tier 1 surfaces something materially new):**
- "Materially new" = Codex's hypothesis is not already in `hypotheses.jsonl` with `verdict: rejected`
- Dispatch `Agent(subagent_type="general-purpose", isolation="worktree")` with full context bundle
- Mandate: produce a **diagnosis-and-patch artifact** at `docs/bugs/<bug-code>/escalation-patch-N.md` — NOT to commit
- Why no commit: per `feedback_review_loop_roles.md` ("Codex reviews, never edits files") — same principle extends to escalation agents
- The original session reads the patch artifact and decides whether to apply

Both tiers gate before running. Human sees:

> COMP-BUG-FOO has hit 3 attempts. Escalate?
> Tier 1 (Codex second opinion, ~30s, no code changes): yes / skip
> Tier 2 will be proposed if Tier 1 finds something new.

**Why no auto-commit at any tier:** the load-bearing rule across this whole project is that the human (or the original session, with human approval) lands code. Escalation widens the *diagnosis* search space; it does not widen the *commit* surface.

### Decision 6: IR additions to bug-fix.stratum.yaml

New optional fields, all default-off so existing flows are unaffected:

```yaml
# In triage's output (computed inline today, becoming explicit)
TriageResult:
  regression_class: {type: boolean, default: false}
  severity: {type: string}  # already implicit
  scope_hint: {type: string}  # already on DiagnoseResult

# diagnose now reads the ledger
diagnose:
  reads: ["docs/bugs/${bug_code}/hypotheses.jsonl"]
  writes_append: ["docs/bugs/${bug_code}/hypotheses.jsonl"]

# new bisect step (conditional on regression_class)
bisect:
  mode: compute
  intent: "If regression_class=true, propose git bisect with cost estimate. Gate before running."
  ensure:
    - "result.skipped == True or result.bisect_commit != null"
  retries: 1

# checkpoint emission added to test failure path
test:
  on_failure_after_retries: emit_checkpoint  # NEW directive
  retries: 5

# retro_check gains escalation hook
retro_check:
  reads: ["docs/bugs/INDEX.md"]
  writes: ["docs/bugs/INDEX.md"]
  escalation:
    tier_1: {type: codex, contract: ReviewResult}
    tier_2: {type: general_purpose, isolation: worktree, output: patch_artifact}
```

`emit_checkpoint` and `escalation` are new directives we'll need to either land in Stratum core (preferred — generally useful) or implement as a Compose-side wrapper around the existing flow runner. Phase 4 (blueprint) decides which.

## Files

| File | Action | Purpose |
|---|---|---|
| `compose/pipelines/bug-fix.stratum.yaml` | Modify | Add `bisect` step, ledger read/write on diagnose, checkpoint emit on test failure, escalation directive on retro_check |
| `compose/lib/bug-ledger.js` | New | JSONL read/append helpers + "previously rejected" prompt formatter |
| `compose/lib/bug-checkpoint.js` | New | Emit checkpoint.md, update INDEX.md, parse on resume |
| `compose/lib/bug-bisect.js` | New | git-bisect driver, cost estimator |
| `compose/lib/bug-escalation.js` | New | Tier 1 / Tier 2 dispatch, patch artifact writer |
| `compose/bin/compose.js` | Modify | `--resume` flag on `compose fix`; `compose bug show <code>` formatter |
| `compose/.claude/skills/compose/SKILL.md` | Modify | Document hard-bug machinery in fix-mode section |
| `compose/.claude/skills/bug-fix/SKILL.md` | Modify | Same — add hard-bug section under existing phases |
| `compose/test/bug-ledger.test.js` | New | Unit tests for ledger ops |
| `compose/test/bug-checkpoint.test.js` | New | Unit tests for checkpoint round-trip |
| `compose/test/bug-fix-pipeline.integration.test.js` | New | E2E: simulate hard bug, verify ledger persists, escalation fires, resume works |

## Open Questions

1. **Stratum core vs Compose-side wrapper for `emit_checkpoint` / `escalation` directives** — does Stratum want these as first-class IR (useful for any pipeline, not just bug-fix), or do we implement in `compose/lib/build.js` as bug-fix-specific hooks? Resolve in Phase 4 blueprint after reading Stratum's IR extension story.
2. **`--resume` semantics** — does resume re-run the failed step from scratch (with ledger context), or pick up from the saved diff? Probably re-run with ledger; saved diff is for human review only. Confirm in plan.
3. **INDEX.md vs `.compose/bugs.jsonl`** — markdown is human-readable, but JSONL is what every other compose tracker uses. Final answer probably: ship a JSONL file as truth, render INDEX.md from it (same pattern as ROADMAP.md ↔ feature.json today). Defer to blueprint.
4. **Tier 2 worktree cleanup policy** — when does the worktree get deleted? On bug closed? On checkpoint emit? On a TTL? Existing `STRAT-PAR-RESUME` pattern (worktrees under `~/.stratum/worktrees/`) suggests TTL-based cleanup; align with that.
5. **Cost ceilings** — should there be a hard cap on Tier 1+2 escalations per bug? `idea_budget_ceilings.md` in memory suggests yes. Probably 3 escalations per bug, then `retro_check` kills the bug as `unfixable_in_pipeline` and surfaces to human definitively.

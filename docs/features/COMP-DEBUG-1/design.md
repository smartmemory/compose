# COMP-DEBUG-1: Debug Discipline Engine

**Status:** PLANNED
**Phase:** 7 (Trusted Pipeline Harness)
**Depends on:** None (COMP-HARNESS-1 and COMP-HARNESS-9 are nice-to-haves, not blockers — runBuild() and file-based counters suffice for v1)
**Blocks:** None (enhances existing pipelines)

## Related Documents

- [ROADMAP.md](../../ROADMAP.md) — Phase 7 harness features
- [bug-fix.stratum.yaml](../../../pipelines/bug-fix.stratum.yaml) — Current bug-fix pipeline
- [health-score.js](../../../lib/health-score.js) — Existing health dimensions
- [review-lenses.js](../../../lib/review-lenses.js) — Existing review lenses
- SmartMemory weekly retro (2026-04-12) — Source data for all anti-patterns

## Problem

Compose's `bug-fix` pipeline has correct steps (reproduce → diagnose → fix → test → verify → ship) but no enforcement of discipline *within* those steps. The agent can:

1. **Skip the trace step** — write fixes based on assumptions about data types/shapes, then iterate when assumptions are wrong. Real-world cost: 7 commits to fix one endpoint (`list_memories`).

2. **Discover multi-layer changes incrementally** — fix one layer, deploy, discover the next layer is broken. Real-world cost: 10 core commits + 4 downstream rebuilds for a provider switch (OpenAI → Groq).

3. **Rabbit-hole on visual bugs** — "one more tweak" on CSS/layout problems that need a fresh perspective, not more iteration. Real-world cost: 8 commits for Cytoscape layout on hidden tabs.

4. **Assume return types at boundaries** — call a function from another layer without verifying the return type, then branch on `isinstance(x, dict)` instead of fixing the ambiguity. Real-world cost: 7 patches from a single `dict` vs `MemoryItem` mismatch.

All four patterns share one root cause: **acting on assumptions instead of observations.** The pipeline permits this because the `diagnose` step has no postcondition requiring evidence.

## Solution

A **Debug Discipline Engine** — a set of detectors, enforcers, and interventions that sit inside the bug-fix (and build) pipelines to catch thrashing before it compounds.

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Compose Pipeline (bug-fix or build)                         │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌───────┐  ┌──────┐  ┌──────┐ │
│  │reproduce │→ │ diagnose │→ │  fix  │→ │ test │→ │ ship │ │
│  └──────────┘  └────┬─────┘  └───┬───┘  └──────┘  └──────┘ │
│                     │            │                            │
│              ┌──────┴──────┐  ┌──┴──────────┐                │
│              │ Trace       │  │ Attempt     │                │
│              │ Enforcer    │  │ Counter     │                │
│              └─────────────┘  └─────────────┘                │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Debug Discipline Engine (lib/debug-discipline.js)      │ │
│  │                                                         │ │
│  │  Detectors:                                             │ │
│  │  ├─ Fix-chain detector (git history analysis)           │ │
│  │  ├─ Cross-layer audit (grep-before-migrate)             │ │
│  │  ├─ Visual bug counter (attempt tracking)               │ │
│  │  └─ Type boundary checker (isinstance smell detection)  │ │
│  │                                                         │ │
│  │  Interventions:                                         │ │
│  │  ├─ Trace gate (block fix until evidence produced)      │ │
│  │  ├─ Escalation trigger (switch to cross-agent review)   │ │
│  │  ├─ Scope expansion (force grep audit for migrations)   │ │
│  │  └─ Hard stop (abort after N attempts on same target)   │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Signals → health-score.js (new dimension)              │ │
│  │  debug_discipline: fix_chain_count, trace_evidence,     │ │
│  │                    attempt_ratio, escalation_rate        │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### Component 1: Fix-Chain Detector

**What it does:** Tracks which files/functions the agent modifies across iterations within the fix loop. When the same file is touched in multiple iterations, that's a fix chain — the signal that the agent is patching symptoms instead of tracing to root cause.

**Timing problem (resolved):** Git commits only happen at `ship` (end of pipeline), so there's no commit history to analyze during the fix loop. Instead, the detector uses two complementary signals:

1. **In-loop tracking** — `build.js` already tracks `step_done` results per iteration. The fix-chain detector maintains an in-memory map of `file → iteration_count` across fix/test retry cycles. This runs inside the fix loop, before any commits exist.
2. **Cross-session git analysis** — After `ship`, analyze the branch's commit history for patterns across prior bug-fix sessions. This is the retro signal, not the live signal.

**Inputs:** Iteration-level file change lists from `step_done` results (in-loop), git log (cross-session).
**Detection rules:**
- Same file modified in 2+ fix iterations = `fix_chain_warning`
- Same file modified in 3+ fix iterations = `fix_chain_critical`
- Same function signature changed across iterations (via diff analysis) = `fix_chain_critical`

**Intervention:** On `fix_chain_warning`, inject a trace reminder into the agent's next prompt. On `fix_chain_critical`, halt the fix step and require a fresh trace evidence artifact before proceeding.

**Implementation:** In-memory `Map<file, iterationCount>` maintained by `lib/debug-discipline.js`, called from `build.js` after each fix iteration's `step_done`. Persisted to `.compose/debug-state.json` for crash recovery.

```js
// lib/debug-discipline.js (sketch)
export class FixChainDetector {
  constructor() {
    this.fileHits = new Map(); // file → iteration count
    this.iteration = 0;
  }

  recordIteration(filesChanged) {
    this.iteration++;
    for (const file of filesChanged) {
      this.fileHits.set(file, (this.fileHits.get(file) ?? 0) + 1);
    }
  }

  detect() {
    return [...this.fileHits.entries()]
      .filter(([, count]) => count >= 2)
      .map(([file, count]) => ({
        file, iterations: count,
        level: count >= 3 ? 'critical' : 'warning',
      }));
  }
}
```

### Component 2: Trace Enforcer

**What it does:** Ensures the `diagnose` step produces actual evidence (command output, printed values, type checks) before allowing the `fix` step to proceed.

**How it works:** The `diagnose` function's postcondition requires a `trace_evidence` field in its output — a list of commands run and their actual output. The pipeline rejects `diagnose` results that contain only prose analysis without concrete data.

**Postcondition (stratum):**
```yaml
ensure:
  - "result.trace_evidence != null"
  - "result.trace_evidence.length >= 2"
  - "all(e.command != null and e.actual_output != null for e in result.trace_evidence)"
  - "result.root_cause != null"
  - "any(e.actual_output.length > 5 for e in result.trace_evidence)"
```

The minimum of 2 evidence items prevents trivial satisfaction. The `actual_output.length > 5` check catches empty or stub outputs while allowing short but valid results like type names (`MemoryItem`, `dict`, `None`). The `root_cause` field forces the agent to connect the evidence to a conclusion.

**What counts as trace evidence:**
- `docker exec ... python3 -c "print(type(x))"` → actual type
- `curl localhost:9001/endpoint` → actual response shape
- `grep -r "old_thing" --include="*.py"` → actual reference list (for migrations)

**What does NOT count:**
- "The function should return a dict" (assumption, not observation)
- "Import succeeded" (syntax check, not data verification)
- "Build passed" (compilation, not behavior)

### Component 3: Cross-Layer Audit

**What it does:** When the diagnose step identifies a change that crosses layer boundaries (provider switch, field rename, config key change), automatically runs a grep audit across all configured repos and presents the full reference list before the fix step begins.

**Trigger detection:** Two-tier detection — structured fields first, keyword fallback second.

1. **Structured (primary):** The `DiagnoseResult` contract includes a `scope_hint` field (`single` | `cross-layer` | `unknown`). The agent is instructed to set this based on whether the root cause spans multiple repos/layers. When `scope_hint == 'cross-layer'`, the audit always runs.

2. **Keyword fallback:** If `scope_hint` is `unknown` or absent, the engine scans the diagnose output for keywords:
   - Provider names: `openai`, `groq`, `anthropic`, `gpt-4`, `llama`
   - Config patterns: `config.json`, `env`, `.env`, `VITE_`
   - Field renames: "rename", "was previously", "changed from"
   - Routing changes: `Caddy`, `proxy`, `nginx`, `route`

The structured field is the reliable path; keywords catch cases where the agent forgets to set the hint.

**Intervention:** When triggered, inject a `scope_expansion` step between diagnose and fix:
1. Grep all configured repos for the affected term
2. Group results by repo and file
3. Present the full list to the agent
4. Require the fix step to address ALL references, not just the first one found

**Config:** Cross-layer repos are configured per-project in `.compose/compose.json`, not hardcoded. If no repos are configured, the audit scans only the current project directory.

```json
// .compose/compose.json
{
  "debug_discipline": {
    "cross_layer_repos": ["../other-repo", "../shared-lib"],
    "cross_layer_extensions": ["*.py", "*.json", "*.ts", "*.jsx", "*.yaml"]
  }
}
```

Default `cross_layer_extensions` is `["*.py", "*.json", "*.ts", "*.tsx", "*.jsx", "*.yaml"]`. Default `cross_layer_repos` is `[]` (current project only). The engine reads this config at startup — no hardcoded repo paths.

### Component 4: Attempt Counter

**What it does:** Tracks how many fix iterations target the same bug/file/endpoint. Enforces hard stops and escalation based on attempt count.

**Thresholds (canonical — all other references defer to this table):**
| Attempt | Action |
|---------|--------|
| 1 | Normal fix |
| 2 | Inject trace reminder. Visual bugs: hard stop, escalate to cross-agent review. |
| 3 | All bugs: require fresh trace evidence before next fix attempt |
| 5 | All bugs: hard stop, escalate to cross-agent review |

**Visual bug detection:** File extensions `.css`, `.scss`, `.jsx`, `.tsx` with keywords: `layout`, `position`, `display`, `animation`, `fit`, `resize`, `scroll`, `hidden`, `visible`, `z-index`.

**Escalation:** When triggered, the harness dispatches the bug to a different agent (e.g., Codex) with the full context of what was tried and failed. This breaks the "one more tweak" loop by introducing a fresh perspective.

### Component 5: Health Score Dimension

**New dimension in `health-score.js`:**

`computeCompositeScore()` uses a `DIMENSIONS` export (object with `weight` + `name`) and a local `scorers` object inside the function. Adding `debug_discipline` requires:
1. Add entry to `DIMENSIONS` export: `debug_discipline: { weight: 0.10, name: 'Debug Discipline' }`
2. Add scorer to the local `scorers` object inside `computeCompositeScore()`
3. Re-normalize existing weights to sum to 1.0 (subtract 0.10 proportionally from existing 6 dimensions)

The scorer is only called when `signals.debug_discipline` is present — absent dimensions are skipped and scored neutral (see `computeCompositeScore` line 179-183).

```js
// In DIMENSIONS export
debug_discipline: { weight: 0.10, name: 'Debug Discipline' },

// In computeCompositeScore scorers object
debug_discipline: () => scoreDebugDiscipline(signals.debug_discipline),

// New scorer function
function scoreDebugDiscipline(signals) {
  if (signals == null) return 50;
  let score = 100;
  // Fix chains: -15 per chain detected
  score -= (signals.fix_chain_count ?? 0) * 15;
  // Missing trace evidence: -20 per untraced fix
  score -= (signals.untraced_fixes ?? 0) * 20;
  // Escalations triggered: -10 per escalation (they indicate thrashing)
  score -= (signals.escalation_count ?? 0) * 10;
  return Math.max(0, score);
}
```

If `signals.debug_discipline` is absent (e.g., non-bug-fix builds), the scorer returns 50 (neutral) — it doesn't penalize builds that don't use the debug pipeline.

### Component 6: Review Lens

**New lens in `review-lenses.js`:**

```js
'debug-discipline': {
  id: 'debug-discipline',
  lens_name: 'debug-discipline',
  lens_focus: 'Fix-chain detection: are multiple commits patching the same function? ' +
    'Trace evidence: was the actual data inspected before the fix? ' +
    'Cross-layer completeness: does a migration/rename address ALL references? ' +
    'Type contracts: are there isinstance(x, dict) gates hiding type ambiguity?',
  confidence_gate: 7,
  exclusions: 'First-attempt fixes with trace evidence, pure refactors',
}
```

**Trigger:** Always active — runs on every review pass like the baseline lenses. The lens itself inspects fix-chain signals (from `.compose/debug-state.json` if present) and diff patterns (multiple hunks in the same function, `isinstance` checks, provider-name changes) to decide what to flag. Unlike conditional lenses (security, framework), this lens doesn't need file-pattern triggers because its signals come from iteration state, not file types.

## Enhanced Bug-Fix Pipeline

Updated `bug-fix.stratum.yaml` with discipline enforcement:

```yaml
functions:
  reproduce:
    # ... unchanged ...

  diagnose:
    mode: compute
    intent: >
      Trace the root cause by OBSERVING actual data, not assuming.
      Run commands that print real values at the failure point.
      Return trace_evidence: a list of {command, actual_output, conclusion}.
      You MUST run at least one command that prints an actual value.
    input:
      task: {type: string}
    output: DiagnoseResult
    ensure:
      - "result.trace_evidence != null"
      - "result.trace_evidence.length >= 2"
      - "all(e.command != null and e.actual_output != null for e in result.trace_evidence)"
      - "any(e.actual_output.length > 5 for e in result.trace_evidence)"
      - "result.root_cause != null"
    retries: 2

  scope_check:
    mode: compute
    intent: >
      If the diagnosed root cause involves a provider switch, field rename,
      config change, or anything that might span multiple repos/layers,
      grep ALL configured repos for every reference. Return the full list
      with references_found count. If the change is single-layer,
      return scope: 'single', references_found: 0, and skip.
    input:
      task: {type: string}
      diagnosis: {type: object}
    output: ScopeResult
    ensure:
      - "result.scope != null"
      - "result.references_found is not None"
    retries: 1

  fix:
    mode: compute
    intent: >
      Implement the minimal correct fix. If scope_check found cross-layer
      references, address ALL of them — report references_addressed count.
      Change only what is necessary.
    input:
      task: {type: string}
      scope: {type: object}  # ScopeResult with references_found
    output: BugFixResult  # must include references_addressed: int
    ensure:
      - "result.references_addressed >= scope.references_found if scope.references_found > 0 else True"
    retries: 2

**Contract note:** `references_found` is owned by `ScopeResult` (output of `scope_check`). `references_addressed` is owned by `BugFixResult` (output of `fix`). The fix step's ensure cross-references both — the scope result is available via `scope` input.

  # ... test, verify, ship unchanged ...
```

## Anti-Patterns Addressed

| Retro Finding | Detection | Intervention | Postcondition |
|---------------|-----------|-------------|---------------|
| 7-commit list_memories chain | Fix-chain detector (2+ iterations same file) | Trace gate blocks fix until evidence | `trace_evidence.length >= 2` |
| 10-commit Groq migration | Cross-layer audit triggered by structured diagnose fields + keyword fallback | Scope expansion: grep all configured repos | `fix.references_addressed >= scope.references_found` |
| 8-commit graph layout | Attempt counter + visual bug detection | Hard stop at attempt 2 (visual), cross-agent escalation | `attempt_count <= threshold` (see canonical threshold table) |
| dict vs MemoryItem mismatch | isinstance smell in review lens | Trace enforcer requires type() output | `trace_evidence contains type check` |

## Iteration Ledger (v1: file-based, upgrades to COMP-HARNESS-9 later)

v1 uses a file-based ledger at `.compose/debug-ledger.jsonl` — append-only JSONL written by `lib/debug-discipline.js`. When COMP-HARNESS-9 ships, this migrates to its structured format. Every debug discipline intervention writes to the ledger:

```jsonl
{"ts": "2026-04-12T10:30:00Z", "type": "fix_chain_detected", "file": "list_memories.py", "commits": 3, "intervention": "trace_gate"}
{"ts": "2026-04-12T10:31:00Z", "type": "trace_evidence", "command": "docker exec ... type(result)", "output": "MemoryItem", "conclusion": "callers assume dict"}
{"ts": "2026-04-12T10:35:00Z", "type": "scope_expansion", "trigger": "groq", "repos_scanned": 5, "references_found": 14, "references_addressed": 14}
{"ts": "2026-04-12T11:00:00Z", "type": "escalation", "reason": "visual_bug_attempt_3", "target_agent": "codex", "prior_attempts": ["rAF delay", "resize observer"]}
```

This feeds into SmartMemory via COMP-MEM-2, enabling cross-session learning: "last time this agent hit a fix chain on FalkorDB serialization, the root cause was MemoryItem vs dict."

## Files

| File | Status | Purpose |
|------|--------|---------|
| `lib/debug-discipline.js` | (new) | Core engine: detectors, interventions, attempt tracking |
| `pipelines/bug-fix.stratum.yaml` | (existing) | Add scope_check step, trace postconditions |
| `lib/health-score.js` | (existing) | Add debug_discipline dimension |
| `lib/review-lenses.js` | (existing) | Add debug-discipline lens |
| `contracts/debug-discipline.json` | (new) | TraceEvidence, ScopeResult, FixChain schemas |
| `server/debug-routes.js` | (new) | REST endpoints for discipline signals and history |

## Relationship to Existing Features

- **COMP-HARNESS-2 (stagnation detection):** Complementary. Stagnation = zero progress. Debug discipline = high activity, wrong direction. Both are agent governance, different failure modes.
- **COMP-HARNESS-5 (anti-gaming):** Debug discipline catches honest thrashing; anti-gaming catches dishonest reporting. Different trust levels, same goal.
- **COMP-HARNESS-9 (iteration ledger):** Debug discipline is a *producer* of ledger entries. The ledger is the persistence layer; discipline is the detection/intervention layer.
- **COMP-MEM-1/2/3 (SmartMemory integration):** Discipline findings ingested to SmartMemory enable cross-session learning about which codebases/layers are prone to which anti-patterns.

## Scope

**In scope:**
- Fix-chain detection via git analysis
- Trace evidence postcondition in bug-fix pipeline
- Cross-layer grep audit for migrations
- Attempt counting with thresholds and escalation
- Health score dimension
- Review lens
- Iteration ledger integration

**Out of scope (future):**
- Automatic root-cause inference from fix-chain patterns
- ML-based prediction of which bugs will thrash
- IDE integration (inline trace reminders)

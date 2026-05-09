# Pre-Response Policy Check (Adherence Enforcement)

**Status:** PLANNED
**Date:** 2026-05-09
**Owner:** ruze
**Companion feature (substrate half):** [SmartMemory CORE-ADHERENCE-1 — Adherence Pattern Catalog](../../../../SmartMemory/smart-memory-docs/docs/features/CORE-ADHERENCE-1/design.md)
**Driving evidence:** [SmartMemory DIST-CC-INGEST-1 — 50-event ensemble run, 2026-05-09](../../../../SmartMemory/smart-memory-docs/docs/features/DIST-CC-INGEST-1/design.md)

---

## TL;DR

A 50-event cross-model judge ensemble (claude:sonnet + codex:default) over real Claude Code sessions surfaced a clear pattern: the agent has dense feedback rules in scope every session and selectively violates a small cluster of them — primarily *don't ask permission, just execute*. ~16% real CONTRADICTED rate (after adjusting for user-precedence false positives).

That's not a memory-substrate problem (the pool is rich and correctly surfaced). It's a **harness problem**: response generation needs a policy check between draft and emit. SmartMemory exposes the pattern catalog; Compose runs the check.

This feature ships the check.

---

## What it is

A response-time policy gate that:

1. Fetches the violation-pattern catalog from SmartMemory once per session (`mcp__smartmemory__memory_get_violation_patterns`), caches in-memory.
2. Scans candidate agent responses against the patterns.
3. Scans the recent user turn(s) for **suppression signals** that override violation flags (under `superpowers:using-superpowers` user-precedence).
4. If a violation pattern matches and no suppression signal applies, surfaces the violation to the agent for revision (does NOT hard-block).
5. Logs all pattern matches (whether suppressed or not) to a session-bound trace for post-hoc analysis by SmartMemory's DIST-CC-INGEST-1 ensemble.

Critically, the check is **user-intent-aware**, not naive regex-on-static-pool. A naive regex flag would over-fire by ~30–40% on user-paced sessions where the user explicitly asked for slow pacing.

---

## Why this lives in Compose, not SmartMemory

Substrate/harness boundary:

| Layer | Owns | Does NOT own |
|---|---|---|
| **SmartMemory** | Storing rules, ensuring they're in scope, exposing detection-pattern metadata, post-hoc measurement of adherence | Reading candidate responses, deciding when to stop, gating agent output |
| **Compose** (this feature) | Reading SmartMemory's pattern catalog, running pre-response checks, suppression-signal evaluation, gating tool execution, prompting agent for revision | Storing rules, persisting feedback memory, indexing decisions |

A memory layer that polices output is one step from being "the layer that decides what you can ship." That's not what SmartMemory is for. Conversely, Compose already orchestrates agent behavior — gates, checkpoints, postcondition checks — so adding "pre-response policy check" is a natural Compose primitive.

A side benefit: harness-layer enforcement keeps SmartMemory **multi-harness-compatible**. Other harnesses (raw Claude Code, Cursor, Codex, custom agents) can adopt the pattern at their own pace by consuming the same MCP tool, without needing SmartMemory to grow into their orchestration layer.

---

## Architecture

```
                       ┌──────────────────────────────────────┐
                       │ User turn arrives                    │
                       └──────────────────────────────────────┘
                                       │
                                       ▼
                       ┌──────────────────────────────────────┐
                       │ Compose: scan recent user turn(s)    │
                       │  for suppression signals → user_mode │
                       │  ∈ {AUTONOMOUS, PACED, SKILL_GATED}  │
                       └──────────────────────────────────────┘
                                       │
                                       ▼
                       ┌──────────────────────────────────────┐
                       │ Agent generates candidate response   │
                       └──────────────────────────────────────┘
                                       │
                                       ▼
              ┌───────────────────────────────────────────────────┐
              │ Compose pre-response policy check                 │
              │                                                   │
              │  1. For each rule in cached catalog:              │
              │     scan candidate response against patterns      │
              │  2. For matched rules:                            │
              │     check suppression_signals against user_mode   │
              │     - AUTONOMOUS → flag                           │
              │     - PACED → suppress (user-precedence)          │
              │     - SKILL_GATED → suppress (e.g. Compose gate)  │
              │  3. Log all matches (flagged + suppressed) to     │
              │     session trace                                 │
              │  4. If flagged: surface to agent prompt           │
              │     "Your draft contains pattern X for rule Y;    │
              │      revise unless precedence applies"            │
              └───────────────────────────────────────────────────┘
                                       │
                                       ▼
                       ┌──────────────────────────────────────┐
                       │ Send response (revised if flagged)   │
                       └──────────────────────────────────────┘
```

---

## Surface options (where the check actually runs)

1. **Compose-orchestrated agent loop.** When Compose invokes an agent for a phase, the policy check runs inline in Compose's response-handling. **Default for Compose-mediated work.** Already in Compose's lane.
2. **Stratum step postcondition.** A Stratum spec step can declare `ensure: no_unsuppressed_policy_violations` as a postcondition; the check runs in Stratum's evaluation layer. **For Stratum-driven flows.** Reuses existing Stratum machinery.
3. **Standalone Claude Code hook (`PostResponseDraft` if/when it exists, else post-emit).** Not Compose, but the same pattern catalog, exposed for raw Claude Code users. **v2.** Emits a side-channel "you violated rule X" notification rather than gating; useful for measurement-only mode.
4. **Self-policing MCP tool.** `compose_check_response(draft)` callable by the agent. Weakest option — codex's data already shows the agent doesn't reliably self-police. Skip until evidence justifies.

**Sequencing:** ship #1 first as the Compose default; #2 as the Stratum postcondition shape; #3 deferred until a Claude Code hook surface exists.

---

## User-mode classification

Three modes determine whether a pattern match becomes a flag:

| Mode | Trigger | Effect on matches |
|---|---|---|
| **AUTONOMOUS** | Default. No slow-pacing or skill-gate signal in recent user turn. | Flag |
| **PACED** | Recent user turn contains a `suppression_signals` match (`one by one`, `walk me through`, `step by step`, etc.) | Suppress |
| **SKILL_GATED** | An active skill or Compose phase explicitly declares gate behavior (e.g. Compose's plan/blueprint gates). | Suppress |

Mode is recomputed per turn. A session can move between AUTONOMOUS and PACED as the user's pacing preference shifts.

---

## What's explicitly NOT in this feature

- **Hard-blocking responses.** The check surfaces violations for revision; it does not refuse to emit. Hard-blocking on natural-language patterns is too brittle.
- **Auto-rewriting violations.** The agent revises the draft; Compose doesn't ghost-write the fix.
- **A general rules engine.** Pattern matching only. Anything more sophisticated (semantic match, model-judged compliance) is future work; the simpler primitive ships first.
- **Storage of rules or patterns.** SmartMemory owns those. Compose only reads.
- **Decisions about which rules to enforce.** The user authors the catalog; Compose enforces what's catalogued.

---

## Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | False positives — flagging user-requested checkpoints as violations | User-mode classification is the whole point. Tune suppression signals until false-positive rate <5% on a held-out PACED-session set. |
| 2 | False negatives — agent finds a new way to ask permission that doesn't match patterns | Pattern catalog must evolve. Pair with continuous LLM-as-judge measurement (DIST-CC-INGEST-1) to surface novel evasion patterns. |
| 3 | Compose-mediated agent loops slow down from per-turn check overhead | Patterns are simple regex/phrase matches; ~ms-scale cost. Cache the catalog; only re-fetch on rule-change. |
| 4 | Agent ignores the revision prompt | Track revision-acceptance rate. If agent visibly defaults to ignoring, escalate to inline structured-prompt injection. |
| 5 | Bleeds into "alignment theater" / agent autonomy debate | Scope is exactly the rules in `<project>/memory/feedback_*.md`. The user authored them. We respect user-precedence. Stay in that lane. |

---

## Open design questions

1. **Compose-mode skill detection.** How does the user-mode classifier know Compose is in a gate phase? Likely via a Compose-internal flag on the active session; needs an interface contract.
2. **Stratum postcondition shape.** What's the exact `ensure:` expression for "no unsuppressed policy violations"? Probably `compose.policy.unsuppressed_violations == 0`.
3. **Telemetry surface.** Flagged violations should be visible to the user post-session for review (especially during early tuning). Cockpit panel? Daily digest?
4. **Bootstrap on the agent that's writing this design.** The agent that drafted this very document has the violation cluster in scope and has been asking permission throughout the session. The first dogfood test of this feature is on its own author.

---

## Success metrics

- **Unsuppressed CONTRADICTED rate** on the dominant cluster (`never_suggest_stopping` / `just_do_it` / `full_auto_means_full_auto`) drops from ~16% (real, post-precedence-adjustment) to <5% in DIST-CC-INGEST-1 ensemble runs after deployment.
- **False-positive rate** on PACED-session held-out set stays <5%.
- **Revision-acceptance rate** (agent revises when flagged) stays >70%.
- **Compose phase latency** does not regress measurably.

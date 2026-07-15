# COMP-TRIAGE-5 — Front-of-pipeline scope estimation + verification-gated escalation (E3)

**Status:** DESIGN
**Owner:** ruze
**Date:** 2026-07-15
**Mode:** build

## Related Documents

- Upstream capability: `docs/features/COMP-TRIAGE-1/feature.json` (classification engine `lib/triage.js`), `COMP-TRIAGE-3` (build integration + `skip_if` toggling), `COMP-TRIAGE-4` (PARKED tier history).
- External source: Yin & Feng, *"Do AI Agents Know When a Task Is Simple? Toward Complexity-Aware Reasoning and Execution"*, arXiv:2607.13034 (Jul 2026). E3 = Estimate → Execute → Expand; ACRR = Agent Cognitive Redundancy Ratio.
- Related parked ideas: `idea_budget_ceilings` (bounded escalation), `idea_tiered_gate_evaluation` (cheap-before-expensive).

## 1. Problem

Compose already ships a complexity-triage engine (`lib/triage.js`, COMP-TRIAGE-1/3). It assigns a Tier 0–4 and a build `profile` of `{needs_prd, needs_architecture, needs_verification, needs_report}`, and enforces it by toggling `skip_if` on Stratum steps (`lib/build.js:1045-1075`).

**The engine is positioned backwards.** `deriveProfile` reads the *already-written* `design.md` / `plan.md` / `blueprint.md` for its signal (`lib/triage.js:194`), and it runs *inside* `runBuild` after those docs exist (`lib/build.js:973`). So the pipeline pays for the design/blueprint audit **before** it learns the task didn't need them. This is exactly the "maximum-context-first" waste E3 identifies: a one-line edit still triggers a small codebase audit before the skip decision fires.

There is no seam that estimates scope from the **raw request** before any doc is written, and no mechanism to recover if a lean lane was the wrong call.

## 2. Goal & Non-goals

**Goal:** Faithfully implement E3 on top of the existing engine:
1. **Estimate at the front** — derive `{tier, profile}` from the raw request + repo signals *before* the genesis phase, so trivial work never enters design/blueprint.
2. **Execute lean** — reuse the existing `profile → skip_if` enforcement unchanged.
3. **Expand on verification failure** — when a downstream gate we already own fails, escalate the lane, un-skip the phases it skipped, and re-run wider. Bounded.

Plus two prerequisite correctness fixes (Section 6) that this work sits on top of.

**Authority model: C (advisory entry, enforced escalation).** Entry into the lean lane is a recommendation the orchestrator follows; the *escalation* is enforced and keyed off existing gates. Chosen over pure-advisory (A) because the enforcement already exists, and over hard-budget (B) because a wrong "trivial" call must be recoverable, not fatal.

### 2.1 Relationship to the manual `--quick` flag

Today `--quick` is a **binary decision a human types** (`build-quick` template, `bin/compose.js:2157-2158`), and the human is the one guessing whether the task is small. This feature makes that decision **automatic and more granular**:

- **Automatic:** `estimateScope` picks the lane from the request; the human no longer has to know to type `--quick`.
- **More granular than quick-vs-full:** the lane drives the existing per-phase `profile` (`needs_prd`, `needs_architecture`, `needs_verification`, `needs_report`), so the output is "which specific phases does *this* task need," not one on/off switch. `--quick` is effectively the `trivial` lane chosen by hand; the estimator can also land in between (e.g. skip PRD but keep verification).
- **Overrides retained:** `--quick`, `--skip-triage`, and `--template` remain as manual escape hatches that pin the lane and bypass the estimator.

**Non-goals (v1 narrow — deferred as follow-ups):**
- ACRR as a Stratum audit metric (`files_inspected / files_needed`). Filed, not built.
- Fix-mode front estimate. v1 is build mode only, matching the existing `runsTriage:true` for build / `false` for fix (`lib/lifecycle-modes.js:66,103`).
- Cross-feature tier history (already parked as COMP-TRIAGE-4).

## 3. Design overview — E3 mapping

| E3 step | Mechanism | New or reused |
|---|---|---|
| **Estimate** | `estimateScope(request, repoSignals)` — doc-free front estimator | **New** (extends `lib/triage.js`) |
| **Execute** | existing `profile → skip_if` toggling | **Reused** unchanged (`lib/build.js:1045-1075`) |
| **Expand** | gate-failure → lane escalation → un-skip → re-enter | **New** (`lib/escalation.js`) |

The existing `deriveProfile` (doc-reading) is retained but demoted to a **refinement** pass: once design/plan exist it may only *narrow* the lane (confirm trivial), never silently widen it. Widening is the escalation path's job and must be explicit.

## 4. Components & boundaries

### 4.1 `estimateScope(request, repoSignals)` — `lib/triage.js` (existing file, new export)

- **Purpose:** produce the same `{tier, profile}` contract as `deriveProfile`, from signals available *before* any doc exists.
- **Inputs:**
  - `request`: the raw task text (verbs, explicit file paths, task-checkbox count if present).
  - `repoSignals`: files the request plausibly touches (path extraction, reusing the existing path-count logic), and whether those paths hit the existing security patterns (`lib/triage.js:33-44`) or core/shared patterns (`:46-54`).
- **Explicitly does NOT** read `design.md`/`plan.md`/`blueprint.md` — they don't exist yet.
- **Output:** `{tier, profile, lane, confidence, rationale}`, persisted (Section 6) with the existing `triageTimestamp` idempotency (`lib/triage.js:244` `isTriageStale`).
- **Dependency:** shares the pattern-set constants already in `lib/triage.js`; no LLM call (stays consistent with COMP-TRIAGE-1's "no LLM" contract). If a signal-only estimate is low-confidence, see Section 7.

### 4.2 Front-seam wiring — `lib/build.js` (existing)

- Call `estimateScope` **before spec load** (~`lib/build.js:963`, where `deriveProfile` runs today), so the lane is set before the genesis phase (`explore_design`, `lib/lifecycle-modes.js:55`).
- Feed the resulting `profile` into the existing `skip_if` toggling unchanged.
- The later `deriveProfile` refinement pass (after docs exist) may only narrow.

### 4.3 `lib/escalation.js` — new module (one purpose, isolatable)

- **Purpose:** given `(failedGate, currentLane, escalationCount)`, decide `(nextLane, reEntryPhase)` or `STOP`.
- **Escalation ladder:** `trivial → standard → complex`. Each step un-skips the phases the lower lane skipped and sets the re-entry phase to the earliest un-skipped phase (design/blueprint).
- **Re-entry phase source:** read `item.lifecycle.currentPhase` from the vision store (`server/compose-mcp-tools.js:836`), **not** `feature.json.phase` (Section 6, fix #2).
- **Bound:** max 2 escalations, then `STOP` and surface to human (ties to `idea_budget_ceilings`). Prevents the DeepSWE retry-loop cost blowup.
- **Gate sources (triggers):** the COMP-TEST-BOOTSTRAP-4 test-count/pass-rate ship gate, a Codex review verdict, or `stratum_judge`. The module is agnostic to which fired — it takes a normalized `{gate, passed}`.

### 4.4 Registry — `lib/lifecycle-modes.js` (existing)

- No new mode. `runsTriage` stays build-only for v1. Note fix-mode front estimate as a follow-up in the registry comment.

## 5. Data flow

```
raw request
  → estimateScope(request, repoSignals)         # E3: Estimate  (before any doc)
  → {tier, profile, lane, confidence} persisted to feature.json
  → profile sets skip_if BEFORE genesis phase    # E3: Execute (reused enforcement)
  → lean phases run (trivial skips design/blueprint/PRD)
  → downstream gate (test-count | codex | judge)
       ├─ pass → done
       └─ fail → escalation.js: nextLane + reEntryPhase   # E3: Expand
                   → un-skip phases, re-enter at design/blueprint
                   → (bounded: max 2, then STOP → human)
```

## 6. Feature-record / schema changes (prerequisite bolt-fixes — in scope)

These are pre-existing correctness gaps the explorer surfaced; the front seam sits on top of them, so they are fixed here.

### Fix #1 — reconcile the `complexity` field (two meanings today)

Today the MCP schema/writer enforces `complexity ∈ {S,M,L,XL}` (`server/compose-mcp.js:327`, `lib/feature-writer.js`), but the triage path writes the tier as a string `"0".."4"` into the *same field* (`lib/build.js:997,1006`), bypassing the validator.

**Resolution:** separate the two axes.
- [ ] Add a distinct machine field `triageTier` (integer 0–4) to the `feature.json` schema via `lib/feature-writer.js`.
- [ ] Triage writes the tier to `triageTier`, and writes a **mapped** `S/M/L/XL` value to `complexity` **through** the validator (no more bypass).
- [ ] Add a mapping (tier 0–1 → S, 2 → M, 3 → L, 4 → XL) documented in `lib/triage.js`.
- [ ] Regression test asserting `complexity` is never written outside the enum.

### Fix #2 — read lifecycle phase from the vision store, not `feature.json`

`feature.json.phase` is the roadmap grouping heading, not the lifecycle phase; the live phase is `item.lifecycle.currentPhase` in the vision store (`server/compose-mcp-tools.js:836`, `server/index.js:218`).

- [ ] Escalation re-entry reads `item.lifecycle.currentPhase`; never infers phase from `feature.json`.

### New persisted fields

- [ ] `lane` (enum: `trivial | standard | complex`) on `feature.json` via `lib/feature-writer.js`.
- [ ] `triageTier` (see Fix #1).
- [ ] `estimateSource` (`front | refined | escalated`) so an inspector can see whether the lane came from the raw request, the doc-refinement pass, or an escalation.

## 7. Error handling & safety

- **Bias to the safe lane on low confidence.** If `estimateScope` confidence is below threshold, default to `standard` (full), never `trivial`. Under-scoping a subtly-hard task is the one dangerous error (the DeepSWE "under-specified → Opus/high" failure mode); over-scoping only costs tokens. This is the load-bearing safety rule.
- **Escalation is bounded** (max 2) and terminates in a human handoff, never an infinite widen-retry loop.
- **Idempotency:** re-runs no-op via `triageTimestamp` + mtime staleness (`isTriageStale`), reusing the COMP-TRIAGE-1 pattern.
- **Escalation is explicit, refinement is not.** The doc-reading refinement pass can only narrow; any widening must go through `escalation.js` and be recorded (`estimateSource: escalated`).

## 8. Testing (golden flows — real Stratum backend, no mocks)

- [ ] **Lean-path golden:** a one-line edit request → `estimateScope` picks `trivial` → design/blueprint/PRD skipped → implement → gate passes → done. Assert phases skipped **and** success. Record files-inspected count (proto-ACRR) and assert it is far below the full-lane count.
- [ ] **Escalation golden (load-bearing):** a request that *looks* trivial but fails the test-count gate → assert lane auto-escalates `trivial → standard`, previously-skipped phases run, second pass passes. This test proves the safety net; without it the whole design is unsafe.
- [ ] **Low-confidence → safe lane:** ambiguous request → asserts `standard`, not `trivial`.
- [ ] **Bounded escalation:** a request that keeps failing → asserts `STOP` + human handoff after 2 escalations, no loop.
- [ ] **Contract:** `estimateScope` output schema; `complexity` never written outside `{S,M,L,XL}` (Fix #1 regression).

## 9. Acceptance criteria

- [ ] `estimateScope(request, repoSignals)` exists in `lib/triage.js`, doc-free, returns `{tier, profile, lane, confidence, rationale}`.
- [ ] Front-seam call runs before genesis phase in `lib/build.js`; trivial lane demonstrably skips design/blueprint on the lean-path golden.
- [ ] `lib/escalation.js` escalates on a failed gate, un-skips, re-enters from the vision-store phase, bounded at 2 with human handoff.
- [ ] `complexity` field reconciled (Fix #1); `triageTier` + `lane` + `estimateSource` persisted; no validator bypass.
- [ ] Escalation reads `item.lifecycle.currentPhase` (Fix #2).
- [ ] All five golden/contract tests pass against real backends.
- [ ] Low-confidence defaults to the safe lane.

## 10. Deferred / follow-ups

- **COMP-TRIAGE-6 (proposed):** ACRR as a Stratum audit metric (`files_inspected / files_needed`), emitted per step. The lean-path golden already records the raw count as a stepping stone.
- **Fix-mode front estimate:** extend `estimateScope` to fix mode once the build-mode seam is proven.
- **COMP-TRIAGE-4 (parked):** cross-feature tier history — unblocked by `triageTier` landing as a first-class field.

## 11. Provenance

Reframed 2026-07-15 after codebase exploration found COMP-TRIAGE-1/3 already ship the classifier and the `skip_if` enforcement, but positioned *after* design docs exist. Original framing ("build a triage gate") was corrected to "move the estimate to the front + add verification-gated escalation," building on `lib/triage.js` rather than beside it. Authority model C selected because enforcement already exists and a wrong trivial call must be recoverable.

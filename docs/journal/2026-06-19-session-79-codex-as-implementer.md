---
date: 2026-06-19
session_number: 79
slug: codex-as-implementer
summary: "Shipped STRAT-AGENT-INTERP (interpolatable per-step agent) then COMP-CODEX-IMPL (--codex: Codex implements, Claude reviews) on top of it"
feature_code: COMP-CODEX-IMPL
closing_line: Build the data-plane primitive first, and the feature on top is a spec edit plus a fail-fast probe — not a fork.
---

# Session 79 — COMP-CODEX-IMPL

**Date:** 2026-06-19
**Feature:** `COMP-CODEX-IMPL`

## What happened

A single `/compose build STRAT-AGENT-INTERP then COMP-CODEX-IMPL full auto codex reviews` request. We shipped the Stratum enabler first, then the Compose consumer that depends on it.

STRAT-AGENT-INTERP makes a flow step's `agent:` field interpolatable through the same JSONPath resolver that already handles `inputs`, so `agent: "$.input.implementer_agent"` (or a router step's output) selects the executor at runtime. The design Codex review went 3 rounds and earned its keep: it caught that a single chokepoint wasn't enough (the server-side parallel_dispatch path passes the literal agent into ParallelExecutor), that the result-cache key would collide claude-vs-codex dispatches of the same step, that profile agents like `claude:reviewer` need prefix validation, and that `has_cert` misclassifies a `$`-ref agent. Implementation review was clean in one pass. The full suite caught a subtle one we didn't: importing `connectors.factory` at executor module-load broke the multiprocessing-spawned guardrail regex worker (every pattern fail-closed to a false match) — fixed with a lazy import.

COMP-CODEX-IMPL then flips the implementer to Codex while keeping cross-model Claude review. Because STRAT-AGENT-INTERP made the parallel_dispatch `execute` step's agent resolvable from a flow input, this is one spec — not a `build-codex.stratum.yaml` fork. Three explorers mapped the build pipeline first; the design review went 2 rounds (resume role durability + the worktree-Seatbelt guard), and the implementation review went 4 rounds, each finding real: stale-role bleed into fresh rebuilds, a probe that could hang/false-pass, the probe bypassing resumed builds, and a stale `running` active-build on probe-abort.

## What we built

Stratum (committed 4651933):
- `executor.py`: `resolve_agent` + `effective_agent` helpers; every runtime consumer of `step.agent` rerouted (dispatch envelopes, cert injection/validation, completion StepRecord, server-side ParallelExecutor, error envelopes); conditional cache-key fold (only for interpolated agents, so literal-agent keys stay byte-identical).
- `connectors/factory.py`: public `VALID_AGENT_TYPES`. `spec.py`: `has_cert` treats a `$`-ref agent as conservatively cert-capable. 18 tests.

Compose (committed ac56231):
- `bin/compose.js`: `--codex` flag, v1 full-build single-feature guards.
- `lib/build.js`: implementer/reviewer role model, resume-durable role restoration (only on actual resume), fixer=implementer, Codex self-review suppression, the probe call with identity-guarded fail-fast rollback.
- `lib/codex-preflight.js` (new): the worktree write-probe (bounded timeout, unique sentinel, per-repo cache, env escape hatch).
- `pipelines/build.stratum.yaml`: interpolated execute/reviewer agents, role inputs in both input blocks, sub-flow reviewer threading.
- `test/codex-impl.test.js` (18 tests); updated two `par-merge-consumer-retry` planInputs assertions for the new contract.

## What we learned

1. A 3-round design review on a 'small' primitive paid off four times over — the single-chokepoint instinct was wrong, and the cache-key collision was a silent correctness bug no test would have caught until two executors produced different results for the 'same' step.
2. Import order is behavior: pulling a package into a module's load graph changed what a multiprocessing-spawned worker re-imported, and a fail-closed guardrail turned that into false matches. The full suite (not the unit tests) caught it — run it.
3. Recompute-from-persisted-state beats storing new mutable state for anything that must survive resume: `effective_agent` recomputes from flow inputs + step outputs, so audit/resume/cache replay identically with zero new serialize surface.
4. 'Defer the spike behind a warning' is not a guard. A warning explains a failure after it happens; a preflight probe that aborts fast (and rolls back the state it touched) is the honest version. Codex pushed us from warning → probe → identity-guarded rollback over four rounds.
5. Restore-on-resume must fire ONLY on an actual resume — restoring eagerly let a completed --codex build's role bleed into a later plain build of the same code.

## Open threads

- [ ] COMP-CODEX-IMPL-SPIKE: live-verify Codex writing in a detached worktree; add a Codex `isolation: none` fallback for environments where the probe fails (isolation isn't interpolatable, so it needs a producer change or an execute variant).
- [ ] build-quick Codex parity (v1 rejects --codex + --quick).
- [ ] lib/new.js still has the old codex->claude swap (off the build path).
- [ ] A Codex/gpt tier->model map in server/model-tiers.js (today Codex gets the producer default for type:codex).
- [ ] Neither commit pushed yet (awaiting user). Stratum push triggers the pre-push auto-bump.
- [ ] Pre-existing unrelated WIP in stratum connectors/codex.py (model-validation softened to warn-not-raise) makes 3 codex-model tests stale — not ours, left untouched.

---

*Build the data-plane primitive first, and the feature on top is a spec edit plus a fail-fast probe — not a fork.*

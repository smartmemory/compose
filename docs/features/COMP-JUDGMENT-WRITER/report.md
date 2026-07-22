# COMP-JUDGMENT-WRITER — Implementation Report

**From:** [plan.md](plan.md) (T1–T7, executed in order, TDD per slice) · [blueprint.md](blueprint.md) (Corrections Table honored) · [design.md](design.md) rev 5
**Status:** W1–W2 shipped; W3 cutover HUMAN-GATED (staged diff ready, awaiting owner approval)
**Date:** 2026-07-22

## What shipped

| Slice | Files | Tests |
|---|---|---|
| S01 contract + loader | `contracts/judgment-record.schema.json`, `lib/judgment/schema.js` | `test/judgment-schema.test.js` (32) |
| S02 store + registry | `lib/judgment/store/records.js`, `lib/judgment/store/index.js` | `test/judgment-store.test.js` (11) |
| S03 write guard | `lib/judgment-write-guard.js` | `test/judgment-write-guard.test.js` (20) |
| S04 projections | `lib/judgment-gen.js` | `test/judgment-gen.test.js` (8) |
| S05 writer | `lib/judgment-writer.js` (+ `lifecycle-modes.js` judgment mode) | `test/judgment-writer.test.js` (8), `test/judgment-guard-integration.test.js` (4) |
| S06 MCP surface | `server/compose-mcp.js`, `server/compose-mcp-tools.js`, `server/mcp-tool-policy.js` | `test/judgment-writer-mcp.test.js` (7) |
| S07 importer | `bin/judgment-import.js` | `test/judgment-import.test.js` (4) |

Full suite green at ship: 4,775 node tests + 681 vitest, 0 failures.

## Deviations from the blueprint (all deliberate, none silent)

1. **`judgment` lifecycle mode added to `LIFECYCLE_MODES`** (`lib/lifecycle-modes.js`, not in the blueprint file plan). The untouched `guardedTransition` adapter resolves its graph from the mode registry; without a mode entry it would register the *build* phase graph against joints and fail-closed refuse every judgment edge. The registry's own contract says a new mode is a data-only add. Known superset: `buildPhaseGraph` unconditionally adds `resolved→complete` and `→killed` edges — unreachable through the writer (edge→artifact table refuses first), pinned exactly in the parity test, guard-side closure is epic S4–S6 territory.
2. **`lib/judgment-gen.js` consumes `createJudgmentStore`, not `RecordsStore`** (boundary map said RecordsStore). The one-canon acceptance criterion ("`judgment.provider` is the ONLY canon selector") requires every production read/write path to pass the selector — Codex round 1 finding 1.
3. **Cutover mechanics:** the real import stages the full writer-driven import in a temp workspace, then lands records via copy + single atomic rename and regenerates projections — instead of replaying writer calls against the live tree. Crash-safety (no partial `records/`); the records are still 100% writer-produced. Audit events for the import land in the staging workspace (discarded); the cutover commit itself is the durable audit.
4. **Lock recipe hardened over the journal template:** the judgment critical section can span a 10s Stratum guard call, so the 5s-stale mkdir lock gained a 1s heartbeat + owner token (steal only a heartbeat-dead lock; never release another holder's lock).
5. **`lib/idempotency.js` lock hardened** (shared util, not in the blueprint file plan): the same heartbeat + owner-token recipe, because `checkOrInsert` holds its lock across the whole compute and a guarded judgment transition can outlast the old 5s stale threshold (Codex round 2, finding 4). No API change; journal/feature writers unaffected (their critical sections were already short).

## ONE-UNDER-TEST guard-predicate probe (plan T5 requirement)

**Result: not expressible.** STRAT-GUARD edge predicates are per-resource `deterministic` statements of the form `server_file_exists('<rel path>')` (`server/lifecycle-guard.js#edgePredicates`); there is no predicate form quantified over a population of resources, so "no OTHER joint is under_test" cannot be pushed into the guard today. The writer-local floor (check inside the judgment advisory lock) is the enforcement. The upstream contribution the design requires either way is filed: **smartmemory/stratum#25** (population-level invariant predicates).

## Review history

- **Round 1** (Codex `gpt-5.6-sol/xhigh`, adversarial, 2026-07-22): 11 findings — 8 fixed (provider selector bypass, guard crash-window roll-forward + durable divergence notes + intent kept on guard error, lock heartbeat/ownership, EXT result-package + dispatch-stamp enforcement, re-dispose packages on both targets, sync validate-before-idempotency, importer grounding fidelity + owner-locked parsing, staged-diff reviewability + atomic cutover), 3 accepted-in-part (guard-graph superset pinned + documented; reviewer gate proven e2e — enabling `phaseScopedTools` in this workspace is a separate owner decision; roundtrip guard gained orphan detection, pre-commit invocation stays at the cutover/exit gates).
- **Round 2** (same config, fix verification): confirmed all round-1 fixes present; 7 narrower findings — 6 fixed (stacked-intent ONE-UNDER-TEST occupancy on the live path + replay re-check with durable drop, importer provider preflight, dispatch-stamp attachment restricted to the dispose edge, idempotency-lock heartbeat, note-before-clear durable divergence drops, sync validation of straddle/redispose packages), 1 deflected with evidence (owner-token TOCTOU requires an already-dead holder — a live holder's heartbeat makes the steal precondition unsatisfiable; documented in code).
- **Round 3** (same config): 4 findings, all accepted — replay occupancy check moved BEFORE the guard call (recovery can never advance the guard for an intent it drops), redispose restricted to `inconclusive →` edges (kills the method-swap smuggling path), lock stale thresholds raised to 20s with the sync-block bound documented, live guard refusals made durable via the same drop path as replay.
- **Round 4** (same config, P1-only verification bar): all four fixes verified, no new defects — **REVIEW CLEAN**. Convergence across rounds: 11 → 7 → 4 → 0.

## Open items at ship

- **W3 cutover** — human gate: owner reviews staged generated-vs-hand-written diff, then the single cutover commit (records + projections + importer + CHANGELOG).
- **`capabilities.phaseScopedTools`** is OFF in this workspace, so the reviewer-profile denial of judgment write tools is policy-table-only until the capability is enabled — owner decision, flagged.
- **W4** SmartMemory enrichment (own blueprint) + SmartMemory RFC items 1–3 — deferred by design.
- **EXT evidence writer** — Answerer slice; until it exists no EXT resolution can be written (now structurally enforced, not just true by absence).

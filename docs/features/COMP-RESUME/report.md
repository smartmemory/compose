# COMP-RESUME: Implementation Report

**Status:** COMPLETE
**Date:** 2026-06-02
**Design:** `design.md` · **Blueprint:** `blueprint.md` · **Plan:** `plan.md`

## Summary

Environment-based resumability for Compose builds. Interrupted builds resume from ground-truth environment state (git + on-disk artifacts + append logs) rather than reconstructed context. Shipped the full spine: capability-tiered checkpoint store, deterministic environment fingerprint + drift classifier, best-effort anchor checkpoints at every lifecycle boundary, on-demand narrative checkpoints, and a deterministic reconcile-on-resume that auto-resumes safe cases and gates only genuine divergence.

## Delivered vs Planned

| Slice | Planned | Delivered |
|---|---|---|
| S1 contract | ✓ | `contracts/checkpoint.schema.json` |
| S2/S3 fingerprint+git | ✓ | `lib/checkpoint/{git,fingerprint}.js` |
| S4/S5 store | ✓ | `lib/checkpoint/store/{index,jsonl}.js` + `atomic.js` |
| S6 prompts | ✓ | `lib/checkpoint/prompts.js` |
| S7 anchor | ✓ | `lib/checkpoint/anchor.js` |
| S8 reconciler | ✓ | `lib/checkpoint/reconciler.js` |
| S9 MCP tools | ✓ | `write_checkpoint`, `compose_resume` + `checkpoint-writer.js` |
| S10 boundary wiring + route | ✓ | 7 boundary anchors + `POST /api/session/bind/reconcile` |
| S11 config + render | ✓ | `checkpoint` config block + `render.js` |

**Deferred (intentional):** SmartMemory backend — registered seam (`NOT_IMPLEMENTED`) only, per scope cut. `memory-pointer` backend — same.

## Architecture deviations (from design, via Codex boundary review)

- **No `.claude/agents/*.md`**: Compose dispatches agents via connectors, so scribe/reconciler are prompt builders (`prompts.js`) invoked at the orchestrator, not agent files.
- **`reconcile()` is deterministic**: does not persist, mutate the vision DB, or call an LLM. The route applies `lifecycleMutations`; the orchestrator runs the agent on `needs-sync`. (Resolved a double-apply bug found post-wiring.)
- **`loadProjectConfig` does not merge defaults**: `checkpoint.*` defaults applied explicitly at call sites.
- **build-stream path**: read from `composeDir` (`.compose/`), not `dataDir`.

## Test coverage

- Golden flow (real git + real jsonl): write anchors across phases → narrative checkpoint → interrupt → reconcile resumes at correct nextStep.
- Drift table: clean/advanced/diverged → resume vs needs-sync; `decideAfterSync` threshold.
- Contract conformance; best-effort (throwing store swallowed); writer (anchor/narrative/scribePrompt; enabled/disabled gate).
- **77 checkpoint tests; full node suite 3043/0; UI 146; tracker 100.**

## Known issues & tech debt

- **Pre-existing, unrelated:** `test/integration/agent-run-streaming.test.js` (STRAT-DEDUP-AGENTRUN-V3) fails 2/4 — verified independent of COMP-RESUME (fails with COMP-RESUME edits reverted). Follow-up filed.
- **Test hygiene:** boundary hooks write checkpoint files to the real `.compose/data/` when existing route tests exercise the handlers (gitignored, benign — same pattern as `gate-log.jsonl`). Route tests could set `COMPOSE_TARGET` to a tmp dir. Minor.
- **`currentPhase` reconciliation** from `active-build.json` is not yet emitted (only `phaseHistory` backfill); the route is ready for it. Future enhancement.
- **No HTTP route integration test** for `/api/session/bind/reconcile` (reconcile + appendPhaseHistory are unit-tested separately). Candidate follow-up.

## Lessons

- The boundary Codex review (before wiring) caught 5 issues; the post-wiring impl review caught 3 more (incl. a real double-apply bug) — both gates earned their cost. Reviewing the *blueprint boundaries* before integration and the *wired implementation* after are distinct, both necessary.
- Deterministic core + thin persistence/agent boundary kept the heart unit-testable with no live server.

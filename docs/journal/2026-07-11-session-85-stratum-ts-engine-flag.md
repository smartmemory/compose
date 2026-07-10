---
date: 2026-07-11
session_number: 85
slug: stratum-ts-engine-flag
summary: Flag-gated stratum engine selection (python or ts) for the flow/gate monitor seam; guard pinned to Python; spawn failures surfaced honestly; live-verified against the TS engine
feature_code: COMP-STRATUM-TS
closing_line: The port's last mile was never the engine — it was every place that quietly assumed Python.
---

# Session 85 — COMP-STRATUM-TS

**Date:** 2026-07-11
**Feature:** `COMP-STRATUM-TS`

## What happened

STRAT-TS-PORT closed out its engine-repo work yesterday (P0–P6 plus a live acceptance flow), and the human said "go ahead" on P7 — the compose-side cutover. We scoped it the way the upstream design demanded: grep compose for what it actually calls. The answer was pleasantly narrow. stratum-client.js is the only module that spawns stratum, and it speaks two CLI dialects: query/gate for the monitor seam and guard for STRAT-GUARD. Everything else is config (the in-session MCP registration) or a retirement shim.

We carved v1 to the monitor seam only (ship-narrow-first): the TS engine had no query/gate CLI, so we built one in the stratum repo that emits the Python CLI's exact JSON projections and exit-code contract, then taught stratum-client to select an engine. The stratum-side review loop ran five rounds and kept finding real contract violations — a fixture sweep that missed the repo-root Python suite, a killed-status derivation spoofable by a malformed spec, gate conflict classification that inverted Python's idempotency order, result words leaked from TS engine internals. One finding was rejected on evidence (compose-bin routing is compose-side by design). The compose-side loop ran four rounds and was just as productive: the guard runner missed the spawn-failure mapping, the startup probe demanded a Python install even under engine=ts (defeating the packaging point of the port), and Node's execFile delivering spawn failures through BOTH the callback and the child error event meant our error surface was racy.

The live checks earned their keep twice. The first end-to-end run failed with PARSE_ERROR — which turned out to be a repo bin missing its exec bit AND a real pre-existing compose bug: string spawn-error codes fell through the numeric exit-code mapping to "clean exit 0, empty stdout". The second run, against the committed TS CLI, walked the whole seam: flows listed as awaiting_gate, approve returned execute_step, double-approve came back as a wrong_step conflict at HTTP 409.

## What we built

- stratum repo (32a36b4, 0.2.90): ts/src/cli/query_gate.ts — stratum query flows/flow/gates + stratum gate approve/reject/revise emitting Python-compatible projections (status vocabulary complete/running/awaiting_gate/failed/budget_exhausted/killed, route-derived gate results, Python resolve_gate conflict order with a TS-DAG exception for simultaneously-waiting gates); exec bits on both bins; new CLI tests (380 total).
- server/stratum-client.js — resolveStratumEngine() (COMPOSE_STRATUM_ENGINE env → capabilities.stratumEngine → python; unknown values throw), TS bin dispatch (stratum / COMPOSE_STRATUM_TS_BIN), guard pinned to Python, unified spawn-failure mapping (_spawnResult/_spawnRemedy: genuine spawn codes → SPAWN with a binary-specific remedy from either the callback or the error event; non-spawn string codes stay generic).
- server/index.js — startup capability probe follows the selected engine (executable regular-file check for paths, which for names); server/stratum-api.js — SPAWN → 503.
- test/stratum-client.test.js — 9 new cases (engine selection incl. real config-file precedence via switchProject, guard pinning, SPAWN across all three runners, event-path settle, maxbuffer discrimination). 21/21; full suite 4620+ green.
- docs/features/COMP-STRATUM-TS/design.md — scoping results, decisions, live-verification record, acceptance checklist; COMP-STRATUM-TS-2 filed PLANNED for the post-soak agent-authoring cutover.

## What we learned

1. Live end-to-end checks catch what suites cannot: the exec-bit EACCES and the string-code exit-mapping bug were invisible to every mocked test because the mock never reproduced real execFile spawn semantics.
2. Node execFile delivers spawn failures through both the callback and the child error event in racy order — any adapter that treats them differently has nondeterministic error behavior. Settle both paths through one mapping.
3. Contract projections belong in ONE place: putting the Python-shape mapping in the TS CLI (not compose) kept compose free of engine branches, and the review loop could then attack a single seam.
4. Cross-engine parity review needs the consumer's grep, not the producer's schema: two findings died because compose provably never reads the fields in question, and two survived because compose provably branches on the exact strings.
5. A startup capability probe that hard-codes one engine's binary silently defeats the very cutover it guards — availability checks must follow the same selection logic as the runtime path.

## Open threads

- [ ] Soak: run the forge workspace with COMPOSE_STRATUM_ENGINE=ts for a week; flip capabilities.stratumEngine default only after a clean week
- [ ] COMP-STRATUM-TS-2: agent-side execution-model cutover (v1 spec authoring, TS stdio server registration in compose init, stratum-mcp bin-name collision), then the default flip and PyPI deprecation notes
- [ ] Consider a table-driven both-engines contract test that runs the same stratum-client scenarios against both real CLIs when both are installed

---

*The port's last mile was never the engine — it was every place that quietly assumed Python.*

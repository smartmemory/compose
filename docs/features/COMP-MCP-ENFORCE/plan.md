# COMP-MCP-ENFORCE — Implementation Plan (Slice 1)

**Source of truth:** [`blueprint.md`](./blueprint.md) (verified, Codex REVIEW CLEAN). This plan is the ordered execution checklist; data shapes and predicate grammar live in the blueprint.

## Ordered tasks (TDD per task — test first, watch fail, implement, watch pass)

### A — Stratum: `guard` CLI subcommand `(stratum-mcp, prerequisite)`
- [ ] A1 `stratum-mcp/tests/test_guard_cli.py` (new): register → transition(applied) → transition(refused, missing file) → history; errors: unknown subcommand, bad JSON, illegal edge → error dict + non-zero exit.
- [ ] A2 `_cmd_guard(args)` in `server.py` (subparsers register/transition/override/migrate/history; `--json-stdin` for dict/list kwargs; async via `asyncio.run`; pass `stratum_agent_run`; reuse `_guard_error_dict`; non-zero exit on error).
- [ ] A3 Wire `if cmd == "guard"` in `main()`; add `guard …` lines to `_cmd_help`.
- [ ] A4 `pytest stratum-mcp/tests/test_guard_cli.py` green; `stratum-mcp guard --help` works.

### B — Compose: `stratum-client.js` guard adapter `(existing)`
- [ ] B1 Test (`test/stratum-client-guard.test.js`, new) via `_testOnly_setExecFile`: args + JSON-stdin shape, exit-code → result mapping.
- [ ] B2 `spawnStratumStdin(args, json, timeoutMs)` + exports `guardRegister`/`guardTransition`/`guardOverride`/`guardHistory`.

### C — Compose: `lifecycle-guard.js` policy module `(new)`
- [ ] C1 Test (`test/lifecycle-guard.test.js`, new): `buildPhaseGraph` includes `ship→complete` + `*→killed`; `resourceId` is project-scoped (different roots → different ids); `edgePredicates` derives from configured feature root; `guardedTransition` applied/refused/fail-closed.
- [ ] C2 Implement `buildPhaseGraph`, `edgePredicates(featureRelDir)`, `resourceId(fc, root)`, `ensureGuard(fc, currentPhase, root)`, `guardedTransition(...)`.

### D — Compose: wire endpoints `(vision-routes.js, vision-server.js — existing)`
- [ ] D1 `advance` → async + guard before mutation; 422 on refuse.
- [ ] D2 `skip` → same.
- [ ] D3 `complete` (already async) → guard `ship→complete` w/ `commit_sha` in artifacts; 422 on refuse; keep `recordCompletion`.
- [ ] D4 `kill` → async + guard `*→killed`, fail-closed.
- [ ] D5 Add `capabilities` param to `attachVisionRoutes`; pass `this._config.capabilities` from `vision-server.js`; `guardEnabled = capabilities?.guard === true`. Default OFF.
- [ ] D6 Eager `ensureGuard(initial='explore_design')` at `/lifecycle/start`.

### E — Verification
- [ ] E1 `node lib/boundary-map.js docs/features/COMP-MCP-ENFORCE/blueprint.md $(pwd)` → ok.
- [ ] E2 Full compose suite (`npm test`) green; full stratum-mcp suite (`pytest`) green.
- [ ] E3 Golden flow with `capabilities.guard` ON against the real `stratum-mcp guard` CLI.
- [ ] E4 Flag OFF → endpoints byte-identical to today.

## Acceptance criteria (slice exit gates)
- [ ] No caller can `advance`/`skip`/`complete`/`kill` a guard-enabled feature through an edge the guard refuses (verdict-gated, returns 422).
- [ ] The artifact edges (`design`/`blueprint`/`plan`) refuse when the artifact file is absent on disk (server-read, not caller-claimed).
- [ ] Every guarded transition (applied or refused) appears in the STRAT-GUARD append-only ledger.
- [ ] Flag OFF is a no-op vs. current behavior (both suites prove parity).
- [ ] Both test suites green; Boundary Map clean; Codex REVIEW CLEAN on the implementation.

# COMP-MCP-ENFORCE — Implementation Blueprint (Slice 1)

**Status:** Slice 1 SHIPPED 2026-06-02 (Codex REVIEW CLEAN, both suites green). Verified against source 2026-06-02.
**Scope this run:** Slice 1 only (highest-leverage). Slices 2–4 are deferred follow-ups (see design `## Rollout`).
**Seam decision:** Add a `guard` CLI subcommand to `stratum-mcp` and reach it from the compose server via the existing CLI-subprocess adapter (`server/stratum-client.js`). The MCP-stdio client (`lib/stratum-mcp-client.js`) is the build-runner's and is NOT used in the request path.

## Related Documents

- Design (gated): [`design.md`](./design.md)
- Substrate: stratum `STRAT-GUARD` — `../../../../stratum/docs/features/STRAT-GUARD/{design,blueprint,report}.md`

## Slice 1 goal (from design `## Rollout` item 1)

Route the compose feature-lifecycle transitions through a STRAT-GUARD verdict so that **no caller** (skill, human cockpit, or rogue MCP/REST client) can effect a transition the guard refuses. This closes both the gate path (`approve_gate` / `gates/:id/resolve`) **and** the direct lifecycle-mutation endpoints (`advance` / `skip` / `complete`) — guarding the gate alone leaves the bypass open (skip the gate, call `advance`).

Slice 1 wires the **mechanism** end-to-end with conservative, correct per-edge predicates (server-read artifact existence). Aggressive evidence-bound completion (`command_exit_zero` test attestation, `force` removal) is explicitly **Slice 3** and is NOT in this run.

## What exists (verified)

### Stratum (substrate — SHIPPED)
- Guard library: `stratum-mcp/src/stratum_mcp/guard/` — `register_guard`, `guard_transition`, `guard_override`, `guard_migrate`, `guard_history` (all `async` except `guard_history`), in `guard/transition.py:234,312,454,504,569`.
- Guard MCP tools: `server.py:4399–4540` (`stratum_guard_register/transition/override/migrate/history`) — thin wrappers over the library, with a `_guard_error_dict(exc)` canonicaliser.
- Trusted-evidence builtins (`guard/evidence.py:30–33`): `server_file_exists('rel/path')`, `git_commit_exists('<sha>')`, `command_exit_zero(['cmd','arg'])`, `verdict_receipt_clean('<digest>')`. Predicate statement grammar is `name(literal, ...)` parsed via `ast` — args must be literals (`evidence.py:56–82`).
- Predicate dict shape: `{id, type, statement}`. `type: "deterministic"` → trusted server-side eval; `type: "verified"|"judged"` → LLM-tier via `run_judge`. A `deterministic` statement that is NOT a known builtin is **rejected at registration** (fail-closed — `transition.py:199–206`).
- Registration is checksummed + immutable; identical re-register is a no-op returning `{status:"exists"}` (`transition.py:255–274`). → **lazy idempotent register on every transition is safe.**
- `workspace_root` MUST be an existing absolute dir when any file/git/command predicate is declared (`transition.py:213–223`).
- Paranoid edges require ≥1 deterministic predicate (`transition.py:225–231`).
- **GAP (this blueprint closes it):** no `guard` CLI subcommand. `main()` (`server.py:4543`) dispatches `query`/`gate`/`compile`/`migrate`/`doctor` only; `stratum-mcp guard` → "Unknown command". CLI builders `_cmd_query`/`_cmd_gate` at `server.py:3950–4000` are the pattern to mirror.

### Compose (consumer)
- `server/stratum-client.js` — the ONLY module that spawns `stratum-mcp` subprocesses. Exports `queryFlows/queryFlow/queryGates/gateApprove/gateReject/gateRevise` (lines 135–188). `spawnStratum(args, timeoutMs)` core runner (`:39`), `runQuery`/`runMutation` wrappers. Exit-code contract: 0→JSON, 2→`{conflict:true}`, non-zero→`{error}`.
- Phase graph `TRANSITIONS` (`vision-routes.js:156–167`): `explore_design→[prd,architecture,blueprint]`, `prd→[architecture,blueprint]`, `architecture→[blueprint]`, `blueprint→[verification]`, `verification→[plan,blueprint]`, `plan→[execute]`, `execute→[report,docs]`, `report→[docs]`, `docs→[ship]`, `ship→[]`. `SKIPPABLE={prd,architecture,report}`, `TERMINAL={complete,killed}`.
- Lifecycle endpoints to guard: `advance` (`vision-routes.js:263`, sync), `skip` (`:294`, sync), `complete` (`:358`, **async** already), `kill` (`:326`, sync). Gate resolve: `gates/:id/resolve` (`:768`, sync; self-approval comment "AD-4" at `:795`).
- `complete` already does a best-effort `recordCompletion` import (`vision-routes.js:392`) and reads `commit_sha`/`tests_pass` from body.
- Each endpoint mutates `item.lifecycle.currentPhase`, calls `appendPhaseHistory`, `store.updateLifecycle`, broadcasts, emits decision/drift/status events, `anchorBoundary`. **The guard check must gate BEFORE any of this mutation/emission.**

## Corrections table (spec assumption → reality)

| Design assumption | Reality | Resolution |
|---|---|---|
| "compose Node → stratum over MCP" (design `## Approach`/Risks) | Server path uses **CLI subprocess**; guard has **no CLI surface** | Add `guard` CLI subcommand (this blueprint, Stratum work-unit) |
| Graph = `vision-routes.js:155–166` TRANSITIONS | TRANSITIONS omits `ship→complete` (`:367`) and `kill` edges (`:335`) | Assemble full graph from all three; register `complete` + `killed` as reachable, `complete`/`killed` terminal |
| `approve_gate` triggers the verdict | Gate resolve (`:768`) is decoupled from lifecycle advance (comment "CLI owns lifecycle transitions" `:795`) | Slice 1 guards the **lifecycle endpoints** (advance/skip/complete); the gate-resolve endpoint records the operator decision but the *effecting* transition is `advance`, which is now guarded. Document this; do not double-guard. |
| Evidence-bound completion in Slice 1 | That is **Slice 3** (design `## Rollout`) | ship→complete predicate in Slice 1 = `git_commit_exists(sha)` ONLY when a `commit_sha` is supplied; no `command_exit_zero` (deferred) |

## Build plan

### Work unit A — Stratum: `guard` CLI subcommand (prerequisite)

**A1.** `stratum-mcp/src/stratum_mcp/server.py` (existing) — add `_cmd_guard(args: list[str])` mirroring `_cmd_gate` (`:3973`). Subparsers: `register`, `transition`, `override`, `migrate`, `history`.
- Inputs that are dicts/lists (`graph`, `edge_predicates`, `artifacts`, `modified_files`, `stakes`, `terminal`) are passed as **JSON strings** on flags (e.g. `--graph '{...}'`) or via `--json-stdin` (read one JSON object from stdin → kwargs). Scalars (`resource_id`, `from_state`, `to_state`, `initial`, `workspace_root`, `idempotency_key`, `resolved_by`, `override_token`, `rationale`) are flags/positionals.
- Dispatch to the library functions; async ones run via `asyncio.run(...)`. `guard_transition` is called with `stratum_agent_run=stratum_agent_run` (the module-level verifier already referenced at `server.py:4456`) so LLM-tier edges still work from the CLI.
- Wrap in `try/except` → reuse `_guard_error_dict(exc)`; `print(json.dumps(result, indent=2))`. Exit non-zero on the error dict so compose's `runMutation` maps it to `{error}`.

**A2.** `server.py` `main()` (`:4543`) — add `if cmd == "guard": _cmd_guard(sys.argv[2:]); return`.

**A3.** `_cmd_help` — add `guard …` usage lines (parity with `query`/`gate`).

**A4.** Tests: `stratum-mcp/tests/test_guard_cli.py` (new) — golden flow: register → transition (applied) → transition (refused, missing file) → history; error harness: unknown subcommand, bad JSON, missing required arg, tampered/illegal edge surfaced as error dict + non-zero exit.

### Work unit B — Compose: `stratum-client.js` guard adapter

**B1.** `server/stratum-client.js` (existing) — add exports:
- `guardRegister({ resourceId, graph, edgePredicates, initial, terminal, stakes, workspaceRoot })`
- `guardTransition({ resourceId, fromState, toState, artifacts, modifiedFiles, idempotencyKey, resolvedBy })`
- `guardOverride({ resourceId, fromState, toState, overrideToken, rationale })`
- `guardHistory(resourceId)`

Each builds `['guard', <action>, '--json-stdin']`, feeds the JSON kwargs on stdin via a new `spawnStratumStdin(args, json, timeoutMs)` (extends `spawnStratum` with `proc.stdin.write`). Mutations use `MUTATION_TIMEOUT_MS`; `guardHistory` uses query timeout. Same exit-code mapping as existing calls.

### Work unit C — Compose: lifecycle-guard policy module (compose-owned)

**C1.** `server/lifecycle-guard.js` (new) — compose owns the phase semantics:
- `buildPhaseGraph()` → the full graph: `TRANSITIONS` + `ship→[complete]` + `<every non-terminal>→[killed]`. `complete` and `killed` terminal.
- `edgePredicates(featureRelDir)` → per-edge `deterministic` predicates bound to **server-read** evidence. **Paths are derived from the configured feature root, not hardcoded** (Codex finding-3): `featureRelDir` = `<paths.features || 'docs/features'>/<FC>` from `loadProjectConfig().paths?.features` (the same derivation as `vision-routes.js:152–154`), expressed relative to `workspace_root`:
  - `explore_design→blueprint`: `server_file_exists('<featureRelDir>/design.md')`
  - `blueprint→verification`: `server_file_exists('<featureRelDir>/blueprint.md')`
  - `plan→execute`: `server_file_exists('<featureRelDir>/plan.md')`
  - all other edges (incl. `prd`/`architecture` skip edges, `→killed`, `ship→complete`): **no predicate** (graph-legality + serialization + audit only — honest "mechanism wired, policy light"). Evidence-bound completion (`git_commit_exists`/`command_exit_zero` on `ship→complete`) is **Slice 3**; registration is immutable so per-call predicate injection is impossible — the commit SHA is recorded in the ledger via `artifacts` in Slice 1, enforced in Slice 3.
- `resourceId(featureCode, workspaceRoot)` → **project-scoped** `compose:<sha256(absWorkspaceRoot)[:12]>:<FC>` (Codex finding-1). Guard state is stored globally keyed only by `resource_id` (`guard/store.py:42,68`) and `workspace_root` is **not** part of the checksum — a bare `compose:<FC>` would make two compose projects sharing a feature code collide on one ledger/current-state and bind the first project's `workspace_root`. The project-path hash prevents cross-project collision.
- `ensureGuard(featureCode, currentPhase, workspaceRoot)` → idempotent `guardRegister` seeding **`initial = currentPhase`** (Codex finding-2). `register_guard` sets `current_state = initial` on first registration (`guard/transition.py:261`); compose items can already be mid-lifecycle (past `explore_design`) when the guard is first introduced, so seeding `initial` from the item's *current* phase prevents a spurious `stale_from_state` on the first guarded transition. Idempotent re-register is a no-op when the checksum matches; cached per-resource in-process. **Bootstrap:** prefer eager registration at `/lifecycle/start` (`vision-routes.js:196`) with `initial='explore_design'` for new items; `ensureGuard` with `initial=currentPhase` is the backfill path for items opened before rollout.
- `guardedTransition({ featureCode, from, to, workspaceRoot, commitSha, resolvedBy })` → `ensureGuard(featureCode, from, workspaceRoot)` then `guardTransition` (idempotency_key = `<FC>:<from>:<to>:<sha|''>`, artifacts include `commit_sha` when supplied); returns `{ applied, refused, verdict, ledgerRef, currentState, error }`. On `error` (stratum unreachable / not installed) → **fail-closed** (refused) when the capability is on (C2).

**C2.** Capability flag: `capabilities.guard` from `.compose/compose.json` (mirror `capabilities.stratum` at `vision-server.js:228`). Default **off** until wired+tested, then flip on. When off, endpoints behave exactly as today (incremental-builds rule: keep the old path available). When on and stratum is unreachable, the transition is **refused** (fail-closed, including `kill` — Codex finding-4) with a clear error. **Wiring (Codex finding-5):** `attachVisionRoutes` today receives `{ store, scheduleBroadcast, broadcastMessage, projectRoot, settingsStore }` (`vision-routes.js:63`) — it does **not** get the capability config. So D5 must (a) add a `capabilities` (or `config`) param to `attachVisionRoutes`, and (b) pass `this._config.capabilities` from the call site `vision-server.js:87`. `guardEnabled = capabilities?.guard === true`.

### Work unit D — Compose: wire endpoints (`vision-routes.js`)

**D1.** `advance` (`:263`) — make handler `async`. After the existing `TRANSITIONS` legality check and before mutating `item.lifecycle.currentPhase`, if `capabilities.guard`: `const g = await guardedTransition({featureCode, from, to:targetPhase, workspaceRoot:projectRoot, resolvedBy:'agent'})`. If `!g.applied` → `res.status(422).json({ error:'transition refused by guard', verdict:g.verdict })`; return. Else proceed unchanged.

**D2.** `skip` (`:294`) — same pattern, `outcome:'skipped'`.

**D3.** `complete` (`:358`, already async) — guard `ship→complete`, passing `commitSha: req.body.commit_sha`. On refuse → 422. Keep the existing best-effort `recordCompletion` afterward.

**D4.** `kill` (`:326`) — make handler `async`; guard `<from>→killed` (no predicate; records the kill in the tamper-evident ledger). **Fail-closed** like the other edges (Codex finding-4): when `guardEnabled` and the guard refuses or is unreachable → 422. (Rationale: the slice goal is "no caller effects an unverified transition"; a fail-open kill would bypass the ledger and contradict that. Kill has no predicate, so when the guard is reachable it always applies — the only way kill is blocked is guard unavailability, which is the same fail-closed posture as advance/skip/complete. An authorized escape remains `stratum_guard_override`, Slice 3.)

**D5.** Wiring (Codex finding-5): add a `capabilities` param to `attachVisionRoutes(app, { store, scheduleBroadcast, broadcastMessage, projectRoot, settingsStore, capabilities })` (`vision-routes.js:63`); pass `capabilities: this._config.capabilities` from `vision-server.js:87`. `projectRoot` is already in scope (`:152`). Compute `const guardEnabled = capabilities?.guard === true` once in the route closure.

### Work unit E — Tests

- **Compose golden flow** (`test/lifecycle-guard.test.js`, new): register → advance with design.md present (applied) → advance with design.md absent (422 refused) → complete with commit (applied) → history shows ledger. Use the real `stratum-mcp guard` CLI (real backend per testing rules); skip-guard path verified with flag off.
- **stratum-client guard adapter** unit test via injected `_testOnly_setExecFile` (existing seam at `stratum-client.js:23`).
- **Error harness**: guard unreachable → fail-closed 422; flag off → legacy 200.

## File Plan

| File | Action |
|---|---|
| `stratum-mcp/src/stratum_mcp/server.py` | edit |
| `stratum-mcp/tests/test_guard_cli.py` | new |
| `server/stratum-client.js` | edit |
| `server/lifecycle-guard.js` | new |
| `server/vision-routes.js` | edit |
| `test/lifecycle-guard.test.js` | new |

(`server.py` lives in the stratum repo, outside compose's repoRoot; it is listed as a planned write so the Boundary Map disk check treats it as authored here.)

## Boundary Map

The S01→S02 seam (compose JS → stratum CLI subprocess) is an out-of-process **CLI invocation**, not a symbol import — per the Boundary Map rule it is described in prose (Work units A/B), not as a `Consumes` symbol edge. Only intra-compose symbol dependencies appear as edges.

### S01: Stratum guard CLI subcommand
Produces:
  stratum-mcp/src/stratum_mcp/server.py → _cmd_guard (function)
Consumes: nothing

### S02: Compose stratum-client guard adapter
Produces:
  server/stratum-client.js → guardRegister, guardTransition, guardOverride, guardHistory (function)
Consumes: nothing

### S03: Lifecycle-guard policy module
Produces:
  server/lifecycle-guard.js → buildPhaseGraph, edgePredicates, ensureGuard, guardedTransition, resourceId (function)
Consumes:
  from S02: server/stratum-client.js → guardTransition, guardRegister

### S04: Wire guarded lifecycle endpoints
Produces: nothing
Consumes:
  from S03: server/lifecycle-guard.js → guardedTransition

## Verification table (Phase 5)

Verified against source on 2026-06-02.

| Claim | Ref | Result |
|---|---|---|
| `advance` endpoint | `server/vision-routes.js:263` | ✓ `lifecycle/advance` |
| `skip` endpoint | `server/vision-routes.js:294` | ✓ `lifecycle/skip` |
| `kill` endpoint | `server/vision-routes.js:326` | ✓ `lifecycle/kill` |
| `complete` endpoint (async) | `server/vision-routes.js:358` | ✓ `lifecycle/complete` |
| gate resolve self-approval | `server/vision-routes.js:768,795` | ✓ "AD-4: Server only updates gate state" |
| `TRANSITIONS` graph | `server/vision-routes.js:156–167` | ✓ matches |
| only stratum spawner | `server/stratum-client.js` | ✓ 0 existing `guard*` exports; `_testOnly_setExecFile@23`, `spawnStratum@39` |
| `lifecycle-guard.js` | `server/lifecycle-guard.js` | ✓ absent (new) |
| guard library API | `stratum-mcp/src/.../guard/transition.py:234,312,454,504,569` | ✓ signatures match (4 async + `guard_history` sync) |
| guard MCP tools + `_guard_error_dict` | `stratum-mcp/.../server.py:4399–4540` | ✓ |
| CLI dispatch lacks `guard` | `stratum-mcp/.../server.py:4543` `main()` | ✓ "Unknown command: guard" confirmed at runtime |
| trusted-evidence builtins + grammar | `guard/evidence.py:30–33,56–82` | ✓ `name('literal')` via ast |
| immutable idempotent register | `guard/transition.py:255–274` | ✓ identical re-register → `{status:"exists"}` |
| on-PATH `stratum-mcp` is this source | editable install | ✓ `module: .../forge/stratum/stratum-mcp/src/stratum_mcp` |

Boundary Map: `node lib/boundary-map.js` → `{ok:true, violations:[], warnings:[]}`.

**Gate: PASS** — zero stale references, zero Boundary Map violations.

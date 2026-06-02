# COMP-MCP-ENFORCE — Implementation Report (Slice 1)

**Status:** SHIPPED (Slice 1) — 2026-06-02. Slices 2–4 remain PLANNED.
**Source:** [`design.md`](./design.md) → [`blueprint.md`](./blueprint.md) → [`plan.md`](./plan.md).

## 1. Summary

Lifecycle phase transitions in compose are now **verdict-gated by stratum's STRAT-GUARD** when `capabilities.guard` is enabled: `advance` / `skip` / `complete` / `kill` apply **only if** the edge's server-read evidence verifies, fail-closed, with every attempt recorded in the tamper-evident guard ledger. No caller — skill, human cockpit, or rogue MCP/REST client — can effect a transition the guard refuses. Default OFF; flag-off behavior is byte-identical to before.

## 2. Delivered vs Planned

| Planned (Slice 1) | Delivered |
|---|---|
| `guard` CLI subcommand on stratum-mcp | ✅ `_cmd_guard` (register/transition/override/migrate/history), JSON-kwargs-on-stdin |
| compose guard adapter | ✅ `guardRegister/guardTransition/guardOverride/guardHistory` in `stratum-client.js` |
| compose-owned policy module | ✅ `server/lifecycle-guard.js` (graph + predicates + register + transition) |
| wire advance/skip/complete/kill + capability flag | ✅ all four + eager register at `/lifecycle/start` |
| real-backend golden flow + parity | ✅ E2E vs real CLI; full suites green (flag-off parity proven) |

## 3. Key Implementation Decisions

- **Seam = `guard` CLI subcommand**, consumed by the existing `server/stratum-client.js` subprocess adapter (chosen over wiring an MCP-stdio client into the request path). Uniform wire format: each action reads one JSON kwargs object from stdin.
- **Single source of truth for the phase graph.** `BASE_TRANSITIONS`/`SKIPPABLE`/`TERMINAL` moved to `lifecycle-guard.js` and imported by `vision-routes.js`, so the guard graph and the route's own legality check can never drift.
- **Project-scoped resource id** `compose:<sha256(absRoot)[:12]>:<FC>` — guard state is global and keyed only by resource_id, so a bare `compose:<FC>` would collide across projects.
- **`initial` seeded from current phase** at registration — items already mid-lifecycle at rollout don't trip `stale_from_state`. Eager register at `/lifecycle/start` is the clean path; lazy register is the backfill path.
- **No idempotency_key on lifecycle transitions** — refuse→fix→retry is a new logical attempt carrying an identical payload; an idempotency_key would replay the prior refusal. Double-apply is already prevented by the server-side `from_state == current_state` check.
- **Fail-closed, including thrown spawn failures** — `ensureGuard`/`guardedTransition` normalize any thrown subprocess error into `{applied:false, error}` so an unreachable/uninstalled stratum-mcp never silently lets a transition through.
- **Slice 1 predicates are conservative & correct** — artifact-existence (`design.md`/`blueprint.md`/`plan.md`) via server-read `server_file_exists`, paths derived from the served workspace's config. Evidence-bound completion (real commit/test attestation on `ship→complete`) is deliberately **Slice 3**; Slice 1 records `commit_sha` in the ledger without yet enforcing it.

## 4. Test Coverage

- `stratum-mcp/tests/test_guard_cli.py` — golden flow, idempotent register, override, error harness (unknown action, bad JSON, illegal edge, not-found). Full stratum suite **1370 passed**.
- `compose/test/stratum-client-guard.test.js` — adapter args/stdin/exit-code mapping (7).
- `compose/test/lifecycle-guard.test.js` — graph, project-scoped id, workspace-derived predicate paths, applied/refused/fail-closed/thrown-fail-closed/commit-sha (12).
- `compose/test/lifecycle-guard-e2e.test.js` — REST→real `stratum-mcp guard` golden flow (refuse-missing-evidence → write → applied).
- Compose `node --test` suite **2947 passed** (flag-off parity).

## 5. Files Changed

- **stratum:** `stratum-mcp/src/stratum_mcp/server.py` (`_cmd_guard`, `main()` dispatch, help), `stratum-mcp/tests/test_guard_cli.py` (new).
- **compose:** `server/lifecycle-guard.js` (new), `server/stratum-client.js`, `server/vision-routes.js`, `server/vision-server.js`, `test/{stratum-client-guard,lifecycle-guard,lifecycle-guard-e2e}.test.js` (new).

## 6. Known Issues & Follow-ups

- **`vision-routes.js` `featuresPath` still reads process-global `loadProjectConfig()`** (pinned to `getTargetRoot()`) for the `/artifacts` routes. The new guard code is workspace-root-aware, but for a non-current served `projectRoot` the artifact routes still consult the global feature dir. **Pre-existing** (not introduced by this slice) and out of Slice 1 scope; the single-workspace default (how compose actually runs) is correct. → file as a multi-workspace config-resolution follow-up.
- **Slices 2–4 (PLANNED):** collapse the two state machines (lifecycle-as-truth, status as projection); kill `force` → `stratum_guard_override`; evidence-bound completion (`command_exit_zero`/`git_commit_exists` on `ship→complete`); phase-scoped tool capabilities + loopback REST auth. Per the design, COMP-PARITY-7 / COMP-DEBUG-1 are absorbed and COMP-PARITY-5 reduces to a view — that roadmap restatusing lands when the umbrella progresses, not in Slice 1.

## 7. Lessons Learned

- The design assumed "compose → stratum over MCP," but the server request path is a CLI subprocess and the guard had no CLI surface — verifying the seam first (rather than trusting the design's framing) turned a hidden blocker into a clean prerequisite work-unit.
- The guard's idempotency-replay semantics are correct for true retries but wrong for refuse→fix→retry; the E2E golden flow (real backend) caught it where the stubbed unit tests could not.

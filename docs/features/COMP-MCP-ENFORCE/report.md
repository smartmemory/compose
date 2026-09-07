# COMP-MCP-ENFORCE — Implementation Report (Slices 1–4)

**Status:** SHIPPED (Slices 1–4 + COMP-MCP-ENFORCE-1) — 2026-06-02. `capabilities.guard` enabled in this repo (guard-OFF byte-identical). See [Slices 2–4](#slices-24-shipped-2026-06-02) below.
**Source:** [`design.md`](./design.md) → [`blueprint.md`](./blueprint.md) → [`plan.md`](./plan.md).

## 1. Summary

Lifecycle phase transitions in compose are now **verdict-gated by stratum's STRAT-GUARD** when `capabilities.guard` is enabled: `advance` / `skip` / `complete` / `kill` apply **only if** the edge's server-read evidence verifies, fail-closed, with every attempt recorded in the tamper-evident guard ledger. No caller — skill, human cockpit, or rogue MCP/REST client — can effect a transition the guard refuses. Default OFF; flag-off behavior is byte-identical to before.

> **Correction — 2026-08-18 (COMP-GUARD-CLAIM-1):** The claim above was not true when written
> and was not true at ship. The guard covered only HTTP-facing lifecycle transitions in
> `server/vision-routes.js` — the CLI and build runner run in-process and called no guarded
> transition. COMP-COMPLETION-GATE's audit (2026-08-18) measured 321 managed features against
> 31 registered guard resources with zero overlap (all 31 are leaked test fixtures), and
> 230 COMPLETE features none of which passed a guarded transition. After COMP-COMPLETION-GATE
> slices 1–2 (2026-08-18), `record_completion` (MCP + CLI) and the build runner are gated;
> `setFeatureStatus`, the vision PATCH endpoint, stratum-sync, and direct `updateItemStatus`
> remain open. See `docs/features/COMP-COMPLETION-GATE/design.md` for the full plan.

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
- **Slices 2–4 — SHIPPED 2026-06-02** (see [section below](#slices-24-shipped-2026-06-02)): collapsed the two state machines (lifecycle-as-truth, status as projection); killed `force` → `stratum_guard_override`; evidence-bound completion (`command_exit_zero`/`git_commit_exists` on `ship→complete`); phase-scoped tool capabilities + loopback REST auth. The absorbed-row restatusing (COMP-PARITY-7 / COMP-DEBUG-1 → SUPERSEDED, COMP-PARITY-5 reduced to a UI view) landed 2026-06-04.

## Slices 2–4 (shipped 2026-06-02)

All gated behind `capabilities.guard` (now enabled in this repo); guard-OFF is byte-identical to before. Each slice was implemented TDD-first and Codex-reviewed to CLEAN.

### Slice 2 — lifecycle-as-truth (status projection)
Roadmap STATUS is now a projection driven by lifecycle phase. `phaseToStatus()` (complete→COMPLETE, killed→KILLED, active→IN_PROGRESS) + `projectFeatureStatus()` write through to feature.json after every guarded transition and at `/lifecycle/start` (best-effort; never rolls back an applied transition). Closes the COMP-PARITY-7 one-way-sync gap. `setFeatureStatus` gained a `derived` option — lifecycle is the authority, so the roadmap transition table no longer gates lifecycle-driven projections (e.g. PARKED→IN_PROGRESS on resume); the roundtrip fixed-point guard still applies. Off-lifecycle statuses (BLOCKED/PARKED/PARTIAL/SUPERSEDED) stay `set_feature_status`'s domain. *(Codex: 3 findings — transition-table bypass, complete-ordering mask, start gap → CLEAN.)*

### Slice 3 — evidence-bound completion + kill the force bypass
`verifyCompletionEvidence()` substrate-verifies completion: server-read git commit existence (not a syntax check) + test attestation (configured `guard.testCommand` exits 0, OR explicit `tests_pass` true — **no silent default-to-true**). `/lifecycle/complete` verifies before the guarded transition. The MCP boundary is closed against four bypass paths (`set_feature_status`, `add_roadmap_entry`, `propose_followup` reject lifecycle-owned COMPLETE/KILLED; `record_completion` enforces the same evidence) — each requires an out-of-band `STRATUM_GUARD_OVERRIDE_TOKEN` to deviate, the single authorized escape replacing `force`. *(Codex: 4 rounds enumerating every public terminal-write path → CLEAN.)*

> **Correction — 2026-08-18 (COMP-GUARD-CLAIM-1):** The MCP tool boundary above is accurate.
> The Codex annotation ("every public terminal-write path") is not: COMP-COMPLETION-GATE's
> audit identified 14 paths (§1.3), of which the CLI and build runner — the paths that account
> for the majority of real completions — were not covered. The annotation reflects an incomplete
> enumeration; it does not reflect coverage.

> **Correction — 2026-09-07 (override-token removal):** "each requires an out-of-band
> `STRATUM_GUARD_OVERRIDE_TOKEN` to deviate, the single authorized escape replacing `force`" is no
> longer true, and this correction is written by the change that made it untrue. The token is
> REMOVED (@f79e804): `assertForceAuthorized`, `assertTerminalStatusAuthorized` and
> `assertToolPhaseAllowed` now refuse unconditionally when their capability is on, and nothing in
> `server/`, `lib/` or `bin/` reads that variable. It was removed because the escape had no user and
> could not have one — the variable was unset in every environment we ship and `override_token`
> appeared in no MCP tool schema — while both statuses it nominally unlocked already had
> first-class doors. Reasoning and evidence:
> `docs/decisions/2026-09-07-override-token-audit.md`.

### Slice 4 Part A — opt-in loopback REST auth
A `guardAuth` middleware (`capabilities.guardAuth`, default OFF) requires `x-compose-token` on every vision mutation endpoint; reads stay open; fail-closed (503) if enabled without a configured token. Default OFF because the cockpit UI does not yet send the token. *(Codex: 3 findings — coverage of iteration/branch/PATCH, fail-closed semantics → CLEAN.)*

### Slice 4 Part B — DEFERRED
Phase-scoped MCP tool filtering ("an implement-phase context should not even *have* `approve_gate`/`set_feature_status`") needs the MCP stdio server to track per-session phase, which it does not today — a real architectural addition (originally COMP-DEBUG-1). Filed as a follow-up; the agent-capability profiles in `server/agent-templates.js` are the substrate.

## 7. Lessons Learned

- The design assumed "compose → stratum over MCP," but the server request path is a CLI subprocess and the guard had no CLI surface — verifying the seam first (rather than trusting the design's framing) turned a hidden blocker into a clean prerequisite work-unit.
- The guard's idempotency-replay semantics are correct for true retries but wrong for refuse→fix→retry; the E2E golden flow (real backend) caught it where the stubbed unit tests could not.

## 7. Corrections (COMP-COMPLETION-GATE)

> **Correction — 2026-08-30 (COMP-COMPLETION-GATE slice 3, AC-14).** Two claims above are
> corrected, with the originals preserved:
>
> - §1 (line 8): *"No caller — skill, human cockpit, or rogue MCP/REST client — can effect a
>   transition the guard refuses."* Not true when written: the CLI and the build runner never called
>   a guarded transition (0 of 321 managed features had a guard resource; all 31 registered resources
>   were test fixtures). Slices 1–3 of COMP-COMPLETION-GATE (`753ed47`, `4625b2b`, this commit)
>   change what is true, and it is narrower than the sentence above.
> - Slice 3 (line 52): *"The MCP boundary is closed against four bypass paths"* was accurate for the
>   MCP boundary; the Codex annotation *"every public terminal-write path"* was not — the audit
>   found fourteen (design §1.3), and the in-process ones carried most real completions.
>
> **What is true now.** For a build-mode feature that has a `feature.json`, COMPLETE is reachable
> only through `lib/completion-gate.js`: the commit is server-verified, tests are attested (never
> defaulted), ONE guarded `→ complete` transition is ledgered, and the gate performs the record,
> status, ROADMAP, vision and event writes itself. `setFeatureStatus` refuses COMPLETE
> unconditionally; the vision PATCH, direct `updateItemStatus`, and stratum audit ingestion no longer
> reach it; the vision projection re-reads canonical state before it writes. The invariant is
> **allowlist-shaped** — every remaining COMPLETE/complete write is enumerated and justified in
> `test/completion-write-allowlist.test.js` — and it is **evidence-checked + ledgered, not
> lifecycle-enforced**: the guard registers late at the completable phase and takes one edge; it
> does not attest that design/blueprint/plan phases were walked (design §2.2). Legacy COMPLETE
> features are projected as `canonical-status-only` and stay unguarded. Fix/plan modes and remote
> trackers are out of scope (COMP-COMPLETION-GATE-MODES / -REMOTE).

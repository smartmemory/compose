# COMP-MCP-ENFORCE — Mechanical Enforcement of Lifecycle/Gate Guarantees

**Status:** DESIGN (Phase 1) — not implemented. Intent document; file:line references describe the *current* surface to be changed, not shipped behavior.
**Owner:** compose
**Depends on:** stratum `STRAT-GUARD` (standalone guarded-transition primitive)
**Created:** 2026-06-02

## Related Documents

- Substrate dependency: `../../../../stratum/docs/features/STRAT-GUARD/design.md`
- Reused as-is: stratum `stratum_judge` / `stratum_gate_resolve` (in-flow), `STRAT-JUDGE`

## Problem

Compose's `/compose` lifecycle guarantees — design-before-implement, Codex-review-until-CLEAN, full-suite-before-merge — are enforced by the **skill prompt's instruction text**, not by the tools. The MCP server (`server/compose-mcp.js` + `compose-mcp-tools.js`) is a typed CRUD surface over tracker state. Drive the tools directly instead of through the skill and **none of those guarantees apply**. There is no protocol-level skill gate, and the REST surface has **no auth** — only CORS-to-localhost + workspace middleware (`server/index.js:50-55`). The skill is advisory narration, not an enforcement boundary.

Concretely, the honor-system surfaces (verified by source sweep):

1. **Gates are self-approved.** `POST /api/vision/gates/:id/resolve` (`vision-routes.js:755`) records the caller-supplied `outcome`/`resolvedBy` verbatim. Explicit comment at `vision-routes.js:782`: *"AD-4: Server only updates gate state."* No independent verification, no signature, no artifact re-check. `approve_gate` (`compose-mcp-tools.js:452`) is reachable by any MCP client. **The single biggest gap.**
2. **`force` bypasses everything.** `set_feature_status` / `add_roadmap_entry` / `record_completion` accept `force: true`, overriding both the status `TRANSITIONS` policy *and* the `roundtripGuard` fixed-point guard (`feature-writer.js:314,332`; completion `flipForce` at `completion-writer.js:338`).
3. **Two uncoordinated state machines.** The lifecycle *phase* machine (`vision-routes.js:155-169`: `explore_design→…→ship`) and the roadmap *status* machine (`feature-writer.js:48-57`: `PLANNED→…→COMPLETE`) are independent. The only bridge is a best-effort `record_completion` inside `/lifecycle/complete` (`vision-routes.js:381-408`) whose failure never rolls back the phase transition. Phase and status drift.
4. **Completion accepts claims, not evidence.** `complete_feature` (`compose-mcp-tools.js:403`) takes `tests_pass` as a caller boolean; `record_completion` defaults it to `true`. Nothing verifies the SHA exists, the suite ran, or review was CLEAN.
5. **Iteration exit is self-reported.** `report_iteration_result` exits on caller-supplied `result.clean`/`result.passing` (`vision-routes.js:511-530`); the only hard ceiling is the cumulative budget (`budget-ledger.js`).

## Principle

**Move enforcement from prompt-trust into the tool/server layer, by consuming stratum's enforcement substrate rather than re-implementing a weaker one.** Compose is a client app of stratum; enforcement is a stratum capability (`STRAT-GUARD` + `stratum_judge`). Compose declares its phase graph, per-edge evidence predicates, and invariants; stratum enforces them. Then it does not matter whether a human, the skill, or a rogue MCP client drives the surface — the invariants hold.

## Approach

### 1. Collapse two state machines into one (lifecycle as truth)
**Decided (gate, 2026-06-02): lifecycle-as-truth.** The lifecycle phases (`explore_design → … → ship → complete`) are the execution source of truth; roadmap `STATUS` (`PLANNED/IN_PROGRESS/COMPLETE/...`) becomes a **projection** of lifecycle phase, not an independently writable field.

- `set_feature_status` stops being a free mutator. Status is derived from phase (e.g. `ship`/`complete` → `COMPLETE`, `killed` → `KILLED`, post-`explore_design` → `IN_PROGRESS`).
- `feature-writer.js:48-57` `TRANSITIONS` table is retired; the only transition authority is the lifecycle graph, now enforced by STRAT-GUARD.
- This subsumes **COMP-PARITY-7**'s write-path unification (route all roadmap writes through one path; make UI mutations write-through to the canonical store) — absorbed here, see Relationship section.

### 2. Register the feature lifecycle as a STRAT-GUARD resource
On feature creation, `stratum_guard_register("compose:<FEAT>", graph, edge_predicates, ...)` where:
- `graph` = the compose phase graph. **Note:** this is *not just* the `vision-routes.js:155-166` `TRANSITIONS` table (which covers only `explore_design → … → ship`). The full graph must also include the `ship → complete` edge (implemented separately at `vision-routes.js:351`) and `kill` edges from any non-terminal phase (`vision-routes.js:321`). Registering only the `TRANSITIONS` table would omit the very `ship → complete` edge this design most wants to guard. The graph is assembled from all three sources, declared as data.
- `edge_predicates` = compose-owned evidence policy per edge, bound to STRAT-GUARD's **trusted evidence sources** (server-read files / VCS digests / command attestations / verdict receipts), never caller-staged blobs. Examples:
  - `explore_design → blueprint`: `server_file_exists(design.md)` ∧ passes `validate_feature` ∧ a CLEAN review **verdict receipt** (referenced by digest, re-validated against the ledger).
  - `ship → complete`: `git_commit_exists(commit_sha)` ∧ `command_exit_zero(<test cmd>)` (real exit, attested — not a caller boolean) ∧ review-CLEAN receipt.
- `stakes` = `paranoid` on the high-consequence edges (`→ ship`, `→ complete`) so the T3 adversary fires.

The graph + predicates are checksummed at registration (STRAT-IMMUTABLE) — an agent cannot later weaken the design→blueprint requirement.

### 3. Route every guarded mutation through STRAT-GUARD
`advance` / `skip` / `complete` / `set_feature_status` / `approve_gate` become `stratum_guard_transition` calls. The transition applies **only if** the edge's predicates verify.

- `approve_gate` no longer records a caller outcome. It triggers (or consumes) a STRAT-GUARD verdict for the current edge; "approved" means the verdict was `met`. The `vision-routes.js:782` self-approval path is removed.
- `complete` requires the `ship → complete` predicates to verify — replacing the `currentPhase === 'ship'` structural-only check (`vision-routes.js:355`) with evidence.

### 4. Kill `force`; add an authorized override
Remove `force: true` from `set_feature_status` / `add_roadmap_entry` / `record_completion`. Legitimate deviations route through `stratum_guard_override` (human resolver + rationale, recorded as a `deviation` ledger entry). This preserves the escape hatch but makes it visible, attributed, and non-agent-mintable.

### 5. Evidence-bound completion
`complete_feature` / `record_completion`: `tests_pass` must come from STRAT-GUARD's `command_exit_zero` attestation (a real test-command exit), not the caller boolean that today defaults to `true` (`vision-routes.js:387`, `compose-mcp-tools.js:403`). `commit_sha` is checked via `git_commit_exists`. Review-CLEAN is a verdict receipt, not a re-asserted claim. **Dependency note:** these trusted-evidence predicates (`command_exit_zero`, `git_commit_exists`, `verdict_receipt_clean`) are **net-new predicate surface in STRAT-GUARD** — today's deterministic layer is only `file_exists`/`file_contains` over staged inputs (`predicates.py:32`). So evidence-bound completion is gated on STRAT-GUARD shipping that surface; it is not achievable by "stronger predicate names" alone. This makes the global testing rule (full suite before merge) mechanical.

### 6. Phase-scoped tool capabilities (defense in depth — later slice)
An implement-phase context should not even *have* `approve_gate` / `set_feature_status` in its toolset (per `reference_statewright` per-phase `allowed_tools`). Unrepresentable beats forbidden. Candidate for a follow-up slice once the core enforcement lands.

## Compose-internal cleanups (NOT stratum migrations)

The pre-exploration analysis floated migrating idempotency and tamper guards to stratum. The source sweep corrected this — they are cheaper handled in-place:

- **Idempotency wrapper dedup.** The four `maybeIdempotent` copies (`feature-writer.js:73`, `completion-writer.js:206`, `changelog-writer.js:325`, `journal-writer.js:538`) are **byte-identical** and already delegate to a shared `lib/idempotency.js#checkOrInsert`. Only the 6-line wrapper is quadruplicated — collapse to one shared helper. **No stratum migration** (the real primitive is already shared; a stratum hop would add latency for no gain).
- **`roundtripGuard` fixed-point + `STATUS_FLIP_AFTER_COMPLETION_RECORDED`.** These protect **compose-specific** invariants (ROADMAP regen fixed-point; completion-record-before-status-flip ordering). Re-express each as a compose-owned deterministic (T1) predicate evaluated by STRAT-GUARD — keeping the invariant while removing the `force` bypass. The invariant stays compose's; only the enforcement mechanism moves.

## What stays compose

Phase semantics, the `feature.json` / `ROADMAP.md` schema + rendering, per-edge evidence policy (which predicates each transition requires), and the cross-session cumulative `budget-ledger.js` (stratum's budget is run-scoped; keep compose's persistence, optionally debit through stratum later).

## Migration boundary summary

| Concern | Disposition |
|---|---|
| Gate verification (self-approval) | **Consume** stratum (`STRAT-GUARD` / `stratum_judge`) — delete parallel impl |
| Guarded transition + immutable verdict ledger | **Consume** stratum (`STRAT-GUARD`) |
| `force` override | **Replace** with `stratum_guard_override` |
| Two state machines | **Collapse** to lifecycle-as-truth (compose-internal) |
| Idempotency wrapper ×4 | **Dedupe in compose** (already shared engine) — not migrated |
| ROADMAP fixed-point / completion-ordering invariants | **Re-express** as compose predicates run by STRAT-GUARD |
| Phase/status vocabulary, schema, rendering, budget ledger | **Stays compose** |

## Relationship to existing compose tickets

**Decided (gate, 2026-06-02): absorb.** COMP-MCP-ENFORCE is the **enforcement-substrate umbrella**; the three overlapping tickets are reconciled as follows:

- **`COMP-PARITY-7`** (State-sync single-source-of-truth across `feature.json`/`ROADMAP.md`/`vision-state.json`) — **SUPERSEDED → merged into Slice 2.** Its write-path unification (one roadmap write path; UI mutations write-through to the canonical store) *is* lifecycle-as-truth (Approach 1).
- **`COMP-DEBUG-1`** (agent capability profiles + enforcement) — **SUPERSEDED → merged into Slice 4.** This is exactly phase-scoped tool capabilities; it becomes Slice 4's implementation scope.
- **`COMP-PARITY-5`** (Reconcile completion vs. status across surfaces) — **reduced to a thin UI view.** Its root cause (the two-state-machine divergence) is fixed by Slice 2; what remains is surfacing the recorded completion (commit SHA + tests-pass) next to the status control. Stays a small PLANNED follow-up, no longer a reconciliation effort.

Roadmap rows for COMP-PARITY-7 and COMP-DEBUG-1 are restatused SUPERSEDED with a pointer here; COMP-PARITY-5 is annotated as a view-on-top.

## Rollout (slices)

1. **Slice 1 (highest leverage):** STRAT-GUARD primitive ships (stratum); wire `approve_gate` **and the direct lifecycle-mutation endpoints** (`advance`/`skip`/`complete`, `vision-routes.js:262/291/351`) to require a STRAT-GUARD verdict for the current edge. **Decided (gate): guard the lifecycle endpoints in this slice** — guarding `approve_gate` alone would leave the bypass open (a caller skips the gate and calls `advance` directly), so Slice 1 closes both. The no-auth REST boundary itself (any localhost client can reach the routes) is a separate hardening deferred to Slice 4; routing through the guard means even an unauthenticated caller cannot effect an unverified transition.
2. **Slice 2:** Collapse the two state machines; route `advance`/`complete`/`set_feature_status` through STRAT-GUARD; status becomes a projection.
3. **Slice 3:** Kill `force` → `stratum_guard_override`; evidence-bound completion (verified `tests_pass`, real `commit_sha`).
4. **Slice 4 (optional follow-up):** Phase-scoped tool capabilities; loopback REST auth/token.

## Risks & open questions

- **Network hop per transition** (compose Node → stratum Python over MCP). Acceptable — compose already round-trips its own REST (`127.0.0.1:3001`) for lifecycle/gate ops today.
- **Build-twice vs. TS port** — accepted (decision 2026-06-02): Python now for enforcement value; STRAT-GUARD's contract is the TS reimplementation spec.
- **Vocabulary decision** — RESOLVED at gate: lifecycle-as-truth.
- **REST no-auth** — routing through STRAT-GUARD moves the trust boundary for mutations, but the raw REST endpoints remain callable. A loopback token / required workspace binding is a Slice 4 hardening, flagged not solved here.
- **Override token issuance** — depends on STRAT-GUARD open question #1.

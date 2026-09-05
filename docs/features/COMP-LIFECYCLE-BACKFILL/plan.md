# COMP-LIFECYCLE-BACKFILL — Implementation Plan

**Status:** IN_PROGRESS (2026-09-05)
**Feature:** COMP-LIFECYCLE-BACKFILL
**Stratum run:** `9ed5acaf-cf66-42e8-a23b-be70a8bb14d3`

## Related Documents

- Design: [design.md](./design.md) — read from "Revision 2026-09-05" to end; decisions there are locked
- Blueprint: [blueprint.md](./blueprint.md) — the authority for every algorithm, wire shape, and file:line below
- Gate reviews: [reviews/blueprint-r1-2026-09-05.md](./reviews/blueprint-r1-2026-09-05.md),
  [reviews/blueprint-r2-2026-09-05.md](./reviews/blueprint-r2-2026-09-05.md),
  [reviews/blueprint-r3-2026-09-05.md](./reviews/blueprint-r3-2026-09-05.md)
- Ledger: [progress.md](./progress.md)
- Contract: `contracts/lifecycle-backfill.schema.json` (new, blueprint §2) — use its types for request,
  occurrence, intent and batch record; never restate shapes in prose here
- Obs contract: `contracts/comp-obs-contract.schema.json` → 0.2.7 (blueprint §2, "Obs-contract additions")
- Stratum: `stratum/ts` at v0.4.4 — `guard policy` / `guard apply-upgrade` / `guard digest` /
  `expected_policy_checksum`; exact stdin keys in `stratum/ts/src/cli/guard.ts` (`assertOnlyKeys`)

## Dispatch plan

Slices are strictly ordered S1 → S2 → S3 (Boundary Map: S02 consumes S01, S03 consumes S01 + S02).
Every unit is test-first: write the test named in the blueprint, watch it fail, then the code.

| Slice | Worker | Sandbox | Reviewer |
|---|---|---|---|
| S1 graph / transport / descriptors | Codex `gpt-5.6-terra/high` | workspace-write | Codex terra, to CLEAN (≤3 rounds) |
| S2 gate intent + valid-time history | Opus (general-purpose, `model: opus`) | — | Codex terra, to CLEAN (≤3 rounds) |
| S3 routes / MCP / readers / UI | Codex `gpt-5.6-terra/high` | workspace-write | Codex terra, to CLEAN (≤3 rounds) |

Per slice: implement → targeted tests for the slice → Codex impl review → controller adjudicates with
evidence → commit. ONE compose full suite at the very end (task 4).

Constraints the workers must honour:
- Only the files listed in the slice's task may change. `blueprint.md` and `design.md` are read-only.
- Change test expectations that the blueprint says break by design (BP-17); never weaken assertions.
- No test seam in stratum; the golden flow spawns the REAL CLI (blueprint §7.1).
- `node_modules/@smartmemory/stratum` is a symlink to `stratum/ts`; do not replace it.
- Codex sandbox cannot commit; the controller commits.

---

## Task 1 — Slice S1: graph, transport, descriptors (blueprint §3)

### 1.1 `complete_backfilled` in the mode registry (S1-1)

Files: `lib/lifecycle-modes.js` (existing), `server/lifecycle-guard.js` (existing),
`test/lifecycle-backfill-graph.test.js` (new), `test/lifecycle-modes.test.js` (existing),
`test/lifecycle-modes-golden.test.js` (existing), `test/judgment-writer.test.js` (existing)

- [ ] `terminal` gains `'complete_backfilled'` in all four modes (build, fix, plan, judgment)
- [ ] `export const TERMINAL` in `lifecycle-guard.js` gains `'complete_backfilled'`
- [ ] `buildPhaseGraph`: every non-terminal node gets a `complete_backfilled` edge, appended AFTER
      the `complete` push and BEFORE the `killed` loop (array order is hashed by stratum)
- [ ] `phaseToStatus('complete_backfilled') === 'COMPLETE'`
- [ ] New graph test: terminal membership, `[]` adjacency, before-`killed` ordering, status projection
- [ ] `lifecycle-modes.test.js` expected `terminal` updated
- [ ] `lifecycle-modes-golden.test.js` filters BOTH auto-added terminals AND asserts positively that
      `g.explore_design` includes `complete_backfilled`; `g.complete_backfilled` deep-equals `[]`
- [ ] `judgment-writer.test.js` surplus-edge list grows from five to nine, sorted

### 1.2 `guardPolicy`, `guardApplyUpgrade`, `guardDigest` (S1-2)

Files: `server/stratum-client.js` (existing), `test/stratum-client-guard.test.js` (existing)

- [ ] `spawnStratumStdin` accepts an optional `extraEnv`; when absent the spawn options are
      byte-identical to today (`{timeout}` only)
- [ ] `runGuard(action, kwargs, timeoutMs, extraEnv)` forwards it
- [ ] `guardPolicy(resourceId)` → `['guard','policy']`, stdin exactly `{resource_id}`
- [ ] `guardApplyUpgrade({resourceId, descriptorId, descriptorsPath})` → stdin exactly
      `{resource_id, descriptor_id}`, descriptors path in child env `STRATUM_GUARD_UPGRADE_DESCRIPTORS`
- [ ] `guardDigest(...)` → `['guard','digest']` with exactly the six documented keys;
      `modified_files` and `resolved_by` sent explicitly
- [ ] `guardTransition` gains `expectedPolicyChecksum` (wire key `expected_policy_checksum`); camelCase
      everywhere in JS, snake_case only inside `runGuard` (R3-1); remains the raw recovery transport
- [ ] `guardedTransition` forwards `idempotencyKey` and `expectedPolicyChecksum` in camelCase
- [ ] Wire-shape tests for all three new functions plus the not-found error envelope

### 1.3 Legacy-policy projection and `ensureGuard` compatibility (S1-3)

Files: `server/lifecycle-guard.js` (existing), `test/lifecycle-guard.test.js` (existing)

- [ ] `_registered` becomes a `Map`; cache short-circuit returns `status: 'legacy' | 'cached'`
- [ ] Exports `policyChecksumFields`, `legacyPolicyProjection`, `policiesEqual` (terminal compared
      sorted, adjacency arrays compared in order)
- [ ] `ensureGuard` on `guard_already_registered`: read stored policy via `guardPolicy`; equal to
      new-minus-node ⇒ `{status:'legacy', storedChecksum}`; otherwise `GUARD_POLICY_DIVERGED`, fail closed
- [ ] Stored policy differing only in `initial` is still `legacy`
- [ ] `guardedTransition` on a `legacy` resource proceeds normally; returns verbatim `status`
- [ ] Every other `ensureGuard` outcome is byte-for-byte today's behaviour (existing tests still pass)

### 1.4 Lazy `apply-upgrade` (S1-4)

Files: `server/lifecycle-guard.js` (existing), `test/lifecycle-backfill-upgrade.test.js` (new)

- [ ] `applyBackfillUpgrade({featureCode, workspaceRoot, mode})` reads the stored policy, computes
      `descriptorIdFor`, spawns `apply-upgrade` with an ABSOLUTE descriptors path under `.compose/`
- [ ] Returns `{ok:true, status, ledgerRef, checksum}` for `unchanged` / `applied`
- [ ] `upgrade_descriptor_unavailable`, `upgrade_descriptor_mismatch`, any other error ⇒
      `{ok:false, reasons}` naming `compose guard descriptors` + re-sign
- [ ] Only ever invoked for a resource whose `ensureGuard` status was `legacy`

### 1.5 `compose guard descriptors` (S1-5)

Files: `lib/guard-descriptors.js` (new), `bin/compose.js` (existing), `test/guard-descriptors.test.js` (new)

- [ ] `descriptorIdFor(fromChecksum, mode)` = `backfill-<mode>-<checksum[0:12]>`
- [ ] `deriveBackfillPolicy(stored, mode)` adds the node with `[]` adjacency, appends before `killed`
      in every non-terminal list, adds to `terminal`, touches nothing else
- [ ] Round trip: `legacyPolicyProjection(deriveBackfillPolicy(p))` deep-equals `p`
- [ ] `buildDescriptorFile` dedups by `from_checksum`, sorts by `id`, byte-stable on shuffled input
- [ ] A `to_policy` with a fifth key is refused before write
- [ ] `enumerateRegisteredResources` + `writeDescriptorFile` write `.compose/guard-upgrades.json`
- [ ] `bin/compose.js` dispatches `compose guard descriptors`

### 1.6 Async evidence runner (S1, consumed by S2)

Files: `server/lifecycle-guard.js` (existing)

- [ ] `verifyCompletionEvidenceAsync` replaces the two `spawnSync` calls with async spawns so the dir
      lock heartbeat keeps running during a long test command (R2B-12); same result shape as
      `verifyCompletionEvidence`

### 1.7 S1 gate

- [ ] Targeted run: `node --test test/lifecycle-backfill-graph.test.js test/lifecycle-modes*.test.js test/judgment-writer.test.js test/stratum-client-guard.test.js test/lifecycle-guard.test.js test/lifecycle-backfill-upgrade.test.js test/guard-descriptors.test.js` green
- [ ] Codex impl review CLEAN; adjudications recorded in `reviews/impl-s1-*.md`
- [ ] Commit `feat(COMP-LIFECYCLE-BACKFILL): S1 graph, transport, descriptors`

---

## Task 2 — Slice S2: valid-time merge, evidence, gate intent (blueprint §4–§5)

### 2.1 `insertBackfilledPhases` (§4.1, §4.2)

Files: `server/lifecycle-phase-history.js` (existing), `test/phase-history-merge.test.js` (new)

- [ ] History entries carry `recordedAt`, `origin`, `confidence`; `normaliseOrigin` exported;
      `appendPhaseHistory` unchanged for live writes (absence of `origin` preserved)
- [ ] Occurrences ordered by valid time with epoch comparison; ISO strings always carry explicit `Z`
- [ ] Dedup by `operation_id` with immutable-field verification first (§4.1 step 3a, R3-5), then by
      claim `{phase, evidence.kind, evidence.ref, observedTime}`
- [ ] Incoming-only tie ⇒ refusal; single adoption boundary at `lifecycle.startedAt`; an occurrence at
      exactly `startedAt` ⇒ refusal; strictly inside a closed live interval ⇒ refusal
- [ ] Out-of-graph genesis (fix mode `explore_design`) is a marker only; caller pairs validated on
      `transitionsOf`, terminal pair on `buildPhaseGraph`
- [ ] Future-dated evidence (after the completion being recorded) ⇒ refusal
- [ ] All seven histories (H1–H7) from §4.2 pass with epoch AND string equality on every closure;
      `ship.exitedAt` asserted equal to `lc.startedAt`, not a re-typed literal

### 2.2 Evidence resolver (§4.3)

Files: `lib/backfill-evidence.js` (new), `test/backfill-evidence.test.js` (new)

- [ ] `CONFIDENCE_BY_KIND` frozen `{commit: 0.9, path: 0.6}`; `deriveConfidence` exported
- [ ] `resolveEvidenceRef`: commit SHA verified in the real repo; path must be repo-relative, resolved
      by realpath, contained in the repo (rejects `../`, absolute, and symlink-to-outside)
- [ ] macOS firmlink prefix stripped (`lib/canon-guard.js` `stripFirmlink`), covered by a real test
- [ ] Tests run against a real tmp git repo (the `makeWorkspace` fixture) plus a real symlink

### 2.3 `completionGate({intent:'backfill'})` (§5.1–§5.11)

Files: `lib/completion-gate.js` (existing), `contracts/lifecycle-backfill.schema.json` (new),
`test/lifecycle-backfill.test.js` (new), `test/helpers/sshsig-sign.js` (new)

- [ ] Contract file written first; request / occurrence / `StoredHistoryEntry` / intent / batch-record
      shapes validated against it in tests, including a literal live genesis record (R3-3)
- [ ] Canonicalise request → `request_digest` before anything else (§5.1)
- [ ] One `writeContext` object built by BOTH branches (§5.4a field table); every write in §5.10
      reads only it; `notes`, `guard_initial`, `upgrade`, `policy_checksum` persisted in the intent (R3-4)
- [ ] Ordering exactly as §5.2: digest → dir lock → lookup (finalized / pending / new, §5.3) →
      evidence via the async runner → history pre-validation (§5.5) → register → upgrade (§5.6) →
      persist intent holding the COMPLETE validated write plan (§5.7) → transition (§5.8) → writes
      (§5.10) → pending→finalized flip only when zero failures AND audit confirmed → clear intent
- [ ] Mode-aware preflight: fix/plan modes (`tracksFeatureJson:false`) do lifecycle-only writes plus
      durable `item.status='complete'` via `updateItem`; build mode writes feature.json + ROADMAP + projection
- [ ] Bootstrap and recovery are two branches, never interleaved (§5.4)
- [ ] Fresh transition sends `idempotency_key = operation_id` and `expected_policy_checksum`;
      `policy_checksum_mismatch` refuses with a message saying it is retryable
- [ ] Recovery (§5.9a): replay the persisted envelope through raw `guardTransition` (no `ensureGuard`)
      WITH the persisted `expectedPolicyChecksum` (R3-2); §5.9c read-only verification via `guardDigest`
      + one `guardHistory` resolves `replayed`, `idempotency_conflict` and `policy_checksum_mismatch`;
      later `transition`/`deviation` ledger entries disqualify, `graph_version` only if state-preserving
      (R3-6); neither intent nor finalized record ⇒ refuse
- [ ] Effective guard flag from the intent threaded through the projector callback and the verifier
      (§5.10a, R3-7); both config flips tested through the real projection path
- [ ] The route/gate, not the caller, mutates `currentPhase` / `completedAt` / `phaseHistory` (§5.10 step 6.0)
- [ ] A durable write failure refuses at `write` and KEEPS the intent
- [ ] Refusal taxonomy (§5.11): every `refusedAt` value reachable and nothing written on any refusal

### 2.4 Golden flows and refusal harness (§7)

Files: `test/lifecycle-backfill.test.js` (new), `test/helpers/sshsig-sign.js` (new)

- [ ] Isolated runnable stratum copy per §7.1: package.json + full dist, fixture pubkey line in
      `dist/contracts/guard-signers.allowed`, dependency resolution exactly as §7.1 step 4 (R3-8), `$HOME` → temp
      dir, smoke `guard` with no action exits 1
- [ ] In-test sshsig signer modelled on `stratum/ts/tests/helpers/sshsig-sign.ts`
- [ ] Flow A: build mode, registered legacy resource — descriptors generated, signed, lazily applied,
      backfill lands as `complete_backfilled`, feature COMPLETE, ledger entry present, replay is
      idempotent; steps 6b/7/7b cover recovery after step 6.0 and both halves of the pre-transition window
- [ ] Flow B: fix mode, no feature.json — lifecycle-only writes, `item.status === 'complete'`
- [ ] Flow C: guard off — backfill succeeds with no stratum spawn
- [ ] Refusal harness R1–R29 table-driven, one test per row, each asserting `refusedAt` and that
      nothing was written (R8 and R19 assert success). R17 uses `0o660`; R26 points at an EXISTING
      non-CLI file
- [ ] Heartbeat-progress assertion: lock dir mtime advances during a slow evidence command (R2B-12)

### 2.5 S2 gate

- [ ] Targeted run: `node --test test/phase-history-merge.test.js test/backfill-evidence.test.js test/lifecycle-backfill.test.js test/completion-gate.test.js test/dir-lock*.test.js` green
- [ ] Codex impl review CLEAN; adjudications in `reviews/impl-s2-*.md`
- [ ] Commit `feat(COMP-LIFECYCLE-BACKFILL): S2 valid-time history + backfill gate`

---

## Task 3 — Slice S3: surfaces and readers (blueprint §6)

### 3.1 REST route (S3-1)

Files: `server/vision-routes.js` (existing), `test/lifecycle-backfill-routes.test.js` (new)

- [ ] `POST /api/vision/items/:id/lifecycle/backfill` behind `guardAuth`
- [ ] 404 on missing item / lifecycle; 400 on missing or blank `reason`; 422 on gate refusal echoing
      `refusedAt` + `reasons`
- [ ] NOT gated on `currentPhase === completablePhaseOf(mode)`; reachable from any non-terminal phase
- [ ] Passes the live store and item into the gate with `intent:'backfill'`; reuses the in-process
      `visionProjector`; does not itself mutate phase fields
- [ ] Success side effects mirror `/lifecycle/complete` with `to: 'complete_backfilled'`

### 3.2 MCP tool (S3-2)

Files: `server/compose-mcp-tools.js` (existing), `server/mcp-tool-defs.js` (existing),
`server/compose-mcp.js` (existing), `test/completion-write-allowlist.test.js` (existing)

- [ ] `toolBackfillCompletion` delegates via `_postLifecycle(id, 'backfill', body)`; never calls
      `_overrideOk` or `assertTerminalStatusAuthorized`
- [ ] Tool def next to `record_completion`: `effect:'mutating'`, `writes:["feature-json"]`, required
      `['id','commit_sha','tests_pass','files_changed','reason']`, description states the explicit
      `tests_pass` rule, evidence rules, and the server-must-be-running dependency
- [ ] Dispatch `case 'backfill_completion'` in `compose-mcp.js`
- [ ] Allowlist test asserts the gate remains the only COMPLETE writer (no new entry)

### 3.3 Projection and readers (S3-3)

Files: `server/completion-projection.js` (existing), `server/decision-events-snapshot.js` (existing),
`server/decision-event-emit.js` (existing), `server/session-routes.js` (existing),
`contracts/comp-obs-contract.schema.json` (existing), `test/decision-events-snapshot.test.js` (existing),
`test/obs-contract-backfill.test.js` (new)

- [ ] `completion-projection.js` accepts `GUARDED_TERMINAL_STATES = {complete, complete_backfilled}`
      and stamps the ACTUAL state
- [ ] Snapshot passes `origin` / `recorded_at` / `confidence` through unchanged; no `?? 'live'` default
- [ ] Emitter adds each of the three metadata fields only when not undefined; a live event is
      byte-identical to today's
- [ ] Session lifecycle projection carries `origin`
- [ ] Obs contract bumped to 0.2.7 with a `_changelog` entry; `phase_transition` metadata admits the
      three optional fields
- [ ] Snapshot tests: fixture with `origin:'backfill'` carries it; fixture with no `origin` has no key
- [ ] Contract test validates one backfilled and one live event against 0.2.7

### 3.4 UI (S3-4)

Files: `src/components/vision/constants.js` (existing), `src/components/vision/ItemDetailPanel.jsx` (existing),
`src/components/vision/ContextPipelineDots.jsx` (existing), matching vitest suites under `test/ui/` (existing)

- [ ] `LIFECYCLE_PHASE_LABELS.complete_backfilled = 'Complete (backfilled)'`
- [ ] History strip renders a backfill badge when `(entry.origin ?? 'live') === 'backfill'`
- [ ] Pipeline dot for a backfilled step is muted; `StepDetail` surfaces `origin` and `confidence`
- [ ] Vitest coverage for the label, the badge, and the muted dot

### 3.5 S3 gate

- [ ] Targeted run: `node --test test/lifecycle-backfill-routes.test.js test/completion-write-allowlist.test.js test/decision-events-snapshot.test.js test/obs-contract-backfill.test.js` and the touched vitest files green
- [ ] Codex impl review CLEAN; adjudications in `reviews/impl-s3-*.md`
- [ ] Commit `feat(COMP-LIFECYCLE-BACKFILL): S3 route, MCP tool, readers, UI`

---

## Task 4 — Ship

Files: `package.json` (existing), `CHANGELOG.md` (existing), `README.md` (existing),
`docs/features/COMP-LIFECYCLE-BACKFILL/report.md` (new), `progress.md` (existing)

- [ ] `@smartmemory/stratum` → `^0.4.4` in `package.json` (symlink stays)
- [ ] ONE full suite, unsandboxed: `cd compose && CI=1 npm test`, then `npm run test:ui` (611) and
      `npm run test:tracker` (100) separately; only `test/build-stream-smoke.test.js` may flake
- [ ] CHANGELOG entry + README operator steps (ed25519 key → enrol pubkey in stratum trust root →
      release + install → `compose guard descriptors` → `ssh-keygen -Y sign` → commit json + .sig) in
      the SAME commit as the version bump
- [ ] Implementation report `report.md` linking back to design, blueprint, reviews
- [ ] `record_completion` through the gate (works since `d459846`); journal entry; roadmap row regenerates
- [ ] `stratum_step_done` for `implement`; `stratum_audit` trace in the commit message
- [ ] Push compose (pre-push runs the full suite, ~8 min); the six local docs commits ride along

## Out of scope (recorded, not built)

- Any MCP guard transport; guard stays CLI-only via `server/stratum-client.js`
- Resource-scoped descriptors; policy-wide scope is accepted for v1
- Enrolling a signing key: operator-owned, cannot be automated (see README steps)

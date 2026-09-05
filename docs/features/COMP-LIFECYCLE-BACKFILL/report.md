# COMP-LIFECYCLE-BACKFILL — Implementation Report

**Status:** COMPLETE (2026-09-06)
**Stratum run:** `9ed5acaf-cf66-42e8-a23b-be70a8bb14d3`

## Related Documents

- Design: [design.md](./design.md) (revision 2026-09-05 + addendum, three Codex gates)
- Blueprint: [blueprint.md](./blueprint.md) (four Codex gates: 18 → 13 → 8 → 2 findings, all confirmed)
- Plan: [plan.md](./plan.md)
- Reviews: [reviews/](./reviews/) — blueprint r1–r4, impl S1 r1, S2 r1–r2, S3 r1
- Ledger: [progress.md](./progress.md)
- Contract: `contracts/lifecycle-backfill.schema.json`; obs contract 0.2.7
- Stratum releases shipped for this feature: 0.4.2 (`guard apply-upgrade`, `guard policy`), 0.4.3
  (`guard digest`), 0.4.4 (`expected_policy_checksum` on `guard transition`)

## Commits (compose)

| Commit | Content |
|---|---|
| `d459846` | completion gate `resolved_by` fix (every guarded completion had failed since stratum 0.4.0) |
| `f0b4259`, `9289690` | design revision + addendum |
| `547c7d5`, `3176b06`, `85e5f7c` | blueprint through four gate rounds; plan.md |
| `82ef056` | S1 — graph, transport, descriptors |
| `80a9592` | S2 — valid-time history + backfill gate + golden flows |
| (S3 commit) | S3 — route, MCP tool, readers, UI; ship prep |

## What shipped

- **`complete_backfilled`** is a distinct terminal state in all four lifecycle modes. Every non-terminal
  node gains the edge, appended before `killed` because stratum hashes adjacency arrays in order.
- **Transport** (`server/stratum-client.js`): `guardPolicy`, `guardApplyUpgrade` (descriptors path in the
  child env), `guardDigest`, `expected_policy_checksum` on `guardTransition`. camelCase in JS, snake_case
  only at the wire.
- **Legacy compatibility** (`server/lifecycle-guard.js`): `ensureGuard` reads the stored policy on
  `guard_already_registered` and accepts it as `legacy` when it equals the new policy minus the backfill
  node. `deriveBackfillPolicy ∘ legacyPolicyProjection` is byte-equal to `buildPhaseGraph` for all modes
  (checked live). Raw-transport error-shape helpers cover both stratum's canonical envelope and the
  spawn-failure wrapper.
- **`compose guard descriptors`** writes `.compose/guard-upgrades.json` (mode 0600), one entry per stored
  checksum; the operator signs it with `ssh-keygen -Y sign`. Applied lazily inside the gate.
- **Gate** (`lib/completion-gate.js`, `intent:'backfill'`): request digest → dir lock →
  finalized/pending/new → async evidence → history pre-validation → register → upgrade → write-ahead
  intent holding the full `writeContext` → transition (`idempotency_key` = operation id,
  `expected_policy_checksum`) → writes → pending→finalized only on zero failures. Recovery replays the
  persisted envelope with the persisted checksum and otherwise verifies read-only via `guard digest` +
  one `guard history`; it never issues an unchecked transition. The live and backfill doors share one
  `COMPLETE` status writer (single callsite preserved).
- **History** (`server/lifecycle-phase-history.js`): `insertBackfilledPhases` orders by epoch, dedups by
  `operation_id` then by claim, refuses ties/adoption-boundary/closed-interval violations, treats an
  out-of-graph genesis as a marker only.
- **Evidence** (`lib/backfill-evidence.js`): commit-in-repo, repo-relative realpath containment,
  symlink-to-outside refused, macOS firmlink stripped.
- **Surfaces**: `POST /api/vision/items/:id/lifecycle/backfill`; MCP `backfill_completion` (HTTP
  delegation, no override token path); readers and decision events carry `origin` / `recorded_at` /
  `confidence` only when present; UI label, badge, muted dot.
- **Tests**: golden flows A/B/C spawn the REAL stratum CLI from an isolated copy with a temp `HOME` and
  an in-test sshsig signer; refusal harness R1–R26b; contract tests through the production validator
  (`server/schema-validator.js` now enables Ajv `$data`).

## Deviations from the blueprint (recorded, accepted)

- Flow A steps 6/7/8 (the four mid-operation policy-change variants) are not built; §5.9c's three
  conditions are exercised via step 7b (pre-transition crash window) and the replay path.
- H7 refuses at §4.1 step 4e (unreachable pair) rather than §5.5 step 5; same `refusedAt:'history'`.
- The fresh branch uses the raw `guardTransition` transport, not the `guardedTransition` wrapper: the
  wrapper collapses `replayed` into `applied`, which the design forbids the gate from confusing.
- Projection widening and the allowlist entry for the gate's fix/plan status write landed in S2, not S3.
- Tool inventory re-pinned 52 tools / 27 mutating.

## Operator steps (not automatable — see README "Backfilling a completion")

Key → enrol public key in stratum's trust root (release + install) → `compose guard descriptors` →
`ssh-keygen -Y sign` → commit json + sig. Until then backfill on a REGISTERED resource refuses with
`upgrade_descriptor_unavailable`; unregistered features work immediately.

## Follow-ups

- Compose test suites register guards into the real `~/.stratum/guards` (32 fixture ids). Run them with
  `HOME` at a temp dir like the backfill golden flow does.
- The gate does not validate the persisted intent against the schema at runtime (the contract test does,
  on the intent the gate actually writes). Wiring it in adds a refusal path §5.11 does not name.
- `guardedTransition` still lacks a verbatim `status` passthrough (§5.8 nicety; S2 routed around it).
- Flow A steps 6/7/8 variants.
- Stratum trust root `guard-signers.allowed` ships EMPTY; the operator step above is required before any
  legacy-resource backfill.

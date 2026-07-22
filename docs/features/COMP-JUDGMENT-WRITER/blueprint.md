# COMP-JUDGMENT-WRITER — Implementation Blueprint

**From:** [design.md](design.md) rev 5 (gate-clean, 2026-07-22). W1–W3 only; W4 (SmartMemory enrichment) is a fast-follow with its own blueprint.
**In-flight overlap:** none found — every existing `blueprint.md` touching `server/compose-mcp.js` / `lib/feature-events.js` belongs to a COMPLETE feature (verify at Phase 5: no IN_PROGRESS feature shares these files).

## Critical files and patterns (assumptions to verify at Phase 5)

Every claim below carries the file:line it rests on; the Phase 5 pass verifies each against disk and fills the Corrections Table.

| # | Assumption | Source ref |
|---|---|---|
| A1 | Writer template: transport-free `(cwd, args)`, validate-before-idempotency, audit-append after commit, small results | `lib/feature-writer.js:1-17,138-143,373-381` |
| A2 | Advisory-lock recipe + stale recovery + critical-section discipline + compensating rollback | `lib/journal-writer.js:509-514,556-586,649-843` |
| A3 | Atomic write idiom `tmp.${pid}` + rename | `lib/feature-json.js:84-94`, `lib/journal-writer.js:509-514` |
| A4 | Idempotency wrapper consumed as-is | `lib/idempotency.js:108-128` |
| A5 | Audit events via `appendEvent`; additive event shape, any `tool` name legal | `lib/feature-events.js:45-72` |
| A6 | Ajv loader: `SchemaValidator(schemaPath).validateRoot()`; `$id` required for definitions path | `server/schema-validator.js:52,63-85` |
| A7 | Leaf-validator shape: typed error with `kind`+`violations`, memoized compiled schema, no upward imports | `lib/feature-write-guard.js:25-51` |
| A8 | MCP two-site registration: TOOLS entry + dispatch case + thin shim injecting `getTargetRoot()` | `server/compose-mcp.js:86,573-600,765,784-820`; `server/compose-mcp-tools.js:486-489` |
| A9 | Workspace resolution central in CallTool handler; tests drive via `COMPOSE_TARGET` | `server/compose-mcp.js:714,731-734`; `test/journal-writer-mcp.test.js:19` |
| A10 | Policy: reviewer allowlist-mode (add read tool), implementer deny-mode (write tools allowed by default) | `server/mcp-tool-policy.js:27-44` |
| A11 | Provider-registry template with method-granular `capabilities()` + `NOT_IMPLEMENTED` stubs | `lib/checkpoint/store/index.js:5-60`; consumer gate `lib/checkpoint/reconciler.js:150-156` |
| A12 | Stratum guard adapter exists, fail-closed before state mutation, returns verdict/state/receipt only | `server/lifecycle-guard.js:325,333,339,363` |
| A13 | Guard capability flag on in this workspace | `.compose/compose.json:4` (`capabilities.guard: true`) |
| A14 | Test harness: `node:test` + `assert/strict`, `freshCwd()` tempdir fixtures, hand-rolled `McpClient` over stdio | `test/feature-writer.test.js:5-32`, `test/journal-writer-mcp.test.js:16-91` |
| A15 | OKF codec rules for emitted projections: frontmatter fence, required `type`, single-component item ids, nullable `resource` | `smartmemory-obsidian/src/bridge/okf.ts:52-54,79-149` (reference only — compose ships its own emitter) |
| A16 | `resolveProjectTag` = display name only; real workspace identity is service-returned `team_id` (W4 concern, recorded so W1 schema reserves `provider_ids`) | `lib/smartmemory-config.js:30-50` |

**Known trap (do not copy):** `lib/roadmap-gen.js:525` writes non-atomically.

## File Plan

| File | Action | Slice |
|---|---|---|
| `contracts/judgment-record.schema.json` | new | S01 |
| `lib/judgment/schema.js` | new — `JUDGMENT_SCHEMA_PATH` const + memoized validator factory | S01 |
| `lib/judgment/store/records.js` | new — tracked-floor store: revision chains, joints, predictions, ledger append, intents | S02 |
| `lib/judgment/store/index.js` | new — `createJudgmentStore` registry (`records` real; `smartmemory` NOT_IMPLEMENTED stub), `capabilities()` | S02 |
| `lib/judgment-write-guard.js` | new — pure leaf: schema + grounding/elicitation + edge→artifact + method-gate rules | S03 |
| `lib/judgment-gen.js` | new — OKF projections (REGISTER/LEDGER/OBJECTIVE/positions/index.md), fixed-point roundtrip guard | S04 |
| `lib/judgment-writer.js` | new — six operations, advisory lock, intent-first transitions, reconciler, prediction spawn/grade, derived status | S05 |
| `server/compose-mcp.js` | modify — 6 TOOLS entries + 6 dispatch cases | S06 |
| `server/compose-mcp-tools.js` | modify — 6 shims | S06 |
| `server/mcp-tool-policy.js` | modify — `get_judgment_state` → REVIEWER_ALLOW | S06 |
| `bin/judgment-import.js` | new — one-time markdown→records import via the writer (`via: 'import'`) | S07 |
| `test/judgment-writer.test.js` | new — unit + golden flow (P1→P7 through writer API) | S05 |
| `test/judgment-writer-mcp.test.js` | new — e2e via McpClient, policy assertions | S06 |
| `test/judgment-import.test.js` | new — import round-trip on fixture copies of live canon | S07 |
| `CHANGELOG.md` | modify — same commit as ship | S07 |

Guard integration: S05/S06 call the existing exported `guardedTransition(...)` (`server/lifecycle-guard.js:333`), coding against its verified return shape `{applied, refused?, verdict, ledgerRef, currentState}` — adapter itself untouched (A12 correction).

## Boundary Map

### S01: contract + schema loader
Produces:
  lib/judgment/schema.js → JUDGMENT_SCHEMA_PATH (const)
  lib/judgment/schema.js → getJudgmentValidator (function)

Consumes: nothing (leaf node)

### S02: records store + provider registry
Produces:
  lib/judgment/store/records.js → RecordsStore (class)
  lib/judgment/store/index.js → createJudgmentStore (function)

Consumes:
  from S01: lib/judgment/schema.js → getJudgmentValidator

### S03: write guard
Produces:
  lib/judgment-write-guard.js → JudgmentWriteValidationError (class)
  lib/judgment-write-guard.js → assertValidRecord, assertEdgeArtifact, assertMethodGate, assertGrounding (function)

Consumes:
  from S01: lib/judgment/schema.js → getJudgmentValidator, JUDGMENT_SCHEMA_PATH

### S04: projections
Produces:
  lib/judgment-gen.js → regenerateProjections, checkProjectionRoundtrip (function)

Consumes:
  from S02: lib/judgment/store/records.js → RecordsStore

### S05: writer
Produces:
  lib/judgment-writer.js → judgmentPositionCreate, judgmentPositionAmend, judgmentJointAdd, judgmentTransition, judgmentLedgerAppend, getJudgmentState (function)
  lib/judgment-writer.js → replayPendingIntents (function)

Consumes:
  from S02: lib/judgment/store/index.js → createJudgmentStore
  from S03: lib/judgment-write-guard.js → assertValidRecord, assertEdgeArtifact, assertMethodGate, assertGrounding, JudgmentWriteValidationError
  from S04: lib/judgment-gen.js → regenerateProjections, checkProjectionRoundtrip

### S06: MCP surface
Produces:
  server/compose-mcp-tools.js → toolJudgmentPositionCreate, toolJudgmentPositionAmend, toolJudgmentJointAdd, toolJudgmentTransition, toolJudgmentLedgerAppend, toolGetJudgmentState (function)

Consumes:
  from S05: lib/judgment-writer.js → judgmentPositionCreate, judgmentPositionAmend, judgmentJointAdd, judgmentTransition, judgmentLedgerAppend, getJudgmentState

### S07: importer + cutover
Produces:
  bin/judgment-import.js → runJudgmentImport (function)

Consumes:
  from S05: lib/judgment-writer.js → judgmentPositionCreate, judgmentJointAdd, judgmentLedgerAppend

## Corrections Table (Phase 5 pass, Codex `gpt-5.6-sol/xhigh`, 2026-07-22)

6 VERIFIED, 10 corrected. No correction changes the design — all are reference/naming precision. Corrections are binding on implementation.

| A# | Verdict | Correction (binding) |
|---|---|---|
| A1 | corrected | Behavior right, ranges wrong: validation precedes idempotency at `feature-writer.js:170,397` (idempotency at 203/403); write→audit at 250→262, 444→466; sanitization at :124 |
| A2 | VERIFIED | — |
| A3 | corrected | **Copy `feature-json.js:87-90`** (`${path}.tmp.${process.pid}` + rename). `journal-writer.js:509` uses `.tmp` with NO pid — do not copy that variant |
| A4 | VERIFIED | — |
| A5 | VERIFIED | — |
| A6 | corrected | `new SchemaValidator(schemaPath).validateRoot(obj)` — class, instantiate (ctor :33, validateRoot :74); root validation works without `$id` (fallback :74-80); `$id` needed only for definition refs (:52) |
| A7 | corrected | Leaf-ness is *no upward imports into feature-json/validator/writer* — it DOES import `SchemaValidator` + three lib helpers (`feature-write-guard.js:20-23`). Judgment guard mirrors exactly that import set discipline |
| A8 | corrected | Registration is FOUR sites: shim import (`compose-mcp.js:30`), TOOLS entry (:573 example), dispatch case (:765), shim export (`compose-mcp-tools.js:486`). :784-820 is serialization, not registration |
| A9 | VERIFIED | — |
| A10 | VERIFIED | — |
| A11 | corrected | `capabilities()` lives on each backend (real impl `checkpoint/store/jsonl.js:77`), not the registry; unimplemented backends throw `NOT_IMPLEMENTED` at selection inside `createCheckpointStore` (`index.js:32,54`) — they do not return stubs. Judgment registry copies that: throw at selection |
| A12 | corrected | **Adapter symbol: `guardedTransition` (exported, `lifecycle-guard.js:333`; uses `ensureGuard` internally :299,334). Returns `{applied, refused?, verdict, ledgerRef, currentState}` on success/refusal, `{applied:false, error}` on failure — no `state`/`receipt` fields.** S05/S06 code against this exact shape |
| A13 | corrected | `capabilities.guard: true` at `.compose/compose.json:7` (not :4) |
| A14 | VERIFIED | — |
| A15 | corrected | `type` required EXCEPT bundle-root with `okf_version: "0.1"` (`okf.ts:102-105,128-135`); item-id single-component means one literal URI component — `/` is percent-encoded by `buildResource`, so slugs containing `/` are representable but our `<kind>.<slug>` ids avoid it anyway; null `resource` maps clean (:114-125,192-194) |
| A16 | corrected | `resolveProjectTag` = `deriveId({root}).id` (workspaceId or basename; `smartmemory-config.js:37`, `discover-workspaces.js:112`) — a local slug, no service call, no `team_id`. The design's W4 rule (persist service-returned `team_id`, use it in URIs) stands; this row just mis-described the helper |

## Notes for the plan phase

- TDD per slice; golden flow lands with S05, MCP e2e with S06, import round-trip with S07.
- The W3 cutover commit contains: records, regenerated projections, importer, and the human-approved diff — one commit, per design Decision 6.
- ONE-UNDER-TEST guard-predicate expressibility (design D4) is answered during S05 with an empirical probe against `guard_register` — writer-local fallback is the floor either way.
- Reviewer-policy test asserts: write tools denied to reviewer profile, `get_judgment_state` allowed.

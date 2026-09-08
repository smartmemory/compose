# Decision: retire `canon_override_grant` and keep the canon guard

**Date:** 2026-09-08
**Trigger:** An audit of the canon override found a schema-advertised, dispatchable MCP tool with no production caller and mostly unread governance state.

## Findings

**1. The tool had no production caller.** `server/mcp-tool-defs.js` advertised `canon_override_grant`, `server/compose-mcp.js` dispatched it, and `server/compose-mcp-tools.js` implemented it. The repository contains no CLI command, REST route, pipeline, skill, hook-to-server flow, other server flow, or recorded agent session that invokes the tool. The only runtime consumer of a minted grant was the canon-guard PreToolUse hook.

**2. Most of the machinery had no reader.** The grant writer produced an append-only bypass ledger, an attestation baseline, live grant files, and consumed-grant files. `verifyAppend` in `lib/append-integrity.js` had no production caller, so the baseline was never verified. Nothing inspected the consumed-grant directory after the hook moved a token into it. The promised ship-time ledger staging and `compose guard verify` coverage for overrides never landed.

**3. Minting could erase evidence of prior drift.** `mintGrant` appended a new ledger row and then `writeAttestBaseline` replaced the integrity baseline with one calculated from the current ledger. It never verified the old baseline first. If an earlier ledger prefix had drifted, the next mint blessed the changed bytes and erased that evidence. Finishing the feature would have required fixing this defect before adding any promised consumer.

**4. There is no recorded incident that needs this escape.** The capability was a logged, single-use Claude Write/Edit escape for `docs/judgment/**`. No invocation or incident of needing it appears in the repository record. For an exceptional repair, the fallback is an authorized write outside the PreToolUse hook's reach; a restricted agent escalates.

## Decision

**DECIDED 2026-09-08 by the owner: remove `canon_override_grant` and all grant machinery, while keeping the canon-guard PreToolUse hook.** Direct Claude Write/Edit calls to `docs/judgment/**` remain denied. There is no in-hook grant branch and no profile-specific escape wording.

Removed with the tool: its MCP schema, handler, import and dispatch case, profile-policy entry, three canon-registry governance entries, override eligibility classification, tool-inventory canon IDs, ledger/token modules, and feature-specific tests. The runtime paths `.compose/canon-overrides.jsonl`, `.compose/canon-overrides-attest.json`, and `.compose/data/canon-grants/**` are no longer referenced by production code.

`lib/append-integrity.js` is removed too. After the grant module is gone it has no production consumer; git retains it if COMP-CANON-ATTEST later establishes a real use for the primitive. Reintroduction must start from that feature's actual trust boundary and verifier, not from the retired grant design.

The safety condition is the hook's behavior, not merely the absence of the tool. The real-hook end-to-end test asserts that a raw Write to `docs/judgment/**` is denied unconditionally. Its mutation check restores the deleted dynamic import; because the module no longer exists, that import falls into the hook's fail-open catch and the test goes red. This pins the exact dangerous partial-removal failure.

## Precedent

Commit `f79e804` removed `STRATUM_GUARD_OVERRIDE_TOKEN` one day earlier after the same essential result: the hatch had no user, first-class paths covered the legitimate operations, and a real break-glass mechanism should be built only after a concrete incident demonstrates the need. The shared lesson is to delete unused escape machinery rather than preserve an advertised capability whose guarantees and consumers never became real.

## Related

- [COMP-CANON-OVERRIDE design](../features/COMP-CANON-OVERRIDE/design.md) — retained historical design, now retired
- [COMP-CANON-ATTEST design](../features/COMP-CANON-ATTEST/design.md) — dependency removed; reconcile design remains open
- [Override-token audit](2026-09-07-override-token-audit.md) — removal precedent

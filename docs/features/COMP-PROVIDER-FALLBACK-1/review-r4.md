# COMP-PROVIDER-FALLBACK-1 — Review round 4 (Codex gpt-6-astra/medium, fresh read-only session, narrow confirm, 2026-09-30)

**Round-3 finding: partially resolved. One P2 remains in D7.**

1. **P2 — Path B still obtains an unstable auxiliary parent on resume.**  
   [design.md:239](/Users/ruze/reg/my/forge/compose/docs/features/COMP-PROVIDER-FALLBACK-1/design.md:239) retains the auxiliary observation created by `callsForRouting` as the substitution’s current parent. That function still allocates `prior.length`, appends it to `callSite`, and creates a new auxiliary binding ([routing-runtime.js:124](/Users/ruze/reg/my/forge/compose/lib/routing-runtime.js:124), [routing-runtime.js:135](/Users/ruze/reg/my/forge/compose/lib/routing-runtime.js:135)).

   Consequently, interruption case **(a)** remains broken for auxiliary calls: resume creates auxiliary parent 1 instead of reusing parent 0. Even if the substitution uses a stable call-site prefix and finds its original observation, D7 directs it to re-put that observation with the **current** parent. `parentRecordId` is stored in the record but excluded from its identity ([consumer-fanout.js:912](/Users/ruze/reg/my/forge/compose/lib/consumer-fanout.js:912), [consumer-fanout.js:929](/Users/ruze/reg/my/forge/compose/lib/consumer-fanout.js:929)), so this produces `ROUTING_CALL_EVIDENCE_CONFLICT`, contrary to the claimed idempotence at [design.md:247](/Users/ruze/reg/my/forge/compose/docs/features/COMP-PROVIDER-FALLBACK-1/design.md:247). If `<callSite>` instead inherits the auxiliary slot suffix, the substitution ID changes too, preserving the original duplicate-dispatch risk.

   **Required change:** explicitly reuse the original auxiliary binding before allocating another one, or locate and bind the persisted substitution independently of a newly allocated parent. Define the entire substitution call site as stable, and run cases **(a)/(b)/(c)** through the real auxiliary-binding path.

Otherwise, the revised four-way lookup correctly specifies replay, uncertain refusal, and payload persistence before resolution. The intent-before-launch citation checks out ([stratum-mcp-client.js:292](/Users/ruze/reg/my/forge/compose/lib/stratum-mcp-client.js:292)); Path A’s parent linkage also matches the ledger ([routing-ledger.js:850](/Users/ruze/reg/my/forge/compose/lib/routing-ledger.js:850)). The new acceptance item explicitly covers the requested interruptions and genuine retry ([design.md:435](/Users/ruze/reg/my/forge/compose/docs/features/COMP-PROVIDER-FALLBACK-1/design.md:435)).

No separate new P1/P2 defect identified within the requested scope.

REVIEW NOT CLEAN (1 findings)

## Adjudication (controller, 2026-09-30)

Accepted. Rounds 3 and 4 both land on resume-stable identity, now one level down in the pre-existing auxiliary allocator (routing-runtime.js:124-136, slot = prior.length). Per review-convergence practice this is a scope signal, not a patch target.
- Scope cut (controller call, owner may override): in S1, an interrupted Path B substitution whose parent is an auxiliary binding is NOT replayed on resume; it goes to recovery-required (D11). Primary-call Path B keeps full replay. Resume-stable auxiliary identity is split to a follow-up, since the base allocator already has the same property.

# COMP-PROVIDER-FALLBACK-1 — Review round 2 (Codex gpt-6-astra/medium, fresh read-only session, 2026-09-30)

Scope: fixes only (review-r1.md → revision-r1.md → design.md). Verbatim reviewer output below; adjudication appended.


1. **P1 — D10’s mapping table violates its capability-preservation rule.**  
   [design.md:286](/Users/ruze/reg/my/forge/compose/docs/features/COMP-PROVIDER-FALLBACK-1/design.md:286) maps Codex `workspace-write` to Claude `implementer` with cwd pinned. That profile has no tool restrictions ([agent-templates.js:22](/Users/ruze/reg/my/forge/compose/server/agent-templates.js:22)); Claude receives `acceptEdits` and the full preset ([claude.ts:85](/Users/ruze/reg/my/forge/stratum/ts/src/connectors/claude.ts:85), [claude.ts:128](/Users/ruze/reg/my/forge/stratum/ts/src/connectors/claude.ts:128)). Cwd is not a filesystem or network boundary. This widens workspace-confined, network-off execution to the unrestricted capabilities D10 itself identifies.

   The reverse review mappings also widen capabilities: [design.md:284](/Users/ruze/reg/my/forge/compose/docs/features/COMP-PROVIDER-FALLBACK-1/design.md:284) maps Claude reviewers/researchers to Codex read-only, which permits sandboxed shell execution, although those Claude profiles explicitly deny Bash ([agent-templates.js:12](/Users/ruze/reg/my/forge/compose/server/agent-templates.js:12)). This contradicts the “never looser on any axis” rule at [design.md:272](/Users/ruze/reg/my/forge/compose/docs/features/COMP-PROVIDER-FALLBACK-1/design.md:272).

   **Required change:** specify enforceable destination restrictions for these rows, or fail closed. Preserve shell prohibition separately from filesystem read-only. This does **not** challenge the explicitly allowed Claude unrestricted → Codex workspace narrowing.

2. **P2 — D11’s witness check does not establish restoration of all permitted filesystem effects.**  
   [design.md:309](/Users/ruze/reg/my/forge/compose/docs/features/COMP-PROVIDER-FALLBACK-1/design.md:309) authorizes automatic redispatch after `restoreToPreStageWitness` succeeds and the worktree tree equals the witness. However, the witness explicitly captures only tracked and non-ignored content ([consumer-fanout.js:118](/Users/ruze/reg/my/forge/compose/lib/consumer-fanout.js:118)). Restoration uses `git clean -fd`, preserves ignored content, and already performs the proposed tree-equality verification ([consumer-fanout.js:127](/Users/ruze/reg/my/forge/compose/lib/consumer-fanout.js:127)).

   A write-capable call can modify an ignored workspace file, fail after partial execution, and pass both checks while that modification remains. The prohibition on effects outside the worktree does not cover this case. It becomes especially relevant when S2 enables quota failures after edits.

   **Required change:** constrain automatic recovery to effects covered by the witness, or require additional restoration/reconciliation of writable state outside that coverage. Add an ignored-file mutation acceptance case. The new persistent resume block is sound, but automatic case 3 remains insufficient.

3. **P2 — D7’s retry-binding contract has no path for sticky substitutions without a failed invocation.**  
   [design.md:231](/Users/ruze/reg/my/forge/compose/docs/features/COMP-PROVIDER-FALLBACK-1/design.md:231) requires a resolved failed intent and creates the substitute as its child. D3 substitutes every later call **before dispatch**, so those calls have no failed intent ([design.md:123](/Users/ruze/reg/my/forge/compose/docs/features/COMP-PROVIDER-FALLBACK-1/design.md:123)).

   The cited runtime API explicitly refuses `child()` without a connector-owned parent intent ([routing-runtime.js:112](/Users/ruze/reg/my/forge/compose/lib/routing-runtime.js:112)). The underlying API also requires the parent intent to belong to the current binding ([routing-ledger.js:850](/Users/ruze/reg/my/forge/compose/lib/routing-ledger.js:850)); reusing the first failure from another step does not satisfy it.

   **Required change:** define a pre-dispatch substitution observation tied to the current issuance/observation, with the original vendor failure retained separately as the substitution reason. Cover both primary and auxiliary calls after stickiness takes effect, including resume. The returned-failure child mechanism resolves the original double-invocation problem; it needs this second path.

4. **P2 — D6’s off-rank branch permits an unproven-strength review without an applicable exception.**  
   [design.md:196](/Users/ruze/reg/my/forge/compose/docs/features/COMP-PROVIDER-FALLBACK-1/design.md:196) explicitly permits a different top-ranked reviewer when the implementer is off-rank and strength cannot be established. A warning records uncertainty but does not satisfy the stronger-review requirement at [design.md:30](/Users/ruze/reg/my/forge/compose/docs/features/COMP-PROVIDER-FALLBACK-1/design.md:30).

   Effective configurations outside the proposed rank are possible: Codex resolves caller-supplied model/effort independently of that rank ([codex.ts:649](/Users/ruze/reg/my/forge/stratum/ts/src/connectors/codex.ts:649)). Owner ruling #5 covers the established top-rung case and same-top-model review; it does not establish the ordering of an unknown configuration against a different reviewer.

   **Required change:** resolve off-rank configurations into an owner-approved ordering, or stop pending an explicit exception. Keep the closed same-top-model ruling unchanged.

Round-1 resolution assessment:

| Finding | Round-2 assessment |
|---|---|
| P1-1: capability widening | **Partially resolved.** Bare Codex review now has an explicit policy; finding 1 identifies contradictory remaining mappings. |
| P1-2: unsafe resume | **Partially resolved.** Persistent recovery state closes the stop/resume bypass; finding 2 concerns the new automatic-restore predicate. |
| P1-3: stronger reviewer | **Partially resolved.** Alias collapse, effective configurations, coordinator handling, and the closed top-model exception address the original cases. Finding 4 concerns the new off-rank branch. |
| P1-4: observation reuse | **Partially resolved.** A distinct child binding is implementable for returned failures. Finding 3 covers sticky pre-dispatch substitutions. |
| P2-5: policy snapshot | **Resolved as a design contract.** Frozen policy/configurations and an immutable sidecar avoid altering existing start mappings; those mappings are indeed checked on resume ([routing-ledger.js:353](/Users/ruze/reg/my/forge/compose/lib/routing-ledger.js:353)). |
| P2-6: installation errors | **Resolved.** Missing tooling and ambiguous spawn failures now fail closed. The cited installation error is confirmed at [codex.ts:685](/Users/ruze/reg/my/forge/stratum/ts/src/connectors/codex.ts:685). |
| P2-7: Claude no-plan case | **Resolved as a gated design.** Captured no-plan evidence and reliable connector propagation are explicit S2 gates. Both cited connectors currently branch only on subtype, confirming the dependency. |

The three author-flagged calls are acceptable as stated: unrestricted Claude → workspace-write Codex is an expressly permitted, recorded narrowing; orchestrator/security-auditor → Codex fails closed; and Agent-tool inheritance remains an explicit S1 acceptance gate with removal of `Agent` if inheritance fails. None is independently re-raised here.

REVIEW NOT CLEAN (4 findings)

## Adjudication (controller, 2026-09-30)

All 4 accepted. Code claims verified: agent-templates.js:12-26 (implementer unrestricted, reviewers deny Bash), consumer-fanout.js:112-118 (snapshot excludes ignored content), routing-runtime.js:113 (child() refuses without parent intent).
- F4 policy (controller call, owner may override): an off-rank effective config has no established ordering → fail loud with a hint naming the rank list, same as explicit unavailable-vendor naming. No guessed reviewer.

# COMP-PROVIDER-FALLBACK-1 — Review round 3 (Codex gpt-6-astra/medium, fresh read-only session, 2026-09-30)

Scope: round-2 fixes only. Verbatim reviewer output; adjudication appended.

1. **P2 — Path B’s slot allocation bypasses its resume replay/refusal contract.**

   [design.md:239](/Users/ruze/reg/my/forge/compose/docs/features/COMP-PROVIDER-FALLBACK-1/design.md:239) defines the substitution slot as the **count of prior observations** under the current parent and call site. But [design.md:243](/Users/ruze/reg/my/forge/compose/docs/features/COMP-PROVIDER-FALLBACK-1/design.md:243) assumes resume recomputes the existing slot and replays its resolved call or refuses its unresolved call.

   After slot `0` is persisted, counting prior observations on resume produces slot `1`. Because `callSite` participates in the observation identity ([consumer-fanout.js:912](/Users/ruze/reg/my/forge/compose/lib/consumer-fanout.js:912), [:925](/Users/ruze/reg/my/forge/compose/lib/consumer-fanout.js:925)), this creates a different observation and permits another dispatch. The intent-level uncertainty check only searches calls on the **new binding’s record ID** ([consumer-fanout.js:869](/Users/ruze/reg/my/forge/compose/lib/consumer-fanout.js:869)), so it cannot protect the previous slot.

   The cited auxiliary precedent explicitly checks prior observations for unresolved calls **before** allocating `prior.length` ([routing-runtime.js:124](/Users/ruze/reg/my/forge/compose/lib/routing-runtime.js:124)–136); it does not provide resolved-outcome replay.

   **Required change:** define a durable logical-call identity whose slot is reused on resume. Look up that observation before allocating another slot, replay completed outcomes, and refuse uncertain invocations. Cover interruption after observation creation, after intent creation, and after resolution but before step completion.

Resolution assessment:

- **F1 resolved as a gated design.** Both widening mappings now fail closed ([design.md:301](/Users/ruze/reg/my/forge/compose/docs/features/COMP-PROVIDER-FALLBACK-1/design.md:301)). The shell restrictions match [agent-templates.js:12](/Users/ruze/reg/my/forge/compose/server/agent-templates.js:12). Installed SDK declarations confirm the documented sandbox limitations and options: [Compose sdk.d.ts:2063](/Users/ruze/reg/my/forge/compose/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2063), [:3285](/Users/ruze/reg/my/forge/compose/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:3285), [:8272](/Users/ruze/reg/my/forge/compose/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:8272), and [Stratum sdk.d.ts:1817](/Users/ruze/reg/my/forge/stratum/ts/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1817).
- **F2 resolved.** Witness restoration no longer authorizes redispatch ([design.md:360](/Users/ruze/reg/my/forge/compose/docs/features/COMP-PROVIDER-FALLBACK-1/design.md:360)); this correctly accounts for the non-ignored snapshot and `git clean -fd` behavior ([consumer-fanout.js:118](/Users/ruze/reg/my/forge/compose/lib/consumer-fanout.js:118)–138).
- **F3 partially resolved.** Direct observations avoid the parent-intent requirement, and termination traverses their parent links ([routing-runtime.js:318](/Users/ruze/reg/my/forge/compose/lib/routing-runtime.js:318)–328). The new resume defect above remains.
- **F4 resolved.** Rule 5 now stops off-rank review ([design.md:196](/Users/ruze/reg/my/forge/compose/docs/features/COMP-PROVIDER-FALLBACK-1/design.md:196)), consistent with owner ruling #6. Caller-supplied model/effort resolution is confirmed at [codex.ts:649](/Users/ruze/reg/my/forge/stratum/ts/src/connectors/codex.ts:649).

REVIEW NOT CLEAN (1 findings)

## Adjudication (controller, 2026-09-30)

Accepted. Verified routing-runtime.js:124-136: slot = prior.length, so a resumed run allocates a new slot for the same logical call.

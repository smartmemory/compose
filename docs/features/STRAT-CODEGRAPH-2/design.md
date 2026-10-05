# STRAT-CODEGRAPH-2 — Auto-query injection and code checks

**Status:** PLANNED (rescoped 2026-10-05) · **Epic:** STRAT-CODEGRAPH · **Depends on:** STRAT-CODEGRAPH-1

## Related Documents
- Backend: [STRAT-CODEGRAPH-1](../STRAT-CODEGRAPH-1/design.md)
- Evidence: [STRAT-CODEGRAPH-1 fixtures](../STRAT-CODEGRAPH-1/fixtures/README.md)
- SmartMemory dependencies: CODE-CALLSITE-COVERAGE-1, CODE-EDGE-CONFIDENCE-1, CODE-FRAMEWORK-SEMANTICS-1
- Motivating memories: `feedback_review_loops_catch_unwired`, `reference_dead_paths_under_green_suites`, `feedback_scope_codex_briefs_by_slice`

## Scope
The original scope (inject callers / types / tests of X before dispatch, replacing broad file reads) is kept. It is extended with checks that turn "did we miss anything" into set comparisons.

- **Context injection and brief file lists:**
  - Before an agent is dispatched for a task on X, query callers of X, types used by X and tests covering X.
  - Inject the results as a structured block.
  - Emit the exact file/function list into Codex briefs. Broad briefs have cost 1-2.6M input tokens.
- **Callers of changed functions.** For each function the plan changes, list every caller. The plan must cover each one or declare it unaffected.
- **Unwired check.** At review, any new function that nothing calls (no caller, no registration as an MCP tool, route or CLI command, no test) is flagged.
- **Patch fence.** Map the implementation diff to symbols. Flag edits outside the symbols the plan declared.
- **Test reach.** Run only the tests whose call graph reaches the changed code.

## Acceptance criteria
- [ ] **Spike S1 (first):** replay a past built-but-unwired incident. The unwired check flags it.
- [ ] **Spike S2:** replay a past plan whose missing caller was found by a later review. The callers list surfaces that caller up front.
- [ ] Injected context and brief file lists are measured on one real feature. Record input-token cost with and without, as a check on the original "replaces broad file reads" claim.
- [ ] Every check reports edge confidence (exact vs name-only) and never blocks on name-only edges alone.
- [ ] The patch fence uses persisted line spans (CODE-EDGE-CONFIDENCE-1) and reports off-plan symbols with file:line.
- [ ] Without SmartMemory, all checks degrade to warn-only.

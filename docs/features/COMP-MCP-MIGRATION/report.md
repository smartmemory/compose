# COMP-MCP-MIGRATION — Implementation Report

## Summary

Migrated Compose's three internal feature-management mutators (cockpit
lifecycle endpoint, build runner, `/compose` skill) from free-text
Edit/Write to the typed MCP writer tools shipped earlier in the
COMP-MCP-FEATURE-MGMT family. Reconciled `complete_feature` (cockpit) with
`record_completion` (commit-bound). Added an opt-in
`enforcement.mcpForFeatureMgmt` settings flag that injects a typed-tool
instruction into agent prompts.

## Delivered vs Planned

| Item | Status |
|---|---|
| `complete_feature` MCP schema gains `commit_sha` / `tests_pass` / `files_changed` / `notes` | ✓ |
| `toolCompleteFeature` wrapper forwards new fields | ✓ |
| Cockpit `lifecycle/complete` calls `recordCompletion` when SHA present | ✓ |
| Skip event (`cockpit_completion_skipped`) when SHA absent | ✓ |
| Partial event (`cockpit_completion_failed` / `_partial_status_flip`) on writer error | ✓ |
| Lifecycle transition never rolls back on typed-tool failure (best-effort) | ✓ |
| Build runner calls `recordCompletion` post-commit with real SHA + files | ✓ |
| `enforcement.mcpForFeatureMgmt` setting + prompt-injection in step-prompt.js | ✓ |
| Skill files (`steps/docs.md`, `steps/ship.md`) updated for typed-tool boundary | ✓ |
| Cockpit integration tests (4) | ✓ |
| Auto-rollback enforcement (audit-log correlated) | DEFERRED — `COMP-MCP-ENFORCE-AUTO-ROLLBACK` follow-up; v1 is prompt-only |

## Architecture Deviations

None. Implementation matches the revised design after Codex review caught
contract mismatches in the original draft (`record_completion`'s actual
contract — `feature_code`, full 40-char SHA, `tests_pass`,
`files_changed`, `notes`; storage on `feature.json.completions[]` not
`.jsonl`; status flip happens inside `record_completion`).

## Files Changed

New:
- `compose/test/migration-cockpit.test.js` — 4 integration tests
- `docs/features/COMP-MCP-MIGRATION/{design,blueprint,report}.md`

Edited:
- `compose/server/compose-mcp.js` — extended `complete_feature` schema
- `compose/server/compose-mcp-tools.js` — `toolCompleteFeature` forwards new fields
- `compose/server/vision-routes.js` — lifecycle/complete reconciliation
- `compose/lib/build.js` — `recordCompletion` post-commit + `enforceMcpForFeatureMgmt` context flag
- `compose/lib/step-prompt.js` — typed-tool enforcement injection
- `compose/CHANGELOG.md` — entry under 2026-05-04
- `compose/ROADMAP.md` — flip COMP-MCP-MIGRATION + umbrella to COMPLETE
- `~/.claude/skills/compose/steps/docs.md` — typed-tool recipes; no early ROADMAP flip
- `~/.claude/skills/compose/steps/ship.md` — runner records completion; manual fallback documented

## Test Coverage

4 new cockpit integration tests in `migration-cockpit.test.js`:
- Happy path with `commit_sha`: completion record on `feature.json.completions[]`, status flipped to COMPLETE, ROADMAP regenerated
- No `commit_sha`: lifecycle still completes, `cockpit_completion_skipped` decision event emitted, no completion record
- Invalid `commit_sha`: lifecycle still completes, `partial: true` and `completion_failed: 'INVALID_INPUT'` in response, no completion record
- Item without `featureCode`: legacy path, no typed-tool calls, no errors

Build-runner integration test for the post-commit `recordCompletion` call
is covered indirectly by the existing `build.js` test scaffolding plus the
manual smoke test that the build pipeline runs in self-build mode.

Full suite: 2528 + 92 UI = 2620 tests, all green.

## Known Limitations

- `enforcement.mcpForFeatureMgmt` is prompt-injection only in v1. There is
  no auto-rollback when an agent ignores the instruction. Filed
  `COMP-MCP-ENFORCE-AUTO-ROLLBACK` as the follow-up that adds per-build
  correlation IDs to audit rows so the build runner can reliably tell
  "did the typed tool produce this change?" from "did Edit/Write produce
  it?"
- The build-runner `recordCompletion` call uses `tests_pass: true`
  unconditionally (the ship step's pre-flight already gated tests).
  Threading per-test-suite results through is its own follow-up.

## Lessons Learned

- Codex review caught two large contract mismatches in the design draft
  (status flip happening at docs phase rather than ship; using `summary`
  field that the writer doesn't expose). Worth running review on the
  design doc before writing blueprint, every time — those mismatches are
  cheaper to fix in prose.
- The right architectural answer for "atomic completion + status flip"
  was already inside `recordCompletion` from COMP-MCP-COMPLETION; the
  migration's job was purely to *use* it from the right places, not to
  re-implement composition. Trust the prior writer's contract.

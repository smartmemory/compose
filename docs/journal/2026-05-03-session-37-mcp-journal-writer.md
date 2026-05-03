---
date: 2026-05-03
session_number: 37
slug: mcp-journal-writer
summary: Journal writer ships (COMP-MCP-JOURNAL-WRITER)
feature_code: COMP-MCP-JOURNAL-WRITER
closing_line: Five Codex passes catch what one would not.
---

# Session 37 — COMP-MCP-JOURNAL-WRITER

**Date:** 2026-05-03
**Feature:** `COMP-MCP-JOURNAL-WRITER`

## What happened

Sub-ticket #4 of the writer family. The family pattern is now drilled-in: scaffold, design, blueprint (gated by Codex), plan, then implement TDD with Codex review iterating to clean.

The interesting moments were all in review again. Five Codex passes — three pre-code on design/blueprint/plan, two post-code on the implementation — caught fourteen actionable issues that would otherwise have shipped. Pre-code: parent-contract drift (per-date vs global numbering), `unknownSections` lossy on read, closing-line ambiguity (the parser would have eaten the trailing one-liner into `Open threads`), `summary` non-determinism (depended on README health), `unknownSections` keyed-by-string dropping duplicate `## Notes` blocks, design/blueprint field-presence drift, `parseJournalIndex.postamble` drift. Post-code: frontmatter escape decode-order corruption (literal `\\n` got turned into a real newline), stale `index_line` on idempotent no-op (used pre-lock parse), heading whitespace-insensitive match missing, missing forced atomic-write-failure test, two-file partial-commit window with no rollback, `err.cause` not surviving the MCP boundary, the new e2e test not actually driving the failing path through the spawned child.

The cross-cutting MCP-wrapper fix is the highest-leverage one: the wrapper now appends `Caused by [CODE]: message` when `err.cause` is present. Backward-compatible — every prior writer's tests still pass — and lights up structured error chains for every future writer that wants them.

Self-application worked first try: this entry was written by the new `writeJournalEntry` tool, dogfooded from a tiny `/tmp/dogfood-journal.mjs` script.

## What we built

- `compose/lib/journal-writer.js` — `parseJournalEntry`, `parseJournalIndex` (returns `postamble`), `renderJournalEntry` (HR + italic closing-line delimiter), `writeJournalEntry` (advisory-locked global counter, two-file rollback on partial-commit failure with `err.code = 'JOURNAL_PARTIAL_WRITE'` + `err.cause`), `getJournalEntries`. Hand-rolled YAML-ish frontmatter encode/decode with placeholder-based decode order. `_fsHooks` indirection for testable failure injection. Reuses `lib/idempotency.js` and `lib/feature-events.js`.
- `compose/server/compose-mcp-tools.js` + `compose/server/compose-mcp.js` — two new tools registered (`write_journal_entry`, `get_journal_entries`). Cross-cutting wrapper extension: `err.cause` now serialized as `Caused by [CODE]: message` after the existing `Error [CODE]: message` envelope. Every prior MCP tool inherits this for free.
- `compose/test/journal-writer.test.js` — 70 unit tests including frontmatter round-trip with literal backslash, in-lock `index_line` recompute under concurrent insertion, whitespace-insensitive heading match, atomic-write `.tmp` cleanup under forced `renameSync` failure, two-file partial-write rollback (compensating delete on new entry; content restore on force-overwrite), audit not appended on partial-write failure.
- `compose/test/journal-writer-mcp.test.js` — 6 e2e tests over stdio JSON-RPC, including a real failing-path test that spawns a fixture wrapper rather than the production server.
- `compose/test/fixtures/mcp-fail-index-write.mjs` — test fixture that installs an `_fsHooks.renameSync` hook on the child's module instance before importing the MCP server, so the failing path actually runs in the spawned child instead of being faked in the parent.
- `compose/docs/mcp.md` — two new tool rows + "Journal writer" section (frontmatter contract, error codes including `JOURNAL_PARTIAL_WRITE`, in-lock idempotent re-parse).
- `compose/.claude/rules/journaling.md` — fixed the by-date numbering claim to match actual global-monotonic practice; the writer enforces this.
- `docs/features/COMP-MCP-FEATURE-MGMT/design.md` — one-line note in the Journal section pointing here as the canonical contract.
- `compose/CHANGELOG.md` — self-applied entry under `## 2026-05-03` via the sibling `add_changelog_entry` tool.
- `/Users/ruze/reg/my/forge/ROADMAP.md` — `COMP-MCP-JOURNAL-WRITER` row added via `add_roadmap_entry`, flipped to COMPLETE via `set_feature_status`.
- `docs/features/COMP-MCP-JOURNAL-WRITER/{design,blueprint,plan,report}.md` — lifecycle artifacts.

## What we learned

1. **Codex review on planning artifacts keeps paying off.** Three pre-code passes surfaced seven contract-drift issues. The `unknownSections` map-vs-array decision is exactly the kind of thing tests can't catch — both shapes pass tests for single-heading entries; only a duplicate `## Notes` block reveals the data loss, and that case wouldn't have been written until far later.

2. **Cross-cutting MCP wrapper fixes compound.** Session 36 made the wrapper propagate `err.code`. This session made it propagate `err.cause`. Both were one-line additions that any future writer wanting structured error chains gets for free. The pattern: if a writer family needs a typed-error contract, fix the wrapper once at the family level, not once per writer.

3. **The "real boundary" trap in e2e tests.** The first attempt at the `err.cause` propagation test installed the failure hook in the parent process, then spawned the MCP server, then asserted the formatted output. It passed because the test reimplemented the formatter inline. The child had its own module instance and its own `_fsHooks` — the parent patch never reached it. Codex caught this on round 4. The fix was a small fixture file the test spawns as the entry-point: it installs the hook before `await import('../../server/compose-mcp.js')`, so the running server picks up the patched hook. Generalizable: any test that claims to verify cross-process behavior must drive the actual cross-process path, not a same-process facsimile.

4. **Two-file atomic commits need explicit rollback.** Both `writeJournalEntry` and `addChangelogEntry` mutate a content file plus an index file. Sibling writers had this gap too but were never bitten because the index write rarely fails. Codex round 2 made the gap concrete: the new-entry path now compensates by deleting the orphaned entry; the force-overwrite path restores prior content. Rollback failures are appended to the rethrown message and re-emitted as `err.cause` for structured inspection. Audit log is appended only after both writes succeed — so the partial-write retry is also idempotent at the audit level.

## Open threads

- [ ] Three writer sub-tickets remain in the family: `COMP-MCP-FOLLOWUP`, `COMP-MCP-COMPLETION`, `COMP-MCP-VALIDATE`, plus `COMP-MCP-MIGRATION` to retire free-text writers. Parent design has the order.
- [ ] `COMP-MCP-VALIDATE` should warn on (a) journal entries missing canonical four-section structure, (b) journal entries missing frontmatter, (c) duplicate same-label headings inside a single entry. This writer treats them as legal input.
- [ ] The cross-cutting `err.cause` propagation now in the MCP wrapper is opt-in for writers that set `err.cause`. Sibling writers (`addRoadmapEntry`, `linkArtifact`, `addChangelogEntry`) could be retrofitted to set `err.cause` on their own multi-step failures. Low priority; their existing single-step error contract still works.

---

*Five Codex passes catch what one would not.*

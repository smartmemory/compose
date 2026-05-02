# Session 36 — COMP-MCP-CHANGELOG-WRITER

**Date:** 2026-05-03
**Feature:** `COMP-MCP-CHANGELOG-WRITER`

## What happened

Sub-ticket #3 of the writer family. The pattern is now well-established: scaffold, design, blueprint, plan, all gated by Codex review before code; then implement TDD, MCP-wire, e2e test, Codex-review the implementation, dogfood, ship.

The interesting moments were all in review. Three pre-code Codex passes on the design/blueprint/plan caught 8 contract-drift issues — return-shape inconsistency across docs, idempotency semantics split three ways (parent design vs feature design vs blueprint), missing rule for the duplicate `## 2026-05-02` headings that already exist in the live file, `since` semantics that didn't make sense for version surfaces, audit-field naming inconsistency, and missing test coverage on the duplicate path. Fixing all that on paper before writing code took two re-reviews but cost nothing in the codebase.

Then four implementation review iterations. Iteration 1 caught four real issues: the reader was silently dropping `unknownLabels` (so `**New tools:**`, `**Knobs:**`, `**Test results:**` blocks parsed but never reached callers); the subsection regex couldn't tolerate digit-bearing labels like `**Phase 7 review-loop fixes:**` (which exists in the live file); `inserted_at` was looked up by global scan, so the same code on multiple dates would return the wrong line on replace; and idempotent no-ops were appending audit events in violation of design Decision 2. Iteration 2 caught one more: the MCP wrapper was stripping `err.code`, so the `INVALID_INPUT` / `CHANGELOG_FORMAT` typed errors weren't observable. Iteration 3 caught a redundant `CHANGELOG_FORMAT:` prefix in the message body that double-printed once the wrapper started adding the `[CODE]` envelope. Iteration 4 clean.

The MCP wrapper change was the only cross-cutting edit. It now serializes `err.code` as `Error [CODE]: message` when present, falling back to the original shape when absent. Backward-compatible for every existing tool; lights up the typed-error contract for this and future writers.

Self-application worked first try: the new `add_changelog_entry` wrote its own CHANGELOG entry by being called from a tiny `/tmp/dogfood-changelog.mjs` script. Returned `{inserted_at: 101, idempotent: false, surface: '2026-05-02'}`. The entry slotted in correctly under the existing `## 2026-05-02` heading at line 3.

## What we built

- `compose/lib/changelog-writer.js` — `parseChangelog` (single-pass tolerant parser), `renderEntry` (strict canonical renderer, fixed Added → Changed → Fixed → Snapshot order), `addChangelogEntry`, `getChangelogEntries`. Atomic tmp+rename mirroring `lib/sections.js:writeRollup`. Reuses `lib/idempotency.js` and `lib/feature-events.js`.
- `compose/server/compose-mcp.js`, `compose/server/compose-mcp-tools.js` — two new tools registered. Cross-cutting MCP error wrapper extended to surface `err.code` as `Error [CODE]: message`.
- `compose/test/changelog-writer.test.js` — 38 unit tests including parser round-trip on the real `compose/CHANGELOG.md`, duplicate-surface coverage, force replace targeting first surface, same code on multiple dates, idempotent no-op skipping audit, typed-error assertions, mixed date+version `since` filter.
- `compose/test/changelog-writer-mcp.test.js` — 3 end-to-end tests over stdio JSON-RPC.
- `compose/docs/mcp.md` — two new tool rows + "Changelog writer" section.
- `compose/CHANGELOG.md` — self-applied entry under `## 2026-05-02` (line 101).
- `/Users/ruze/reg/my/forge/ROADMAP.md` — `COMP-MCP-CHANGELOG-WRITER` row added, COMPLETE.
- `docs/features/COMP-MCP-CHANGELOG-WRITER/{design,blueprint,plan,report}.md` — lifecycle artifacts.

## What we learned

1. **Codex review on planning artifacts catches contract drift the way Codex review on code catches semantics drift.** Three pre-code review passes on this feature surfaced 8 issues — every one of them would have been more expensive caught against tests. Two of the issues (idempotency split, duplicate-surface ambiguity) would have produced code that *looked* correct, passed its tests, and silently corrupted state when the live file's edge cases were exercised.

2. **The MCP wrapper had a latent bug for the entire writer family.** It collapsed `err.message` and dropped `err.code` for every tool, but no prior writer had typed errors so it never mattered. This feature lit it up. The fix is a one-line change to a single error-handling branch — backward-compatible, no migration — and now every future tool that wants typed errors gets them for free.

3. **Reuse compounds, but tests still need their own legwork.** The writer module is ~580 lines but the test file is ~600. The framework reuse (idempotency, events, atomic write, validation) means the *new* logic to test is small, but the *interactions with file shape* (duplicate surfaces, digit-bearing labels, mixed date/version surfaces, code-on-multiple-dates) needed bespoke coverage. Codex caught two test-coverage gaps that the human + the plan had both missed.

## Open threads

- [ ] Five writer sub-tickets remain in the family: `JOURNAL-WRITER`, `FOLLOWUP`, `COMPLETION`, `VALIDATE`, `MIGRATION`. The parent design has the order.
- [ ] `COMP-MCP-VALIDATE` (later sub-ticket) should lint duplicate same-label surfaces and warn — this writer treats them as legal input but they're a smell.
- [ ] Now that the MCP wrapper passes `err.code` through, prior writers (`addRoadmapEntry`, `linkArtifact`, etc.) could be retrofitted to throw typed errors too. Low priority; their existing string-message contract still works.

A typed writer with a typed error path beats a careful agent every time.

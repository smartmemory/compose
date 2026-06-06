---
date: 2026-06-06
session_number: 60
slug: validate-escaped-pipe-fix
summary: "COMP-MCP-VALIDATE-4: fix validator escaped-pipe column-parse false positives — shared splitRoadmapCells across all row-parse sites"
feature_code: COMP-MCP-VALIDATE-4
closing_line: The fixer's first real catch was a bug in the detector it mends.
---

# Session 60 — COMP-MCP-VALIDATE-4

**Date:** 2026-06-06
**Feature:** `COMP-MCP-VALIDATE-4`

## What happened

Dogfooding the freshly-shipped COMP-MCP-VALIDATE-2 `validate --fix` against the live repo, the opt-in roadmap_status_rewrite dry-run surfaced 3 rows it wanted to 'fix' — but the before-values were garbage prose (`--REVISE\`, `"BLOCK"\`). Our reconciler correctly refused them, and the human asked us to file and fix the underlying bug. Root cause: the cross-artifact validator splits ROADMAP table rows with `split('|')`, which also splits on escaped `\|` (the markdown escape for a literal pipe inside a cell). A description containing `\|` adds a phantom column, shifting status-column detection so the validator reads description prose as the row's status — producing false STATUS_MISMATCH / ROADMAP_ROW_SCHEMA_VIOLATION warnings even though the row visually agreed with feature.json. The canonical `lib/roadmap-parser.js` already handled this (split on unescaped pipes only); the read validator and write-guard didn't. We promoted the correct splitter to a shared exported helper and used it everywhere.

## What we built

New exported `splitRoadmapCells(rawLine)` in `lib/roadmap-parser.js` (split on `/(?<!\\)\|/`, slice off the outer empties, unescape `\| → |`) — promoted from the parser's existing inline logic and reused by it. Applied at the two buggy parse sites: `lib/feature-validator.js` (column parse) and `lib/feature-write-guard.js` (`scanRoadmapRows`). New `test/validate-escaped-pipe.test.js` (4 tests: splitter unit, no-false-positive, real-mismatch-still-detected, code-still-found). Fix doc in `docs/features/COMP-MCP-VALIDATE-4/design.md`.

## What we learned

1. **Dogfooding a new tool against real data is where the next bug hides.** COMP-MCP-VALIDATE-2 didn't introduce this parser bug — it *revealed* a long-standing validator false-positive by trying to act on it, and its safety guards (refuse escaped-pipe rows, skip non-status tokens) meant it surfaced the issue without corrupting anything. 2. **One correct implementation, three copies.** The escaped-pipe-aware split already existed in roadmap-parser.js; the bug was that two other parse sites reimplemented the naive version. The fix is consolidation, not invention — export the canonical helper and delete the divergent copies. 3. **Byte-identical-for-the-common-case is the safety property.** For pipe-free rows the new helper produces exactly the old cells, so the change is provably inert except on the rows that were broken.

## Open threads

- [ ] The 3 live rows (COMP-PARITY-1, COMP-CAPS-ENFORCE-4, COMP-ROADMAP-RT-GENFIX) no longer false-flag; their descriptions still carry `\|` legitimately — no action needed.
- [ ] Consider auditing for any other naive `split('|')` row parsers that should use `splitRoadmapCells` (ideabox.js was flagged but reads a different table shape).

---

*The fixer's first real catch was a bug in the detector it mends.*

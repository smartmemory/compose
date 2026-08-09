---
date: 2026-08-09
session_number: 103
slug: roadmap-prose-loss-guard
summary: roadmap generate stops silently eating hand-authored prose; four review rounds taught us to identify generator-owned content by identity, not shape.
feature_code: COMP-CONFLICT-MERGE
closing_line: The tool that swore it was lossless learned to read the one column it had been ignoring, and to admit when it could not.
---

# Session 103 — COMP-CONFLICT-MERGE

**Date:** 2026-08-09
**Feature:** `COMP-CONFLICT-MERGE`

## What happened

Second feature of the session (after COMP-JUDGMENT-PRECEDENT). `compose roadmap generate` renders feature rows from feature.json and preserves curated content through a six-reader whitelist. Anything matching none of the six was dropped, and the roundtrip check only compares ROWS — so it could print 'lossless: true' over a file that just lost a curated block. We built a residue check: compare the base against the FINAL canonical bytes (after all generation passes, because the duplicate-heading loss only shows up on a later pass) and refuse the write if hand-authored lines would disappear.

The design was already gated and narrow (two verified loss paths), but the residue CLASSIFIER — deciding which base lines are hand-authored vs generator-owned — took four Codex rounds to get right. Each round found a real defect: r1 flagged six (configured features dir, duplicate marker ids, curated-table headers, drift emission, the typed error, heading occurrence); r2 caught the Key Documents section reading generator churn as loss; r3 caught the shape heuristic over-matching any row ending in 'design' and the occurrence matcher flagging the surviving duplicate instead of the lost one; r4 proved the shape heuristic was fundamentally ambiguous and forced the real fix. Along the way an Edit wrote a literal NUL byte as the multiset key delimiter, which silently broke grep across the whole file until we spotted it.

## What we built

- `lib/roadmap-residue.js` (new) — computeResidue (occurrence-aware multiset keyed by (block, line text); excludes feature rows, structural lines, feature-table headers, surviving-phase headings, and identity-verified Key Documents rows) and protectResidue (wraps lost runs in preserved-section markers with collision-safe, file-deduped ids).
- `lib/roadmap-errors.js` (new) — RoadmapProseLossError, RoadmapUnbalancedMarkerError, RoadmapDuplicateMarkerError.
- `lib/roadmap-preservers.js` — readPreservedSections strict mode raises on unbalanced/duplicate markers on the CLI write path; default (drop) unchanged.
- `bin/compose.js` — generate restructured to fixed-point-then-diff-then-write, with three outcomes (halt / --accept-loss / --protect), configured features dir, one-shot drift emission.
- test/roadmap-residue.test.js (25 tests) + strict-marker tests, incl. a live-ROADMAP residue-clean guard.

## What we learned

1. **Identity beats shape for 'who owns this content'.** buildKeyDocs emits `| `path` | CODE design |`; a curated row can be byte-identical. Excluding by shape either silently drops a curated look-alike (r4 P1) or false-flags a stale generated row when a designDoc changes (r2 P1). The only correct signal is the actual feature set: a Key Documents row is the generator's iff its code is a current feature. When you find yourself writing a regex to guess provenance, reach for the real identity instead.
2. **When duplicates collapse, flag the FIRST, not the last.** readPhaseBlocks keeps the LAST occurrence, so occurrence matching that consumes base copies in order flags the survivor and makes --protect wrap the wrong line. Match the flagging order to the loss mechanism.
3. **A silent loss is worse than a false positive** — that ranking decided every ambiguous call, and is the whole reason the feature exists.
4. **A literal NUL byte from an Edit is invisible until grep goes quiet.** The keyOf delimiter was fine at runtime but killed search across the file; write the escape text, not the raw control character.
5. **Name the scope you did NOT cover.** The MCP provider render paths bypass the CLI; saying so plainly is the same discipline as the row-level 'lossless' message this feature exists to fix.

## Open threads

- [ ] Move the residue guard into the MCP provider render paths (local-provider.js, github-provider.js) and make persist+render atomic — the larger, separate piece this feature deliberately left out.
- [ ] The build-stream / active-build last-writer-wins race (same stance, different writer) still wants concurrency primitives first.
- [ ] `roadmap check` could grow a prose-residue verdict so drift is visible without running generate (design open question, leaning yes).

---

*The tool that swore it was lossless learned to read the one column it had been ignoring, and to admit when it could not.*

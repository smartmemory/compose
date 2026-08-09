---
date: 2026-08-09
session_number: 104
slug: prov-o-artifact-lineage
summary: "COMP-PROV-LINEAGE: W3C PROV-O artifact lineage (vocabulary only), reachability query for staleness, two Codex rounds"
feature_code: COMP-PROV-LINEAGE
closing_line: Borrow the standard's words, not its machinery — and never trust a marker nothing writes.
---

# Session 104 — COMP-PROV-LINEAGE

**Date:** 2026-08-09
**Feature:** `COMP-PROV-LINEAGE`

## What happened

Picked up COMP-PROV-LINEAGE off a clean-tree resume — the smallest remaining sibling of the Semantica teardown. The plan already existed and its first acceptance criterion was a hard gate: read the W3C PROV-O spec and record the term mapping before touching any schema. We did, and the mapping surfaced the one real design fork: Compose never registers its canonical artifacts (design.md, plan.md, ...) anywhere — they're auto-discovered on disk — so there was literally no record to hang a 'derived from' edge on. The user chose embedded HTML-comment markers over a feature.json block, reusing the exact <!-- phase: --> convention lib/staleness.js already reads.

Digging into that convention turned up the load-bearing discovery: the existing phase-marker staleness path is dead. staleness.js READS <!-- phase: --> markers, but nothing in production ever WRITES them — only test fixtures do. That reframed the whole feature: don't add another marker nobody writes. So the reachability query (findStaleDescendants) was built to work off a canonical derivation chain by default (mirrored from lifecycle-modes, drift-guarded), with markers only as an override — it works on any feature folder today, stamped or not.

Two Codex review rounds (gpt-5.6-sol/high) earned their keep. Round 1 caught a genuine self-inflicted bug: stamping rewrote artifacts and reset their mtimes — the very clock staleness depends on — so a retrofit stamp would erase the staleness it was meant to reveal. Fixed by preserving mtime across the write (a metadata annotation must not tick the derivation clock). It also flagged a path-traversal hole in --feature. Round 2 (reviewing the fixes) correctly caught that the build wiring runs once at finalization, not per-step as the changelog claimed, and that --changed was still an unvalidated path join. Both fixed.

## What we built

- docs/features/COMP-PROV-LINEAGE/prov-o-mapping.md (new): the PROV-O term mapping written before schema work; Entity=artifact, Activity=phase, wasGeneratedBy/wasDerivedFrom edges; records the embedded-marker storage decision and what's deferred (wasAttributedTo/Agent).
- lib/lineage.js (new): CANONICAL_CHAIN (mirrors lifecycle-modes build mode), extractLineageMarkers (line-anchored), canonicalLineageOf, lineageOf (marker overrides canonical), buildDerivationGraph, findStaleDescendants (the reachability query — descendant mtime older than the changed ancestor = stale), stampLineageContent (pure) + stampFeatureLineage (on-disk, mtime-preserving, idempotent).
- bin/compose.js: `compose lineage {stamp,stale,show}`; --feature validated via isFeatureCode, --changed constrained to a bare filename.
- lib/build.js: stampFeatureLineage runs once per build in the finalization pass (build is the single writer there).
- test/lineage.test.js (new): 37 tests incl. the acceptance case (editing design.md marks blueprint.md and plan.md stale), drift guard as an in-order subsequence of phaseOrder, marker anchoring, empty-marker idempotency, traversal rejection, no-RDF import guard.
- CHANGELOG.md + plan.md updated in-step. Shipped 9ec1a59, COMPLETE at 5edc0de.

## What we learned

1. A marker convention with a reader but no writer is a dead path dressed as a feature — grep for who WRITES before you trust that a signal is live. staleness.js had read <!-- phase: --> markers for a whole feature with nothing ever producing them.
2. Make the query work without the write. findStaleDescendants falls back to the canonical chain, so it delivers value on day one regardless of whether stamping ever ran — the markers are an override, not a precondition. That's how you avoid shipping a third thing that depends on a second thing nobody does.
3. Stamping is annotation, not regeneration — it must not reset the mtime that staleness reads, or the tool erases the very state it reports. Codex round 1 caught this; the fix (capture/write/restore mtime) is one of those bugs that only bites in the retrofit case the happy-path test masked.
4. Round 2 reviews the FIXES, not the feature: it caught that round 1's build wiring was post-loop, not per-step, and that the changelog overclaimed. The lesson (already in memory) held: r1 fixes introduce their own findings.
5. Borrow the vocabulary, not the stack. PROV-O gave correct names (wasDerivedFrom, Entity->Activity direction) for free; adopting the RDF runtime would have cost far more than the naming was worth. Out-of-scope declared explicitly in the mapping doc.

## Open threads

- [ ] Non-canonical registered artifacts (feature.json artifacts[]) are not yet in the derivation graph — only the fixed canonical chain is. Fine for now; revisit if lineage needs to span journal/snapshot pointers.
- [ ] The read/write/utimes in stampFeatureLineage is uncontended only because build is the single writer at finalization; if lineage ever gets stamped from a concurrent surface, it needs a lock.
- [ ] A JSON-LD export was kept possible (edges are standard) but not built — the point of choosing PROV-O names now.

---

*Borrow the standard's words, not its machinery — and never trust a marker nothing writes.*

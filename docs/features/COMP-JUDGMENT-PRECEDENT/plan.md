# COMP-JUDGMENT-PRECEDENT — Precedent search over judgment records

**Status:** PLANNED | **Complexity:** L | **Impact:** high
**Promoted from:** IDEA-29 | **Source:** Semantica teardown (semantica-agi/semantica), 2026-08-08
**Depends on:** COMP-JUDGMENT-BITEMPORAL

## Related Documents

- Ideabox origin: `docs/product/ideabox.md` (IDEA-29)
- Depends on: `docs/features/COMP-JUDGMENT-BITEMPORAL/plan.md`
- Builds on: `docs/features/COMP-JUDGMENT-STORES/`, `docs/features/COMP-JUDGMENT-WRITER/`

## Problem

The judgment layer is strong on the write side — positions, amendments, ledger,
goal/situation/person stores all shipped — and has no retrieval surface.

**Judgment records nobody reads are pure cost.** The point of recording a
decision is that the *next* similar decision retrieves it unprompted.

## Approach — two slices

### Slice A — Decision chain trace (unblocked, mechanical)

Walk the ledger to reconstruct the causal ancestry of a position: what it
superseded, what evidence it cited, which situation it answered. No embeddings,
no external dependency. **Worth shipping standalone even if Slice B never lands.**

### Slice B — Semantic precedent search (BLOCKED)

Similarity over position statements, surfacing prior comparable calls when a new
one is being made. Natural bridge to the SmartMemory coupling.

> **BLOCKED:** SmartMemory recall currently drops 19 of 20 on live-fire and the
> root cause is unsolved (`project_livefire_recall_broken`). Do not build Slice B
> on that surface until it is root-caused. Building on a broken recall layer
> would produce a feature that silently returns nothing.

## Why the dependency on BITEMPORAL

A precedent is only useful if you can see what was believed **at the time it was
decided**, not what is believed now. Without valid/transaction time, retrieved
precedent is silently misleading — it shows a past decision annotated with
present beliefs.

## Acceptance Criteria

### Slice A
- [ ] `trace` read op returning the causal chain for a position ID
- [ ] Chain includes supersessions, cited evidence, and originating situation
- [ ] Renders in CLI and cockpit
- [ ] Golden flow: record → amend → trace → assert full ancestry with both
      pre- and post-amendment beliefs visible

### Slice B (gated on SmartMemory root-cause)
- [ ] Similarity retrieval over position statements
- [ ] Results carry as-of-decision belief state, not current
- [ ] Recall measured against a fixture corpus before wiring into any prompt

## Open Questions

- [ ] Does precedent surface automatically at a decision point, or on request?
- [ ] Slice B fallback if SmartMemory stays unreliable — local embedding index?

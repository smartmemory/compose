# <Feature Name>: Design


## Why

Surfaced by COMP-MODEL-ROUTE-1 (see the surfaced_by link); filed as a flat sibling rather than COMP-MODEL-ROUTE-1-1 per the flat-feature-codes convention, since lineage belongs in the link, not the code.

The ledger is the training input for learned model routing, so this is a data-integrity problem before it is an accounting one.

Every Claude dispatch passing an explicit allowedTools between stratum 603ec78 and f250d9e inlined every configured MCP tool schema on the post-connect turn: 511,214 cache-creation tokens for a one-line echo, about $3.26 per trivial turn on sonnet-5. Those costs are recorded as if they were real properties of the dispatch.

The error is not random noise. It lands only on dispatches that passed an explicit tool list, which makes it structurally biased by provider and template rather than spread evenly. CORRECTED after adversarial review (2026-09-17): the original wording claimed it was "perfectly correlated with provider and step kind", which is overstated — no row-level correlation analysis has been done, and the supporting evidence is that some templates carry explicit lists and others do not (`server/agent-templates.js:12-35`: reviewer, researcher, orchestrator and security-auditor have explicit lists; implementer does not). The bias is plausible and worth correcting for; its exact shape is exactly what this feature must measure rather than assume. That is the worst possible shape for a learner: COMP-MODEL-ROUTE resolves tiers from receipts joined with downstream acceptance, so a router trained on this window would confidently conclude "Claude is expensive on these steps" when the truth is "we had a bug there". Averaging will not wash it out.

Approach, not yet decided: the ledger is append-only by design and feedback_recompute_beats_stored_state applies, so prefer marking the affected range and having consumers exclude it over rewriting rows and breaking anything that hashes over them. Exclusion is likely more honest than correction, because the inflation scales with the host's MCP roster size, which varied by machine and by day and is not recoverable per row.

Bounded by the window 603ec78..f250d9e. CORRECTED after review: the affected-row predicate is NOT simply "Claude dispatches with a non-empty allowedTools". That is wrong three ways — a list already containing `ToolSearch` was never affected, an EMPTY list also entered the old connector's explicit-list branch, and inflation only manifests where MCP servers were configured AND the turn was a continuation after they connected. Deriving the correct predicate is part of the work, not an input to it. Doing it also yields a measured before/after in dollars for what the defect actually cost.

Surfaced 2026-09-17 while completing COMP-MODEL-ROUTE-1; deliberately left unfiled at the time pending an owner decision, now filed at the owner's instruction.

**Status:** DESIGN
**Date:** <date>

## Related Documents

<!-- Link to roadmap, dependencies, and related features -->

---

## Problem

<!-- Describe the problem this feature solves -->

## Goal

<!-- What does success look like? Scope and non-scope. -->

---

## Decision 1: <Title>

<!-- Describe the decision, options considered, and rationale -->

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| | | |

## Open Questions

<!-- List unresolved questions -->

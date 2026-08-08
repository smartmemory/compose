# COMP-PROV-LINEAGE — W3C PROV-O as the artifact-lineage vocabulary

**Status:** PLANNED | **Complexity:** S | **Impact:** low
**Promoted from:** IDEA-30 | **Source:** Semantica teardown (semantica-agi/semantica), 2026-08-08

## Related Documents

- Ideabox origin: `docs/product/ideabox.md` (IDEA-30)
- General form of: IDEA-21 (staleness-track multi-slice blueprints)
- Serves the parked `idea_artifact_lineage` concept

## Problem

Compose artifacts form a derivation chain — design.md produces blueprint.md
produces plan.md produces the implementation — but nothing records it. When an
upstream artifact changes, downstream artifacts go stale silently.

The instinct is to invent a `_sources` field. **That is a solved standards
problem**, and inventing a schema for it costs more than reading the spec.

## Approach

Adopt the **W3C PROV-O vocabulary**, not the RDF stack.

PROV-O's Entity / Activity / Agent triad plus `wasDerivedFrom`,
`wasGeneratedBy`, and `used` already expresses "this artifact came from those
artifacts, via that lifecycle phase, run by that agent." Name the fields after
PROV-O terms inside existing artifact records so that:

- staleness becomes a standard graph-reachability query rather than bespoke logic
- an RDF/JSON-LD export stays possible later without a rename
- the concepts are correct from day one

**Explicitly out of scope:** adopting a triple store, SPARQL, or any RDF runtime.
This is a naming and modelling decision.

## Acceptance Criteria

- [ ] Read the PROV-O spec and record the term mapping in this feature folder
      before any schema work
- [ ] PROV-O-named lineage fields on the artifact record shape
- [ ] Lifecycle writers populate `wasGeneratedBy` (phase) and `wasDerivedFrom`
      (upstream artifacts)
- [ ] Reachability query: given a changed artifact, list downstream stale ones
- [ ] Test: editing design.md marks blueprint.md and plan.md stale
- [ ] No RDF runtime dependency added

## Why this is P2

Nothing is blocked on it, and the artifact-lineage feature it serves has not
started. Promoting the vocabulary decision now would be building naming for a
feature that does not exist. It sits here so that when that work wakes up, the
first step is "read the spec" rather than "invent a schema."

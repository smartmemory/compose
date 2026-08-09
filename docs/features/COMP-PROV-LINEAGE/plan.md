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

- [x] Read the PROV-O spec and record the term mapping in this feature folder
      before any schema work — `prov-o-mapping.md`
- [x] PROV-O-named lineage fields on the artifact record shape — embedded
      `<!-- wasGeneratedBy -->` / `<!-- wasDerivedFrom -->` markers (`lib/lineage.js`)
- [x] Lifecycle writers populate `wasGeneratedBy` (phase) and `wasDerivedFrom`
      (upstream artifacts) — `stampFeatureLineage` runs once per build in the
      finalization pass (`lib/build.js`, after the dispatch loop) and via
      `compose lineage stamp`
- [x] Reachability query: given a changed artifact, list downstream stale ones
      — `findStaleDescendants` / `compose lineage stale --changed <file>`
- [x] Test: editing design.md marks blueprint.md and plan.md stale — `test/lineage.test.js`
- [x] No RDF runtime dependency added

## Implementation notes (2026-08-09)

Storage decision: **embedded markers, not a feature.json block** — canonical
artifacts (design.md, plan.md, …) are auto-discovered and never registered, so
markers keep that invariant intact and reuse the `<!-- phase: -->` convention
`lib/staleness.js` already reads. The reachability query does not require
stamping: it falls back to `CANONICAL_CHAIN` (mirrored from `lib/lifecycle-modes.js`,
drift-guarded by a test), so it works on any feature folder today; markers only
override the default derivation. Staleness = a descendant's mtime is older than
the changed ancestor's. CLI surface: `compose lineage {stamp,stale,show}`.

Two Codex review rounds (gpt-5.6-sol/high, 2026-08-09) hardened it before ship.
Round 1: stamping now **preserves mtime** (a metadata annotation must not reset
the derivation clock and erase existing staleness); the CLI validates `--feature`
against the strict feature-code regex (no path traversal); marker regexes are
**line-anchored** (a marker in prose/backticks is not authoritative); an empty
`wasDerivedFrom` marker is treated as absent (idempotency); the drift guard now
asserts every chain phase is an in-order subsequence of `phaseOrder`; and the
"lifecycle writers populate" AC is met by wiring `stampFeatureLineage` into the
build finalization pass, not just the manual command. Round 2 (reviewing the
fixes): `--changed` is now validated as a bare filename and marker parents with
a path separator are dropped at parse time (closing the last traversal vector);
the build-wiring comment/changelog were corrected to say "once per build in the
finalization pass" (not per-step); and the read/write/utimes in stamping is
uncontended because build is the single writer at that point (accepted, not
locked, for this single-writer context).

Post-ship follow-up (same day): the build's `doc_freshness` health signal was
consuming the phase-based `checkStaleness`, which reads a `<!-- phase: -->`
marker that no production code writes — so the signal always scored 100/fresh.
Added `findStaleArtifacts` (the global, changed-file-free form of the
reachability query) and pointed the build signal at it, so the freshness score
now reflects real derivation staleness. `staleness.js` remains only for the
gate-context warning in `step-prompt.js` — swapping that surface (which changes
agent-facing gate messaging and its tests) is a deliberate separate step, not
done here.

## Why this is P2

Nothing is blocked on it, and the artifact-lineage feature it serves has not
started. Promoting the vocabulary decision now would be building naming for a
feature that does not exist. It sits here so that when that work wakes up, the
first step is "read the spec" rather than "invent a schema."

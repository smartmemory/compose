# COMP-CONFLICT-MERGE — Conflict-first merge instead of last-writer-wins

**Status:** PLANNED | **Complexity:** S | **Impact:** medium
**Promoted from:** IDEA-27 | **Source:** Semantica teardown 2026-08-08, re-grounded 2026-08-08

> **SUPERSEDED IN PART (2026-08-08).** This plan was written at promotion time,
> before anyone read the roadmap writer. Two of its premises are false:
> the "field ownership" model does not fit a text document, and general prose
> loss **does not occur** (`spliceTableIntoBlock` preserves typed-phase prose;
> `test/roadmap-roundtrip.test.js:83` asserts it). The feature narrowed to two
> verified loss paths and a CLI-scoped guarantee.
>
> **[design.md](design.md) is the authority.** Read it first; treat the
> acceptance criteria below as superseded where the two disagree.

## Related Documents

- Ideabox origin: `docs/product/ideabox.md` (IDEA-27)
- Sibling (prevents the race rather than the silent merge): Umbrella B concurrency ideas IDEA-11 / IDEA-14
- Pairs with: IDEA-2 (typed error schema) — a conflict is a typed error

## Problem

Compose has at least two writers that resolve a collision by keeping whichever
wrote last, with no signal that anything was lost:

1. **Roadmap generation clobbers hand-authored prose.** Known and previously
   bitten (`reference_roadmap_generate_clobbers_prose`).
2. **Shared build-stream / active-build last-writer-wins** during batch builds
   (`project_compose_idempotency_gaps`).

A merge that cannot detect contradiction is a merge that loses data quietly.
The concurrency work (IDEA-11/14) prevents the *race*; it does not make the
merge itself honest when two legitimate sources genuinely disagree.

## Approach

Before a write supersedes an existing record, diff the incoming value against
the stored one **on the fields the writer does not own**. If they differ, emit a
typed conflict and halt rather than overwrite.

Field ownership is the load-bearing concept: a generator owns generated columns
and must never silently replace fields a human authored.

## Acceptance Criteria

- [ ] Field-ownership declaration for the roadmap writer: which fields are
      generator-owned vs. author-owned
- [ ] Pre-write contradiction check comparing incoming vs. stored values on
      author-owned fields
- [ ] Typed `MergeConflict` error carrying `field_path`, `stored`, `incoming`,
      `source_of_truth`, and a remediation string
- [ ] Writer halts on conflict — no partial write, no overwrite
- [ ] Operator path to resolve: accept-incoming / keep-stored / abort
- [ ] Regression test: hand-edited prose survives a `roadmap generate` that
      would previously have clobbered it
- [ ] Regression test: conflicting writes to the same record raise rather than
      silently resolving

## Scope

**In (slice 1):** the roadmap / prose writer. Single-threaded, needs none of the
Umbrella B concurrency primitives, and covers the failure that has already bitten.

**Out (slice 2+, not this feature):** build-stream and active-build writers —
those want the concurrency primitives landed first.

## Open Questions

- [ ] Is field ownership declared per-writer, or derived from the record schema?
- [ ] Does an unresolved conflict block the whole generate run, or quarantine the
      one record and continue?

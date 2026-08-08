# COMP-JUDGMENT-BITEMPORAL — Bi-temporal judgment records

**Status:** PLANNED | **Complexity:** M | **Impact:** medium
**Promoted from:** IDEA-28 | **Source:** Semantica teardown (semantica-agi/semantica), 2026-08-08

## Related Documents

- Ideabox origin: `docs/product/ideabox.md` (IDEA-28)
- Builds on: `docs/features/COMP-JUDGMENT-STORES/`, `docs/features/COMP-JUDGMENT-WRITER/`
- Enables: `docs/features/COMP-JUDGMENT-PRECEDENT/plan.md`
- Sibling shape: IDEA-6 (append-only decisions log with supersession-by-ID)

## Problem

Amending a judgment position overwrites the belief. The ledger is the only
history, so answering "what did we believe when we made that call?" means
replaying the ledger rather than querying.

Two distinct questions are collapsed into one timestamp:

- **Valid time** — when the belief was true of the world
- **Transaction time** — when the system recorded it

## Approach

Stamp both times on judgment records (positions, goals, situations). An
amendment closes the prior row's valid interval and opens a new one instead of
mutating in place, which makes amendment non-destructive by construction and
turns point-in-time reconstruction into a range query.

**Timing rationale:** the judgment store schema is young. Two columns are near
free now; the cost rises with every record written. `COMP-MIGRATE-ON-UPGRADE`
means a later migration is a solved path rather than a wall — so the window
narrows but does not close. That is why this is P1 and not P0.

## Acceptance Criteria

- [ ] `valid_from` / `valid_to` and `recorded_at` on judgment record schema
- [ ] Amendment closes the prior interval and appends rather than mutating
- [ ] `as_of(timestamp)` read path returning the record set as believed then
- [ ] Current-state read path unchanged for existing callers (no break)
- [ ] Migration for existing records: back-fill `recorded_at` from ledger,
      open-ended `valid_from`
- [ ] Contract test: amend a position, then assert both the current belief and
      the pre-amendment belief are retrievable
- [ ] Contract test: migrated legacy records round-trip

## Open Questions

- [ ] Do goals and situations need both axes, or only positions?
- [ ] Is valid time ever set to a past date by hand, or always "now"?

# COMP-PRICING — SUPERSEDED 2026-09-12

**Superseded by [COMP-COST-OWNER](../COMP-COST-OWNER/design.md)** on the day it was filed.

Filed as "three hand-maintained price tables should be one." Tracing the value from where it
is set to where it is read proved that pricing is the small part and nearly solved, while the
real defect is that **nothing owns the cost number**: one measurement fans out to five
independent running totals and the history record is short $0.0367685 and 218,629 tokens
against a ledger and accumulator that agree to the cent.

The full design, every correction made to it, and the measured evidence moved to
`docs/features/COMP-COST-OWNER/`. Nothing here was deleted — see that document's amendment
history for what changed and why.

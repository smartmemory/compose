# COMP-FABLE-CALIBRATE — KILLED 2026-09-11

**Reason: superseded by COMP-MODEL-ROUTE.**

CALIBRATE was filed 2026-09-09 out of a question on COMP-FABLE-ASTRA: Fable assigns a tier
per task from its own judgment, so close the loop by comparing each task's planned tier
against its receipt and feeding a calibration table back into the planning prompt.

COMP-MODEL-ROUTE (filed 2026-09-11) subsumes that loop as a strict subset:

| CALIBRATE | Where it lives now |
|---|---|
| receipt ↔ planned-tier join | COMP-MODEL-ROUTE slice S1b (receipt joins, acceptance labels, append-only ledger) |
| calibration table into Fable's planning prompt | COMP-MODEL-ROUTE slice S2, gated behind `calibration_feedback` (default off) |
| E3 complexity-triage shape | unchanged; still the reference shape, now for the S2 report |

Killing rather than merging: CALIBRATE never started (no design, no blueprint, no code), and its
whole surface is one gated path inside a feature that already has a reviewed design. Two rows for
one deliverable is the drift COMP-ROADMAP exists to prevent.

Nothing is lost by this kill. If the S2 `calibration_feedback` path is ever dropped from
COMP-MODEL-ROUTE, re-file CALIBRATE rather than reviving this folder.

Lifecycle: killed via the guarded path (`explore_design` → `killed`) on 2026-09-11; the reason is
also in the tamper-evident guard ledger and `.compose/data/vision-state.json`.

Related: [design.md](../COMP-MODEL-ROUTE/design.md) (Decisions 5 and 6, slices S1b/S2),
[progress.md](../COMP-MODEL-ROUTE/progress.md).

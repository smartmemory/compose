# COMP-LIFECYCLE-BRIDGE-1: Two lifecycle state planes disagree, so a host cannot discover or control its own running build: COMP-HOST-PORTABILITY-1 host B saw the Compose tracker return count:0 gates and 'Item not found: HOSTB-HELLO' during a LIVE design_gate, while Stratum flow poll and audit exposed the real active flow (SD06). Process-local workspace selection succeeded without making session binding usable. An outer driver can connect both MCP servers and still not rely on Compose to find its own CLI lifecycle. This is SD06 plus the loud bind, reconciliation and recovery failures, and is NOT a claim that every tracker tool fails. Establish one source of truth, or a run-ID bridge, across tracker, flow, session and active-build state. Sized M and BLOCKS reliable host control. Gap G4.

**Status:** PLANNED
**Created:** 2026-09-17

---

## Intent

Two lifecycle state planes disagree, so a host cannot discover or control its own running build: COMP-HOST-PORTABILITY-1 host B saw the Compose tracker return count:0 gates and 'Item not found: HOSTB-HELLO' during a LIVE design_gate, while Stratum flow poll and audit exposed the real active flow (SD06). Process-local workspace selection succeeded without making session binding usable. An outer driver can connect both MCP servers and still not rely on Compose to find its own CLI lifecycle. This is SD06 plus the loud bind, reconciliation and recovery failures, and is NOT a claim that every tracker tool fails. Establish one source of truth, or a run-ID bridge, across tracker, flow, session and active-build state. Sized M and BLOCKS reliable host control. Gap G4.

---

## Notes

_This is a seed design doc created by `compose feature`. The `compose build` pipeline will expand it into a full design, blueprint, and implementation plan._

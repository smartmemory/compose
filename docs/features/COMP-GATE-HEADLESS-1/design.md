# COMP-GATE-HEADLESS-1: A gate delegated to the web UI has no headless resolution path and no application timeout: COMP-HOST-PORTABILITY-1 host C waited after 'Gate delegated to web UI. Waiting for resolution...' until an operator killed it, while gate queries returned 'HTTP 400: Unknown workspaceId: proj' because that server could not resolve the scratch workspace ('forever' means no built-in termination was observed, not an infinite-duration measurement). Host B resolved the same gate externally through Stratum, after which the foreground Compose runner tried to resolve an already-resolved gate and failed loudly. Every headless or external gate client is affected. Needs stable workspace, run and gate IDs, an explicit headless resolution path, a single wake-and-reconcile step, and a visible failure when the UI is unavailable instead of an unbounded wait. Sized M and BLOCKS. Gap G1.

**Status:** PLANNED
**Created:** 2026-09-17

---

## Intent

A gate delegated to the web UI has no headless resolution path and no application timeout: COMP-HOST-PORTABILITY-1 host C waited after 'Gate delegated to web UI. Waiting for resolution...' until an operator killed it, while gate queries returned 'HTTP 400: Unknown workspaceId: proj' because that server could not resolve the scratch workspace ('forever' means no built-in termination was observed, not an infinite-duration measurement). Host B resolved the same gate externally through Stratum, after which the foreground Compose runner tried to resolve an already-resolved gate and failed loudly. Every headless or external gate client is affected. Needs stable workspace, run and gate IDs, an explicit headless resolution path, a single wake-and-reconcile step, and a visible failure when the UI is unavailable instead of an unbounded wait. Sized M and BLOCKS. Gap G1.

---

## Notes

_This is a seed design doc created by `compose feature`. The `compose build` pipeline will expand it into a full design, blueprint, and implementation plan._

# COMP-GATE-HEADLESS-1: A gate delegated to the web UI has no headless resolution path and no application timeout: COMP-HOST-PORTABILITY-1 host C waited after 'Gate delegated to web UI. Waiting for resolution...' until an operator killed it, while gate queries returned 'HTTP 400: Unknown workspaceId: proj' because that server could not resolve the scratch workspace ('forever' means no built-in termination was observed, not an infinite-duration measurement). Host B resolved the same gate externally through Stratum, after which the foreground Compose runner tried to resolve an already-resolved gate and failed loudly. Every headless or external gate client is affected. Needs stable workspace, run and gate IDs, an explicit headless resolution path, a single wake-and-reconcile step, and a visible failure when the UI is unavailable instead of an unbounded wait. Sized M and BLOCKS. Gap G1.

**Status:** PLANNED
**Created:** 2026-09-17

---

## Intent

A gate delegated to the web UI has no headless resolution path and no application timeout: COMP-HOST-PORTABILITY-1 host C waited after 'Gate delegated to web UI. Waiting for resolution...' until an operator killed it, while gate queries returned 'HTTP 400: Unknown workspaceId: proj' because that server could not resolve the scratch workspace ('forever' means no built-in termination was observed, not an infinite-duration measurement). Host B resolved the same gate externally through Stratum, after which the foreground Compose runner tried to resolve an already-resolved gate and failed loudly. Every headless or external gate client is affected. Needs stable workspace, run and gate IDs, an explicit headless resolution path, a single wake-and-reconcile step, and a visible failure when the UI is unavailable instead of an unbounded wait. Sized M and BLOCKS. Gap G1.

---

## Notes

_This is a seed design doc created by `compose feature`. The `compose build` pipeline will expand it into a full design, blueprint, and implementation plan._

---

## Residual: gate-response adoption arm 3 (added 2026-09-17)

Shipped in `bacab32`. The `gateResolve` catch block in `runBuild` (`lib/build.js`) adopts an
authoritative gate decision after a lost response via four arms. Arms 1 and 2 are evidence
(an explicit engine refusal, or a validated `token-engine-witness`). Arm 4 rethrows.

**Arm 3 — `waveProfilesEnabled(pipelineProfiles)` — is a scope exception, not proof.** In that
scope `context.routing`, `captured` and `disposition` are all null and no consumed gate token
exists anywhere: the engine records only `{ decision, target }` on a `gate_resolved` event
(`stratum/ts/src/engine/engine.ts:1342`, `:1354`). So adoption there rests on ordinal position.

Closing it requires an engine change, filed as
`stratum/docs/features/STRAT-GATE-WITNESS-1/design.md` (record the consumed gate token on
`gate_resolved`). Until that ships, arm 3 must stay. The guard has already been deleted twice
as "redundant" and both removals broke a safety invariant; the test that fails without it is
`test/build-wave-ship.test.js:103`.

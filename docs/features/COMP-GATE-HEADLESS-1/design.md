# COMP-GATE-HEADLESS-1: A gate delegated to the web UI has no headless resolution path and no application timeout: COMP-HOST-PORTABILITY-1 host C waited after 'Gate delegated to web UI. Waiting for resolution...' until an operator killed it, while gate queries returned 'HTTP 400: Unknown workspaceId: proj' because that server could not resolve the scratch workspace ('forever' means no built-in termination was observed, not an infinite-duration measurement). Host B resolved the same gate externally through Stratum, after which the foreground Compose runner tried to resolve an already-resolved gate and failed loudly. Every headless or external gate client is affected. Needs stable workspace, run and gate IDs, an explicit headless resolution path, a single wake-and-reconcile step, and a visible failure when the UI is unavailable instead of an unbounded wait. Sized M and BLOCKS. Gap G1.

**Status:** PARTIAL (workspace-aware delegation and poll deadline: 47b657b4; headless answer path: COMP-NOTIFY-GATES-1)
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

---

## Headless answer path (COMP-NOTIFY-GATES-1)

Brief: `smart-memory-ops/units/COMP-NOTIFY-GATES-1/brief.md`. With `COMPOSE_NOTIFY_GATES=1` a gate that nobody can answer at this terminal (delegated to a server, or no server and no TTY, never `--all`) is posted as an owner ask through the ops notify client (`lib/notify-gate.js`, post_id `compose.gate:<flowId>.<stepId>:<round>`). With no server the build waits on the file store up to `COMPOSE_GATE_TIMEOUT` (`pollGateResolution(..., { direct: true })`) instead of the 120 s stdin guard. The answer arrives through `compose gate answer` (AnswerEvent on stdin, ProductReply on stdout), the notify client's command handler for source `compose.gate`; the first answer wins and later ones get `conflict`. The ask is closed once: `answered` on the answering channel, `compose` for the web UI or CLI, `withdrawn` on cancel or timeout. Off by default; turning it on is a separate live step.

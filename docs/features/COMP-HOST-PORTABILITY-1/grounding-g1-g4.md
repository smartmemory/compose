# Grounding report — G1 (gate addressing / headless resolution) + G4 (lifecycle state bridge)

> Read-only source reconnaissance for the COMP-HOST-PORTABILITY-1 remediation.
> Produced 2026-09-17 by Codex `gpt-5.6-sol` (effort high), Stratum run `8c89fb244ecd`.
> No files were changed and no commands were run: every claim below is from reading source.
> Claims marked UNCONFIRMED / NOT FOUND were not verifiable by reading and are not evidence.

---

## G1 seams

1. **Web delegation is selected by a global health probe, not by workspace reachability.**  
   The build calls `probeServer()` and delegates whenever it gets a successful `/api/health` response ([lib/build.js:6203](/Users/ruze/reg/my/forge/compose/lib/build.js:6203), [lib/server-probe.js:9](/Users/ruze/reg/my/forge/compose/lib/server-probe.js:9)). That endpoint is deliberately exempt from workspace resolution ([server/workspace-middleware.js:30](/Users/ruze/reg/my/forge/compose/server/workspace-middleware.js:30), [server/index.js:175](/Users/ruze/reg/my/forge/compose/server/index.js:175)). Consequently, any healthy Compose server on the resolved port—`COMPOSE_PORT`, then `PORT`, then `4001`—causes “Gate delegated to web UI,” even when that server cannot address the build workspace ([lib/resolve-port.js:1](/Users/ruze/reg/my/forge/compose/lib/resolve-port.js:1), [lib/build.js:6216](/Users/ruze/reg/my/forge/compose/lib/build.js:6216)).

2. **The client poll has cancellation and failure fallback, but no independent deadline or exponential backoff.**  
   `pollGateResolution` uses a fixed 2-second interval, honors an `AbortSignal`, and falls back to the terminal prompt after three consecutive server-unreachable results ([lib/build.js:7507](/Users/ruze/reg/my/forge/compose/lib/build.js:7507), [lib/build.js:6221](/Users/ruze/reg/my/forge/compose/lib/build.js:6221)). The server lazily expires pending gates; the default is 30 minutes unless `COMPOSE_GATE_TIMEOUT` overrides it ([server/vision-routes.js:1020](/Users/ruze/reg/my/forge/compose/server/vision-routes.js:1020)). The separate non-TTY stdin guard defaults to 120 seconds, but it is reached only after the web path is unavailable or abandoned ([lib/gate-prompt.js:110](/Users/ruze/reg/my/forge/compose/lib/gate-prompt.js:110), [lib/gate-prompt.js:237](/Users/ruze/reg/my/forge/compose/lib/gate-prompt.js:237)).

3. **Three different identifiers govern the gate.**

   - Workspace ID: read from `.compose/compose.json#workspaceId`, otherwise derived from the directory basename. It is stable for that configuration/path, not per run ([lib/discover-workspaces.js:110](/Users/ruze/reg/my/forge/compose/lib/discover-workspaces.js:110)).
   - Stratum run ID: a new UUID per plan, persisted as `<state-root>/flows/<runId>.json` ([engine.ts:576](/Users/ruze/reg/my/forge/stratum/ts/src/engine/engine.ts:576), [state.ts:306](/Users/ruze/reg/my/forge/stratum/ts/src/engine/state.ts:306)).
   - Compose gate ID: deterministic `<flowId>:<stepId>:<round>` ([server/vision-routes.js:953](/Users/ruze/reg/my/forge/compose/server/vision-routes.js:953), [lib/build.js:6208](/Users/ruze/reg/my/forge/compose/lib/build.js:6208)). Stratum separately requires its opaque, per-issuance `gateToken`; this is not the Compose gate ID ([engine.ts:1302](/Users/ruze/reg/my/forge/stratum/ts/src/engine/engine.ts:1302)).

   The shared server can resolve only workspaces registered in its runtime or discoverable beneath its active target root ([server/workspace-runtime.js:191](/Users/ruze/reg/my/forge/compose/server/workspace-runtime.js:191), [server/workspace-middleware.js:51](/Users/ruze/reg/my/forge/compose/server/workspace-middleware.js:51)). A foreign scratch workspace ID therefore produces `Unknown workspace`.

4. **Headless control surfaces exist, but none closes the observed end-to-end path.**

   - `compose gate list/resolve` sends the caller’s workspace ID to the HTTP server ([bin/compose.js:3797](/Users/ruze/reg/my/forge/compose/bin/compose.js:3797)). It fails when the live server has not registered and cannot discover that workspace.
   - MCP `get_pending_gates` reads the MCP process’s bound workspace store, while `approve_gate` posts to the separate HTTP server ([server/compose-mcp-tools.js:140](/Users/ruze/reg/my/forge/compose/server/compose-mcp-tools.js:140), [server/compose-mcp-tools.js:838](/Users/ruze/reg/my/forge/compose/server/compose-mcp-tools.js:838)). Thus the read and write sides can address different workspace runtimes.
   - Direct `stratum_gate_resolve` can resolve the authoritative Stratum gate, but the foreground Compose runner then attempts the same decision using its captured token.
   - Terminal input and `--non-interactive` auto-approval are inside `promptGate`; a continuously healthy server keeps the build in the web-poll branch, so those paths are not reached ([lib/build.js:6216](/Users/ruze/reg/my/forge/compose/lib/build.js:6216), [lib/gate-prompt.js:237](/Users/ruze/reg/my/forge/compose/lib/gate-prompt.js:237)).

5. **The Host B failure is intentionally loud at Stratum, but Compose performs only conditional reconciliation.**  
   After the tracker outcome is observed, Compose calls Stratum `gateResolve` using the original `flowId`, `stepId`, and `gateToken` ([lib/build.js:6253](/Users/ruze/reg/my/forge/compose/lib/build.js:6253), [lib/build.js:5924](/Users/ruze/reg/my/forge/compose/lib/build.js:5924)). Stratum reloads the run and rejects it with `gate is not awaiting a decision` if another actor already resolved the gate ([engine.ts:1302](/Users/ruze/reg/my/forge/stratum/ts/src/engine/engine.ts:1302)). Compose reconciles such a race only when wave profiles are enabled; otherwise it rethrows ([lib/build.js:5942](/Users/ruze/reg/my/forge/compose/lib/build.js:5942)). The Host B audit records exactly that split: tracker showed no gate, direct Stratum resolution succeeded, and the foreground runner subsequently failed rather than adopting the authoritative decision ([host-b-lifecycle.md:114](/Users/ruze/reg/my/forge/compose/docs/features/COMP-HOST-PORTABILITY-1/audit/host-b-lifecycle.md:114)).

## G4 seams

| State plane | Store and writer | Reader | Current join keys |
|---|---|---|---|
| Compose tracker | `<workspace>/.compose/data/vision-state.json`; `VisionStore`, HTTP routes, and `VisionWriter` ([server/vision-store.js:40](/Users/ruze/reg/my/forge/compose/server/vision-store.js:40)) | UI routes and Compose MCP tools | Tracker `itemId`; `featureCode`; gate record contains `flowId`, `stepId`, and `round` |
| Stratum flow | Default `~/.stratum/ts/flows/<runId>.json`, with `STRATUM_STATE_ROOT` override ([state.ts:306](/Users/ruze/reg/my/forge/stratum/ts/src/engine/state.ts:306), [server.ts:88](/Users/ruze/reg/my/forge/stratum/ts/src/mcp/server.ts:88)) | Stratum engine and MCP | `runId`; gate `stepId` plus `gateToken`; optional `workspaceRoot`; Compose supplies `featureCode` as plan input |
| Session binding | In-memory current HTTP session; completed sessions append to `sessions.json` ([server/session-manager.js:62](/Users/ruze/reg/my/forge/compose/server/session-manager.js:62)) | Session API/UI | `bind_session` records `featureCode`, tracker `itemId`, and phase—but no `runId`, `flowId`, or gate ID ([server/session-routes.js:81](/Users/ruze/reg/my/forge/compose/server/session-routes.js:81)) |
| Active build | `<workspace>/.compose/data/active-build.json`, written by the build runner ([lib/build.js:2537](/Users/ruze/reg/my/forge/compose/lib/build.js:2537), [lib/build.js:7417](/Users/ruze/reg/my/forge/compose/lib/build.js:7417)) | Resume logic and server UI | `featureCode` and `flowId`, where `flowId` is the Stratum `runId` |

**Exact divergence path:**

1. The build constructs `new VisionWriter(dataDir)` without passing `workspaceId` ([lib/build.js:3814](/Users/ruze/reg/my/forge/compose/lib/build.js:3814)).
2. `VisionWriter` prefers REST whenever the global server health check succeeds and adds `X-Compose-Workspace-Id` only when its optional `workspaceId` exists ([lib/vision-writer.js:125](/Users/ruze/reg/my/forge/compose/lib/vision-writer.js:125), [lib/vision-writer.js:396](/Users/ruze/reg/my/forge/compose/lib/vision-writer.js:396)).
3. With no header, middleware falls back to the server’s active target root ([server/workspace-middleware.js:54](/Users/ruze/reg/my/forge/compose/server/workspace-middleware.js:54)). The tracker item/gate can therefore be written to the server workspace instead of the build workspace.
4. MCP `set_workspace` changes only that MCP process’s in-memory binding ([server/mcp-tool-defs.js:105](/Users/ruze/reg/my/forge/compose/server/mcp-tool-defs.js:105), [server/compose-mcp-tools.js:864](/Users/ruze/reg/my/forge/compose/server/compose-mcp-tools.js:864)). Its local tracker read can truthfully show zero gates while Stratum independently holds a live `waiting_gate`.
5. `bind_session` posts the workspace header to the shared server. It cannot register an unrelated workspace there, and even on success it binds only a session to a tracker feature/item/phase—not to the live Stratum run ([server/compose-mcp-tools.js:665](/Users/ruze/reg/my/forge/compose/server/compose-mcp-tools.js:665), [server/session-routes.js:88](/Users/ruze/reg/my/forge/compose/server/session-routes.js:88)).

The strongest existing authoritative correlation key is **`flowId`/Stratum `runId`**: it is durable in Stratum, stored in `active-build.json`, and embedded in every Compose gate ID/record. `featureCode` spans more planes, including session binding, but it does not uniquely associate a particular run or gate round.

## Shared seam

G1 and G4 converge at the same boundary: **the build’s workspace-unaware `VisionWriter` plus a workspace-agnostic health probe** ([lib/build.js:3814](/Users/ruze/reg/my/forge/compose/lib/build.js:3814), [lib/build.js:6203](/Users/ruze/reg/my/forge/compose/lib/build.js:6203)).

That combination:

- selects web delegation because some Compose server is alive;
- allows tracker writes to land in that server’s fallback workspace;
- leaves the MCP-bound workspace with no visible tracker gate;
- and separates the human-facing tracker outcome from the authoritative Stratum gate.

Threading the build workspace ID through tracker operations is the common addressing seam. A second, distinct reconciliation seam remains necessary: external resolution must be adopted by `flowId`/`gateToken` state instead of being blindly replayed by the foreground runner.

## Existing feature overlap

| Feature | Status | Relationship to G1/G4 | Grounding verdict |
|---|---:|---|---|
| `COMP-GATE-HEADLESS-1` | PLANNED | Explicitly owns reliable headless gate discovery/resolution | Exact G1 scope; not an already-delivered regression ([feature.json:1](/Users/ruze/reg/my/forge/compose/docs/features/COMP-GATE-HEADLESS-1/feature.json:1)) |
| `COMP-LIFECYCLE-BRIDGE-1` | PLANNED | Explicitly owns authoritative tracker/Stratum/session/active-build correlation | Exact G4 scope; not an already-delivered regression ([feature.json:1](/Users/ruze/reg/my/forge/compose/docs/features/COMP-LIFECYCLE-BRIDGE-1/feature.json:1)) |
| `COMP-PARITY-1` | COMPLETE | Claims CLI gate resolution unblocks headless/CI operation | Command surface exists, but the broad “unblocks” outcome is falsified for an unregistered foreign workspace ([feature.json:1](/Users/ruze/reg/my/forge/compose/docs/features/COMP-PARITY-1/feature.json:1)) |
| `COMP-PARITY` | COMPLETE | Broad lifecycle/headless parity claim | Partially falsified by the cross-host gate path; it did not establish authoritative cross-plane correlation ([feature.json:1](/Users/ruze/reg/my/forge/compose/docs/features/COMP-PARITY/feature.json:1)) |
| `COMP-WORKSPACE-ID` | COMPLETE | Workspace identity derivation and propagation foundation | ID derivation works; the defect is omission/registration at a later boundary, so this claim is not directly falsified ([feature.json:1](/Users/ruze/reg/my/forge/compose/docs/features/COMP-WORKSPACE-ID/feature.json:1)) |
| `COMP-WORKSPACE-HTTP` | COMPLETE | Workspace-aware HTTP middleware foundation | Middleware behavior is present; the build caller omits the header. Out of scope rather than a middleware regression ([feature.json:1](/Users/ruze/reg/my/forge/compose/docs/features/COMP-WORKSPACE-HTTP/feature.json:1)) |
| `COMP-WORKSPACE-VISION` | PLANNED | Per-workspace vision stores/routes | Overlaps the server-side portion of G1/G4, but does not by itself cover build-side header propagation or Stratum reconciliation ([feature.json:1](/Users/ruze/reg/my/forge/compose/docs/features/COMP-WORKSPACE-VISION/feature.json:1)) |
| `COMP-MCP-ENFORCE` / `COMP-MCP-VALIDATE-3` | COMPLETE | Feature/roadmap/tracker lifecycle enforcement and projection | Different truth boundary; neither claims agreement with Stratum runs, active-build state, or gate tokens |

The roadmap contains both new defects as planned work, matching their feature records ([ROADMAP.md:1633](/Users/ruze/reg/my/forge/compose/docs/ROADMAP.md:1633), [ROADMAP.md:1636](/Users/ruze/reg/my/forge/compose/docs/ROADMAP.md:1636)).

## Test coverage

| Test | Exact covered behavior | Current status |
|---|---|---|
| `test/vision-writer.test.js` | Default round and gate-ID suffix; tracker resolution; server-unreachable behavior; optional workspace-header injection/omission ([vision-writer.test.js:121](/Users/ruze/reg/my/forge/compose/test/vision-writer.test.js:121), [vision-writer.test.js:310](/Users/ruze/reg/my/forge/compose/test/vision-writer.test.js:310)) | Not run; green unconfirmed |
| `test/cli-gate.test.js` | CLI list pending gates; resolve approve payload; server-down failure ([cli-gate.test.js:73](/Users/ruze/reg/my/forge/compose/test/cli-gate.test.js:73)) | Not run; green unconfirmed |
| `test/gate-log-emit.test.js` | Re-resolving an already-resolved **tracker** gate is idempotent ([gate-log-emit.test.js:225](/Users/ruze/reg/my/forge/compose/test/gate-log-emit.test.js:225)) | Not run; does not cover Stratum’s loud second-resolution failure |
| `test/gate-round-reentry.test.js` | Revise and fresh-flow gate rounds receive fresh IDs ([gate-round-reentry.test.js:50](/Users/ruze/reg/my/forge/compose/test/gate-round-reentry.test.js:50)) | Not run; green unconfirmed |
| `test/ts-cutover-build-gate-human-golden.test.js` | Prompt-driven approve/revise/kill flow with the server deliberately unavailable ([ts-cutover-build-gate-human-golden.test.js:177](/Users/ruze/reg/my/forge/compose/test/ts-cutover-build-gate-human-golden.test.js:177)) | Not run; does not exercise web delegation |
| `test/build-cancel-review2.test.js` | Abort releases a pending web gate and interrupts poll sleep ([build-cancel-review2.test.js:204](/Users/ruze/reg/my/forge/compose/test/build-cancel-review2.test.js:204)) | Not run; cancellation is pinned |
| `test/gate-input-guard.test.js` | Guarded stdin deadline and EOF rejection ([gate-input-guard.test.js:23](/Users/ruze/reg/my/forge/compose/test/gate-input-guard.test.js:23)) | Not run; covers only the prompt path |
| `test/golden/http-middleware-multi-workspace.test.js` | Header routing, fallback with no header, unknown-ID rejection, and health exemption ([http-middleware-multi-workspace.test.js:119](/Users/ruze/reg/my/forge/compose/test/golden/http-middleware-multi-workspace.test.js:119)) | Not run; it pins the individual behaviors that combine into G1 |
| `test/mcp-workspace-binding.test.js` | Same-process MCP rebinding and local store reads ([mcp-workspace-binding.test.js:11](/Users/ruze/reg/my/forge/compose/test/mcp-workspace-binding.test.js:11)) | Not run; no separate shared-server registration |
| `test/compose-mcp-tools-http.test.js` | HTTP gate/bind payloads and header injection after MCP binding ([compose-mcp-tools-http.test.js:105](/Users/ruze/reg/my/forge/compose/test/compose-mcp-tools-http.test.js:105)) | Not run; server recognition of the ID is not tested |
| `test/session-binding.test.js` | Valid tracker-feature binding and unknown-feature rejection ([session-binding.test.js:491](/Users/ruze/reg/my/forge/compose/test/session-binding.test.js:491)) | Not run; no Stratum-run join |
| `test/build-modes.test.js` | `active-build.json` stores the engine’s run ID ([build-modes.test.js:79](/Users/ruze/reg/my/forge/compose/test/build-modes.test.js:79)) | Not run; green unconfirmed |
| `test/workspace-switch-runtime.test.js` | Registered runtime switching across workspace services ([workspace-switch-runtime.test.js:26](/Users/ruze/reg/my/forge/compose/test/workspace-switch-runtime.test.js:26)) | Not run; does not cover an external build’s headerless `VisionWriter` |

No located test covers either complete defect:

- healthy shared server + foreign build workspace + CLI/MCP headless gate resolution; or
- one decision reconciled across tracker gate, Stratum flow, session binding, and `active-build.json`, including external Stratum resolution racing the foreground runner.

## Unconfirmed

- Current test-suite green status is **unconfirmed** because the brief prohibited test execution.
- The effective runtime value of `COMPOSE_GATE_TIMEOUT` on Hosts B/C is unconfirmed; only the source default of 30 minutes is established.
- Whether every Host B invocation had wave profiles disabled is unconfirmed. The general non-wave path demonstrably rethrows; only the wave-profile branch contains event-based reconciliation.
- No code or files were changed. Final `git status --short` remained limited to the two pre-existing untracked files:
  `docs/features/COMP-GUARD-CLAIM-1/audit.json` and `docs/features/COMP-TUI-4/audit.json`.


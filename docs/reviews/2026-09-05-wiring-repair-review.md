# Review of Codex's 2026-09-05 wiring repair (compose + stratum, uncommitted)

Reviewed: Claude (Fable, adjudication) + two independent Opus reviewers (one per repo),
plus local verification. Subject: the uncommitted working trees left by the Codex Desktop
session briefed "review the full project, find any wiring gaps ... fix them all".
Codex's own report: `2026-09-05-wiring-repair.md`.

Verified locally: stratum `tsc --noEmit` clean; 129 stratum tests across the ten touched
suites pass; 99 compose tests across the six new + four modified suites pass (both with
`CI=1`, live Codex smoke test gated off). No assertion weakening found in either repo.

Not part of this change (dirty since Aug 30, leave alone): `docs/context/decisions.md`,
`docs/features/COMP-GUARD-CLAIM-1/*`, `docs/features/COMP-MCP-ENFORCE/report.md`,
`docs/features/COMP-FOH/*`, `docs/features/COMP-SEMVER-STRICT/*`.

## Verdict: do not commit as one unit. Split into three; block the middle slice.

| Slice | Files | Status |
|---|---|---|
| A. Stratum hygiene | engine.ts stdout→stderr, `flowPoll` durable read + `flowBgPoll` ordering, `appendExistingStream`, guard/transition.ts, entry-input validation + tests, stdio-planning test, p4/p6/fencing/rehydrate determinism | **Mergeable now.** Release-note the strict input validation (breaking for external callers sending superset envelopes). |
| B. Execution + cancellation contract | stratum connectors (claude/codex/runner/cancellation/background), mcp/server.ts, mcp-surface 16→17; compose stratum-mcp-client.js, result-normalizer.js, build.js cancellation paths, model-tiers.js, agent-string.js, codex-preflight.js | **Blocked.** P0 + all P1s live here. |
| C. Compose workspace refactor + test-runner widening | workspace-runtime.js, agent-workspace.js, vision-server/routes, session-manager, agent-spawn/hooks, compose-mcp*, file-watcher, project-root, UI agentServer/agentStream, package.json/vitest.config test globs | **Mergeable after fixing 7 and 8 below.** Best-tested part of the change (real HTTP/WS/process integration test). |

## P0

1. **Compose hard-requires an unpublished Stratum surface (17) and only works because of an
   untracked symlink.** `lib/stratum-mcp-client.js:272-288` always sends `cancellationId`
   (a signal is always present) plus `effort`/`thinking`/tool filters, and refuses with
   `UNSUPPORTED_AGENT_OPTIONS` if the connected server's schema lacks any field. `package.json`
   still pins `^0.3.3` → published 0.3.4 = surface 16. Codex replaced
   `node_modules/@smartmemory/stratum` with a symlink to `../stratum/ts`. Any `npm install`,
   CI run, or second machine fails every agent dispatch. Stratum `ts/package.json` is still
   0.3.4 with no bump in the diff. CONFIRMED.

## P1

2. **Transport failure relabelled as fatal unconfirmed cancellation.** `stratum-mcp-client.js:296-323`:
   on any RPC rejection the client fires a cancel for an id the server may never have
   registered; `not_found` (or the cancel call itself failing on a dead pipe) becomes
   `CANCELLATION_UNCONFIRMED`, which `build.js:962` treats like a user interrupt: whole
   consumer pump aborts, no retry. Previously an MCP child crash failed one item and retried.
3. **Optional policy-revision pass now kills the build.** `build.js:3744` rethrows
   `AgentAbortedError` (raised by the stuck detector, not only interrupts) where it used to
   fail open and keep the draft.
4. **Every MCP Codex run silently switches transport and binary.** `mcp/server.ts:334` attaches
   the request signal to every call; `codex.ts:180-186` forces exec transport + the SDK's
   pinned CLI whenever a signal is present. `STRATUM_CODEX_TRANSPORT` is dead on the MCP path,
   and Codex runs `@openai/codex@0.144.3` (pnpm store) instead of the global 0.153.3. Verified:
   the pinned CLI launches and ships `codex-code-mode-host`, so it works today, but the user's
   binary pin is silently bypassed. Gate on an explicit option, not signal presence.
5. **`bundledCodexCommand()` runs in the constructor** (`codex.ts:186,486-490`) and can throw a
   raw module-resolution error, failing all Codex dispatch, on any layout where `@openai/codex`
   or its platform package is absent. Only covered by a subprocess test. Make it lazy with a
   PATH fallback.
6. **Cancellation is SIGKILL-only on the whole process group, no graceful window.**
   `claude.ts:158-160,223`, `codex.ts:341-346`. A Compose foreground timeout now hard-kills an
   implementer mid-write in the user's worktree; nothing rolls that back. Not acknowledged in
   the design note.
7. **Acknowledged cancellation still awaits the original RPC unbounded.** `stratum-mcp-client.js:316`
   plus `mcp/server.ts:205-215` (`await running.settled` has no timeout). A connector that
   ignores abort hangs both the cancel RPC and the foreground timeout. The new tests cover only
   the three failing-cancel cases, never ack-plus-hung-agent.

## P2

8. Compose `suspend()` (`vision-server.js:476`) leaves `_healthMonitor` and
   `_coalescingBuffer` running; `WorkspaceRuntime` never evicts, so every visited project
   leaks timers, stores, and a router until shutdown.
9. `project-root.js:130`: prepared workspace config is frozen for the process lifetime;
   editing `.compose/compose.json` no longer takes effect without restart (it used to on switch).
10. `workspace-runtime.js:117`: a workspace resolvable on disk but never switched to now 409s
    (`WorkspaceNotActive`); same line dereferences `this.active.binding`, TypeError when null.
11. `compose-mcp.js:141`: session binding precedence moved above `COMPOSE_TARGET`; intentional
    and tested, but `lib/resolve-workspace.js:1-25` still documents the old chain.
12. `agent-workspace.js:255`: `x-compose-project-root` header reaches `prepareProject`, which
    mkdirs and runs the SDK in `acceptEdits` there. Token-gated and loopback-bound, but a
    blast-radius widening; workspaces map unbounded.
13. `result-normalizer.js:366-370`: sandbox fallback keys on a `template === 'implementer'` no
    profile uses, and `readOnlyProfile || reviewMode` outranks an explicit caller
    `sandboxMode`. Mitigated: `build.js:940/3514/4370` pass explicit `workspace-write` on the
    real write paths.
14. `codex.ts:339`: `detached: true` on ALL exec spawns, not only cancellable ones; killing the
    Stratum server now orphans Codex children that previously died with the group.
15. Windows: both connectors fall back to `child.kill`, which does not kill the tree, yet still
    ack `cancelled`.
16. `mcp/server.ts:104-122`: cancellationId validation throws outside the try/catch, bypassing
    the structured error envelope. `:288-292`: client disconnect between response and
    `finally` records a successful run as `cancelled`.
17. Bad caller input now surfaces as `spec_validation_failed` (`engine.ts:402` →
    `server.ts:269`), indistinguishable from a broken pipeline definition.
18. `claude.ts:221` custom spawn drains stderr, so a CLI that dies with a diagnostic yields an
    error with no cause. The hook also permanently overrides `child.kill` to group SIGKILL.
19. `test/execution-contract.test.js` mocks the seam it names (fake `agentRun` calls
    `buildAgentRunRequest` itself). Real coverage is `execution-runtime.test.js`.
20. `src/lib/agentServer.js`: all cockpit agent traffic now via :4001; `VITE_AGENT_PORT` is dead
    config still stubbed in two tests.

Nits: `/api/health` registered twice; spark tier effort `low` vs convention `medium`;
`resolveKnownWorkspace` re-reads compose.json per headered request; `runner.ts:127` binds a
variable named `unknown`; `.codex-out/` untracked and unignored in both repos.

## Cleared

- Stratum stdout is clean on the MCP path (asserted against a real subprocess).
- Surface 16→17 is additive: all new request fields optional, tool count still 24.
- Background runs unchanged (`runAgent` does not forward `signal` to `startBackgroundRun`).
- `codex.live.test.ts` correctly gated on `STRATUM_LIVE_CODEX=1`; nothing else reaches a live provider.
- All 11 in-repo Compose pipelines' plan envelopes pass the new strict entry validator.
- The three modified compose test assertions all track real intended behaviour changes.

## Adjudication of Codex's own follow-up self-review (5 findings, all verified in source)

| Codex finding | Disposition |
|---|---|
| [P1] Clean installs cannot use the new contract (lockfile pins 0.3.3, stratum still 0.3.4) | **Duplicate of P0 #1.** Confirmed. Note `package-lock.json` is gitignored and untracked, so the lock line is moot; the binding fact is `package.json` `^0.3.3` + no stratum version bump. |
| [P1] Claude review fanout (isolation none → `localExecution`, `build.js:956`) still uses `local-claude-connector.js`, which passes an AbortController but does not own the process group or await child close | **NEW, confirmed, P1.** The comment at `build.js:954` ("Both transports now enforce profiles and await termination") is false for the local transport. Belongs to slice B. |
| [P1] Failed provider runs evade usage accounting: `claude.ts:150` throws before reading `total_cost_usd`/usage on an error result; `codex.ts:231` throws on `turn.failed` after accumulating tokens but never returns them | **NEW, confirmed, P1.** Compose's new failure-accounting code (`build.js:958` `failureUsageFields`) has nothing to debit over MCP. Pre-existing gap the change did not close; belongs to slice B. |
| [P2] Primary user-interrupt branch drops `errUsage` (`result-normalizer.js:603`) while timeout/abort branches attach it | **NEW, confirmed, P2.** One-line fix; slice B. |
| [P2] First `listTools()` capability probe (`stratum-mcp-client.js:278`) is awaited before the abort listener is installed, so a stalled probe cannot be released by `maxDurationMs` | **NEW, confirmed, P2.** Slice B. |

Net: Codex's self-review adds four real findings, three of them in the already-blocked
cancellation slice, and does not change the verdict. It did not surface the transport/binary
switch (P1 #4), the constructor-time resolver (P1 #5), the SIGKILL blast radius (P1 #6), the
transport-failure relabelling (P1 #2), or the fail-open regression (P1 #3).

## Environment to undo before any fresh install

`compose/node_modules/@smartmemory/stratum` is a symlink to the sibling checkout (Codex
says the prior directory is in a "temporary backup"; location not recorded). Either restore
the published package or commit to the publish sequence: bump stratum to surface 17 and
publish, then bump compose's dependency and lockfile.

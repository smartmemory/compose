# Compose / Stratum wiring repair

Scope: the eight verified findings from the project review, plus defects exposed
while tracing and exercising those same execution and workspace boundaries.
Existing user edits were preserved. No commits or releases were made.

| Finding | Implemented behavior |
| --- | --- |
| Codex implementation dispatched read-only | Consumer worktree execution, fix passes, and the preflight probe explicitly request workspace-write. Reviewer profiles override write intent with read-only. |
| Claude settings dropped at MCP | Tool allowlists/denylists, thinking, and effort pass through the normalizer, MCP schema/handler, runner, and SDK. Unsupported provider combinations reject. |
| Workspace switch only reloaded vision state | A workspace owns its routes, stores, settings, lifecycle config, sessions, agent registry, and observers. HTTP, WebSocket, SDK proxy, hooks, and MCP calls carry the workspace binding through async work. Destination preparation precedes switching. |
| Foreground timeout could not cancel execution | Foreground cancellation IDs register before asynchronous dispatch. Successful cancellation waits for process-tree teardown and event callbacks. Unconfirmed cancellation is fatal and cannot settle/retry an item. Repair calls share the deadline and interrupt controls. |
| Codex tiers selected Claude models | Tier lookup is provider-specific; Codex receives its own model and effort settings. |
| Root flow inputs bypassed contracts | The effective policy-merged entry contract validates inputs before run persistence or dispatch; malformed inputs return a structured input error. |
| Policy logs contaminated MCP stdout | Engine and guard diagnostics go to stderr; real stdio MCP and CLI probes cover these paths. |
| Default tests omitted existing suites | npm test includes golden HTTP/workspace tests and source UI tests. A discovery check detects omitted test locations. |

Boundary validation also found and fixed:

- An installed older Stratum shadowing the edited source. Compose checks actual
  advertised execution fields and refuses to weaken settings. The local installed
  dependency now links to the rebuilt sibling runtime; its prior directory was
  preserved in a temporary backup.
- Revision fallback swallowing cancellation uncertainty and interruption, and
  timeout conversion losing primary-plus-repair usage.
- A cancellation failure hidden behind a still-running original RPC.
- Codex cancellation settling before queued async progress callbacks completed.
- Streamed usage missing required consumer fields.
- Shared pipeline drafts and MCP feature/profile bindings leaking across projects.
- A background worker recreating terminal artifacts after their removal.
- Polling exposing completion before persistence and mixing disk/live snapshots.

## Verification

The verification uses production entrypoints with fake inference boundaries, not
an end-to-end claim that a live model followed every instruction:

- `test/execution-runtime.test.js`: actual Compose client → stdio MCP → Stratum
  connector → OS process. Verifies sandbox/model/effort argv, real file writes,
  stopped parent/child writers after timeout, Claude SDK options and usage, and
  fail-before-dispatch behavior against an older advertised MCP surface.
- `test/workspace-switch-runtime.test.js`: production server HTTP routes,
  WebSockets, A/B filesystem artifacts and settings, capability-specific behavior,
  failed-switch rollback, real fake CLI cwd/environment, SDK proxy sessions, and
  completion of A's work after switching to B.
- `test/mcp-workspace-binding.test.js`: real Compose MCP stdio and interleaved
  workspace/feature binding checks.
- Stratum cancellation tests use actual parent/child processes and blocked async
  callbacks; input/stdout tests use real MCP/CLI subprocesses; persistence tests
  pause saves and reads to expose race boundaries deterministically.

Final verification (all commands exited 0):

| Check | Result |
| --- | --- |
| Compose `CI=1 npm test` backend/golden/integration runner | 6,063 passed |
| Compose UI runner (same npm test command) | 611 passed |
| Compose tracker runner (same npm test command) | 100 passed |
| Stratum `CI=1 npm test` | 1,030 passed; 3 intentionally skipped |
| Final HTTP/MCP/process probes after rebuilding Stratum | 13 passed |
| Compose `npm run build` | Passed |
| Stratum `npm run build` and `npm run typecheck` | Passed |

The 13 final boundary probes repeat tests already counted in the full suite;
they are not additional unique test coverage. Total full-suite passes: **7,804**.
The final production resolver selects `stratum/ts/dist/mcp/main.js` and
`stratum/ts/dist/cli/stratum.js` through the locally linked dependency.

Execution logs from this session:
`/tmp/forge-compose-suite-final2.log`, `/tmp/forge-stratum-suite-reviewed.log`,
`/tmp/forge-final-boundary-probes.log`, `/tmp/forge-compose-build.log`,
`/tmp/forge-stratum-build-final.log`, `/tmp/forge-stratum-typecheck-final.log`.


Two early Stratum suite runs invoked the pre-existing live Codex echo smoke test
because it automatically ran whenever a Codex binary was installed. That test now
requires `STRATUM_LIVE_CODEX=1`; subsequent verification uses `CI=1` and fake
inference boundaries.

## Runtime and release boundary

The code and local runtime are updated. No npm package was published and no
released dependency/lockfile was invented. Publishing these changes requires a
matching Stratum surface-17 release and then updating Compose's package dependency
and lockfile. See [development runtime setup](../install.md#developing-compose-and-stratum-together).

Workspace contexts remain retained until server shutdown so in-flight work can
finish and a user can return to its sessions. Switching projects is not cancellation.
An unconfirmed preflight cancellation preserves its worktree and reports its path.

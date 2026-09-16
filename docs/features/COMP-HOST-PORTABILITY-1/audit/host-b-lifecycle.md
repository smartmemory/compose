# Host B lifecycle measurement

**Feature:** COMP-HOST-PORTABILITY-1  
**Host:** Codex CLI (`codex exec`) driving Compose through the Compose and Stratum MCP servers plus the `compose` CLI  
**Date:** 2026-09-16  
**Scratch project:** `/private/tmp/claude-501/-Users-ruze-reg-my-forge/12cb24d4-cdb3-44d6-814f-0b9dbcc1efbc/scratchpad/hostaudit/hostb/proj`  
**Result:** **FAIL** for the end-to-end acceptance criterion. The first flow implemented the feature but failed in review before coverage/docs/ship. Recovery could not resume that failed flow through Compose, and the replacement fresh flow was interrupted at the 25-minute cap.

Raw evidence is under `/private/tmp/claude-501/-Users-ruze-reg-my-forge/12cb24d4-cdb3-44d6-814f-0b9dbcc1efbc/scratchpad/hostaudit/hostb/`. The principal files are `probe.log`, `lifecycle.log`, `lifecycle-gate-design.log`, `lifecycle-gate-design-stratum.log`, `isolated-setup.log`, `isolated-hooks-install.log`, and the scratch project's `.compose/data/dispatch-ledger.jsonl`.

## Setup and probe

### Scratch setup

I initialized a new Git repository, added one fixture README, and made one initial commit (`ea90410 chore: initialize host B audit fixture`). I then ran:

```text
node /Users/ruze/reg/my/forge/compose/bin/compose.js init
```

It exited 0 and created the project-local Compose scaffold, including `.compose/compose.json`, `.mcp.json`, `ROADMAP.md`, `contracts/`, `docs/`, and `pipelines/`. Compose and Stratum source repositories were not used as lifecycle workspaces.

Before starting anything, `lsof -nP -iTCP:4001 -sTCP:LISTEN` showed an already-listening Node process (PID 78098) on `127.0.0.1:4001`. I neither started nor killed it. Both audited MCP servers were launched by Codex over stdio, not through that port.

### First inner-Codex probe

The required prompt ran with the specified `gpt-5.6-sol`, high reasoning, ignored user config, explicit stdio MCP overrides, and the scratch project as `-C`. It exited 0 after 205 seconds. No probe or lifecycle log contains `invalid_request_error`. The probe did contain transient model-refresh and WebSocket reconnect errors, after which both MCP calls completed.

Both requested servers connected. Codex enumerated 216 MCP tools: 140 unrelated `codex_apps` tools, 51 Compose tools, and 25 Stratum tools.

Compose tools exposed:

```text
abort_iteration_loop, add_changelog_entry, add_roadmap_entry, approve_gate,
assess_feature_artifacts, backfill_completion, bind_session, complete_feature,
compose_resume, get_blocked_items, get_changelog_entries, get_completions,
get_current_session, get_feature_artifacts, get_feature_lifecycle,
get_feature_links, get_item_detail, get_journal_entries, get_judgment_state,
get_judgment_trace, get_pending_gates, get_phase_summary, get_roadmap,
get_vision_items, get_workspace, judgment_goal_write, judgment_joint_add,
judgment_ledger_append, judgment_person_write, judgment_position_amend,
judgment_position_create, judgment_situation_write, judgment_transition,
kill_feature, link_artifact, link_features, propose_followup,
record_completion, report_iteration_result, roadmap_diff, roadmap_graph,
roadmap_graph_check, roadmap_xref_push, scaffold_feature, set_feature_status,
set_workspace, start_iteration_loop, validate_feature, validate_project,
write_checkpoint, write_journal_entry
```

Stratum tools exposed:

```text
stratum_agent_poll, stratum_agent_run, stratum_audit,
stratum_cancel_agent_run, stratum_commit, stratum_compile_speckit,
stratum_flow_bg_poll, stratum_flow_cancel, stratum_flow_cancel_bg,
stratum_flow_poll, stratum_flow_run_bg, stratum_gate_resolve,
stratum_guard_apply_upgrade, stratum_guard_history, stratum_guard_migrate,
stratum_guard_override, stratum_guard_register, stratum_guard_transition,
stratum_guard_upgrade, stratum_plan, stratum_resume, stratum_revert,
stratum_step_done, stratum_usage_report, stratum_validate
```

Raw `compose/get_workspace({})` returned `current: null` and one candidate, workspace ID `proj`, at the correct scratch path. Raw `stratum_validate` returned:

```json
{"content":[{"type":"text","text":"{\"status\":\"valid\"}"}],"structuredContent":{"status":"valid"}}
```

The validated minimal flow used a single `agent: "claude"` step, but this was validation only; it did not prove agent execution. A fresh host must inspect `get_workspace`, call `set_workspace({"workspaceId":"proj"})`, and then bind a lifecycle feature if the session tools require it. The workspace exemption and binding path are implemented at `server/compose-mcp.js:135-156`; the tool definitions say that `set_workspace` is process-memory-only at `server/mcp-tool-defs.js:93-118`.

In practice, `set_workspace` returned success, but `bind_session` failed with `Unknown workspaceId: proj`, and session lookup continued to report the same workspace problem. Thus the documented fresh-host sequence did not produce a usable bound Compose session in this measurement.

### Isolated-HOME setup behavior

With `HOME=/private/tmp/claude-501/-Users-ruze-reg-my-forge/12cb24d4-cdb3-44d6-814f-0b9dbcc1efbc/scratchpad/hostaudit/hostb/home` initially empty:

| Command | Exit | Measured writes and message |
|---|---:|---|
| `compose setup` | 0 | Printed three `+ claude/...` skills, two `+ claude/agents/...` agents, and `~ codex — shares skill dir with claude, skipped`. Wrote `~/.claude/skills/{bug-fix,compose,context-budget}`, `~/.claude/skills/.compose-skills.json`, `~/.claude/agents/{compose-architect,compose-explorer}.md`, `~/.claude/settings.json`, Claude plugin state/cache files, `~/.claude.json`, and a `.claude.json` backup. It installed `superpowers@claude-plugins-official`; six optional dependencies remained missing. |
| `compose hooks install` | 0 | Wrote no HOME file. It installed `proj/.git/hooks/post-commit`, embedding the Node path, Compose binary path, and `COMPOSE_WORKSPACE_ID=proj`; it printed all three values. |

The behavior is source-driven, not environment noise: Codex detection deliberately maps Codex to `~/.claude/skills/stratum` and marks it shared with Claude (`bin/compose.js:140-156`), agent definitions are installed only into the Claude tree (`bin/compose.js:239-247`), and a no-agent fallback is explicitly Claude (`bin/compose.js:614-622`). The installed agent definitions use Claude tool names (`Read`, `Grep`, `Glob`, `Bash`).

## MCP surface table

“Works” below means the inner Codex host obtained a meaningful result in this run. It does not mean all 76 Compose/Stratum tools were destructively exercised. Mutation tools unrelated to this fixture were intentionally left uncalled.

| Tool or surface | Works / fails / assumes-Claude | Evidence | Source evidence |
|---|---|---|---|
| `compose/get_workspace` | Works | Returned `current: null` plus the correct `proj` candidate in the first probe. | Workspace-exempt tool at `server/compose-mcp.js:135-156`; definition at `server/mcp-tool-defs.js:105-118`. |
| `compose/set_workspace` | Works, process-local | Returned the selected `proj` binding; a later `get_workspace` showed it. | Binding is explicitly memory-only at `server/mcp-tool-defs.js:105-112`. |
| `compose/bind_session`, `compose/get_current_session` | Fails for a fresh Codex session | After successful `set_workspace`, `bind_session` failed `Unknown workspaceId: proj`; session lookup did not become usable. | Dispatch at `server/compose-mcp.js:153-155`; definitions at `server/mcp-tool-defs.js:82-103`. |
| `compose/get_vision_items`, `get_phase_summary`, `get_blocked_items`, `get_feature_lifecycle` | Calls complete, but lifecycle state is disconnected | During a real CLI/Stratum build, these returned no matching tracker item or `Item not found: HOSTB-HELLO`. | Routed through tracker handlers at `server/compose-mcp.js:148-157`. |
| `compose/get_pending_gates`, `approve_gate` | Silent state-plane failure | While Stratum was waiting at `design_gate`, repeated calls returned `{count:0,gates:[]}`; there was consequently no safe gate ID to pass to `approve_gate`. | Routed at `server/compose-mcp.js:166-167`; gate definitions at `server/mcp-tool-defs.js:237-259`. |
| `compose/validate_feature` | Works | Call completed against the scratch feature during preflight. | Routed at `server/compose-mcp.js:182-183`. |
| `compose/compose_resume` | Fails | Failed against the paused/failed build. The CLI's later `build --resume` also exited 1 with `Nothing to resume` after review failure. | Routed at `server/compose-mcp.js:188-189`. |
| `stratum/stratum_validate` | Works | Returned structured `status: valid` for the trivial schema-compliant flow. | Raw probe result in `probe.log`. |
| `stratum/stratum_flow_poll`, `stratum_audit` | Works | Exposed the real flow and gate/review state that Compose tracker calls could not see. | Raw lifecycle calls in `lifecycle.log`. |
| `stratum/stratum_gate_resolve` | Works | Accepted the design-gate approval and advanced Stratum to blueprint. The already-running foreground Compose command did not reconcile cleanly and subsequently failed because the gate was no longer awaiting a decision. | Raw lifecycle calls in `lifecycle.log`. |
| `stratum/stratum_resume` | Works at Stratum layer only | MCP call completed after review failure, but Compose still could not resume the failed build, so the driver resorted to `--fresh`. | Raw lifecycle calls in `lifecycle.log`. |
| Remaining advertised Compose mutation/judgment/roadmap tools and remaining Stratum execution/guard tools | Not exercised | Calling them would mutate unrelated state or was unnecessary once the actual build supplied lifecycle evidence. Exposure was verified by `tools/list`; successful behavior was not inferred. | Complete routing switch at `server/compose-mcp.js:148-200`. |
| Entire Compose MCP host-facing surface | **Assumes-Claude A1** | Server documentation says it is for “Claude Code agents”; the ambiguity error path is written “so Claude can prompt the user.” | `server/compose-mcp.js:3-10`, `server/compose-mcp.js:220-225`. |
| Compose build → Stratum `explore_design` | **Assumes-Claude A2** | The step is hardcoded to `agent: claude` and tells that agent to launch 2–3 explorer subagents. The observed agent used Claude's `Agent` tool with `subagent_type: Explore`. | `pipelines/build.stratum.yaml:107-119`. |
| Compose build → Stratum blueprint/verification/plan/decompose | **Assumes-Claude A3** | All four phase agents are hardcoded Claude. The ledger recorded Claude Sonnet/Opus dispatches. | `pipelines/build.stratum.yaml:153-216`; profiles at `pipelines/build.profiles.json:5`. |
| Compose build → implementation consumer | **Assumes-Claude A4** | Without the unrequested `--codex` flag, Compose defaults the implementer to Claude and reviewer to Codex. Both observed worktree implementation tasks were Claude. | `lib/build.js:4000-4003`; flag semantics at `bin/compose.js:2700-2708`. |
| Compose build → review triage/lenses/merge | **Assumes-Claude A5** | Review triage, each lens, and merge are hardcoded Claude; every observed review dispatch was Claude. | `pipelines/build.stratum.yaml:250-300`; profiles at `pipelines/build.profiles.json:6-8`. |
| Compose build → coverage test runner | **Assumes-Claude A6** | `coverage` invokes `run_tests`, whose agent is hardcoded Claude. | `pipelines/build.stratum.yaml:80-88`, `pipelines/build.stratum.yaml:324-329`; profile at `pipelines/build.profiles.json:9`. |
| Compose build → docs/ship | **Assumes-Claude A7** | Both downstream phases are hardcoded Claude. They were not reached in this run. | `pipelines/build.stratum.yaml:353-377`; ship profile at `pipelines/build.profiles.json:10`. |

The actual connector confirms what the ledger reports: Compose imports `@anthropic-ai/claude-agent-sdk` and says controlled Claude executions run locally (`lib/local-claude-connector.js:1-24`). `runLocalClaudeAgent` uses that SDK and defaults to `claude-sonnet-5` (`lib/local-claude-connector.js:129-180`), with the full `claude_code` tool preset unless restricted (`lib/local-claude-connector.js:182-196`). Therefore these were not Codex subagents reached through the Codex host; they were Claude Code processes spawned by Compose itself.

## Lifecycle run

### Narrative

I created `HOSTB-HELLO` with `compose feature` in the scratch project. Its scope was a `## Hello from Host B` README section plus a test for that exact heading. The required inner Codex driver read the Claude `/compose` skill and all 15 phase files, performed MCP preflight, and launched the exact required command:

```text
node /Users/ruze/reg/my/forge/compose/bin/compose.js build HOSTB-HELLO
```

The first Stratum flow was `97a0cc34-e6b0-4757-92fa-eb8da3810185`. The design agent first returned the invalid outcome `success`; the contract allowed only `complete|skipped|failed`, so Compose retried and the second attempt was accepted. At `design_gate`, Compose tracker MCP reported no gate while Stratum did. The Codex driver obtained the Stratum gate state and `stratum_gate_resolve` accepted approval, but the foreground runner did not reconcile the external resolution and failed loudly when it tried to resolve the already-resolved gate. `compose build HOSTB-HELLO --resume` then correctly re-entered at blueprint without rerunning design.

Blueprint completed under Claude Opus. Verification was skipped by the runtime triage profile. Plan also required a retry for the same invalid `success` vocabulary, then completed. Decompose produced T1 (README) and T2 (test), with T2 declaring `depends_on: ["T1"]`. The fanout nevertheless started both at stage 0 in parallel. Both Claude worktree agents completed, the merge gate approved, and the merged scratch tree contained the intended README section and executable shell test.

Review triage selected three Claude lenses. Two first failed with `Prompt is too long`; their automatic retries then failed with a visible Claude provider rate-limit error. The remaining diff-quality lens eventually returned, but the `require: all` fanout failed. The first lifecycle flow therefore stopped loudly at review with 208,080 recorded tokens and $14.04413865 recorded cost. It never reached review merge, Codex review, coverage, test review, docs, or ship.

After that failure, both Compose MCP resume and `compose build HOSTB-HELLO --resume` failed; the latter exited 1 with `Nothing to resume` even though active-build/history and Stratum audit recorded failure. `stratum_resume` completed but did not repair Compose recovery. The driver used the documented `--fresh` control, producing flow `99d76a27-c5f1-4b10-bbea-7d527e9f147d`; it restarted from design instead of the failed review. At 25 minutes 20 seconds the outer measurement interrupted its own inner Codex process (exit 130). No audit-owned process remained afterward. The persisted second-flow `active-build.json` still says `running`, which is stale state caused by the measurement interruption.

### Phase-by-phase result

| Phase | Entered? | Agent/connector actually used | Result and stopping behavior |
|---|---:|---|---|
| MCP preflight/session bind | Yes | Inner Codex → Compose MCP | Workspace selection worked; session bind failed loudly with `Unknown workspaceId: proj`. Tracker reads otherwise returned. |
| Design / `explore_design` | Yes | Compose local Claude SDK, `claude-sonnet-5`; observed Claude `Agent` → `Explore` subagent | First result rejected for invalid `success`; retry accepted. This was a loud contract retry, not a skipped phase. |
| Design gate | Yes | Inner Codex → Compose MCP then Stratum MCP | Compose gate list silently returned empty. Stratum approval worked. Foreground build then stopped loudly on already-resolved gate; CLI resume continued at blueprint. |
| PRD | No | Hardcoded Claude if entered | Explicitly skipped by `needs_prd:false`. Optional under the reference lifecycle. |
| Architecture | No | Hardcoded Claude if entered | Explicitly skipped by `needs_architecture:false`. Optional under the reference lifecycle. |
| Blueprint | Yes | Compose local Claude SDK, `claude-opus-5`, xhigh | Completed and wrote a 183-line blueprint with file/line references. |
| Verification | No | Hardcoded Claude if entered | Audit recorded `skipped`; triage changed the feature's initial `needs_verification:true` intent to false. No verifier agent ran. |
| Plan | Yes | Compose local Claude SDK, `claude-sonnet-5` | First result rejected for invalid `success`; retry accepted and wrote a 96-line plan. |
| Plan gate | Yes | Compose runner gate path | Approved; lifecycle continued. |
| Decompose | Yes | Compose local Claude SDK, `claude-sonnet-5` | Produced T1 and T2, including T2's declared dependency on T1. |
| Implement / execute | Yes | Two Compose local Claude SDK worktree consumers, `claude-sonnet-5` | Both succeeded. T1 changed README; T2 added `test/test_readme_heading.sh`. They ran concurrently despite the dependency. |
| Execute merge gate | Yes | Compose runner gate path | Approved; implementation appeared in the main scratch tree. |
| Review triage | Yes | Compose local Claude SDK, `claude-sonnet-5` | Succeeded and selected diff-quality, contract-compliance, and debug-discipline. |
| Review lenses | Yes | Three Compose local Claude SDK consumers, `claude-sonnet-5` | Two exhausted attempts (`Prompt is too long`, then rate limit); fanout failed loudly. First flow terminated failed. |
| Review merge/gate | No | Would be Claude | Not reached because lens fanout required all results. |
| Codex review | No | Would use configured reviewer `codex` | Not reached. The only planned Codex child-agent phase never ran. |
| Coverage / run tests | No | Would be hardcoded Claude | Not reached. |
| Test review | No | Would use configured reviewer `codex` | Not reached. |
| Report | No | Hardcoded Claude if entered | Profile set `needs_report:false`; downstream stage was not reached. |
| Docs | No | Would be hardcoded Claude | Not reached. |
| Ship / ship gate | No | Would be hardcoded Claude | Not reached; no feature commit or completion record exists. |
| Fresh recovery flow | Partially | Compose local Claude SDK | Restarted design; interrupted loudly by the externally enforced 25-minute cap. |

The dispatch ledger contains 36 records. Every completed lifecycle dispatch in the first flow names `agent:"claude"`; the only `reviewerAgent:"codex"` appears in configuration because the Codex review phases were never reached. The feature implementation itself is present and its direct test passes:

```text
PASS: .../proj/README.md contains the '## Hello from Host B' heading
test_exit=0
```

That local test result does not make the lifecycle a pass: the lifecycle did not complete review, coverage, docs, or ship, and Git still has only the initial fixture commit.

## Silent degradations observed

1. **S1 — Compose MCP reported successful empty tracker/gate queries while the CLI/Stratum flow was active.** `get_pending_gates` returned zero at a real `design_gate`; feature lifecycle lookup returned `Item not found`. Only Stratum MCP exposed the running flow. The calls themselves did not error.
2. **S2 — The design prompt required 2–3 explorer subagents, but the Claude design agent launched only one observed `Agent`/`Explore` subagent.** The phase still returned complete and no cardinality check or warning fired.
3. **S3 — Declared task dependency was ignored by execution scheduling.** T2 declared `depends_on:["T1"]`, but `execute/0` and `execute/1` both began in stage 0 and ran concurrently. The fanout implementation merely tells agents to honor dependency fields while configuring concurrency 3; it does not schedule dependency stages (`pipelines/build.stratum.yaml:218-238`).
4. **S4 — Verification intent was silently reduced.** Feature creation initially recorded `needs_verification:true`; build triage changed the runtime profile to `needs_verification:false`, and Stratum recorded the verification step as skipped. The build proceeded without a verification agent or a portability warning.

Loud failures are not counted as silent degradations: the invalid outcome retries, foreground gate reconciliation failure, Claude prompt/rate-limit failures, failed Compose resume, and 25-minute interruption all emitted error text and/or a non-zero exit.

## Constraints hit

- The 25-minute cap was enforced at 25:20 observed process elapsed time. The extra 20 seconds were the polling/interrupt boundary. The resulting second-flow active record is stale `running` state.
- The first flow spent approximately 18 minutes 51 seconds through its terminal review failure and recorded $14.04 of Claude usage. That left insufficient time for a clean full restart.
- Compose recovery had no working path from the terminal review failure: MCP resume failed, CLI `--resume` exited 1, Stratum resume did not restore Compose's resumable state, and `--fresh` restarted at design.
- Provider behavior affected the result: two Claude review agents rejected their prompt as too long, then hit a server-side rate limit on retry. This was loud and is not classified as silent degradation.
- The Compose and Stratum repos already contained unrelated work before this audit. Those files were not modified. The only intended source-repo write from this arm is this report; `ROADMAP.md` and all `audit.json` files were not touched.
- No `~/.codex/config.toml` edit was made. All inner MCP configuration used command-line overrides and `--ignore-user-config`.
- **Constraint violation:** the initial scratch `compose init` was invoked before HOME isolation. `compose init` also performs skill sync, so its output indicates it synchronized Compose skills/agents against the real user agent directories, including `~/.claude`. This should have been run with the isolated HOME. I did not attempt an unsafe rollback because prior contents were unknown. All explicit `compose setup` and subsequent setup measurement used the isolated HOME.
- The full advertised MCP mutation surface was not invoked. Destructive or irrelevant tracker/guard/judgment tools were inventoried but not called; the table distinguishes exposure from measured success.

## What a Codex-hosted lifecycle would need

- A first-class Codex skill/install target rather than mapping Codex to `~/.claude`, Claude agent definitions, and Claude plugins.
- One authoritative lifecycle state plane, or a bridge that makes Compose MCP feature/gate/session queries reflect the same Stratum flow used by `compose build`.
- A reliable non-interactive gate protocol in which an external MCP resolution wakes/reconciles the foreground runner exactly once.
- Host-aware default routing: a Codex-driven build should not silently default every implementation and most lifecycle phases to the Anthropic Claude SDK. Agent/provider choice should be explicit in the command or reported before dispatch.
- Codex-capable equivalents for hardcoded Claude design, blueprint, plan, review, coverage, docs, and ship stages, including host-neutral subagent instructions instead of Claude `Agent`/`subagent_type` semantics.
- Dependency-aware task scheduling that enforces `depends_on`, not just places that field in the consumer prompt.
- Resume state shared between Compose and Stratum so a failed review can continue at review rather than report “Nothing to resume” or require a fresh design restart.
- A checked verification-skip decision that preserves the feature's requested verification policy or emits a blocking/visible explanation when triage downgrades it.
- Outcome vocabulary guidance or normalization so agents do not repeatedly return `success` where the phase contract requires `complete`.

FINDINGS_COUNT: 11

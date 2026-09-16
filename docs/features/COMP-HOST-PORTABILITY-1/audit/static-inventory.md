# COMP-HOST-PORTABILITY-1 static inventory

This is the static arm only. It was derived from the executable dispatchers, not the README: the top-level registry is `lib/cli-commands.js:35-85`, top-level execution dispatch is `bin/compose.js:839-4311`, and the nested dispatchers are `lib/pipeline-cli.js:435-470`, `lib/ideabox-cli.js:123-383`, `lib/cli-remote.js:473-532`, and `lib/tracker/cli.js:3-30`. No Compose command was run.

The command table uses these values:

- **Claude home**: direct or reachable read/write of the user's `~/.claude` tree. Project-local `.claude` operations are called out separately.
- **Agent**: a model-agent launch through the Claude Agent SDK, `claude`, Codex, or `stratum_agent_run`. `Claude CLI (plugin)` means the command may spawn `claude plugin ...`, but not a model session.
- **Server/network**: `:4001`, a remote tracker/SmartMemory provider, package/plugin lookup, or a model provider. `Conditional` means configuration or flags decide it.
- **Git repo**: whether the command refuses without Git. `Conditional` means only an option or downstream path uses Git. A plain **No** is a static negative over the cited handler and its reachable helpers, not a runtime observation.

## 1. COMMAND LIST

| Command | Aliases | Handler / source | Claude home | Agent | Server / network | Git repo |
|---|---|---|---:|---:|---:|---:|
| `compose version` | `--version`, `-V` | inline version branch, `bin/compose.js:110-121` | No | No | No | No (optional Git metadata only) |
| `compose init` | - | `runInit`, `bin/compose.js:375-548`; dispatch `bin/compose.js:839-843` | R/W | Conditional Claude CLI (plugin) | Conditional registry/plugin install | No |
| `compose setup` | `sync` | `runSetup`, `bin/compose.js:602-657`; dispatch `bin/compose.js:845-852` | R/W | Conditional Claude CLI (plugin) | Conditional plugin install | No |
| `compose install` | - | `runInit` + `runSetup`, `bin/compose.js:901-906` | R/W | Conditional Claude CLI (plugin) | Conditional registry/plugin install | No |
| `compose import` | - | `runImport`, `bin/compose.js:908-926`; `lib/import.js:122-246` | R/W if auto-init | Yes, Claude through Stratum | Yes, model/MCP | No |
| `compose doctor` | - | `runDoctor`, `bin/compose.js:302-368`; dispatch `bin/compose.js:854-857` | R | No | Conditional registry lookup | No |
| `compose update` | `upgrade` | `runUpdate`, `bin/compose.js:659-772`; dispatch `bin/compose.js:859-862` | R/W | Conditional Claude CLI (plugin) | Yes, package/git/plugin update | Conditional install style |
| `compose migrate-state` | - | inline state migrator, `bin/compose.js:864-881` | No | No | No | No |
| `compose migrate-anon` | - | `runMigrateAnon`, `bin/compose.js:883-899` | No | No | No | No |
| `compose new` | - | `runNew`, `bin/compose.js:928-1068`; `lib/new.js:63-216` | No | Yes, Claude/Codex through Stratum | Yes, model/MCP | No |
| `compose feature` | - | inline feature creation, `bin/compose.js:1070-1248` | No | No | No | No |
| `compose roadmap` | - | inline show/default, `bin/compose.js:1636-1757` | No | No | No | No |
| `compose roadmap generate` | `gen` | inline generator, `bin/compose.js:1271-1366` | No | No | No | No |
| `compose roadmap add` | - | `addRoadmapEntry`, `bin/compose.js:1374-1485` | No | No | Conditional tracker provider | No |
| `compose roadmap migrate` | - | inline migration, `bin/compose.js:1489-1508` | No | No | No | No |
| `compose roadmap check` | - | inline checker, `bin/compose.js:1512-1545` | No | No | No | No |
| `compose roadmap xref-sync` | - | inline cross-reference sync, `bin/compose.js:1549-1566` | No | No | Yes, tracker provider | No |
| `compose roadmap xref-push` | - | inline cross-reference push, `bin/compose.js:1571-1591` | No | No | Yes, tracker provider | No |
| `compose roadmap graph` | - | inline graph renderer, `bin/compose.js:1597-1634` | No | No | No | No |
| `compose triage` | - | inline `runTriage`, `bin/compose.js:3284-3335` | No | No | No | No |
| `compose qa-scope` | - | inline `qaScope`, `bin/compose.js:3466-3529` | No | No | No | Conditional diff/base |
| `compose build` | - | `runBuild`, `bin/compose.js:2608-2918`; `lib/build.js:3443-6833` | R, policy catalog | Yes, Claude/Codex through Stratum | Yes, model/MCP | Conditional; ship has non-Git fallback (`lib/build.js:7027-7071`) |
| `compose fix` | - | `runBuild(..., mode:'bug')`, `bin/compose.js:2918-3036` | R, policy catalog | Yes, Claude/Codex through Stratum | Yes, model/MCP | Conditional |
| `compose plan` | - | `runBuild(..., mode:'plan')`, `bin/compose.js:3036-3149` | R, policy catalog | Yes, Claude/Codex through Stratum | Yes, model/MCP | Conditional |
| `compose gsd` | `gsd run` | `runGsd`, `bin/compose.js:3194-3283`; `lib/gsd.js:68-510` | No | Yes, Claude/Codex through Stratum | Yes, model/MCP | Yes (`lib/gsd.js:124-129`) |
| `compose gsd query` | - | inline query, `bin/compose.js:3156-3169` | No | No | No | No |
| `compose gsd report` | - | inline report, `bin/compose.js:3174-3192` | No | No | No | No |
| `compose pipeline` | help/default | `runPipelineCli`, `lib/pipeline-cli.js:435-470` | No | No | No | No |
| `compose pipeline show` | - | `pipelineShow`, `lib/pipeline-cli.js:58-93` | No | No | No | No |
| `compose pipeline set` | - | `pipelineSet`, `lib/pipeline-cli.js:137-274` | No | No | No | No |
| `compose pipeline add` | - | `pipelineAdd`, `lib/pipeline-cli.js:309-355` | No | No | No | No |
| `compose pipeline remove` | - | `pipelineRemove`, `lib/pipeline-cli.js:357-390` | No | No | No | No |
| `compose pipeline enable` | - | `pipelineEnable`, `lib/pipeline-cli.js:392-405` | No | No | No | No |
| `compose pipeline disable` | - | `pipelineDisable`, `lib/pipeline-cli.js:407-429` | No | No | No | No |
| `compose experiment` | - | `runExperiment`, `bin/compose.js:2581-2606`; `lib/experiment.js:465-572` | R through child build | Yes, child `compose build` | Yes, child model/MCP | Yes, sandbox/worktree (`lib/experiment.js:255-355`) |
| `compose gates` | top-level `gate` also accepted | missing/unknown-subcommand usage error, `bin/compose.js:3879-3889` | No | No | No | No |
| `compose gates report` | top-level `gate` also accepted | inline report, `bin/compose.js:3680-3749` | No | No | No | No |
| `compose gates list` | top-level `gate` also accepted | inline HTTP client, `bin/compose.js:3751-3798` | No | No | Yes, `:4001` | No |
| `compose gates resolve` | top-level `gate` also accepted | inline HTTP client, `bin/compose.js:3800-3889` | No | No | Yes, `:4001` | No |
| `compose loops add` | - | inline HTTP client, `bin/compose.js:3890-3988` | No | No | Yes, `:4001` | No |
| `compose loops list` | - | inline HTTP client, `bin/compose.js:3990-4037` | No | No | Yes, `:4001` | No |
| `compose loops resolve` | - | inline HTTP client, `bin/compose.js:4039-4111` | No | No | Yes, `:4001` | No |
| `compose loops` | - | missing/unknown-subcommand usage error, `bin/compose.js:4103-4110` | No | No | No | No |
| `compose guard descriptors` | - | `runDescriptorVerification`, `bin/compose.js:1250-1256` | No | No (local Stratum CLI verification) | No | No |
| `compose guard sign` | - | `runGuardSign`, `bin/compose.js:1258-1260` | No | No | No | No |
| `compose guard enrol` | - | `runGuardEnrol`, `bin/compose.js:1261-1264` | No | No | No | No |
| `compose guard` | `guard status` | inline status, `bin/compose.js:2356-2395` | No | No | No | No (Git probe only) |
| `compose guard init` | - | inline config writer, `bin/compose.js:2162-2235` | No | No | No | No |
| `compose guard verify` | - | inline verifier, `bin/compose.js:2237-2324` | No | No | No | No |
| `compose guard install` | - | inline hook install, `bin/compose.js:2326-2343` | No; writes project `.claude` | No | No | No |
| `compose guard uninstall` | - | inline hook removal, `bin/compose.js:2345-2354` | No; writes project `.claude` | No | No | No |
| `compose validate` | - | inline validator, `bin/compose.js:2402-2566` | No | No | Conditional `--external` provider | No |
| `compose record-completion` | - | inline recorder, `bin/compose.js:1760-1935` | No | No | Conditional tracker provider | Conditional evidence |
| `compose lineage stamp` | - | inline lineage writer, `bin/compose.js:3590-3619` | No | No | No | No |
| `compose lineage stale` | - | inline stale checker, `bin/compose.js:3621-3645` | No | No | No | No |
| `compose lineage show` | - | inline lineage reader, `bin/compose.js:3647-3679` | No | No | No | No |
| `compose context decisions` | - | inline decision index, `bin/compose.js:3529-3589` | No | No | No | No |
| `compose items` | `items list` | inline item list, `bin/compose.js:4128-4177` | No | No | No | No |
| `compose items show` | - | inline item reader, `bin/compose.js:4179-4233` | No | No | No | No |
| `compose ideabox` | help/default | `runIdeaboxCommand`, `lib/ideabox-cli.js:123-383` | No | No | No before provider creation | No |
| `compose ideabox add` | - | `runIdeaboxCommand` add branch, `lib/ideabox-cli.js:135-151` | No | No | Conditional fluid provider | No |
| `compose ideabox list` | - | list branch, `lib/ideabox-cli.js:153-193` | No | No | Conditional fluid provider | No |
| `compose ideabox promote` | - | promote branch, `lib/ideabox-cli.js:195-206` | No | No | Conditional fluid provider | No |
| `compose ideabox kill` | - | kill branch, `lib/ideabox-cli.js:208-222` | No | No | Conditional fluid provider | No |
| `compose ideabox resurrect` | - | resurrect branch, `lib/ideabox-cli.js:224-233` | No | No | Conditional fluid provider | No |
| `compose ideabox pri` | - | priority branch, `lib/ideabox-cli.js:235-249` | No | No | Conditional fluid provider | No |
| `compose ideabox discuss` | - | discuss branch, `lib/ideabox-cli.js:251-261` | No | No | Conditional fluid provider | No |
| `compose ideabox triage` | - | triage branch, `lib/ideabox-cli.js:263-312` | No | No | Conditional fluid provider | No |
| `compose ideabox render` | - | render branch, `lib/ideabox-cli.js:314-329` | No | No | Conditional fluid provider | No |
| `compose ideabox adopt-file` | - | adopt branch, `lib/ideabox-cli.js:331-345` | No | No | Conditional fluid provider | No |
| `compose ideabox discard-edits` | - | discard branch, `lib/ideabox-cli.js:347-360` | No | No | Conditional fluid provider | No |
| `compose judgment` | help/default | inline usage branch, `bin/compose.js:3390-3402` | No | No | No | No |
| `compose judgment trace` | - | inline trace renderer, `bin/compose.js:3390-3443` | No | No | No | No |
| `compose metrics` | - | inline metrics summary, `bin/compose.js:4277-4311` | No | No | No | No |
| `compose tracker` | help/default | usage result, `lib/tracker/cli.js:3-9`; dispatch `bin/compose.js:4112-4127` | No | No | No | No |
| `compose tracker status` | - | `runTrackerCli`, `lib/tracker/cli.js:3-23`; dispatch `bin/compose.js:4112-4127` | No | No | Conditional tracker provider | No |
| `compose tracker sync` | - | `runTrackerCli`, `lib/tracker/cli.js:25-30`; dispatch `bin/compose.js:4112-4127` | No | No | Conditional tracker provider | No |
| `compose start` | - | inline server launcher, `bin/compose.js:3335-3366` | No | No | Starts local `:4001` stack | No |
| `compose remote` | help/default | `runRemoteCommand`, `lib/cli-remote.js:473-532` | No | No | No for help | No |
| `compose remote pair` | - | `verbPair`, `lib/cli-remote.js:160-255` | No | No | Yes, `:4001`; optional public URL | No |
| `compose remote list` | - | `verbList`, `lib/cli-remote.js:257-305` | No | No | Yes, `:4001` | No |
| `compose remote revoke` | - | `verbRevoke`, `lib/cli-remote.js:307-343` | No | No | Yes, `:4001` | No |
| `compose remote rotate-secret` | - | `verbRotateSecret`, `lib/cli-remote.js:345-382` | No | No | Yes, `:4001` | No |
| `compose remote status` | - | `verbStatus`, `lib/cli-remote.js:384-463` | No | No | Conditional local/public health checks | No |
| `compose smartmemory` | - | missing/unknown-subcommand usage error, `bin/compose.js:4271-4275` | No | No | No | No |
| `compose smartmemory sync` | - | inline sync, `bin/compose.js:4234-4276` | No | No | Yes, SmartMemory | No |
| `compose hooks` | `hooks status` | inline hook status, `bin/compose.js:2109-2125` | No | No | No | Yes (`bin/compose.js:1983-1992`) |
| `compose hooks install` | - | inline hook installer, `bin/compose.js:2086-2090` | No | No | No | Yes (`bin/compose.js:1983-1992`) |
| `compose hooks uninstall` | - | inline hook removal, `bin/compose.js:2092-2107` | No | No | No | Yes (`bin/compose.js:1983-1992`) |

## 2. CLAUDE-COUPLING INVENTORY

Each row is a distinct source or installed-artifact site. Installed copies are intentionally separate rows because the audit scope explicitly includes them, even where they currently match the repository copy.

| ID | Site | Category | Hardcoded Claude-host assumption | Non-Claude branch? |
|---|---|---|---|---|
| C01 | `bin/compose.js:140-156` | host detection | Treats either a `claude` executable or `~/.claude` as Claude Code; Codex/OpenCode detection exists alongside it. | Yes, Codex/OpenCode. |
| C02 | `bin/compose.js:169-183`, `bin/compose.js:206-228` | `~/.claude` path | Installs/synchronizes Compose skills into `~/.claude/skills` and records `.compose-skills.json` there. | Yes, discovered Codex/OpenCode directories. |
| C03 | `bin/compose.js:230-261` | agent definitions | Copies `compose-*.md` definitions into the sibling `~/.claude/agents` directory inferred from the skill target. | No equivalent Codex agent-definition install. |
| C04 | `bin/compose.js:614-622` | default host | If no supported host is detected, setup defaults to `~/.claude/skills` and labels the target `Claude Code (default)`. | No; this branch chooses Claude. |
| C05 | `bin/compose.js:758-766` | prompt text | Update restart guidance specifically says to reconnect/restart Claude Code after MCP wiring repair. | Generic `/mcp reconnect` is also mentioned. |
| C06 | `bin/compose.js:2131-2146` | hook install path | Canon guard is installed into project `.claude/settings.json` and `.claude/hooks/canon-guard.mjs`. | No host-neutral hook path. |
| C07 | `bin/compose.js:2356-2370` | tool names | Guard status describes Claude runtime interception of `Write`, `Edit`, and `NotebookEdit`. | No. |
| C08 | `lib/cli-commands.js:81-84` | CLI help text | Public help calls the hook command “Claude Code hooks.” | No. |
| C09 | `lib/deps.js:93-123` | `~/.claude` path | Plugin discovery reads `~/.claude/plugins/installed_plugins.json`, marketplaces, and cache. | No for plugin registry; skill checks have their own branches. |
| C10 | `lib/deps.js:170-241` | `~/.claude` path | External-skill discovery searches Claude plugin cache and `~/.claude/skills`. | Yes, package-root and discovered host skill dirs are also searched. |
| C11 | `lib/deps.js:326-404` | Claude binary | Dependency auto-install invokes `claude plugin install ...` and treats missing `claude` as a skipped install. | Fallback-copy branches exist for some deps; no alternate plugin manager. |
| C12 | `lib/install-agent-defs.js:4-21` | agent definitions | Installer is explicitly “Claude Code agent definitions” and reads only `compose-*.md`. | No. |
| C13 | `lib/policy-catalog.js:90-104` | `~/.claude` path | Default policy catalog is `~/.claude/projects/<encoded-cwd>/memory`. | Yes, `memoryDir` config override. |
| C14 | `lib/context-budget.js:116-178` | context paths | Budget scanning has hardcoded `.claude/{agents,skills,rules}` inputs. | Yes, `.agents`, generic skill/rule, and other paths are also scanned. |
| C15 | `lib/context-budget.js:254-280` | prompt/context file | Context ancestry specifically looks for `CLAUDE.md`. | Other context sources are included elsewhere, but this chain is Claude-named. |
| C16 | `lib/context-budget.js:288-361` | host cost model | Classification and estimates model `CLAUDE.md`, Claude agent/skill files, and MCP startup cost. | Partial generic categories only. |
| C17 | `lib/canon-guard.js:1-29`, `lib/canon-guard.js:147-223` | hook/tool contract | Implements Claude `PreToolUse` payloads for `Write`, `Edit`, `NotebookEdit` and emits Claude settings-hook schema. | No. |
| C18 | `.claude/settings.json:33-39` | installed hook | Repository settings wire a `PreToolUse` matcher for Claude tool names to the canon hook. | No. |
| C19 | `.claude/hooks/canon-guard.mjs:3-14`, `.claude/hooks/canon-guard.mjs:21-51` | installed hook/runtime | Runtime wrapper imports Compose guard code and follows Claude hook stdin/stdout/exit semantics. | No. |
| C20 | `lib/judgment-writer.js:158-170` | Claude env | Session metadata reads `CLAUDE_SESSION_ID`. | Yes, it falls back to `null`. |
| C21 | `lib/local-claude-connector.js:13-28` | SDK/env | Imports `@anthropic-ai/claude-agent-sdk` and explicitly handles `CLAUDE_API_KEY` and `CLAUDECODE`. | No in this connector. |
| C22 | `lib/local-claude-connector.js:129-183`, `lib/local-claude-connector.js:218-276` | SDK/process | Defaults `CLAUDE_MODEL` to `claude-sonnet-5`, uses `spawnClaudeCodeProcess`, and reports provider `claude`. | No; provider routing chooses a different connector before this file. |
| C23 | `lib/agent-string.js:23-53`, `lib/agent-string.js:105-121` | default provider | Missing agent strings default to provider `claude`; parser and thinking rules are Claude/Codex-specific. | Yes, explicit `codex:` strings. |
| C24 | `lib/agent-chains.js:58-60` | default provider | Chain normalization defaults missing agent/provider to `claude`. | Explicit provider values survive. |
| C25 | `lib/pipeline-profiles.js:90-104`, `lib/pipeline-profiles.js:194-207` | default provider | Missing stage agent profiles normalize to `claude`. | Explicit profile agents survive. |
| C26 | `lib/pipeline-cli.js:123-127`, `lib/pipeline-cli.js:284-316` | default provider | Flow conversion and new pipeline stages write `claude` when no agent is supplied. | `--agent` can select another value. |
| C27 | `lib/step-validator.js:28-39` | agent literal | Validation repair descriptors hardcode `agent: 'claude'`. | No at this site. |
| C28 | `lib/result-normalizer.js:324-374`, `lib/result-normalizer.js:427-430`, `lib/result-normalizer.js:590-666` | provider/tool contract | Missing step agents default to Claude; Claude profiles get Claude tool filters; only Claude uses the local SDK path. | Yes, Codex and remote-Stratum branches. |
| C29 | `lib/stratum-mcp-client.js:100-132`, `lib/stratum-mcp-client.js:168-188`, `lib/stratum-mcp-client.js:240-251`, `lib/stratum-mcp-client.js:283-294` | default/provider set | MCP descriptors default missing providers to `claude` and reject runtime providers other than Claude or Codex. | Explicit Codex survives; no third-provider branch. |
| C30 | `lib/stratum-mcp-client.js:513-546` | Claude auth/env | Spawned Stratum inherits the full environment specifically so downstream Claude Agent SDK auth (`CLAUDECODE`, OAuth/session env) works. | Full env also carries other providers' credentials. |
| C31 | `lib/import.js:207-228` | agent literal | Import analysis dispatches `agent: 'claude'`. | No. |
| C32 | `lib/new.js:108-159`, `lib/new.js:201-209` | agent literal | Normal new-project steps inherit an engine, but validation repair and gate Q&A force `claude`. | Partial: primary engine is configurable. |
| C33 | `lib/gsd.js:665-683` | default provider | GSD step execution uses `step.agent ?? 'claude'`. | Yes, explicit task agent. |
| C34 | `lib/bug-escalation.js:315-331` | agent literal | Tier-2 fresh-agent escalation hardcodes Claude. | No at this tier. |
| C35 | `lib/build.js:567-592` | default provider | Consumer lane envelopes and review options default missing agents to Claude. | Explicit descriptors survive. |
| C36 | `lib/build.js:1418-1432`, `lib/build.js:1527-1540` | default provider | Admission and execute profiles default to Claude when sidecar data is absent. | Explicit profiles survive. |
| C37 | `lib/build.js:1714-1737`, `lib/build.js:1786-1800` | agent/tool contract | Review defaults to Claude and Claude-only lens certification is attached to the review dispatch/progress data. | Explicit non-Claude reviewer exists, but lens certification is Claude-specific. |
| C38 | `lib/build.js:2164-2176` | role defaults | Pipeline preflight defaults implementer to Claude and reviewer to Codex. | Yes, profile roles override both. |
| C39 | `lib/build.js:3136-3161` | agent literal | Interactive gate “ask agent” dispatch hardcodes Claude. | No. |
| C40 | `lib/build.js:3994-4034` | role defaults | Role resolution defaults implementer to Claude; the `--codex` shortcut flips review to Claude. | Yes, explicit implementer/reviewer flags. |
| C41 | `lib/build.js:4939-4960`, `lib/build.js:5077-5091`, `lib/build.js:5140-5155`, `lib/build.js:6050-6063` | default provider | Ready-item, retry, and fixer descriptors repeatedly fall back to Claude. | Explicit descriptor/profile agent survives. |
| C42 | `lib/build.js:7376-7390` | role default | Fresh bug-mode flow defaults implementer to Claude. | Explicit roles override it. |
| C43 | `lib/review-prompt.js:78-89` | default provider | Review prompt generation defaults `agentType` to `claude`. | Caller may provide another type. |
| C44 | `lib/review-normalize.js:135-143`, `lib/review-normalize.js:241-252`, `lib/review-normalize.js:339-350` | default provider | Review synthesis defaults and labels missing agents as Claude. | Explicit agent metadata survives. |
| C45 | `lib/gate-tiers.js:1-15`, `lib/gate-tiers.js:39-45`, `lib/gate-tiers.js:104-113` | prompt text | Gate tiers describe higher rigor as “Claude multi-lens review.” | No host-neutral label. |
| C46 | `lib/routing-ledger.js:268-288` | routing model | Hardcodes Claude/Codex model ladders and a Claude-only coordinator ladder. | Codex ladder exists; coordinator is Claude-only. |
| C47 | `lib/codex-preflight.js:187-198` | fallback prompt | Codex preflight failure tells callers they may re-run without Codex so “Claude implements.” | Yes, the branch is itself a Codex/Claude choice. |
| C48 | `server/compose-mcp.js:3-10`, `server/compose-mcp.js:194-226` | MCP/tool/prompt contract | Says Claude Code launches the server, instructs callers to use `mcp__stratum__stratum_agent_run`, and phrases errors as instructions to Claude. | No. |
| C49 | `.claude/skills/compose/SKILL.md:15-17`, `.claude/skills/compose/SKILL.md:96-111` | host/MCP tools | Assumes Claude native plan/task/session features and calls `mcp__stratum__stratum_agent_run`. | Yes, fallback text mentions general-purpose Agent or Codex plugin. |
| C50 | `.claude/skills/compose/SKILL.md:148-196`, `.claude/skills/compose/SKILL.md:275-281` | custom agents/tools | Calls `compose-explorer`, `compose-architect`, `EnterPlanMode`, and `ExitPlanMode`. | Built-in Explore/general-purpose fallback is mentioned for some agent calls, not plan-mode tools. |
| C51 | `.claude/skills/compose/SKILL.md:263-263`, `.claude/skills/compose/SKILL.md:340-358`, `.claude/skills/compose/SKILL.md:550-587` | paths/prompt/install | Reads `~/.claude/rules`, treats `CLAUDE.md` as contract, calls Claude Code the executor, and installs skills/agents/plugins into Claude paths. | Partial Codex/fallback guidance. |
| C52 | `/Users/ruze/.claude/skills/compose/SKILL.md:15-17`, `/Users/ruze/.claude/skills/compose/SKILL.md:96-111` | installed host/MCP tools | Installed copy assumes Claude plan/task/session features and Stratum MCP tool names. | Same partial fallbacks as repository copy. |
| C53 | `/Users/ruze/.claude/skills/compose/SKILL.md:148-196`, `/Users/ruze/.claude/skills/compose/SKILL.md:275-281` | installed custom agents/tools | Installed copy calls Compose custom agents and Claude plan-mode tools. | Same partial agent fallbacks as repository copy. |
| C54 | `/Users/ruze/.claude/skills/compose/SKILL.md:263-263`, `/Users/ruze/.claude/skills/compose/SKILL.md:340-358`, `/Users/ruze/.claude/skills/compose/SKILL.md:550-587` | installed paths/prompt/install | Installed copy embeds Claude home paths, `CLAUDE.md`, executor wording, and Claude plugin installation. | Partial Codex/fallback guidance. |
| C55 | `/Users/ruze/.claude/skills/compose/steps/explore_design.md:1-12` | installed tool/agent | Legacy step calls the Claude `Agent` tool with `subagent_type: Explore`. | No. |
| C56 | `/Users/ruze/.claude/skills/compose/steps/review.md:17-32` | installed MCP tool | Legacy step calls `mcp__agent__agent_run`. | No. |
| C57 | `/Users/ruze/.claude/skills/compose/steps/docs.md:9-19` | installed MCP/tools | Legacy step calls `mcp__compose__add_changelog_entry` and names Claude `Edit`/`Write` tools. | Manual file editing is allowed, but still uses Claude tool vocabulary. |
| C58 | `/Users/ruze/.claude/skills/compose/steps/ship.md:21-27` | installed MCP tools | Legacy step calls `mcp__compose__record_completion` and `stratum_audit`. | No. |
| C59 | `.claude/agents/compose-explorer.md:1-8`, `.claude/agents/compose-explorer.md:22-30` | agent definition/tool names | Defines custom `compose-explorer` and instructs use of Claude `Edit`/`Write` tools. | No. |
| C60 | `.claude/agents/compose-architect.md:1-8`, `.claude/agents/compose-architect.md:22-28` | agent definition/tool names | Defines custom `compose-architect` in Claude agent-frontmatter/tool vocabulary. | No. |
| C61 | `/Users/ruze/.claude/agents/compose-explorer.md:1-8`, `/Users/ruze/.claude/agents/compose-explorer.md:22-30` | installed agent definition | Installed `compose-explorer` copy assumes Claude agent/tool semantics. | No. |
| C62 | `/Users/ruze/.claude/agents/compose-architect.md:1-8`, `/Users/ruze/.claude/agents/compose-architect.md:22-28` | installed agent definition | Installed `compose-architect` copy assumes Claude agent/tool semantics. | No. |
| C63 | `.compose-deps.json:5-69`, `.compose-deps.json:73-123` | dependency manifest | Declares Claude plugin installs, `~/.claude` fallbacks, and Stratum MCP tool expectations. | Some entries have copy/command fallbacks or are optional. |
| C64 | `/Users/ruze/.claude/skills/compose/.compose-deps.json:5-69`, `/Users/ruze/.claude/skills/compose/.compose-deps.json:73-123` | installed dependency manifest | Installed manifest repeats Claude plugin, home-path, and MCP-tool assumptions. | Same partial fallbacks as repository manifest. |
| C65 | `lib/import.js:56-70` | context file | Import project-file discovery gives `CLAUDE.md` a first-class slot. | Yes, `AGENTS.md` and generic docs are also recognized. |
| C66 | `.claude/skills/bug-fix/SKILL.md:70-89`, `.claude/skills/bug-fix/SKILL.md:136-143` | skill paths | Deprecated-but-delegated bug-fix instructions require four rules under `~/.claude/rules`. | No alternate rules root. |
| C67 | `.claude/skills/context-budget/SKILL.md:1-16`, `.claude/skills/context-budget/SKILL.md:40-57`, `.claude/skills/context-budget/SKILL.md:69-78` | skill/path/context model | Context-budget instructions model `~/.claude`, project `.claude`, and the `CLAUDE.md` chain as the host's startup context surface. | Partial: MCP is generic, but no alternate host instruction/context roots are scanned by this skill. |
| C68 | `lib/build.js:6997-7128` | prompt/ownership contract | Ship constrains agent-owned documentation paths to include `CLAUDE.md` as a canonical file. | Generic docs are also included; no `AGENTS.md` equivalent in this owned-prefix list. |

## 3. SILENT-FALLBACK CANDIDATES

These are **CANDIDATE** findings only. They are branches where a Claude-specific agent definition, skill/plugin, SDK/auth path, MCP capability/server wiring, hook, or Claude-memory resource can be absent or fail without that condition necessarily throwing out of the command. Dynamic arms must establish actual host behavior and final status.

| ID | Site | Missing/failing resource and fallback | Logging | CLI exit |
|---|---|---|---|---|
| F01 | `bin/compose.js:392-400`, `bin/compose.js:839-843` | **CANDIDATE** - missing Stratum MCP resolution during `init` becomes `hasStratum=false`; init continues. | `console.warn` with resolver error. | `0`. |
| F02 | `bin/compose.js:177-196`, `bin/compose.js:845-852` | **CANDIDATE** - missing Compose skill source makes synchronization return without installing a skill. | Informational `console.log` warning. | `0` for setup/sync. |
| F03 | `lib/install-agent-defs.js:11-21`, `bin/compose.js:239-247` | **CANDIDATE** - absent/unreadable agent-definition source returns an empty list; setup continues with no custom agents. | None for the empty result; caller only logs installed names. | `0` for setup/init/install. |
| F04 | `bin/compose.js:614-622`, `bin/compose.js:845-852` | **CANDIDATE** - no detected supported host falls back to writing the Claude home skill path anyway. | Logs `Claude Code (default)`, but not a missing-host warning. | `0`. |
| F05 | `bin/compose.js:272-286`, `lib/deps.js:445-470` | **CANDIDATE** - required or optional external skills may remain missing after setup; the dependency report does not fail setup. | Printed dependency report; required/optional status shown. | `0` for setup/init/install. |
| F06 | `lib/deps.js:338-340`, `lib/deps.js:376-404`, `lib/deps.js:411-420` | **CANDIDATE** - missing `claude` executable turns Claude plugin installation into `skipped` rather than an exception. | Reported as skipped with reason. | `0` for setup/init/install. |
| F07 | `bin/compose.js:319-368`, `bin/compose.js:854-857` | **CANDIDATE** - `doctor` reports missing required skills but succeeds unless `--strict` is supplied. | Full report on stdout; missing registry shown as unavailable. | `0` normally; `1` with `--strict`. |
| F08 | `lib/deps.js:106-123`, `lib/deps.js:200-229` | **CANDIDATE** - unreadable/missing installed-plugin registry falls back to scanning plugin cache, which can make cached content appear available. | None for registry-read failure itself. | Normally `0`; `doctor --strict` depends on resulting presence check. |
| F09 | `.claude/skills/compose/SKILL.md:96-111` | **CANDIDATE** - missing `mcp__stratum__stratum_agent_run` falls back to the general-purpose Agent tool or Codex plugin. | The instructions do not require a warning at the branch. | N/A: host skill execution, not a Compose CLI process. |
| F10 | `/Users/ruze/.claude/skills/compose/SKILL.md:96-111` | **CANDIDATE** - installed skill has the same Stratum-MCP-to-Agent/Codex fallback. | No required warning. | N/A. |
| F11 | `.claude/skills/compose/SKILL.md:579-587` | **CANDIDATE** - unavailable declared dependencies may use `fallback`, warn-and-continue when optional, or be skipped under `degrade`. | Warning is required for optional/degrade, but fallback use has no separate required severity. | N/A; lifecycle continues. |
| F12 | `/Users/ruze/.claude/skills/compose/SKILL.md:579-587` | **CANDIDATE** - installed skill repeats fallback/optional/degrade continuation rules. | Same as repository copy. | N/A. |
| F13 | `.claude/skills/compose/SKILL.md:581-587` | **CANDIDATE** - if the Compose CLI is unavailable, the host reads the installed `~/.claude/skills/compose/.compose-deps.json` manifest directly and proceeds. | No required warning for CLI absence. | N/A. |
| F14 | `/Users/ruze/.claude/skills/compose/SKILL.md:581-587` | **CANDIDATE** - installed skill repeats the CLI-unavailable direct-manifest fallback. | No required warning. | N/A. |
| F15 | `.claude/skills/compose/SKILL.md:148-196`, `.claude/skills/compose/SKILL.md:550-560`, `docs/features/COMP-HOST-PORTABILITY-1/design.md:11-15` | **CANDIDATE** - calls to `compose-explorer`/`compose-architect` have no runtime preflight; a host may substitute built-ins when definitions are absent. | No repository-side runtime log is mandated. | N/A; host-controlled. |
| F16 | `/Users/ruze/.claude/skills/compose/SKILL.md:148-196`, `/Users/ruze/.claude/skills/compose/SKILL.md:550-560` | **CANDIDATE** - installed skill has the same missing-custom-agent exposure. | No mandated log. | N/A; host-controlled. |
| F17 | `bin/compose.js:2356-2395` | **CANDIDATE** - `guard status` treats an absent Claude hook as status information and continues. | Stdout status (`absent`). | `0`. |
| F18 | `bin/compose.js:2345-2354` | **CANDIDATE** - uninstalling an absent Claude hook is a no-op. | Informational stdout (`No ... hook installed`). | `0`. |
| F19 | `.claude/hooks/canon-guard.mjs:21-28`, `.claude/hooks/canon-guard.mjs:30-51` | **CANDIDATE** - malformed hook input, import failure, or any guard exception fails open and permits the tool call. | None. | `0` from the hook wrapper. |
| F20 | `lib/local-claude-connector.js:251-276`, `lib/result-normalizer.js:635-666`, `lib/build.js:1852-1920`, `lib/build.js:2025-2041` | **CANDIDATE** - Claude SDK/auth/connector failure can be converted into one failed fanout item while other ready items continue. | Failed progress event/summary; some control failures are rethrown. | Conditional: top-level build returns `1` only if final `result.ok === false` (`bin/compose.js:2896-2902`); dynamic confirmation required. |
| F21 | `lib/stratum-mcp-client.js:567-584`, `lib/build.js:3825-3830` | **CANDIDATE** - MCP tool-list failure or missing `stratum_usage_report` silently disables receipt mode rather than failing the build. | None. | Build can return `0`; final build result still governs. |
| F22 | `bin/compose.js:747-768`, `bin/compose.js:859-862` | **CANDIDATE** - update treats failed/skipped Stratum MCP wiring repair as best effort and completes. | Informational stdout with skip reason. | `0`. |
| F23 | `lib/policy-catalog.js:90-104`, `lib/policy-catalog.js:186-194`, `lib/build.js:163-175` | **CANDIDATE** - missing/unreadable default Claude project-memory directory becomes an empty policy catalog, so policy scanning is a no-op. | None; source calls it expected opt-in behavior. | Build can return `0`; final build result governs. |
| F24 | `.compose-deps.json:95-111`, `/Users/ruze/.claude/skills/compose/.compose-deps.json:95-111` | **CANDIDATE** - optional Codex review plugin and Stratum skill dependencies explicitly fall back to an MCP tool or degrade/continue. | Dependency report can show missing/optional state; runtime fallback severity is not specified here. | Setup `0`; lifecycle N/A/continues. |
| F25 | `lib/hooks-status.js:70-90`, `lib/hooks-status.js:135-137`, `bin/compose.js:2109-2124` | **CANDIDATE** - missing Compose-managed Git hooks (the command registry labels these “Claude Code hooks”) become an `absent` status rather than an error. | Informational stdout per absent hook. | `0`. |
| F26 | `bin/compose.js:2092-2106` | **CANDIDATE** - uninstalling a missing Compose-managed Git hook simply continues to the next selected hook. | Informational stdout (`No ... hook installed`). | `0`. |

FINDINGS_COUNT: 94

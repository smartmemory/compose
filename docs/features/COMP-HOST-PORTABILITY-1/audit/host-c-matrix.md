# Host C command matrix — standalone shell, no agent host

Measured 2026-09-16 from the command surface in `compose --help`, `lib/cli-commands.js`, and the dispatch/subcommand branches in `bin/compose.js`. Except for the explicitly required real-HOME lifecycle setup/run, every invocation used:

- cwd: `/private/tmp/claude-501/-Users-ruze-reg-my-forge/12cb24d4-cdb3-44d6-814f-0b9dbcc1efbc/scratchpad/hostaudit/hostc/proj`
- `HOME=/private/tmp/claude-501/-Users-ruze-reg-my-forge/12cb24d4-cdb3-44d6-814f-0b9dbcc1efbc/scratchpad/hostaudit/hostc/home`
- stdin from `/dev/null`
- every `CLAUDE_*`, `CLAUDECODE`, and `CLAUDE_CODE_SESSION_ID` variable removed

In the argv column, `C` expands exactly to `node /Users/ruze/reg/my/forge/compose/bin/compose.js`. Every executed row has a raw `<label>.log` in the [Host C raw-log directory](/private/tmp/claude-501/-Users-ruze-reg-my-forge/12cb24d4-cdb3-44d6-814f-0b9dbcc1efbc/scratchpad/hostaudit/hostc/), containing argv, exit, stdout, stderr, full before/after trees, and SHA-256 content deltas.

Classification used here: `works` means the documented operation or a correct empty-state result completed; `degrades-loudly` means a host/server/auth dependency blocked it with non-zero exit or error text; `degrades-silently` means exit 0 while the documented operation was incomplete and no error-level result was emitted; `fails` means a command defect, hang, or unusable result; `n/a` means the operation was prohibited or its required recovery record did not exist.

| command | argv | exit | classification | evidence | files touched |
|---|---|---:|---|---|---|
| help | `C --help` | 0 | works | Printed all top-level groups and `Run compose <command> --help`. | none |
| version | `C version` | 0 | works | `compose 0.5.1`, git `18bd9c6`, correct install root. | none |
| init | `C init` | 0 | works | `Compose initialized`, `Stratum: enabled`, `Lifecycle: enabled`. Also reported `Agents: claude, codex` in an empty HOME. | 743 files: project scaffold plus fake-HOME Claude agents, skills, plugin cache, and config |
| setup | `C setup` | 0 | works | `+ claude/...`; `~ codex — shares skill dir with claude, skipped`; required deps present. | none (idempotent after init) |
| sync | `C sync` | 0 | works | Same complete dependency report as setup. | none |
| install | `C install` | n/a | n/a | Not run: explicitly prohibited because it runs init plus global setup. | none |
| import | `C import` | 1 | degrades-loudly | After `Scanning project...` / `Analyzing...`: `Error: ... Claude Code returned an error result: Not logged in · Please run /login`. | fake-HOME Claude transcript/MCP logs; dispatch ledger |
| doctor | `C doctor` | 0 | works | `6 of 12 deps missing (0 required, 6 optional).` and `Stratum wiring: ✓ ok`. | `home/.compose/version-cache.json` |
| update | `C update` | n/a | n/a | Not run: explicitly prohibited because it mutates the Compose install. | none |
| upgrade | `C upgrade` | n/a | n/a | Not run: prohibited alias of update. | none |
| new | `C new "Tiny standalone host audit product" --auto` | 1 | fails | The documented quoted-description form was rejected with the usage text; no lifecycle started. | none |
| feature | `C feature HOSTC-MATRIX "Matrix fixture for standalone command measurements"` | 0 | works | `Created .../HOSTC-MATRIX/feature.json`, design seed, and ROADMAP row. | `ROADMAP.md`, design, feature JSON |
| feature (lifecycle setup, real HOME) | `C feature HOSTC-HELLO "Add a hello-world section to README"` | 0 | works | `Feature HOSTC-HELLO ready. Next: compose build HOSTC-HELLO`. | `ROADMAP.md`, design, feature JSON |
| roadmap | `C roadmap` | 0 | degrades-silently | Existing `ROADMAP.md` contained named HOSTC rows, but stdout was exactly two blank lines and no error. | none |
| roadmap generate | `C roadmap generate` | 0 | works | `Generated .../ROADMAP.md from feature.json files`. | `ROADMAP.md` |
| roadmap migrate | `C roadmap migrate` | 0 | works | `Created: 0`, `Updated: 0`, `Skipped: 2 ... HOSTC-HELLO, HOSTC-MATRIX`. | none |
| roadmap check | `C roadmap check` | 0 | works | `feature.json and ROADMAP.md are in sync (fixed point, lossless).` | none |
| roadmap add | `C roadmap add HOSTC-DONE --description "Completion command fixture" --phase Audit --status PLANNED` | 0 | works | `Wrote HOSTC-DONE (PLANNED) and regenerated ROADMAP.md`. | feature JSON, ROADMAP, feature event |
| roadmap xref-sync | `C roadmap xref-sync --dry-run` | 0 | works | `No external-link drift to reconcile (0 resolvable link(s) checked...)`. | none |
| roadmap xref-push | `C roadmap xref-push` | 0 | works | `No external trackers to push (0 push-opted link(s) checked...)`. | none |
| roadmap graph | `C roadmap graph` | 0 | works | `Generated .../roadmap-graph.html — 3 nodes, 0 edges`. | `roadmap-graph.html` |
| triage | `C triage HOSTC-MATRIX` | 0 | works | Produced tier 1 and a four-boolean profile, then `Updated feature.json`. | `HOSTC-MATRIX/feature.json` |
| qa-scope | `C qa-scope HOSTC-MATRIX` | 0 | works | Correct empty-state report: `No filesChanged recorded ... Run a build first`. | none |
| build (real HOME) | `C build HOSTC-HELLO` | 143 (operator TERM) | fails | Reached `design_gate`, printed `Gate delegated to web UI. Waiting for resolution...`, and did not progress. It was terminated after the stable block was established, within the 20-minute cap. | build stream, active build, dispatch ledger, design and feature JSON |
| build (isolated HOME) | `C build HOSTC-HELLO` | 1 | degrades-loudly | First phase failed: `Claude Code returned an error result: Not logged in · Please run /login`. | 49 deltas, mainly fake-HOME Claude/Stratum state plus project build state |
| fix | `C fix HOSTC-MATRIX` | 1 | degrades-loudly | Entered `reproduce`, then `Fix failed: ... Not logged in · Please run /login`. | fake-HOME Claude/Stratum logs plus build stream/state/ledger |
| plan | `C plan "Add a note to README"` | 1 | degrades-loudly | `Starting plan for PLAN-ADD-A-NOTE-TO-README...`; failed at `explore_design` with the login error. | 11 deltas: fake-HOME agent state and project build state |
| gsd | `C gsd HOSTC-HELLO` | 1 | degrades-loudly | With a valid Boundary Map and clean tree: `gsd failed: ... Not logged in · Please run /login`. | 9 deltas including `.compose/gsd/HOSTC-HELLO/*`, fake-HOME agent state, ledger |
| gsd query | `C gsd query HOSTC-HELLO` | 0 | works | JSON reported `status: "failed"`, `phase: "decompose"`, zero completed tasks. | none |
| gsd report | `C gsd report HOSTC-HELLO` | 0 | works | `Milestone report written: .../docs/gsd-reports/HOSTC-HELLO.html`. | milestone HTML |
| pipeline show | `C pipeline show` | 0 | works | Printed the 23-step build pipeline and contracts. | none |
| pipeline set | `C pipeline set explore_design --retries 2` | 0 | works | `Set explore_design retries to 2`. | `pipelines/build.stratum.yaml` |
| pipeline add | `C pipeline add --id hostc_audit --after explore_design --agent claude --intent "Host C audit fixture"` | 0 | works | `Added step "hostc_audit" after "explore_design"`. | build pipeline |
| pipeline disable | `C pipeline disable hostc_audit` | 0 | works | `Disabled hostc_audit (skip_if: "true")`. | build pipeline |
| pipeline enable | `C pipeline enable hostc_audit` | 0 | works | `Enabled hostc_audit`. | build pipeline |
| pipeline remove | `C pipeline remove hostc_audit` | 0 | works | `Removed step "hostc_audit"`. | build pipeline |
| experiment | `C experiment experiment.json --prune-workspaces` | 0 | degrades-silently | stderr: `done (completed=false)` followed by `complete`; results recorded `nCompleted: 0`, `nTotal: 1`. Nested build log contains the Claude login error, but the command still exited 0. | results/report/run artifacts plus fake-HOME Claude/Stratum state |
| gates report | `C gates report` | 0 | works | `No gate log entries found for the specified window.` | none |
| gates list | `C gates list` | 1 | degrades-loudly | Existing server returned `HTTP 400: Unknown workspaceId: proj`. | none |
| gates resolve | `C gates resolve hostc-missing --approve` | 1 | degrades-loudly | Existing server returned `HTTP 400: Unknown workspaceId: proj`. | none |
| loops add | `C loops add --feature HOSTC-MATRIX --kind audit --summary "Host C loop fixture"` | 1 | degrades-loudly | `Failed to list items: {"error":"Unknown workspaceId: proj"...}`. | none |
| loops list | `C loops list --feature HOSTC-MATRIX` | 1 | degrades-loudly | Same explicit unknown-workspace server error. | none |
| loops resolve | `C loops resolve hostc-missing --feature HOSTC-MATRIX --note audit` | 1 | degrades-loudly | Same explicit unknown-workspace server error. | none |
| guard install | `C guard install` | n/a | n/a | Not run: source targets the Compose checkout's `PACKAGE_ROOT/.claude/settings.json`, forbidden by the audit constraint. | none |
| guard uninstall | `C guard uninstall` | n/a | n/a | Not run for the same Compose-repo mutation reason. | none |
| guard status | `C guard status` | 0 | works | Reported current hook and signing state; explicitly says guarded writes are `Claude-runtime only`. | none |
| guard init | `C guard init` | 0 | works | Correct empty state: `No judgment records found — nothing to baseline.` | none |
| guard verify | `C guard verify` | 0 | works | `Judgment canon drift detection passed.` | none |
| guard enrol | `C guard enrol` | n/a | n/a | Not run: source invokes sudo and can mutate `/Library/Compose`, `/private/etc`, and the Stratum trust root. | none |
| guard descriptors | `C guard descriptors` | SIGTERM at 60s | fails | No stdout/stderr before timeout. Despite no result, it left a lock owner and staging descriptor. | guard lock owner; `.compose/guard-upgrades/.staging-*/descriptors.json` |
| guard sign | `C guard sign` | SIGTERM at 60s | fails | Same silent 60-second hang and residual staging state. | modified lock owner; second staging descriptor |
| validate | `C validate --scope=project` | 0 | works | Reported two warnings and `0 at or above --block-on=error`. | none |
| record-completion | `C record-completion HOSTC-DONE --commit-sha=6c73... --tests-pass=true` | 0 | works | JSON returned completion ID and `status_changed` from `PLANNED` to `COMPLETE`. | feature events, ROADMAP, `HOSTC-DONE/feature.json` |
| lineage stamp | `C lineage stamp --feature HOSTC-HELLO` | 0 | works | `2 of 2 artifact(s) updated`: design origin, blueprint derived from design. | design and blueprint |
| lineage stale | `C lineage stale --feature HOSTC-HELLO --changed design.md` | 0 | works | `No stale descendants ... all 1 downstream artifact(s) are newer.` | none |
| lineage show | `C lineage show --feature HOSTC-HELLO` | 0 | works | Printed `blueprint.md ⟵ design.md`. | none |
| context decisions | `C context decisions` | 0 | works | `No decisions recorded yet.` | none |
| items list | `C items list` | 0 | works | After the bounded start probe generated local vision state, listed four feature items. | none |
| items show | `C items show 5de70c5d` | 0 | works | Printed the HOSTC-HELLO item, files, position, and lifecycle. | none |
| ideabox list | `C ideabox list` | 0 | works | Initial empty state: `No ideas yet.` | none |
| ideabox add | `C ideabox add "Host C standalone idea" --desc "Audit fixture"` | 0 | works | `Added IDEA-1: Host C standalone idea`. | event log, record, projection |
| ideabox add (triage seed) | `C ideabox add "Host C triage fixture"` | 0 | works | Added IDEA-2 for the stdin/triage measurement. | event log, record, projection |
| ideabox pri | `C ideabox pri IDEA-1 P1` | 0 | works | `Set IDEA-1 priority → P1`. | event log, record, projection |
| ideabox discuss | `C ideabox discuss IDEA-1 "Standalone audit discussion"` | 0 | works | Printed the dated human comment. | event log, record, projection |
| ideabox kill | `C ideabox kill IDEA-1 "Lifecycle fixture"` | 0 | works | `Killed IDEA-1: Lifecycle fixture`. | event log, record, projection |
| ideabox resurrect | `C ideabox resurrect IDEA-1` | 0 | works | `Resurrected IDEA-1`. | event log, record, projection |
| ideabox promote | `C ideabox promote IDEA-1 HOSTC-IDEA` | 0 | works | Created the feature folder and printed `Promoted IDEA-1 → HOSTC-IDEA`. | event log, record, projection, feature JSON |
| ideabox render | `C ideabox render` | 0 | works | `Rendered .../docs/product/ideabox.md`. | none (already canonical) |
| ideabox triage | `C ideabox triage` | 13 | fails | With stdin `/dev/null`, printed one prompt then Node warned `Detected unsettled top-level await` at `bin/compose.js:3461`. | none |
| ideabox adopt-file | `C ideabox adopt-file` | 1 | n/a | Explicitly refused because `no interrupted migration is recorded`. Recovery behavior could not be exercised honestly. | none |
| ideabox discard-edits | `C ideabox discard-edits` | 1 | n/a | Same absent interrupted-migration prerequisite. | none |
| judgment trace | `C judgment trace hostc-missing` | 1 | n/a | `position hostc-missing does not exist`; scratch project had no judgment records to trace. | none |
| metrics | `C metrics` | 0 | works | Reported model/site dispatch metrics, acceptance, retries, cost, and limitations. | none |
| tracker status | `C tracker status` | 0 | works | Local provider, zero pending ops/conflicts, no mixed sources. | none |
| tracker sync | `C tracker sync` | 0 | works | `drained 0, quarantined 0, pending 0`. | none |
| start (20s probe) | `C start` | SIGTERM at 20s | n/a | Probe bound `:4001`, but first printed `Killing previous supervisor (PID 78021)...`; bounded teardown stopped the replacement. See Constraints. | `.compose/data/vision-state.json` |
| remote help | `C remote --help` | 0 | works | Printed pair/list/revoke/rotate-secret/status usage. | none |
| remote status | `C remote status` | 0 | degrades-silently | Printed `Paired devices: (COMPOSE_API_TOKEN not set — cannot query server)` but returned success for a health/status command. | none |
| remote pair | `C remote pair` | 1 | degrades-loudly | `Error: COMPOSE_API_TOKEN is not set.` plus server-start guidance. | none |
| remote list | `C remote list` | 1 | degrades-loudly | `Error: COMPOSE_API_TOKEN is not set.` | none |
| remote revoke | `C remote revoke hostc-missing` | 1 | degrades-loudly | `Error: COMPOSE_API_TOKEN is not set.` | none |
| remote rotate-secret | `C remote rotate-secret --yes` | 1 | degrades-loudly | `Error: COMPOSE_API_TOKEN is not set.` | none |
| smartmemory sync | `C smartmemory sync --dry-run` | 0 | works | `ingested=7 unchanged=0 skipped=0 failed=0`; dry-run touched no files. | none |
| migrate-state | `C migrate-state` | 0 | works | `state up to date (v2)`. | none |
| migrate-anon | `C migrate-anon --non-interactive` | 0 | degrades-silently | Found six anonymous rows, promoted none, and returned success: `Run interactively in a TTY to promote rows.` | none |
| hooks install | `C hooks install` | 0 | works | Installed project `.git/hooks/post-commit` with workspace ID `proj`. | post-commit hook |
| hooks status | `C hooks status` | 0 | works | `post-commit: installed (current)`; pre-push absent. | none |
| hooks uninstall | `C hooks uninstall` | 0 | works | Removed only the Compose-owned post-commit hook. | deleted post-commit hook |

## Silent degradations observed

1. `compose roadmap` returned 0 with an existing, populated roadmap but emitted no status at all. Exact stdout between the raw-log delimiters was two newline bytes; no expected feature/status line appeared.
2. `compose experiment` returned 0 even though its only nested run failed authentication. Exact stderr: `[experiment] host-c-isolated_claude-isolated_rep1: done (completed=false)` and then `[experiment] host-c-isolated: complete → .../results.json`. `results.json` says `"nCompleted": 0, "nTotal": 1`.
3. `compose remote status` returned 0 while omitting paired-device/server health: `Paired devices:  (COMPOSE_API_TOKEN not set — cannot query server)`.
4. `compose migrate-anon --non-interactive` returned 0 after changing nothing: `Run interactively in a TTY to promote rows.`

Additional phase-level silent degradation, not counted as a `degrades-silently` command row because the overall build did not exit 0: the authenticated `explore_design` phase was instructed to launch 2–3 explorer subagents, but its accepted output said `instead of dispatching explorer subagents` / `no explorer subagents were needed`. The dispatch ledger contains only two top-level Claude attempts and no explorer-agent dispatch. No error or warning was raised for ignoring that phase requirement.

## Lifecycle run: real HOME

The scratch feature was created successfully as `HOSTC-HELLO`. Before the run, `lsof` showed an existing listener on `127.0.0.1:4001` (node PID 78098; `server-before.log`). The build did not need that server to start agent work: it launched Stratum locally and entered `explore_design`.

Observed sequence:

| order | phase/event | result |
|---:|---|---|
| 1 | front triage | tier 0 / `lane=trivial`; profile set `needs_prd`, `needs_architecture`, `needs_verification`, and `needs_report` false |
| 2 | `explore_design`, attempt 1 | Claude Sonnet 5 dispatched successfully; wrote `design.md`; result was rejected only because it returned `outcome: "success"` instead of the contract enum `complete` |
| 3 | `explore_design`, attempt 2 | Claude Sonnet 5 dispatched successfully; reused the artifact and returned the corrected enum; accepted |
| 4 | `design_gate` | printed `Gate delegated to web UI. Waiting for resolution...` and made no further progress |
| 5 | operator stop | the measured build process group was terminated after the stable gate block was established; exit 143; ledger terminal status `aborted` |

Agents actually spawned according to `.compose/data/dispatch-ledger.jsonl`: exactly two `agent:"claude"` build-step dispatches, both model `claude-sonnet-5`; attempt 1 was settled `accepted:false` / `ensure-retry`, attempt 2 `accepted:true`. No Codex dispatch and no `compose-explorer`/`compose-architect` child dispatch were recorded. Total recorded use was 39,750 input tokens, 4,552 output tokens, and USD 0.8852928.

No complete pipeline phase was recorded as skipped before the stop. The triage profile would have made PRD, architecture, verification, and report skippable later, but execution never reached them. Inside `explore_design`, however, the required 2–3 explorer subagents were silently skipped and the result was accepted.

The stop was not loud from Compose: there was no non-zero exit or error until the operator terminated the blocked run. The UI dependency was observable in stdout. A subsequent `gates list` against the already-running server returned `Unknown workspaceId: proj`, so that server could not resolve the scratch gate.

Files changed by the run: build stream, active-build state, dispatch ledger, `HOSTC-HELLO/design.md`, and `HOSTC-HELLO/feature.json`. README was never implemented.

## Lifecycle run: isolated HOME

The repeat used the same feature, empty isolated HOME, `/dev/null`, removed Claude environment variables, and a 10-minute cap. It stopped loudly in 1.8 seconds:

- entered front triage and `explore_design` only;
- attempted one Claude Sonnet 5 dispatch;
- exited 1 with `Build failed: ... Claude Code returned an error result: Not logged in · Please run /login`;
- dispatch ledger recorded `agent:"claude"`, `outcome:"error"`, zero input/output tokens;
- build stream recorded `build_error` and `build_end status:"failed"`;
- no Codex or subagent dispatch occurred and no phase was skipped.

This is a loud authentication failure, not a silent fallback. The attempted dispatch nevertheless wrote Claude transcripts/config backups, Stratum flow metadata, MCP logs, and project build/ledger state into the fake HOME/project (49 content deltas in `build-isolated.log`).

## Constraints hit

- `install`, `update`, and `upgrade` were not run by explicit instruction.
- `guard install` and `guard uninstall` were not run because their implementation targets the Compose checkout's `.claude/settings.json`, violating the rule that this audit may only add its report there.
- `guard enrol` was not run because it invokes sudo and can change `/Library/Compose`, `/private/etc`, and the Stratum source trust root.
- `guard descriptors` and `guard sign` each hung silently until the required 60-second cap. Both left staging/lock files in the scratch project.
- `ideabox adopt-file` / `discard-edits` require an actual interrupted migration, and `judgment trace` requires an existing judgment record. No such state existed, so these are `n/a` rather than fabricated successes.
- The real-HOME build was stopped once it was stably blocked at `design_gate`; it did not consume the full 20-minute maximum. This means downstream lifecycle phases could not be measured in that run.
- The initially running `:4001` server rejected scratch workspace ID `proj`. The later required `start` probe did not merely conflict: Compose itself printed `[supervisor] Killing previous supervisor (PID 78021)...`, replaced that server, bound `:4001`, and then the 20-second probe teardown stopped only its replacement. The original listener was gone afterward (`server-after.log`). No restart was attempted.
- Real-HOME auth files were intentionally not crawled or hashed; the real-HOME lifecycle log diffs the scratch project only. Every isolated-HOME command diffs both the project and the fake HOME.
- To satisfy GSD's clean-tree precondition after earlier measurements, the accumulated scratch fixtures were checkpointed in a second scratch-only commit. No real project or Compose source file was used as a command cwd.

FINDINGS_COUNT: 4

# COMP-HOST-PORTABILITY-1 — final audit report

## 1. Summary

- **“Compose has a standalone CLI”: qualified yes.** Host C recorded 55 `works` rows among 88 command probes, including empty-state and dry-run successes; that does not establish a standalone end-to-end lifecycle ([C, command matrix](audit/host-c-matrix.md)).
- **“Stratum is host-agnostic”: refuted as capability neutrality.** Both connectors completed the small matched flow, but capability, accounting, progress, and failure contracts differ ([D, VERDICT](audit/connector-diff.md#verdict)).
- **Headline: 13 silent/under-delivery findings plus 1 explicitly loud retry finding = 14 inventory rows.** Nine arise in B/C lifecycle/CLI evidence (one loud); five arise in connector measurements, including two controlled fixtures (§4). These are distinct findings, not occurrence counts or proven regressions against a measured A.
- **Host B:** Codex drove MCP/CLI; Claude implemented the README and test, then failed loudly at review, recording **$14.04413865**. Recovery failed; a fresh design restart hit the measurement cap ([B, Lifecycle run](audit/host-b-lifecycle.md#lifecycle-run)).
- **Host C:** authenticated build dispatched two Claude design attempts, then waited indefinitely at a web-UI gate until operator termination; **$0.8852928** recorded. Isolated-HOME build failed loudly on Claude login ([C, Lifecycle runs](audit/host-c-matrix.md#lifecycle-run-real-home)).
- **Recommendation:** stage the investment: declare current host/provider limits and fix lifecycle correctness first, then condition a Codex lifecycle port on a successful bounded pilot (§§9–10).

## 2. Method and what was measured vs. reasoned

Sources were read in the requested order: [design/acceptance criteria](design.md#acceptance-criteria), [controller ledger](progress.md), [S: static inventory](audit/static-inventory.md), [C: standalone measurements](audit/host-c-matrix.md), [B: Codex-driver measurements](audit/host-b-lifecycle.md), and [D: connector differential](audit/connector-diff.md). References below use these letters plus section names. This report is synthesis, not a new lifecycle run or a port.

**MEASURED:** C's argv/exit/output/filesystem deltas; B's actual MCP calls, lifecycle artifacts, dispatch ledger and interrupted recovery; D's authenticated matched flows, background runs, invalid-model probes, and explicitly identified process-boundary fixtures. B/C drivers ran outside Stratum's restricted Codex sandbox to avoid its network/loopback restriction confounding host results ([ledger, Decisions](progress.md#decisions)). A was **not re-measured**. The code's intended Claude Code environment supplies a reference contract, not observed A behavior. Consequently a B/C loss is confirmed against its requested contract or recorded output, not proven exclusive to non-Claude hosts.

**STATIC:** S §2's 68 coupling sites and §3's 26 fallback candidates. No CLI command ran in that arm. F01–F26 remain unconfirmed as exact runtime branches unless the dynamic evidence establishes the particular branch. For example, observing fewer explorers does **not** prove missing agent definitions triggered F15/F16, and missing optional dependencies do **not** prove the plugin-install skip branch F06 fired. S calls some build routes “Claude/Codex through Stratum”; B/C dispatch evidence narrows the actual measured runs to Claude only. D's unexercised capability rows remain source findings; the matched flow does not dynamically certify every option ([S, introduction and §§1–3](audit/static-inventory.md); [B, MCP surface table](audit/host-b-lifecycle.md#mcp-surface-table); [D, Capability table](audit/connector-diff.md#capability-table)).

Classification follows C: `works` includes correct empty states; `degrades-loudly` exposes unavailable dependencies; `degrades-silently` returns success while incomplete without an error-level result; `fails` covers defects/hangs; `n/a` covers prohibited/unavailable probes. “Silent” does not necessarily mean no stdout: informational text can accompany success. Matrix classifications apply only to the listed invocation/preconditions, not every flag combination. The 88 C rows include aliases and repeat fixtures/build variants, so **55/88 is the recorded probe denominator, not 55 distinct fully supported commands** ([C, classification and matrix](audit/host-c-matrix.md)).

The requested phrase “the CLI does not detect its host” needs qualification. It **does detect installed-agent indicators for setup**: `detectAgents()` tests executables/directories, maps Codex to Claude's shared skill tree, and has a Claude default (S C01–C04; `bin/compose.js:140-156,614-622`). That is not detection of the current driving session, nor automatic selection of that session's provider for lifecycle dispatch. Thus unmeasured B expectations below assume identical arguments, credentials, HOME, workspace, server and stdin. They are reasoned expectations only, not measurements or a guarantee ([S §2 C21–C29,C38–C40](audit/static-inventory.md#2-claude-coupling-inventory); [B, Assumes-Claude A2–A7](audit/host-b-lifecycle.md#mcp-surface-table)).

## 3. Command matrix

The complete registry/dispatcher inventory is [S §1](audit/static-inventory.md#1-command-list), derived from `bin/compose.js` and nested dispatchers, not README prose. All 88 C probes are reproduced below; additional inventoried default/usage surfaces follow. Each C cell and evidence item cites the corresponding row of [C's command matrix](audit/host-c-matrix.md). B measured cells cite [B, Setup and probe / Lifecycle run](audit/host-b-lifecycle.md). Aliases `--version/-V`, `roadmap gen`, `gsd run`, `gate …`, `guard`, `items`, and `hooks` share the named handlers; an alias without its own probe is not an extra measurement (S §1).

**A-ref** = `works — reference (not re-measured)`: intended operation with valid prerequisites in the environment the code was written for, **not a measured pass**, and not evidence that the C defect is absent on A. **B-NM** = `not measured (expected same as C: the CLI does not detect its driving host)` with the setup-detection qualification in §2; no observed classification is assigned. This intentionally leaves unmeasured cells unknown rather than fabricating passes.

| Command / measured variant (`compose …`) | A — Claude Code | B — Codex CLI | C — standalone | C evidence / boundary |
|---|---|---|---|---|
| `help` | A-ref | B-NM | works — measured | Printed all top-level groups and `Run compose <command> --help`. |
| `version` | A-ref | B-NM | works — measured | `compose 0.5.1`, git `18bd9c6`, correct install root. |
| `init` | A-ref | works — measured | works — measured | `Compose initialized`, `Stratum: enabled`, `Lifecycle: enabled`. Also reported `Agents: claude, codex` in an empty HOME. |
| `setup` | A-ref | works — measured | works — measured | `+ claude/...`; `~ codex — shares skill dir with claude, skipped`; required deps present. |
| `sync` | A-ref | B-NM | works — measured | Same complete dependency report as setup. |
| `install` | A-ref | B-NM | n/a — constrained; see evidence | Not run: explicitly prohibited because it runs init plus global setup. |
| `import` | A-ref | B-NM | degrades-loudly — measured | After `Scanning project...` / `Analyzing...`: `Error: ... Claude Code returned an error result: Not logged in · Please run /login`. |
| `doctor` | A-ref | B-NM | works — measured | `6 of 12 deps missing (0 required, 6 optional).` and `Stratum wiring: ✓ ok`. |
| `update` | A-ref | B-NM | n/a — constrained; see evidence | Not run: explicitly prohibited because it mutates the Compose install. |
| `upgrade` | A-ref | B-NM | n/a — constrained; see evidence | Not run: prohibited alias of update. |
| `new` | A-ref | B-NM | fails — measured | The documented quoted-description form was rejected with the usage text; no lifecycle started. |
| `feature` | A-ref | works — measured (HOSTB-HELLO) | works — measured | `Created .../HOSTC-MATRIX/feature.json`, design seed, and ROADMAP row. |
| `feature (lifecycle setup, real HOME)` | A-ref | B-NM | works — measured | `Feature HOSTC-HELLO ready. Next: compose build HOSTC-HELLO`. |
| `roadmap` | A-ref | B-NM | degrades-silently — measured | Existing `ROADMAP.md` contained named HOSTC rows, but stdout was exactly two blank lines and no error. |
| `roadmap generate` | A-ref | B-NM | works — measured | `Generated .../ROADMAP.md from feature.json files`. |
| `roadmap migrate` | A-ref | B-NM | works — measured | `Created: 0`, `Updated: 0`, `Skipped: 2 ... HOSTC-HELLO, HOSTC-MATRIX`. |
| `roadmap check` | A-ref | B-NM | works — measured | `feature.json and ROADMAP.md are in sync (fixed point, lossless).` |
| `roadmap add` | A-ref | B-NM | works — measured | `Wrote HOSTC-DONE (PLANNED) and regenerated ROADMAP.md`. |
| `roadmap xref-sync` | A-ref | B-NM | works — measured | `No external-link drift to reconcile (0 resolvable link(s) checked...)`. |
| `roadmap xref-push` | A-ref | B-NM | works — measured | `No external trackers to push (0 push-opted link(s) checked...)`. |
| `roadmap graph` | A-ref | B-NM | works — measured | `Generated .../roadmap-graph.html — 3 nodes, 0 edges`. |
| `triage` | A-ref | B-NM | works — measured | Produced tier 1 and a four-boolean profile, then `Updated feature.json`. |
| `qa-scope` | A-ref | B-NM | works — measured | Correct empty-state report: `No filesChanged recorded ... Run a build first`. |
| `build (real HOME)` | A-ref | fails — measured (review; resume failure) | fails — measured | Reached `design_gate`, printed `Gate delegated to web UI. Waiting for resolution...`, and did not progress. It was terminated after the stable block was established, within the 20-minute cap. |
| `build (isolated HOME)` | A-ref | B-NM | degrades-loudly — measured | First phase failed: `Claude Code returned an error result: Not logged in · Please run /login`. |
| `fix` | A-ref | B-NM | degrades-loudly — measured | Entered `reproduce`, then `Fix failed: ... Not logged in · Please run /login`. |
| `plan` | A-ref | B-NM | degrades-loudly — measured | `Starting plan for PLAN-ADD-A-NOTE-TO-README...`; failed at `explore_design` with the login error. |
| `gsd` | A-ref | B-NM | degrades-loudly — measured | With a valid Boundary Map and clean tree: `gsd failed: ... Not logged in · Please run /login`. |
| `gsd query` | A-ref | B-NM | works — measured | JSON reported `status: "failed"`, `phase: "decompose"`, zero completed tasks. |
| `gsd report` | A-ref | B-NM | works — measured | `Milestone report written: .../docs/gsd-reports/HOSTC-HELLO.html`. |
| `pipeline show` | A-ref | B-NM | works — measured | Printed the 23-step build pipeline and contracts. |
| `pipeline set` | A-ref | B-NM | works — measured | `Set explore_design retries to 2`. |
| `pipeline add` | A-ref | B-NM | works — measured | `Added step "hostc_audit" after "explore_design"`. |
| `pipeline disable` | A-ref | B-NM | works — measured | `Disabled hostc_audit (skip_if: "true")`. |
| `pipeline enable` | A-ref | B-NM | works — measured | `Enabled hostc_audit`. |
| `pipeline remove` | A-ref | B-NM | works — measured | `Removed step "hostc_audit"`. |
| `experiment` | A-ref | B-NM | degrades-silently — measured | stderr: `done (completed=false)` followed by `complete`; results recorded `nCompleted: 0`, `nTotal: 1`. Nested build log contains the Claude login error, but the command still exited 0. |
| `gates report` | A-ref | B-NM | works — measured | `No gate log entries found for the specified window.` |
| `gates list` | A-ref | B-NM | degrades-loudly — measured | Existing server returned `HTTP 400: Unknown workspaceId: proj`. |
| `gates resolve` | A-ref | B-NM | degrades-loudly — measured | Existing server returned `HTTP 400: Unknown workspaceId: proj`. |
| `loops add` | A-ref | B-NM | degrades-loudly — measured | `Failed to list items: {"error":"Unknown workspaceId: proj"...}`. |
| `loops list` | A-ref | B-NM | degrades-loudly — measured | Same explicit unknown-workspace server error. |
| `loops resolve` | A-ref | B-NM | degrades-loudly — measured | Same explicit unknown-workspace server error. |
| `guard install` | A-ref | B-NM | n/a — constrained; see evidence | Not run: source targets the Compose checkout's `PACKAGE_ROOT/.claude/settings.json`, forbidden by the audit constraint. |
| `guard uninstall` | A-ref | B-NM | n/a — constrained; see evidence | Not run for the same Compose-repo mutation reason. |
| `guard status` | A-ref | B-NM | works — measured | Reported current hook and signing state; explicitly says guarded writes are `Claude-runtime only`. |
| `guard init` | A-ref | B-NM | works — measured | Correct empty state: `No judgment records found — nothing to baseline.` |
| `guard verify` | A-ref | B-NM | works — measured | `Judgment canon drift detection passed.` |
| `guard enrol` | A-ref | B-NM | n/a — constrained; see evidence | Not run: source invokes sudo and can mutate `/Library/Compose`, `/private/etc`, and the Stratum trust root. |
| `guard descriptors` | A-ref | B-NM | fails — measured | No stdout/stderr before timeout. Despite no result, it left a lock owner and staging descriptor. |
| `guard sign` | A-ref | B-NM | fails — measured | Same silent 60-second hang and residual staging state. |
| `validate` | A-ref | B-NM | works — measured | Reported two warnings and `0 at or above --block-on=error`. |
| `record-completion` | A-ref | B-NM | works — measured | JSON returned completion ID and `status_changed` from `PLANNED` to `COMPLETE`. |
| `lineage stamp` | A-ref | B-NM | works — measured | `2 of 2 artifact(s) updated`: design origin, blueprint derived from design. |
| `lineage stale` | A-ref | B-NM | works — measured | `No stale descendants ... all 1 downstream artifact(s) are newer.` |
| `lineage show` | A-ref | B-NM | works — measured | Printed `blueprint.md ⟵ design.md`. |
| `context decisions` | A-ref | B-NM | works — measured | `No decisions recorded yet.` |
| `items list` | A-ref | B-NM | works — measured | After the bounded start probe generated local vision state, listed four feature items. |
| `items show` | A-ref | B-NM | works — measured | Printed the HOSTC-HELLO item, files, position, and lifecycle. |
| `ideabox list` | A-ref | B-NM | works — measured | Initial empty state: `No ideas yet.` |
| `ideabox add` | A-ref | B-NM | works — measured | `Added IDEA-1: Host C standalone idea`. |
| `ideabox add (triage seed)` | A-ref | B-NM | works — measured | Added IDEA-2 for the stdin/triage measurement. |
| `ideabox pri` | A-ref | B-NM | works — measured | `Set IDEA-1 priority → P1`. |
| `ideabox discuss` | A-ref | B-NM | works — measured | Printed the dated human comment. |
| `ideabox kill` | A-ref | B-NM | works — measured | `Killed IDEA-1: Lifecycle fixture`. |
| `ideabox resurrect` | A-ref | B-NM | works — measured | `Resurrected IDEA-1`. |
| `ideabox promote` | A-ref | B-NM | works — measured | Created the feature folder and printed `Promoted IDEA-1 → HOSTC-IDEA`. |
| `ideabox render` | A-ref | B-NM | works — measured | `Rendered .../docs/product/ideabox.md`. |
| `ideabox triage` | A-ref | B-NM | fails — measured | With stdin `/dev/null`, printed one prompt then Node warned `Detected unsettled top-level await` at `bin/compose.js:3461`. |
| `ideabox adopt-file` | A-ref | B-NM | n/a — constrained; see evidence | Explicitly refused because `no interrupted migration is recorded`. Recovery behavior could not be exercised honestly. |
| `ideabox discard-edits` | A-ref | B-NM | n/a — constrained; see evidence | Same absent interrupted-migration prerequisite. |
| `judgment trace` | A-ref | B-NM | n/a — constrained; see evidence | `position hostc-missing does not exist`; scratch project had no judgment records to trace. |
| `metrics` | A-ref | B-NM | works — measured | Reported model/site dispatch metrics, acceptance, retries, cost, and limitations. |
| `tracker status` | A-ref | B-NM | works — measured | Local provider, zero pending ops/conflicts, no mixed sources. |
| `tracker sync` | A-ref | B-NM | works — measured | `drained 0, quarantined 0, pending 0`. |
| `start (20s probe)` | A-ref | B-NM | n/a — constrained; see evidence | Probe bound `:4001`, but first printed `Killing previous supervisor (PID 78021)...`; bounded teardown stopped the replacement. See Constraints. |
| `remote help` | A-ref | B-NM | works — measured | Printed pair/list/revoke/rotate-secret/status usage. |
| `remote status` | A-ref | B-NM | degrades-silently — measured | Printed `Paired devices: (COMPOSE_API_TOKEN not set — cannot query server)` but returned success for a health/status command. |
| `remote pair` | A-ref | B-NM | degrades-loudly — measured | `Error: COMPOSE_API_TOKEN is not set.` plus server-start guidance. |
| `remote list` | A-ref | B-NM | degrades-loudly — measured | `Error: COMPOSE_API_TOKEN is not set.` |
| `remote revoke` | A-ref | B-NM | degrades-loudly — measured | `Error: COMPOSE_API_TOKEN is not set.` |
| `remote rotate-secret` | A-ref | B-NM | degrades-loudly — measured | `Error: COMPOSE_API_TOKEN is not set.` |
| `smartmemory sync` | A-ref | B-NM | works — measured | `ingested=7 unchanged=0 skipped=0 failed=0`; dry-run touched no files. |
| `migrate-state` | A-ref | B-NM | works — measured | `state up to date (v2)`. |
| `migrate-anon` | A-ref | B-NM | degrades-silently — measured | Found six anonymous rows, promoted none, and returned success: `Run interactively in a TTY to promote rows.` |
| `hooks install` | A-ref | works — measured | works — measured | Installed project `.git/hooks/post-commit` with workspace ID `proj`. |
| `hooks status` | A-ref | B-NM | works — measured | `post-commit: installed (current)`; pre-push absent. |
| `hooks uninstall` | A-ref | B-NM | works — measured | Removed only the Compose-owned post-commit hook. |

The following S §1 dispatcher surfaces lack a distinct C probe. Their `n/a` means **no measurement**, not absence of an implementation. They are outside the 88-probe tally. Bare usage errors should not be misread as host failures.

| Additional surface | A — reference (not re-measured) | B | C |
|---|---|---|---|
| `pipeline` (default help) | works — intended help | B-NM | n/a — not measured |
| `gates` / `gate` (bare) | fails — intended usage error | B-NM | n/a — not measured |
| `loops` (bare) | fails — intended usage error | B-NM | n/a — not measured |
| `ideabox` (default help) | works — intended help | B-NM | n/a — not measured |
| `judgment` (default help) | works — intended help | B-NM | n/a — not measured |
| `tracker` (default help) | works — intended help | B-NM | n/a — not measured |
| `smartmemory` (bare) | fails — intended usage error | B-NM | n/a — not measured |

`remote --help` is the measured help surface for the inventoried `remote` dispatcher. B also actually exercised `build --resume` (worked after gate reconciliation failure; failed after review with `Nothing to resume`) and `build --fresh` (restarted design, then interrupted). Their overall B classifications are respectively **fails** for failed-review recovery, and **n/a** for completion of the interrupted fresh run; C did not separately measure those switches ([B, Lifecycle run](audit/host-b-lifecycle.md#lifecycle-run)).

## 4. SILENT-DEGRADATION INVENTORY

**14 rows: 13 silent/under-delivery findings and one loud recurring retry included by request.** Rows are distinct mechanisms, not 23 retry occurrences, not the sum of artifact `FINDINGS_COUNT` values, and not an assertion of measured A/B parity differences. Connector rows are included because successful phases/dispatches also lose required evidence or accept incomplete output. Controlled fixtures are labeled. “Branch not localized” means no exact fallback branch was established; a dispatcher or prompt citation is not passed off as the branch. In particular, no S §3 candidate can safely be promoted wholesale from these runs.

| ID | Command / lifecycle phase; host and measurement | Quoted evidence and what was lost | Fallback branch / source | Logging and severity |
|---|---|---|---|---|
| SD01 | `roadmap`; C, exit 0 | C: stdout was “two newline bytes” despite populated named HOSTC rows; no status rendered. | **Branch not localized**; handler `bin/compose.js:1636-1757` (S §1). | No error or warning; blank stdout. [C, Silent degradations observed](audit/host-c-matrix.md#silent-degradations-observed). |
| SD02 | `experiment`; C, exit 0 | `done (completed=false)` then `complete`; results `"nCompleted": 0, "nTotal": 1`. Failed authenticated work was reported as a successful experiment process. | **Branch not localized**; `lib/experiment.js:465-572` is the handler, not a verified fallback (S §1). | Informational completion on stderr; nested build logs contain login error, but parent returns 0. [C, Silent degradations observed](audit/host-c-matrix.md#silent-degradations-observed). |
| SD03 | `remote status`; C, exit 0 | `Paired devices:  (COMPOSE_API_TOKEN not set — cannot query server)`; server/device query omitted. | **Branch not localized**; handler `lib/cli-remote.js:384-463` (S §1). | Informational stdout limitation; no error-level command result. [C, Silent degradations observed](audit/host-c-matrix.md#silent-degradations-observed). |
| SD04 | `migrate-anon --non-interactive`; C, exit 0 | `Run interactively in a TTY to promote rows.` Six anonymous rows found, none promoted. | **Branch not localized**; dispatch `bin/compose.js:883-899` (S §1). | Informational instruction, success exit; no failure-level result. [C, matrix / Silent degradations observed](audit/host-c-matrix.md#silent-degradations-observed). |
| SD05 | `explore_design`; B and C, accepted phases | C: `instead of dispatching explorer subagents` / `no explorer subagents were needed`; zero children. B: only one observed `Agent`/`Explore`, versus required 2–3. | **Branch not localized**. Requirement `pipelines/build.stratum.yaml:107-119` (B A2). Related S F15/F16 at `.claude/skills/compose/SKILL.md:148-196,550-560` and installed copy are **not dynamically confirmed missing-definition fallbacks**. | Output mentions omission on C; neither arm emitted a cardinality warning/error. [C, phase-level observation](audit/host-c-matrix.md#silent-degradations-observed); [B S2](audit/host-b-lifecycle.md#silent-degradations-observed). |
| SD06 | Compose tracker/gate MCP during active design gate; B, calls complete | `{count:0,gates:[]}` at live `design_gate`; lifecycle lookup `Item not found: HOSTB-HELLO`. Active Stratum flow invisible to Compose tracker. | **Branch not localized**; routing `server/compose-mcp.js:148-157,166-167`, definitions `server/mcp-tool-defs.js:237-259` (B MCP table). | Empty gate result has no warning/error; lifecycle lookup has “Item not found” text, but calls complete. [B S1 / MCP surface table](audit/host-b-lifecycle.md#mcp-surface-table). |
| SD07 | Decompose → execute scheduling; B, consumers succeed | `depends_on:["T1"]` yet `execute/0` and `execute/1` both begin at stage 0. Dependency ordering lost. | `pipelines/build.stratum.yaml:218-238`: prompt-only dependency instruction with concurrency 3; **no fallback branch localized** (B S3). | No dependency violation warning; normal execution continues. [B S3](audit/host-b-lifecycle.md#silent-degradations-observed). |
| SD08 | Verification triage; B, lifecycle continues | Initial `needs_verification:true` became `needs_verification:false`; audit recorded `skipped`; no verifier ran. | **Branch not localized**; phase declaration `pipelines/build.stratum.yaml:153-216` (B A3). | Skip is recorded in audit/profile; no warning explaining the requested-policy downgrade. [B S4 / Phase-by-phase result](audit/host-b-lifecycle.md#silent-degradations-observed). |
| SD09 | Design/plan contract retry; **B and C, loud**, included separately | `outcome: "success"` rejected against `complete\|skipped\|failed`. C design and B design/plan each required another attempt. Controller separately reports **23 occurrences across stratum+compose**, each costing a full extra agent dispatch. | **Branch not localized** in the supplied artifacts; phase contract and `ensure-retry` ledger evidence are measured. | **Loud contract rejection/retry**, not a silent pass. B explicitly excludes it from its silent count. The 23 total is controller-supplied scope, not independently recounted from these four artifacts. [B, Narrative](audit/host-b-lifecycle.md#narrative); [C, real-HOME sequence](audit/host-c-matrix.md#lifecycle-run-real-home); audit synthesis instruction for controller count. |
| SD10 | Codex durable background dispatch/poll; connector measurement, exit 0 | `"usdSource": null`, usage has tokens but no USD; foreground estimated accounting absent in background result. | `background.ts:597-643` lacks foreground `usdFromTokens`; D OS-14. Paths relative to Stratum `ts/src/`. | No reported accounting-loss warning; successful terminal result. [D, direct terminal diff / OS-14](audit/connector-diff.md#matched-two-run-measurement-and-actual-diff). |
| SD11 | Codex background cached-token accounting; connector measurement, exit 0 | Raw `"cached_input_tokens":61312`; poll only `{input:74855,output:387}`. Cached input dropped. | `background.ts:622-638` reads `cache_read_input_tokens`; D OS-15. | No reported warning; successful poll. [D, raw stream comparison](audit/connector-diff.md#matched-two-run-measurement-and-actual-diff). |
| SD12 | Matched flow audit submission; **both connectors**, flow completes | Both audit traces show `"usdSource": "legacy"`; connector split/provenance and Codex sandbox evidence cannot be forwarded by `stratum_step_done`. | Frozen surface `contracts/mcp-surface.json:243-258` versus agent result `:1107-1124`; **no fallback branch localized**. | No degradation diagnostic reported; `legacy` is an audit label. This is boundary loss, not proof connector responses omitted those fields. [D, Constraints hit](audit/connector-diff.md#constraints-hit). |
| SD13 | Claude success with empty output; **controlled connector fixture**, resolves | `"claudeSuccessResultEmptyOutput": { "settled": "resolved", "result": { "text": "" } }`; empty successful output accepted. | `connectors/claude.ts:124-200`, no empty-output check (D OS-16). | No rejection/warning reported in fixture; not observed as a live provider failure. [D, Failure-surfacing comparison](audit/connector-diff.md#failure-surfacing-comparison). |
| SD14 | Codex nonzero exit with partial text; **controlled connector fixture**, resolves | `"codexNonzeroExitWithAgentText": { "settled": "resolved", "result": { "text": "partial text" } }` after exit 7; paired Claude non-success rejects. | `connectors/codex.ts:481-489`, accepts agent text without structured API error despite nonzero exit (D FS-3). | No failure-level result in fixture; live invalid-model run instead failed correctly. [D, Failure-surfacing comparison](audit/connector-diff.md#failure-surfacing-comparison). |

S's other candidates—including receipt-mode suppression F21, empty policy catalog F23, hook fail-open F19, missing-plugin/cache branches, and built-in substitutions—remain **STATIC candidates never confirmed dynamically here**. Normal status commands reporting absent optional hooks are not newly promoted to silent findings. C classified `doctor` and `setup` as works despite optional missing dependencies; the measured result takes precedence over speculative escalation of S F05/F07 ([S §3](audit/static-inventory.md#3-silent-fallback-candidates); [C matrix](audit/host-c-matrix.md)).

## 5. Claude-coupling inventory

There are **68 static sites**, not 68 observed runtime failures. The following partition counts each C01–C68 once; source and installed copies are deliberately separate. The [full 68-row table, including every file:line and alternate branch](audit/static-inventory.md#2-claude-coupling-inventory) is the authoritative inventory.

| Category | Count / S IDs | Top sites and effect |
|---|---|---|
| Host discovery, home paths, installation and dependency manifests | 13: C01–04, C09–13, C63–66 | `bin/compose.js:140-156,230-261,614-622`; `lib/deps.js:326-404`; `lib/policy-catalog.js:90-104`. Codex shares Claude skill paths; custom agents and plugin management remain Claude-oriented. |
| Hooks, runtime tool contracts and session environment | 7: C06–08, C17–20 | `lib/canon-guard.js:147-223`; `.claude/settings.json:33-39`; `.claude/hooks/canon-guard.mjs:21-51`; `lib/judgment-writer.js:158-170`. Claude tool interception and session metadata. |
| Context discovery, host wording and ownership | 7: C05, C14–16, C45, C67–68 | `lib/context-budget.js:254-361`; `lib/gate-tiers.js:39-45`; `lib/build.js:6997-7128`. Claude context/startup assumptions and canonical documentation ownership. |
| SDK, provider defaults, routing, repair and phase agents | 26: C21–44, C46–47 | `lib/local-claude-connector.js:13-28,129-183`; `lib/result-normalizer.js:590-666`; `lib/build.js:3994-4034`; `lib/step-validator.js:28-39`; `lib/stratum-mcp-client.js:100-132`. Some explicit Codex branches exist; defaults and repairs remain coupled. |
| MCP/skill/custom-agent instructions, including installed copies | 15: C48–62 | `server/compose-mcp.js:194-226`; `.claude/skills/compose/SKILL.md:148-196,275-281`; `.claude/agents/compose-explorer.md:1-8`; installed legacy review step calls `mcp__agent__agent_run` at `~/.claude/skills/compose/steps/review.md:17-32`. |
| **Total** | **68** | Static coupling, with measured consequences only where §§3–4 and §7 say so. |

## 6. Stratum layer verdict

> **Refuted: the Stratum connector layer is not genuinely host-agnostic.**

That is D's verdict, superseding the design's untested “True at the connector layer” premise. The common envelope is useful: both matched two-step workspace-write flows created exactly two bytes `OK`, passed ensures, and emitted `["planned","ready","usage_debit","result","ready","usage_debit","result","completed"]`. It does not supply interchangeable capabilities ([design, Why](design.md#why); [D, matched measurement / VERDICT](audit/connector-diff.md#verdict)).

D's one-sided list is: **Codex** has sandbox-mode coverage, network/root/approval axes, policy provenance, selectable SDK/exec transport, reasoning events, durable post-restart background control, peer discovery, empty-output enforcement, and bounded foreground JSONL. **Claude** has tool allow/deny controls, thinking configuration, explicit correlated tool-result events, and cache-creation accounting. Background Claude retains reported USD and cached-input detail; Codex polling loses USD/provenance and cached-input detail. These are D OS-1–OS-17, with source-only and live evidence distinguished in its [Capability table](audit/connector-diff.md#capability-table).

Both live invalid-model probes failed loudly (`agent_run_failed`, background `status:"error", exitCode:1`, failed flow step). Diagnostic shape, progress and exit interpretation differ (FS-1–FS-3). The controlled rc=0 structured-error and empty-output probes both rejected on Codex; Claude's controlled empty success and Codex's partial-text/exit-7 acceptance are SD13–SD14. Therefore “refuted” means a provider-discriminated adapter pair with a common envelope, **not** an inability to execute a small flow on both providers ([D, Failure-surfacing comparison](audit/connector-diff.md#failure-surfacing-comparison)).

## 7. Lifecycle end-to-end

| Phase / result | B — Codex driving MCP and CLI | C — direct shell |
|---|---|---|
| Setup / preflight | Scratch README plus test feature; 51 Compose and 25 Stratum tools exposed. Workspace selection succeeds, session bind fails `Unknown workspaceId: proj`. | Scratch README feature; authenticated build starts locally without needing the already-running web server. |
| Design | Claude Sonnet; invalid `success` then accepted retry. One observed Claude `Agent` → `Explore` child, fewer than required. | Two Claude Sonnet attempts; same invalid `success` retry; no explorer children. |
| Design gate | Compose MCP returns empty. Stratum approval advances flow, foreground runner fails on already-resolved gate. `--resume` then reaches blueprint. | `Gate delegated to web UI. Waiting for resolution...`; never advances. Server rejects scratch workspace. |
| PRD / architecture | Explicit profile skips; optional reference behavior, not separately counted as loss. | Not reached; flags false are only prospective skips. |
| Blueprint / verification | Claude Opus writes 183-line blueprint. Verification is actually skipped after true→false downgrade (SD08). | Not reached. |
| Plan / plan gate | Claude Sonnet; same enum retry, 96-line plan; gate approved. | Not reached. |
| Decompose / implement / merge | Claude decomposition, two Claude worktree consumers run concurrently despite dependency. README/test merged and merge gate approved. | Not reached; README not implemented. |
| Review | Claude triage selects three Claude lenses. Two first hit `Prompt is too long`, then rate limits; remaining diff-quality returns, but `require: all` fails loudly. | Not reached. |
| Review merge / Codex review / coverage / test review / report / docs / ship | Not reached. Planned Codex reviewer never dispatched. Report flag false is not an executed downstream skip. | Not reached. |
| Recovery / terminal state | Failed-review resume unavailable; `--fresh` restarts design; interrupted at 25:20, exit 130, leaves stale `running`. | Stable gate block stopped by operator, exit 143, ledger `aborted`; isolated-HOME repeat fails exit 1 on Claude login in 1.8 seconds. |
| Recorded first-flow cost | 208,080 tokens; **$14.04413865**, ~18m51s to review failure. Not total outer Codex-driver/restart spend. | 39,750 input + 4,552 output tokens; **$0.8852928** to gate block. Isolated failure records zero input/output tokens. |

All entries above come from [B, Lifecycle run / phase table / Constraints](audit/host-b-lifecycle.md#lifecycle-run) and [C, real-HOME and isolated-HOME lifecycle sections](audit/host-c-matrix.md#lifecycle-run-real-home). B's direct test said `PASS: .../proj/README.md contains the '## Hello from Host B' heading` and `test_exit=0`; that is an implementation test, not completed lifecycle coverage or ship. Only the initial fixture commit remained (B, Phase-by-phase result).

**Actual agents:** both lifecycle hosts spawned **only Claude via `@anthropic-ai/claude-agent-sdk`** (`lib/local-claude-connector.js:1-24,129-196`; B MCP table). B's Codex is the outer driver, not an implementation child; its ledger has 36 records, which must not be equated with 36 distinct agents. B observed design/blueprint/plan/decompose, two implementation consumers, review triage and three review-lens consumers plus retries and fresh-design activity; one nested Explore was observed. C records exactly two top-level Claude Sonnet dispatches and no explorer/architect children. Downstream hardcoded Claude phases are static evidence, not spawned agents. The separate connector differential's Codex runs are not Compose lifecycle dispatches ([B, phase table/ledger](audit/host-b-lifecycle.md#phase-by-phase-result); [C, real-HOME ledger](audit/host-c-matrix.md#lifecycle-run-real-home)).

## 8. Operability findings surfaced by measurement

**Machine-wide supervisor replacement.** `compose start` does not merely compete for an occupied port. `server/supervisor.js:24` places `.compose-supervisor.pid` in `COMPOSE_HOME`; `killExistingSupervisor()` at `:80-93` reads it, probes that PID and SIGTERMs it without project ownership validation. Starting from any project sharing that install can replace another project's server. During this audit it took down the owner's running server; teardown stopped the replacement, leaving :4001 unbound. C quotes `Killing previous supervisor (PID 78021)...`; the controller/pre-run listener is PID 78098. These are different recorded PIDs (supervisor named by PID file versus listener), not grounds to rewrite either observation. The controller source check establishes the mechanism ([ledger, Incident](progress.md#incident-2026-09-16-host-c-arm); [C, Constraints](audit/host-c-matrix.md#constraints-hit)). No restart was attempted.

**Unresolvable UI gate.** C waited without an application timeout/error until operator termination after `Gate delegated to web UI. Waiting for resolution...`. Gate queries returned `HTTP 400: Unknown workspaceId: proj`; that server could not resolve this scratch workspace. “Forever” here means no built-in termination observed, not an infinite-duration measurement. B's external Stratum approval worked but the foreground Compose runner then tried to resolve an already-resolved gate and failed loudly ([C, real-HOME lifecycle](audit/host-c-matrix.md#lifecycle-run-real-home); [B, Narrative](audit/host-b-lifecycle.md#narrative)).

**Failed review is unresumable through the measured recovery paths.** Compose MCP resume failed; CLI `--resume` exited 1 with `Nothing to resume`; `stratum_resume` completed at the Stratum layer but failed to restore Compose resumability. Thus it would be inaccurate to say that Stratum MCP call itself failed. `--fresh` restarted design rather than review. Earlier post-gate CLI resume did work, so the claim is specific to terminal review failure ([B, MCP table / Narrative / Constraints](audit/host-b-lifecycle.md#lifecycle-run)).

**Two disagreeing lifecycle state planes.** Compose tracker returned empty gates/missing feature while Stratum flow poll/audit exposed the real active flow; successful process-local workspace selection did not make session binding usable. This is SD06 plus the loud bind/reconciliation/recovery failures, not evidence that every tracker tool fails. An outer Codex driver can connect both MCP servers but cannot rely on Compose alone to discover and control its own CLI lifecycle ([B, MCP surface table](audit/host-b-lifecycle.md#mcp-surface-table); `server/mcp-tool-defs.js:105-112`).

## 9. RANKED GAP LIST

Rank is **blocking × cheapness**, with current lifecycle blockers first; small degrading fixes follow before broad optional parity work. S/M/L are engineering scope estimates, not measured elapsed times: S is a localized contract/check, M crosses several runtime/state boundaries, L is a provider integration or lifecycle redesign. **BLOCKS** means prevents a reliable end-to-end Codex-hosted lifecycle (or its necessary recovery) in the measured configuration; **DEGRADES** means execution can continue with lost correctness, capability, evidence or money. Estimates and proposed fixes are reasoned, not implemented work.

| Rank / gap | What breaks; blast radius and evidence | Cost / remediation | Codex lifecycle |
|---|---|---|---|
| G1 — gate addressing and external resolution | C cannot resolve scratch UI gate; B resolves through Stratum then foreground fails. Every headless/external gate client (§8; B/C lifecycle). | **M** — stable workspace/run/gate IDs, explicit headless resolution path, wake/reconcile once, fail visibly when unavailable. | **BLOCKS** |
| G2 — failed-phase resume | Review failure strands costly completed implementation; all interrupted/failed lifecycle consumers (§8; B Narrative). | **M** — preserve failed cursor/history and reconcile Compose/Stratum resume rather than forcing fresh design. | **BLOCKS** recovery |
| G3 — review prompt size and bounded provider recovery | Two required lenses reject oversized prompts then rate-limit; all `require: all` reviews using this path (B review table). | **M** — budget lens context and handle bounded provider retries with resumable state; do not assume the provider rate limit is permanent. | **BLOCKS** measured B run |
| G4 — authoritative lifecycle state bridge | Empty tracker gates and unusable session binding; all MCP-driven monitoring/control (SD06, §8). | **M** — one source of truth or run-ID bridge across tracker, flow, session and active-build state. | **BLOCKS** reliable host control |
| G5 — actual Codex lifecycle provider path | B/C only spawn Claude; Codex quota cannot fund these phases. Shared Claude setup targets, prompt/tool shapes and phase defaults affect the entire pipeline (§§5,7; B A2–A7). | **L** — implement/choose and validate a first-class Compose Codex connector path, route every phase/repair/gate/review, supply host-neutral prompts and real install targets. A new `local-codex-connector.js` is **a gap, not done work**; existing Stratum Codex support alone is insufficient. | **BLOCKS** genuinely Codex-executed lifecycle |
| G6 — outcome enum contract | Full extra dispatch for `success` vs `complete`; both hosts, controller count 23 across projects (SD09). | **S** — align prompt/schema vocabulary and narrowly normalize equivalent completion output before costly retry, with contract checks. | **DEGRADES** cost/latency; loud |
| G7 — honest capability/exit reporting | Silent CLI rows SD01–04 and undisclosed provider expectations confuse shell automation and quota planning (§3). | **S** per command — render roadmap, report incomplete experiment/status/migration distinctly, preflight and print provider/limits. | **DEGRADES** |
| G8 — supervisor ownership | Any start can kill another project's server; machine/install-wide blast radius (§8, incident). | **S** — verify ownership and require explicit takeover or use project-scoped supervisor identity. | **DEGRADES**, potentially interrupts unrelated lifecycles |
| G9 — verification policy preservation | Triage overrides requested verification; any feature relying on mandatory verification (SD08). | **S** — preserve explicit requirements or demand a visible, recorded override before skip. | **DEGRADES** assurance |
| G10 — explorer requirement enforcement | Accepted design lacks required exploration on B/C (SD05). | **S** for count/evidence validation; **M** for portable delegation — specify required evidence, validate it and adapt subagent dispatch. | **DEGRADES** |
| G11 — dependency-aware scheduling | `depends_on` ignored; concurrent dependent tasks across implementation fanout (SD07). | **M** — schedule DAG-ready stages, detect cycles and propagate failures. | **DEGRADES** correctness |
| G12 — success/failure and accounting contracts | Empty/partial successes and lost telemetry across connectors/flow submission; all consumers depending on these fields (SD10–14; D FS-1–3). | **M** — normalize terminal semantics and field names, preserve cost/sandbox provenance through MCP schema and pollers. | **DEGRADES** observability/reliability |
| G13 — explicit provider capability negotiation | Tool filters, sandbox controls, thinking, progress and cancellation differ; all portable flows beyond lowest common path (D OS-1–17). | **L** — typed capability declarations, validation and adapters, with tested unsupported-operation handling; no need to pretend every provider implements every feature. | **DEGRADES** general portability; blocks flows requiring unsupported options |
| G14 — remaining standalone operability defects | `new` quoted form rejected; guard sign/descriptors hang; ideabox triage EOF exits 13; affected CLI users (§3 C rows). | **M** aggregate — independent parser, timeout/lock cleanup and stdin handling fixes. | **DEGRADES** CLI breadth |

G1 and G4 overlap and should share implementation design; costs are not additive person-week quotes. G6 is the cheap, immediately actionable recurring waste, despite being lower than blocking work under the requested ranking.

## 10. Recommendation answering the open question

**Choose something between: make current limits honest and stabilize the lifecycle, then buy a bounded Codex pilot before committing to a full port.** The evidence supports retaining the useful standalone shell surface (55 `works` rows out of 88 probes), but does not support advertising a Codex-executed end-to-end lifecycle or neutral connectors (§§1–3,6–7).

| Path | Engineering cost using §9 | Measured reason to accept or reject |
|---|---|---|
| Invest now in a full Codex-hosted lifecycle | G1–G5 are prerequisites (four cross-boundary M efforts plus L provider integration); G9–G12 supply correctness/accounting; G13 adds broad capability support. | Possible lower-cost quota access is the design motivation, but no measured Compose Codex phase or end-to-end pass exists. D's tiny matched flow proves a foundation, not phase parity. Do not extrapolate its non-comparable prices into lifecycle savings. |
| Keep Claude Code as the only supported lifecycle host; declare CLI limits | Start with S G6–G10 checks/reporting/ownership; still fix M G1–G4 for robust headless/control/recovery behavior. Avoid G5 and broad G13. | Cheapest support promise and consistent with actual spawned agents; it retains Anthropic authentication, spend and review failure exposure even when Codex drives. |
| **Recommended staged path** | First implement honest preflight/reporting, cheap correctness fixes G6–G10, and blocking G1–G4. Then scope G5 to one complete Codex README+test lifecycle with G11–G12 checks and an explicit capability subset; expand G13 only when that pilot passes. | Both measured lifecycles already expose host-independent correctness/control faults. Fixing those benefits current users and supplies a fair basis to price a real provider switch. |

The pilot acceptance test should require design through ship, actual Codex dispatch evidence for each required phase, gates controlled without an unavailable web UI, preserved verification/dependencies, and resume from a deliberately failed review with recorded cost/provenance. Until that passes, document “standalone utilities; Claude-backed lifecycle; Codex can drive MCP but does not automatically become the executor.” This is proposed engineering work only; no connector or runtime change was made by this audit ([design, Open question / non-goals](design.md#open-question-for-the-report-to-answer); B/C/D measurements cited above).

## 11. Measurement side effects and constraints

- **Supervisor incident:** C's bounded start probe killed the supervisor named by the shared PID file and removed the owner's running :4001 service; replacement teardown left it unbound. No restart was attempted. Listener PID 78098 and logged supervisor PID 78021 are preserved separately (§8; [ledger Incident](progress.md#incident-2026-09-16-host-c-arm); [C Constraints](audit/host-c-matrix.md#constraints-hit)).
- **Pre-isolation init:** B ran its initial `compose init` against real HOME, synchronizing `~/.claude` before isolation—an acknowledged constraint violation. The synchronized skill entrypoints and two agent definitions were verified identical to repository copies during this synthesis, making those confirmed resyncs harmless content-wise. This is not a complete before/after home audit: B lacked prior contents and attempted no rollback. Read-only comparison also found a differing `compose/templates/boundary-map.md`, whose provenance/change time is unknown; no claim is made that init changed it. Subsequent explicit setup used isolated HOME ([B Constraints](audit/host-b-lifecycle.md#constraints-hit); comparison of `.claude/skills/{bug-fix,compose,context-budget}/SKILL.md` and `.claude/agents/compose-{explorer,architect}.md` with their installed copies).
- **B time/recovery bound:** the nominal 25-minute cap interrupted at 25:20 because of the polling boundary, leaving second-flow `active-build.json` stale `running`; no audit-owned process remained. The first failed flow consumed ~18m51s/$14.04, leaving insufficient restart time. This stale second-flow state is an interruption side effect, not a completed-run claim. Failed-review recovery paths and provider prompt/rate-limit failures limit what later phases can be claimed to do ([B Constraints](audit/host-b-lifecycle.md#constraints-hit)).
- **B exposure versus exercise:** unrelated/destructive advertised MCP mutation/guard/judgment tools were not called. No `~/.codex/config.toml` edit; inner configuration used command-line overrides and `--ignore-user-config`. Unrelated existing repo work, ROADMAP and audit JSON files were left alone by that arm ([B Constraints](audit/host-b-lifecycle.md#constraints-hit)).
- **C prohibited/recovery commands:** install/update/upgrade were prohibited; guard install/uninstall target the Compose checkout's `.claude/settings.json`; guard enrol invokes sudo and can mutate `/Library/Compose`, `/private/etc` and the Stratum trust root. None were run. No interrupted migration/judgment record existed, so adopt-file/discard-edits/judgment trace recovery was not tested ([C Constraints](audit/host-c-matrix.md#constraints-hit)).
- **C bounded and downstream coverage:** guard descriptors/sign each hung for the 60-second cap, leaving staging/lock files. Authenticated build stopped at the stable design gate before the full 20-minute allowance; downstream phases were never measured. GSD required a second scratch-only checkpoint commit to establish a clean tree. Real HOME auth files were not crawled/hashed; real-HOME run deltas cover only scratch project, whereas isolated probes diff project and fake HOME. No real project/Compose source directory was a command cwd ([C Constraints](audit/host-c-matrix.md#constraints-hit)).
- **D boundary limitation:** frozen `stratum_step_done` admits `output|failure|usage|telemetry`, not connector split/USD provenance/sandbox evidence; both flow audits therefore label USD `legacy`. Direct results/progress, not those audits, are authoritative for provider provenance. Flow state was redirected under `conn/ws/state`; durable runs used supported `~/.stratum/ts/agent_runs/` and were copied to raw evidence ([D Constraints](audit/connector-diff.md#constraints-hit)).
- **D live versus synthetic:** both providers were authenticated. Live Codex invalid-model exit was 1, not historical 0; rc=0 regression checks and partial/empty-success cases used documented connector seams. Unrelated MCP OAuth-refresh noise and a recovered patch-format error remained in raw success logs and were not terminal failures. Model/effort differ; single timing/token/cost observations are not performance comparisons ([D Constraints](audit/connector-diff.md#constraints-hit)).
- **D modification/test boundary:** no test suite ran; its only intended source-repo write was its audit artifact. Stratum config, Compose ROADMAP and all audit JSONs remained untouched by that arm. S has no “Constraints hit” section: its explicit limitation is static inspection with **no commands run**, including installed-copy sites, not dynamic confirmation ([D Constraints](audit/connector-diff.md#constraints-hit); [S introduction](audit/static-inventory.md)).
- **Controller execution constraint:** B/C measurement arms were outside Stratum's restricted Codex sandbox; therefore successful local MCP access does not establish that default sandbox's network/loopback operability. `flow` lineage plus `background:true` was incompatible with a required foreground cancellation ID, so lineage was recorded in the ledger instead ([ledger Decisions](progress.md#decisions)). The report-only synthesis ran no GUI, no lifecycle or paid agent tests, and wrote only this report in the repository.

FINDINGS_COUNT: 14

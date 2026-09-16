# review_triage 1M-context failure — hypothesis controls (2026-09-15)

Related: `../design.md` (rationale), parent `../../COMP-MODEL-ROUTE/`, commits compose `4efe988`
(tier pin), `67274cd` (D6 golden updated; rationale corrected), stratum `603ec78` (default → Sonnet 5).

## The failure under investigation

Flow `05f660fe`, step `review_triage`, `.compose/build-stream.jsonl:141-143`:

```
API Error: Usage credits required for 1M context · turn on usage credits at
claude.ai/settings/usage, or use --model to switch to standard context
```

Usage record for the failing request (`build-stream.jsonl:142`):

| field | value |
|---|---|
| model | `claude-sonnet-4-6` |
| input_tokens | 3 |
| cache_creation_input_tokens | 64,118 |
| cache_read_input_tokens | 0 |
| output_tokens | 320 |

First turn of the session (everything cache-created), ~64K tokens total.

## Hypotheses and how each was eliminated

| # | Hypothesis | Control / evidence | Verdict |
|---|---|---|---|
| 1 | Untiered profile → `modelID: null` → dispatched with **no model** → SDK picks 1M mode (stated by `4efe988`) | `git show 4efe988:lib/local-claude-connector.js` line 157 already reads `opts.model ?? process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6'`; built stratum connector `dist/connectors/claude.js` has the same fallback. Null never reached the SDK as absent. (gpt-6-astra adjudication, verified.) | **Refuted** |
| 2 | **Prompt size** — request exceeded standard context, SDK escalated to 1M | Failing request was ~64K tokens (table above). | **Refuted** |
| 3 | **Model eligibility** — Sonnet 4.6 extended context is credit-gated on this subscription; Sonnet 5 is not | Matched-size probe pair, below. Sonnet 4.6 reached ~216K context with no error. | **Refuted** |
| 4 | A **settings/env 1M pin** loaded by `settingSources: ['project']` | `compose/.claude/settings.json`, `settings.local.json`: no model/context keys. `~/.claude/settings.json`: only `"model": "fable"` (interactive session default; not loaded by an SDK subprocess with project-only sources). Shell env: no `CLAUDE_MODEL`/`ANTHROPIC_MODEL`/1M vars. | **Refuted** |

## The probe pair (hypothesis 3 control)

Both dispatched via `stratum_agent_run agent=claude` — the same stratum connector path compose's
`stratum.agentRun` uses — with an identical read-only prompt: read all 7,828 lines of
`compose/lib/build.js` in 2,000-line chunks and reply `PROBE_OK`. No edits, no shell, no subagents.

| runId | model | cacheCreation (≈ peak context) | cacheRead | output | duration | reported usd | result |
|---|---|---|---|---|---|---|---|
| `fbab69b04168` | `claude-sonnet-5` | 230,425 | 1,729,267 | 1,841 | 62.5s | 2.00 | `PROBE_OK model=sonnet-5 last_line=7829` |
| `96d54209e48e` | `claude-sonnet-4-6` | 215,957 | 1,547,525 | 1,982 | 193.9s | 2.47 | `PROBE_OK model=sonnet-4-6 last_line=7829` |

Both exceeded the 200K standard window. Neither produced the credits error. Earlier control from the
prior session: a nine-token prompt on default Sonnet 4.6 also succeeded. So the error is not a
function of model × size on this path.

Cost note: the reported usd is ~4x the pre-run estimate because each sequential chunk re-reads the
whole growing cache (1.5–1.7M cache-read tokens per probe). Estimate cumulative cache reads, not
first-turn tokens, before repeating this.

## What remains

Differences between the probes and the failing dispatch that were NOT controlled:

- compose's `review_triage` dispatch options: `effort`, `thinking`, `permissionMode: acceptEdits`,
  `tools: { type: 'preset', preset: 'claude_code' }`, `settingSources: ['project']`
  (`server/agent-workspace.js`, `lib/local-claude-connector.js`, `lib/stratum-mcp-client.js:190`).
- The env compose's own stratum MCP client process builds for the worker, vs. this session's
  stratum MCP server env.
- A transient server-side condition on the day of `05f660fe`.

**Decisive test:** run `review_triage` for real on a build. On 2026-09-15 this was blocked twice:

1. `compose build COMP-TUI-4 --quick --fresh` died at `explore_design` — the step's
   `ensure: result.outcome == 'complete'` contradicted its `PhaseResult` contract (`skipped` legal)
   when the design already existed. Fixed separately (see CHANGELOG, "skipped is legal only alongside
   file_exists"). `docs/features/COMP-TUI-4/audit.json` holds both attempts.
2. `compose build COMP-TUI-4 --team review` refused with `ROUTING_ROOT_DRIFT` — correct, a different
   spec against COMP-TUI-4's sealed start. `--route-mode=off` did not help because
   `lib/build.js planWithRouting` sets `mode = priorRouting ? 'shadow' : options.mode`; the CLI's
   remedy text is wrong on that path.

## Also observed

- `presets/team-feature`, `team-research`, `team-review`: nine untiered Claude profile entries
  (`claude:orchestrator`, `claude:read-only-reviewer`) with the same default-dependence the build
  sidecars had before `4efe988`. Not changed.
- The failed `--fresh` run flipped `docs/features/COMP-TUI-4/feature.json` status `PLANNED →
  IN_PROGRESS` on start and did not revert on failure.

## CORRECTED 2026-09-16 — see `root-cause-toolsearch-deferral-2026-09-16.md`

Root cause found: explicit SDK `tools` list (from compose `allowedTools`) omits `ToolSearch`,
so MCP schemas are inlined on the post-connect turn (511K tokens) and Sonnet 4.6 escalates to 1M.
Two statements above are wrong: the 64,118-token record is the successful FIRST turn (the failing
continuation has no usage record), and the dispatch used the explicit orchestrator tool list, not
the preset. The four refutations stand.

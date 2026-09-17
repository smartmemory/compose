# <Feature Name>: Design


## Why

Flow 05f660fe died at review_triage with "API Error: Usage credits required for 1M context". Commit 4efe988 pinned claude:<template>:standard on the three review profiles as a fix, but its stated mechanism ("dispatched with no model") was false: lib/local-claude-connector.js:157 and the built stratum connector already fell back to claude-sonnet-4-6 at that commit. Three further hypotheses were eliminated with evidence on 2026-09-15: (1) prompt size — the failing request was 64,118 cache-creation + 3 input tokens (.compose/build-stream.jsonl:142), far under 200K; (2) model eligibility — a matched-size read-only probe pair through the same stratum connector path reached ~216K (claude-sonnet-4-6, run 96d54209e48e) and ~230K (claude-sonnet-5, run fbab69b04168) context with no credits error; (3) a settings/env 1M pin — none in project .claude settings, user settings, or shell env. Remaining candidates are specific to compose's review_triage dispatch shape (effort/thinking/tool preset/permissionMode, or the env compose's own stratum client builds) or a transient server-side condition that day. The only decisive test is running review_triage for real; that was blocked on 2026-09-15 by the explore_design ensure/contract contradiction (fixed separately) and by ROUTING_ROOT_DRIFT correctly refusing a different spec against COMP-TUI-4's sealed start. Also observed: --route-mode=off is silently ignored when prior routing exists (lib/build.js planWithRouting: mode = priorRouting ? 'shadow' : options.mode), so the CLI's remedy text is wrong on that path; and presets/team-{feature,research,review} carry nine untiered Claude entries with the same default-dependence as the pre-4efe988 build sidecars.


## Resolution (2026-09-17)

**Root cause found and fixed.** Not a model-eligibility, prompt-size, or settings problem — all three
were correctly eliminated on 2026-09-15. The cause was tool-list shape: `ClaudeConnector` maps an
explicit `allowedTools` onto the SDK `tools` option, and compose's `orchestrator` template
(`server/agent-templates.js:27`) sends `[Read,Grep,Glob,Agent,Bash]`. That list omits `ToolSearch`,
which is the mechanism Claude Code uses to DEFER MCP tool schemas. Without it, every configured MCP
schema is inlined on the first turn after the servers connect: 511,214 cache-creation tokens for a
one-line `echo`, which pushes `claude-sonnet-4-6` past its 200K window onto the 1M tier, and the API
refuses. On `claude-sonnet-5` the same dispatch succeeded and billed ~$3.26 per trivial turn, so
this was also a silent cost defect on every tiered dispatch since stratum `603ec78`.

Fixed in stratum `f250d9e6746276cfc79ef311fe56d1f2008ea503` (`origin/main`). Full control table,
the two corrected facts from the 2026-09-15 pass, and the live-fire A/B are in
`evidence/root-cause-toolsearch-deferral-2026-09-16.md`.

Two follow-ups were deliberately NOT taken here and remain open decisions: whether stratum should
pass `settingSources`/`--strict-mcp-config` so a compose step does not inherit the account's entire
MCP roster at all (the fix restores deferral, but the roster still loads), and re-pricing the
dispatch-ledger rows since `603ec78` that carry ~500K-token turns caused by this defect.

**Status:** DESIGN
**Date:** <date>

## Related Documents

<!-- Link to roadmap, dependencies, and related features -->

---

## Problem

<!-- Describe the problem this feature solves -->

## Goal

<!-- What does success look like? Scope and non-scope. -->

---

## Decision 1: <Title>

<!-- Describe the decision, options considered, and rationale -->

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| | | |

## Open Questions

<!-- List unresolved questions -->

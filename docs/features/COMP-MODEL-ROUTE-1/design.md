# <Feature Name>: Design


## Why

Flow 05f660fe died at review_triage with "API Error: Usage credits required for 1M context". Commit 4efe988 pinned claude:<template>:standard on the three review profiles as a fix, but its stated mechanism ("dispatched with no model") was false: lib/local-claude-connector.js:157 and the built stratum connector already fell back to claude-sonnet-4-6 at that commit. Three further hypotheses were eliminated with evidence on 2026-09-15: (1) prompt size — the failing request was 64,118 cache-creation + 3 input tokens (.compose/build-stream.jsonl:142), far under 200K; (2) model eligibility — a matched-size read-only probe pair through the same stratum connector path reached ~216K (claude-sonnet-4-6, run 96d54209e48e) and ~230K (claude-sonnet-5, run fbab69b04168) context with no credits error; (3) a settings/env 1M pin — none in project .claude settings, user settings, or shell env. Remaining candidates are specific to compose's review_triage dispatch shape (effort/thinking/tool preset/permissionMode, or the env compose's own stratum client builds) or a transient server-side condition that day. The only decisive test is running review_triage for real; that was blocked on 2026-09-15 by the explore_design ensure/contract contradiction (fixed separately) and by ROUTING_ROOT_DRIFT correctly refusing a different spec against COMP-TUI-4's sealed start. Also observed: --route-mode=off is silently ignored when prior routing exists (lib/build.js planWithRouting: mode = priorRouting ? 'shadow' : options.mode), so the CLI's remedy text is wrong on that path; and presets/team-{feature,research,review} carry nine untiered Claude entries with the same default-dependence as the pre-4efe988 build sidecars.

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

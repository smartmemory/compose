---
date: 2026-06-09
session_number: 69
slug: mcp-roadmap-read
summary: get_roadmap read primitive closes the roadmap read-side gap; /roadmap skill rewired to prefer it
feature_code: COMP-MCP-ROADMAP-READ
closing_line: The question wasn't 'do we have the primitive' — it was 'why doesn't anyone use it,' and the answer was that the read half was never built.
---

# Session 69 — COMP-MCP-ROADMAP-READ

**Date:** 2026-06-09
**Feature:** `COMP-MCP-ROADMAP-READ`

## What happened

The human asked whether we had roadmapping primitives in the MCPs. We did — but only writers (add_roadmap_entry, set_feature_status) and adjacent reads (get_vision_items, roadmap_diff). The follow-up question was sharper: why does everything read ROADMAP.md directly instead of using them? Tracing the code surfaced the real shape: there are TWO roadmaps with opposite ownership. compose's own roadmap is feature.json-backed (ROADMAP.md is a rendered artifact); forge-top is narrative-owned (the file IS canon). The direct-read habit is correct for narrative-owned but a stale-view leak for feature.json-backed — and the global /roadmap skill, being file-first and read-only, would confidently present a stale rendered artifact as truth. Root cause: the MCP surface was write-complete but read-incomplete. No tool returned the rendered roadmap, so there was no in-band alternative to Read ROADMAP.md. We built that missing read primitive.

## What we built

`lib/get-roadmap.js` — pure getRoadmap(root, opts): branches on isNarrativeOwned (reads file verbatim, no console.warn) vs generateRoadmap (in-memory render from canon, never writes); reuses parseRoadmap for rows; reports stale/drift vs on-disk ROADMAP.md by stripping the volatile **Last updated:** line; defaults to a token-safe summary format. Wired toolGetRoadmap into server/compose-mcp-tools.js, registered + dispatched get_roadmap in server/compose-mcp.js, added it to the reviewer read-only allowlist in server/mcp-tool-policy.js. test/get-roadmap.test.js (11 tests). Rewired ~/.claude/skills/roadmap/SKILL.md to prefer get_roadmap (step 0) when a compose MCP server is connected, surface drift, and fall back to file-read otherwise.

## What we learned

1. The design-gate Codex pass earned its keep: it corrected four wrong assumptions about the code before any implementation — generateRoadmap warns on the narrative branch (so we branch on isNarrativeOwned ourselves), **Last updated:** is date-only (per-day, not per-call) so strip the whole line rather than literal-match, there is no single shared row parser (parseRoadmap is the reuse target; validate_project scans independently), and parseRoadmap yields description/phaseId not title/phase. 2. The impl-review Codex pass caught what tests missed: parseRoadmap rewrites codeless rows to _anon_${position}, not the '—' glyph, so our named-row filter leaked _anon_* codes into active/blocked. Tests passed because the fixtures only had real codes — a reminder that anonymous/edge rows need explicit fixtures. 3. Building the fixture revealed parseRoadmap only recognizes the real 4-column `| # | Feature | Description | Status |` layout; a hand-rolled 3-column table parses every row as anonymous. 4. The guard (capabilities.guard) refused a direct COMPLETE on add_roadmap_entry — completion is lifecycle-owned and evidence-gated, so we added as PLANNED then flipped via record_completion bound to the real commit SHA.

## Open threads

- [ ] get_roadmap is not live in the running MCP server (it predates the code change); a server restart is needed before the /roadmap skill can actually call it. Not restarted here per the no-restart-without-asking rule.
- [ ] Not pushed to remote yet — pre-push runs the full npm test (proof-run hang risk) and a running server can break it via port conflict; left for the human to push.
- [ ] The /roadmap skill edit lives in the user's global ~/.claude/skills/, outside the compose repo — tracked here but not under compose version control.

---

*The question wasn't 'do we have the primitive' — it was 'why doesn't anyone use it,' and the answer was that the read half was never built.*

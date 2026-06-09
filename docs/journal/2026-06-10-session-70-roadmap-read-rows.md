---
date: 2026-06-10
session_number: 70
slug: roadmap-read-rows
summary: get_roadmap gains general filtered rows[] + limit so /roadmap next reads PLANNED structured
feature_code: COMP-MCP-ROADMAP-READ-1
closing_line: The follow-up wasn't scope creep — it was the half of 'what to work on next' that the first cut left reading the markdown.
---

# Session 70 — COMP-MCP-ROADMAP-READ-1

**Date:** 2026-06-10
**Feature:** `COMP-MCP-ROADMAP-READ-1`

## What happened

Right after shipping get_roadmap, the human asked what the benefit of a general rows list would be. The honest answer was that it wasn't symmetry for its own sake — it was a real functional hole: the /roadmap skill's 'what to work on next' recommendation needs the PLANNED list, but get_roadmap only exposed PLANNED as a count (summary.planned). The active/blocked convenience lists are fixed-status, so to recommend next the skill would fall back to format:markdown and re-parse the table — the exact direct-read behavior the whole feature existed to kill. So get_roadmap closed the leak for active/blocked but quietly reopened it for PLANNED. The human said build it now, so we did.

## What we built

Extended lib/get-roadmap.js with a `limit` input (default 50) and a general filtered rows list. When status/phase/limit is supplied, the output gains `rows` (named rows matching the status+phase filter via the same matchFilter/pick/_anon_-exclusion path as active/blocked), `rowsTotal` (pre-cap), and `rowsTruncated`. With no filter the summary call stays token-safe (rows omitted). Updated the MCP inputSchema in server/compose-mcp.js (limit integer/minimum:0, richer description). Rewired ~/.claude/skills/roadmap/SKILL.md's next path to call get_roadmap({status:'PLANNED', limit:10}) and read rows instead of re-parsing markdown. 6 new tests (17 total in the file).

## What we learned

1. Codex impl-review caught a token-safety footgun the happy-path tests missed: the first cut emitted rows whenever limit was non-null but only honored non-negative integers, so limit:-1 or limit:1.5 silently fell back to 50 — a caller asking for FEWER rows could get MORE. Fixed with Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 50, an integer/minimum:0 schema, and explicit negative/fractional/zero tests. The lesson: any 'cap' input needs adversarial values tested, not just the nominal one. 2. The emit-on-intent rule (rows only when status/phase/limit given) is what keeps the default dashboard call cheap while making the targeted call useful — same tool, two cost profiles. 3. Dogfooding hit the live/code skew again: get_roadmap on the running MCP server still ran the pre-rows code, so the new rows didn't appear — we verified the new roadmap row landed via the summary.planned count incrementing 94→95 instead. The running server is always one reconnect behind committed code.

## Open threads

- [ ] The rows enhancement is committed + pushed but NOT live in the running MCP server (same as before — needs an /mcp reconnect to load). Until then get_roadmap serves the count-only shape and the /roadmap next rewire can't exercise rows.
- [ ] Noticed unrelated uncommitted working-tree changes from a concurrent session (bin/compose.js, test/init.test.js, an untracked COMP-MIGRATE-ON-UPGRADE / lib/state-migrations.js); left them untouched and committed only our own staged files.

---

*The follow-up wasn't scope creep — it was the half of 'what to work on next' that the first cut left reading the markdown.*

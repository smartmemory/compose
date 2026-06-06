---
date: 2026-06-07
session_number: 62
slug: roadmap-graph-generator
summary: "COMP-ROADMAP-GRAPH-1 v1: generic roadmap dependency-graph generator (schema + lib core + CLI + MCP), dangling-edge refusal, idempotent --check gate; Codex caught external-prefix edge gap."
feature_code: COMP-ROADMAP-GRAPH-1
closing_line: A graph that refuses to lie about edges it can't draw.
---

# Session 62 — COMP-ROADMAP-GRAPH-1

**Date:** 2026-06-07
**Feature:** `COMP-ROADMAP-GRAPH-1`

## What happened

Built COMP-ROADMAP-GRAPH-1 v1 via /compose build (full-auto). The feature folder already held a roadmap-level plan.md (design of record) but no vision item, no blueprint, and zero code — genuinely greenfield. The human chose v1-narrow scope (Phases 1+2: schema + generator core + CLI + MCP), deferring enforcement templates and the forge-top dogfood as follow-ups. Two Explore agents researched the real compose substrate and SmartMemory's hand-maintained roadmap-graph.html (origin + template donor). Their findings corrected the plan's API guesses (no `derive_workspace_id`; status lives in feature.json via readFeature, not a lifecycle query; ROADMAP fallback via parseRoadmap whose code-column detection keys off a `Feature` header). Implemented collect→model→render with a packaged Cytoscape/dagre template, wired the CLI subcommand + two MCP tools, then ran a Codex review loop (2 iterations to REVIEW CLEAN).

## What we built

New: lib/roadmap-graph/{index,collect,model,render,config}.js + template.html; contracts/roadmap-deps.schema.json + roadmap-graph-frontmatter.schema.json; test/roadmap-graph.test.js + test/integration/roadmap-graph.test.js (27 tests). Edited: bin/compose.js (`compose roadmap graph` subcommand), server/compose-mcp.js + compose-mcp-tools.js (roadmap_graph / roadmap_graph_check), server/mcp-tool-policy.js (reviewer allowlist += roadmap_graph_check). Filed follow-ups COMP-ROADMAP-GRAPH-1-1 (enforcement) and -1-2 (dogfood).

## What we learned

1. The plan's substrate API names were mostly guesses; grounding the blueprint in two parallel research passes turned a vague spec into citable file:line facts before any code. 2. roadmap-parser's column detection requires a `Feature` header (not `Code`) and codes that pass isFeatureCode — a test fixture using `| # | Code |` silently parsed every code as anonymous. 3. Codex's highest-value catch: external-prefix (cross-project STRAT-) handling only covered ROADMAP-only rows, so a deps.yaml edge to an external code absent from ROADMAP would have tripped DANGLING_EDGE — fixed by post-scanning edge endpoints and treating external-prefixed codes as known-but-unrendered. 4. Idempotency hinged on emitting no wall-clock timestamp; that single decision makes `--check` a trustworthy CI gate. 5. MCP tools must return summaries, not the HTML body — the oversized-return cap that bit set_feature_status would have bitten this too.

## Open threads

- [ ] COMP-ROADMAP-GRAPH-1-1: pre-commit hook + CI gate + hand-edit sentinel lint
- [ ] COMP-ROADMAP-GRAPH-1-2: generate forge/docs/roadmap-graph.html (dogfood) + docs/howto/roadmap-graph.md
- [ ] No compose feature declares deps.yaml yet, so the live graph has 0 edges — seeding a few would exercise edge rendering in anger
- [ ] SmartMemory's META-GRAPH-1 can now adopt with data + CI only

---

*A graph that refuses to lie about edges it can't draw.*

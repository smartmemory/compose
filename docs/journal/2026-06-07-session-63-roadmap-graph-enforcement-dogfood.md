---
date: 2026-06-07
session_number: 63
slug: roadmap-graph-enforcement-dogfood
summary: "COMP-ROADMAP-GRAPH-1-1/-1-2: roadmap-graph enforcement (source-safe opt-in pre-push + CI templates, --check-as-lint) + compose CI dogfood + howto; seeded first real deps.yaml edges (90 nodes/3 edges)."
feature_code: COMP-ROADMAP-GRAPH-1-1
closing_line: Guard the invariant that crashes you; let the cosmetic drift slide.
---

# Session 63 — COMP-ROADMAP-GRAPH-1-1

**Date:** 2026-06-07
**Feature:** `COMP-ROADMAP-GRAPH-1-1`

## What happened

Tackled the two COMP-ROADMAP-GRAPH-1 follow-ups in one pass: -1-1 (enforcement) and -1-2 (dogfood). The interesting design tension was friction: the obvious enforcement (commit the graph, gate it with --check) would block nearly every compose push, because compose's feature statuses flip on almost every commit and that restyles the derived graph. Resolved by splitting the guarantee: dangling-edge refusal is the hard invariant (enforced fresh in CI, never stale); staleness enforcement is opt-in by graph-file presence (a project commits its graph only if its roadmap is stable enough). The literal spec named forge-top as the first dogfood consumer, but forge's root isn't a git repo, so compose-self became the committable, CI-gated target instead. Codex review caught a real bash bug (the hook used `exit`, which kills a caller that sources it, contradicting the doc's 'source it' option) and two CI path-filter gaps (.compose/compose.json and the workflow file itself missing from triggers) — 3 findings across 3 iterations to REVIEW CLEAN.

## What we built

New: templates/hooks/roadmap-graph-pre-push.sh (source-safe roadmap_graph_gate fn + BASH_SOURCE direct-exec guard), templates/ci/roadmap-graph.yml (reusable snippet, Mode A committed / Mode B artifact), .github/workflows/roadmap-graph.yml (compose dogfood: fresh regen + fail-on-dangling + artifact upload), docs/howto/roadmap-graph.md (adoption recipe), docs/features/COMP-ROADMAP-GRAPH-1-{1,2}/deps.yaml (first real edges), test/integration/roadmap-graph-hook.test.js (5 tests incl. source-safety). The live compose graph now renders 90 nodes / 3 edges.

## What we learned

1. Derived artifacts + commit-and-check enforcement fight each other when the source data churns — separate the hard invariant (no dangling) from the soft one (freshness) and enforce them differently (CI-fresh vs opt-in commit). 2. A copy-into-.git/hooks shell template that also advertises 'source me' MUST be source-safe: define a function + `return`, and only `exit` under `[ "${BASH_SOURCE[0]}" = "${0}" ]`. 3. GitHub Actions path filters silently make a workflow a no-op for changes you forgot to list — include the config file the build reads (.compose/compose.json) AND the workflow file itself, in BOTH push and pull_request. 4. --check (whole-file regen + byte-compare) is a strictly stronger hand-edit lint than a sentinel-region diff, so the separately-planned lint script was unnecessary.

## Open threads

- [ ] First CI run of the dogfood workflow will confirm the artifact upload + dangling gate behave on Actions (validated locally only)
- [ ] SmartMemory META-GRAPH-1 can now adopt: deps.yaml + frontmatter + copy the CI snippet
- [ ] Adopters with stable roadmaps can commit the graph + use the pre-push gate; compose itself stays artifact-only

---

*Guard the invariant that crashes you; let the cosmetic drift slide.*

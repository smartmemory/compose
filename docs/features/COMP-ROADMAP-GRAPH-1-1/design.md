# <Feature Name>: Design


## Why

COMP-ROADMAP-GRAPH-1 shipped v1 narrow (P1 substrate + P2 CLI/MCP): the generator, dangling-edge refusal, and `compose roadmap graph [--check]` exist. The enforcement layer (Phase 3) was deferred: a `.compose/hooks/roadmap-graph.sh` pre-commit template running `--check`, a CI gate snippet under `templates/ci/`, and a hand-edit lint that flags PRs touching the @generated node/edge regions without a matching deps.yaml/frontmatter change. The generator already marks regions with `@generated:*` sentinels, so the lint has a stable anchor.

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

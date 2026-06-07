# Roadmap-graph compose dogfood + adoption recipe: Design

**Status:** SHIPPED 2026-06-07
**Parent:** [COMP-ROADMAP-GRAPH-1](../COMP-ROADMAP-GRAPH-1/) · sibling [COMP-ROADMAP-GRAPH-1-1](../COMP-ROADMAP-GRAPH-1-1/)
**How-to:** [docs/howto/roadmap-graph.md](../../howto/roadmap-graph.md)

## Why

COMP-ROADMAP-GRAPH-1 v1 delivered the generic generator but never dogfooded it
on a real project beyond unit fixtures, and shipped no adoption docs. This
feature closes both.

## Decisions

1. **Dogfood target: compose-self, not forge-top.** The original spec named
   `forge/docs/roadmap-graph.html` as the first consumer, but forge's root is not
   a git repo — a generated HTML there goes nowhere and can't be CI-gated. Compose
   itself is the committable, CI-enabled, second real project, so it becomes the
   dogfood target. (Recorded deviation.)
2. **Artifact, not committed file.** Compose's feature statuses flip on nearly
   every commit, which restyles the derived graph; a committed graph gated by
   `--check` would block every status-flip push. The dogfood CI workflow instead
   regenerates fresh each run, fails only on a dangling edge, and uploads the HTML
   as a build artifact — guarding the hard invariant without commit churn.
3. **Seed real edges.** The two follow-ups genuinely depend on the parent, so
   their `deps.yaml` files give compose's live graph its first edges (2
   `depends_on` + 1 `concurrent_with`), exercising the deps path end to end.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `.github/workflows/roadmap-graph.yml` | new | compose dogfood: fresh regen + fail-on-dangling + artifact |
| `docs/howto/roadmap-graph.md` | new | adoption recipe (deps.yaml, frontmatter, config, CLI/MCP, enforcement) |
| `docs/features/COMP-ROADMAP-GRAPH-1-{1,2}/deps.yaml` | new | first real edges in compose's graph |

## Outcome

Shipped. Live compose graph renders 90 nodes / 3 edges. SmartMemory's
META-GRAPH-1 can now adopt with data (deps.yaml + frontmatter) + the CI snippet.

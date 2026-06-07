# COMP-BUILD-QUICK — Build-mode Quick path

**Status:** PLANNED
**Promoted from:** ideabox IDEA-18 (2026-06-07) — scoped carve-out of IDEA-15
**Source:** OpenSpec friction comparison — empirical entry-path test, 2026-06-07

## Problem

Compose has three work tiers, and only the middle one is underserved:

| Tier | Example | Path today | Friction |
|---|---|---|---|
| Trivial | `--version` alias, typo | Mode Selection says "skip Compose, fix directly" | None — correctly excluded |
| **Small-but-real** | one flag + a test + changelog entry | **full 10-phase `/compose build`** | **The drag** |
| Non-trivial | multi-file feature | full lifecycle | Appropriate |

Fix mode already solved this: `/compose fix --quick` collapses F1→F3 into a single triage step → TDD → ship. **Build mode has no symmetric path** — the SKILL.md admits this verbatim: *"we have `/compose fix --quick`, but `/compose build` has no quick path."* A small additive feature must walk design → blueprint → verify → plan → execute → report → docs → ship, paying gate-proposal overhead at each phase even though half self-skip.

## Goal

Add `/compose build --quick`: a 3-phase collapse of the build lifecycle for small, well-scoped additive work.

```
/compose build --quick <feature-ref>
  → design (lightweight, single gate)
  → implement (TDD + verification-before-completion, the four Phase-7 exit steps preserved)
  → ship (commit + CHANGELOG)
```

## Non-Goals

- **Not** OpenSpec's no-gates model. Gates remain — only the *phase count* shrinks. Enforcement (TDD, verification-before-completion, review loop) is the differentiator and stays.
- Not a replacement for full `/compose build` — `--quick` is opt-in and scoped to small additive work. Anything multi-file or needing architecture/PRD uses the full path.
- Not the broad IDEA-15 simplicity audit — this is the one concrete, shippable slice. The audit can follow.

## Acceptance Criteria

- [ ] `/compose build --quick <ref>` parses in `bin/compose.js` path-selection (mirror the `--quick` flag handling that fix mode already has)
- [ ] A trimmed Stratum flow (`compose_feature_quick` or equivalent) with 3 steps: `write_design` (lightweight) → `implement` → `ship`
- [ ] Phase-7 enforcement preserved in the `implement` step: TDD per task, verification-before-completion, review loop, coverage sweep exit criteria unchanged
- [ ] Single design gate (not per-phase gates); blueprint/blueprint-verify/plan/report phases skipped, not just self-skipping
- [ ] SKILL.md Mode Selection + Partial Execution sections document the `--quick` build path alongside the existing fix `--quick`
- [ ] Guardrail: if the agent detects the work is actually multi-file / needs architecture during `--quick`, it surfaces and offers to escalate to full `/compose build` rather than silently under-scoping
- [ ] CHANGELOG.md entry in the same commit

## Implementation Notes

- **Mirror the fix-mode Quick path** — `/compose fix --quick` already implements path-selection + a collapsed flow. Read its `bin/compose.js` dispatch and the `bug-fix.stratum.yaml` Quick handling, then build the build-mode analog. Don't invent a new pattern.
- The full build flow is `compose_feature` (4 Stratum steps: research → write_design → write_blueprint → implement). The quick flow drops `research` and `write_blueprint`, keeping a lightweight `write_design` and the full-strength `implement`.
- First implementation step should be a corrections-table check: confirm the fix-mode Quick path's actual structure on disk before copying it (per `implement-blueprint` discipline).

## Related

- IDEA-18 (origin), IDEA-15 (parent audit) — `docs/product/ideabox.md`
- IDEA-17 (delta-spec) — the *other* OpenSpec borrow; an artifact, not a philosophy
- `/compose fix --quick` — the existing symmetric path to mirror

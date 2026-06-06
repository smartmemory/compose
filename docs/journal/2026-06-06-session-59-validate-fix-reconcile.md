---
date: 2026-06-06
session_number: 59
slug: validate-fix-reconcile
summary: "COMP-MCP-VALIDATE-2: compose validate --fix closes the validator loop — shared-context reconcile, surgical ROADMAP edit, 4 Codex impl rounds"
feature_code: COMP-MCP-VALIDATE-2
closing_line: A fixer is only as trustworthy as its fidelity to the detector it mends.
---

# Session 59 — COMP-MCP-VALIDATE-2

**Date:** 2026-06-06
**Feature:** `COMP-MCP-VALIDATE-2`

## What happened

We built the last slice of the COMP-MCP-VALIDATE umbrella: `compose validate --fix`, turning the detect-only validator into a closed loop. The human picked two design forks up front — a shared-context reconcile pass (validator stays pure detect) and all five fixable classes — then we let Codex pressure-test each phase. The design gate flagged four real issues (per-feature link convergence, the missing partial/invalid-kind findings, the ROADMAP-writer gap, the no-payload contract). The blueprint gate flagged four more, all rooted in the provider abstraction (GitHub-backed writes skip the local guarantees the fixes rely on) and the validator's both-side status projection. The hard lesson came at implementation: a probe of the planned full `renderRoadmap()` resync showed it *corrupted* hand-authored ROADMAPs, appending a generated section beside the existing rows and leaving duplicate conflicting rows. We surfaced that to the human, who chose to build the safe path now — a surgical single-cell edit. Three Codex impl rounds then hardened that writer: duplicate-row last-wins to match the validator's Map, an alpha-token guard against mangling prose, escaped-pipe refusal, and honest no-op reporting so --fix never claims a repair it didn't make.

## What we built

New `lib/feature-reconciler.js` (reconcileProject + FIX_CLASSES registry + nearestLinkKind). New writers in `lib/feature-writer.js`: `rewriteLinks` (whole-array, the removal/repair primitive) and `setRoadmapRowStatus` (surgical column-aware cell edit); exported `getProvider`/`isLocalProvider`. Atomic `writeFeature` in `lib/feature-json.js`. Exported `loadValidationContext`/`loadFeatureContext`/`effectiveStatus` from `lib/feature-validator.js` (visibility only). CLI `--fix`/`--apply`/`--fix-class` in `bin/compose.js`; MCP `fix`/`apply`/`fix_classes` in `server/compose-mcp-tools.js` + `server/compose-mcp.js`. Three new test files (26 reconciler/CLI/MCP tests incl. a golden closed-loop). Full design/blueprint/plan/report in `docs/features/COMP-MCP-VALIDATE-2/`.

## What we learned

1. **Mirror the detector exactly when building a fixer.** Every convergence bug — external links, duplicate rows, both-side projection, non-canonical statuses — came from the fixer's predicate diverging from the validator's. Matching the validator's semantics (even its quirks, like last-wins and naive pipe splitting) is the invariant that guarantees `--fix` clears what `validate` reports. 2. **Implement-time probes catch what review can't.** The ROADMAP-regeneration corruption was invisible in design and blueprint review; it only appeared when we actually ran `renderRoadmap` on a fixture. A 10-line probe changed the whole approach. 3. **A guard that prevents corruption can introduce non-convergence.** Our first over-strict status-membership guard refused to fix legitimate non-canonical alpha statuses and then reported the refusal as success — Codex caught the false-success path. The fix was to narrow the guard (escaped-pipe only) and report no-ops honestly. 4. **Provider abstractions hide divergence.** The same writer call is safe on local and unsafe on GitHub; scoping v1 to local-provider closed two findings at once.

## Open threads

- [ ] Remote-provider (GitHub) reconcile is unsupported (local-only) — follow-up if needed.
- [ ] `invalid_link_kind_repair` edit-distance heuristic is conservative (≤2); revisit if real typos fall through to drop.
- [ ] Run `compose validate --fix --apply` against the live ~605-warning backlog (the motivating case) once merged, per-class, reviewing the dry-run plan first.

---

*A fixer is only as trustworthy as its fidelity to the detector it mends.*

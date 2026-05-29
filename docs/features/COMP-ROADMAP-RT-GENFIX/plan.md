# COMP-ROADMAP-RT-GENFIX — Fix Plan

**Status:** COMPLETE (2026-05-29) · **Goal:** fix the 5 gen/parse roundtrip defects so the deferred migration of ~169 historical compose rows lands as a fixed point.

> **Implementation:** T1 `d920b56`, T2 `39883de`, T3 `e3f63f6`, T4 `b56ea02` (+ review-fix `7a68b55`), T5 `eb77ec4`. All Codex-reviewed clean; full suite green (node 2933 / vitest 139 / tracker 100). T4 review caught a second NaN comparator in `roadmap-gen.js` `newPhases` sort, fixed in `7a68b55`.

Root-cause (full analysis in session transcript). All touch `roadmap-parser.js`, so tasks run **sequentially**, each TDD + reviewed, full suite green per task.

## Task order (least-coupled / highest-confidence first)

### T1 — SKIP_STATUSES sub-item rewrite (`roadmap-parser.js:100-103`)
Only fall back to phase status when the row's own status cell is empty:
`if (SKIP_STATUSES.has(currentPhaseStatus) && !explicitStatus) status = currentPhaseStatus;`
Preserves the existing "COMPLETE phase → COMPLETE rows" test (those rows have explicit status). Independent.

### T2 — Milestone accumulation + phase-compare semantics
(i) Parser (`roadmap-parser.js:53-64`): track `currentParentPhaseId` (set in the `##` branch); in the `###` branch reset to parent: `currentPhaseId = parent ? `${parent} > ${label}` : label` — no accumulation.
(ii) checkRoundtrip (`roadmap-roundtrip.js:106`): compare TOP-LEVEL phase only — `e.phaseId.split(' > ')[0].trim() !== f.phase`. (feature.json phase is flat by design; gen never emits `###`.) This is a comparison-semantics fix, not a gen/parse paper-over. Independent.

### T3 — Unescaped pipes in cells (symmetric escape)
Emit: `esc(s)=String(s).replace(/\|/g,'\\|')` on description/item cells in `renderTableLines` + `renderPhase` (`roadmap-gen.js`). Parse: split on unescaped pipes `/(?<!\\)\|/` then unescape per cell, in BOTH `roadmap-parser.js:76` and `roadmap-preservers.js:103` (lockstep). Add a fixture row with an escaped pipe.

### T4 — Strikethrough/renumber non-convergence (THE BLOCKER — most care)
Two coupled changes, together:
(a) `feature-json.js:82-86` sort: derive a numeric key tolerant of ranged positions (`String(position).match(/\d+/)` → leading int, sentinel fallback), tie-break by code — removes `NaN` from the comparator so typed-row order is stable/deterministic. Keep display value untouched. **Affects ALL listFeatures consumers (build lists, UI) — run the FULL suite.**
(b) Anon predecessor anchoring (`roadmap-preservers.js` / `roadmap-gen.js renderTableLines`): with stable sort, source order == regen order, so re-derived predecessor is stable. Add a dedicated convergence test: two `generateRoadmapFromBase` passes byte-identical on a fixture with a `~~struck~~` row adjacent to a ranged-position typed row. Coupled to T5.

### T5 — Lowercase/malformed codes (low priority, after T4)
In `readAnonymousRows`, treat a case-insensitive `FEATURE_CODE_RE_STRICT` match as typed (keyed by uppercased code) rather than anon, eliminating phantom-anon-vs-typed duplicate churn. Shares T4's classification path.

## Acceptance
- [ ] Each task: targeted test red→green, full suite 0 fail.
- [ ] After all: re-run `compose roadmap migrate --dry-run` then a scratch migrate+generate+check on a COPY → **fixed point holds, 0 false phase-CHANGED, 0 EXTRA** (external excluded). Then the real migration can proceed (separately).

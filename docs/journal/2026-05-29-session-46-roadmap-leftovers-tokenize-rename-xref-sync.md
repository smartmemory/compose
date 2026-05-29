---
date: 2026-05-29
session_number: 46
slug: roadmap-leftovers-tokenize-rename-xref-sync
summary: "Cleared the migration leftovers: status-cell tokenization, renamed the stray 'implementation' phase, and shipped XREF-SYNC v1 (pull reconciliation of feature.json external links)"
feature_code: COMP-ROADMAP-XREF-SYNC
closing_line: Three leftovers, two cleanups and a real feature — and the one that looked smallest (a phase rename) taught the sharpest lesson about generate's verbatim preservation.
---

# Session 46 — COMP-ROADMAP-XREF-SYNC

**Date:** 2026-05-29
**Feature:** `COMP-ROADMAP-XREF-SYNC`

## What happened

With the migration shipped, the human said 'tackle the leftovers' — three of them.

**(1) Status tokenization.** The migration had created 5 schema-invalid feature.json because status cells carried inline rationale ('PARKED — needs X'). We made parseRoadmap reduce a status cell to its bare enum token via parseStatusToken, moved from roadmap-gen.js into the parser (its natural home, single source of truth, gen now imports it). Codex flagged that the first cut's boundary ('any non-word char') was broader than the old matcher and would coerce glued forms like 'PLANNED-ish' into valid enums — so we tightened it to whitespace/paren/end only, leaving genuinely-malformed cells for the validator to flag rather than silently fixing them. Added negative tests.

**(2) Rename the stray '## implementation' phase.** Set COMP-DEBUG-1's phase to 'COMP-DEBUG: Debug Discipline'. The first regen still showed the old phase — because generate preserves source phase-blocks that have no feature.json features verbatim, so COMP-DEBUG-1 appeared in BOTH the new phase and the stale block, breaking the fixed point. We removed the stale block from ROADMAP.md and regenerated; clean.

**(3) COMP-ROADMAP-XREF-SYNC.** This turned out to be a real M-complexity feature, not a cleanup. We found the read-only XREF subsystem already exists (XREF_DRIFT etc. in feature-validator) and that github write capability (updateIssue) is present — so the defining question was sync DIRECTION. We wrote a design doc, surfaced the decision, and the human chose 'build v1 Pull now'. We built lib/xref-sync.js: pull-reconcile each feature.json external links[] entry's expect= to live target state (github via getIssueResult, local via sibling feature.json), injectable resolver (network-free tests), pull-only (never writes external), structured-carrier-only (no markdown rewrite, no roundtrip impact). Codex review found the local resolver was weaker than the validator's — no sibling-containment/symlink guard, and it reused this repo's featuresDir for the sibling — both High/Medium. We mirrored feature-validator's resolveLocalRef exactly (lexical + realpath containment, loadFeaturesDir(citedRoot)), added a containment test, and re-reviewed clean.

## What we built

- `lib/roadmap-parser.js`: exported STATUS_TOKENS + parseStatusToken (tolerant of trailing commentary, conservative boundary); parseRoadmap tokenizes status cells.
- `lib/roadmap-gen.js`: imports parseStatusToken from the parser (removed its private copy).
- `lib/xref-sync.js` (new): reconcileExpect (pure) + syncExternalRefs (orchestrator, injectable resolver, default github/local resolvers with containment guard).
- `bin/compose.js`: `roadmap xref-sync [--dry-run]` subcommand + help.
- COMP-DEBUG-1 feature.json phase rename; removed the stale ## implementation block from ROADMAP.md.
- `docs/features/COMP-ROADMAP-XREF-SYNC/design.md` (scope + sync-direction decision); feature → PARTIAL.
- Tests: status-tokenization + negative glued-form cases in roadmap-parser.test.js; 12 cases in xref-sync.test.js.
- CHANGELOG entries. Commits 9f8f99f, 662fb79, 64bd44f, 8184430.

## What we learned

1. **generate preserves orphaned source phase-blocks verbatim.** Renaming a phase by editing feature.json isn't enough — if the OLD phase heading still sits in ROADMAP.md with no backing feature.json, generate re-emits it verbatim and the feature appears twice. You must remove the stale block from the source too. Non-obvious and a fixed-point breaker.
2. **'Conservative' beats 'clever' for coercion.** Codex was right to push back on the broad token boundary: silently turning 'PLANNED-ish' into PLANNED hides authoring errors. Leaving malformed input for the validator to flag is the more honest design.
3. **A 'leftover' can be a feature in disguise.** XREF-SYNC read like cleanup but hinged on a product decision (pull vs push, where push can mutate external systems). Writing a short design doc and asking beat blind-building a network subsystem — especially with zero live citations to exercise it.
4. **When extending a subsystem, copy its safety, not just its happy path.** The first xref-sync local resolver reproduced the validator's resolution but not its containment guard. Cross-repo path handling is exactly where the guard matters; parity must include the defensive code.
5. **Injectable resolvers make network features testable.** xref-sync's resolve() seam let us cover drift/skip/dry-run/in-sync without a single network call, and still exercise the real local resolver against a temp sibling.

## Open threads

- [ ] COMP-ROADMAP-XREF-PUSH (optional future): external-write sync (close/relabel a GitHub issue from local truth). Needs write auth, dry-run, per-ref opt-in, blast-radius controls. Deliberately out of XREF-SYNC v1.
- [ ] Inline roadmap-citation carrier (`<!-- xref: ... -->` comments in descriptions) is not yet synced — only the structured links[] carrier. Add if/when inline citations land (0 today).
- [ ] No live xref citations exist yet, so xref-sync has no production data to exercise; first real consumer will be the true test.

---

*Three leftovers, two cleanups and a real feature — and the one that looked smallest (a phase rename) taught the sharpest lesson about generate's verbatim preservation.*

---
date: 2026-06-05
session_number: 58
slug: vision-state-status-projection
summary: "COMP-MCP-VALIDATE-3: project feature.json status onto vision-state at the setFeatureStatus chokepoint + one-time back-projection; STATUS_MISMATCH_*_VS_VISION_STATE 38→0"
feature_code: COMP-MCP-VALIDATE-3
closing_line: The orphan surface finally hears what the canonical one has been saying all along.
---

# Session 58 — COMP-MCP-VALIDATE-3

**Date:** 2026-06-05
**Feature:** `COMP-MCP-VALIDATE-3`

## What happened

We built COMP-MCP-VALIDATE-3, the third slice of the Closed-Loop Hardening umbrella. The ask: status lives in three surfaces (ROADMAP.md, feature.json=canonical, vision-state.json), but the typed writers only kept ROADMAP+feature.json in sync — vision-state drifted as an orphan, producing 38 STATUS_MISMATCH_*_VS_VISION_STATE findings (COMP-GSD/COMP-GSD-3 read COMPLETE everywhere but in_progress in vision-state, forever).

Exploration found the clean seam: every status-mutation path that bypasses the lifecycle routes (set_feature_status, record_completion, lifecycle start/advance/skip) funnels through setFeatureStatus. And the dual-dispatch VisionWriter already solves the hard part (REST when the server is up so the in-memory store stays the single writer authority; atomic file write when down). So one best-effort hook at the chokepoint closes the gap; build.js already self-syncs vision and the kill/complete routes already set it.

The Codex blueprint pass earned its keep: it caught that a lowercase rewrite of the validator comparison would break the existing 'partial' regression test, that the migration hardcoded docs/features instead of honoring paths.features, and that blessing 'superseded' needed wiring through the UI/server status consumers — all fixed before a line of code. The data also overturned an assumption: SUPERSEDED isn't forward-looking (2 real features, 1 already in vision-state), so mapping it to killed would have mislabeled real work; we added it to the enum instead.

The migration applied cleanly on the live project (19 items reconciled), driving the target finding set 38→0.

## What we built

NEW:
- lib/status-projection.js — the single canonical featureStatusToVisionStatus() mapping, used on write AND read so a projected status can never trip the validator.
- scripts/backproject-vision-status.mjs — one-time idempotent back-projection migration (exported fn + CLI; dry-run default, --apply atomic; loadFeaturesDir-aware; skips unbound/external items).
- test/status-projection.test.js, test/feature-writer-vision-projection.test.js, test/backproject-migration.test.js.

MODIFIED:
- lib/feature-writer.js — setFeatureStatus best-effort projects status into vision-state via VisionWriter, after the audit append, only on real transitions.
- lib/feature-validator.js — projectToVisionStatus delegates to the shared helper (proven finding-equivalent, 632→632 / 0 added / 0 removed).
- server/vision-store.js — VALID_STATUSES += 'superseded'.
- server/graph-export.js — STATUS_MAP += superseded:'complete'.
- src/components/vision/constants.js — STATUS_COLORS + STATUSES += superseded.
- test/feature-validator.integration.test.js — SUPERSEDED↔superseded symmetry test.

## What we learned

1. The chokepoint is the unit of a fix, not the call site. Three mutation paths and a fourth UI-route family all collapse to setFeatureStatus; hooking the funnel once beat touching each caller and mirrors how VALIDATE-1 hooked writeFeature.
2. Write/read mapping must be one function or the fix fights itself. If the writer projects SUPERSEDED→x but the validator folds it to y, a 'correct' projection still fires a mismatch. Sharing featureStatusToVisionStatus across write and read is the correctness keystone.
3. Finding-equivalence is provable, not asserted. We snapshotted the validator's 632 findings before the refactor and diffed after (0/0) — the delegation is equivalent by construction (helper output, uppercased, equals the old projection for every key; identity-fallback preserves ready/review).
4. Check the data before picking a default. The 'recommended' SUPERSEDED option looked heavier until the data showed 2 real superseded features — at which point the fallback (→killed) was simply wrong. The enum addition was required, not optional.
5. Best-effort means the downstream mirror can never fail the canonical write — the projection is wrapped like safeAppendEvent, and the noop short-circuit keeps it from touching vision on a no-change call (that is the migration's job).

## Open threads

- [ ] COMP-MCP-VALIDATE-2 (validate --fix) is now unblocked — it consumes this canonical status projection as its status-class fixer.
- [ ] Pre-existing inconsistency: build.js writes vision status 'failed' (server/graph not in VALID_STATUSES) at lib/build.js:1917 — file as a separate follow-up.
- [ ] Reverse direction (vision-state → feature.json on a direct PATCH/UI drag) is still unsynced — out of -3 scope, separate gap.
- [ ] vision-store VALID_STATUSES vs contracts/vision-state.schema.json are still not fully aligned (store has extra ready/review); only the superseded mismatch was addressed.

---

*The orphan surface finally hears what the canonical one has been saying all along.*

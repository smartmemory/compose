# Session 40: Cross-artifact validator ships (COMP-MCP-VALIDATE)

**Date:** 2026-05-04

## What happened

We started this session by asking what the next sub-ticket of `COMP-MCP-FEATURE-MGMT` should be. PUBLISH had just shipped. The remaining unbuilt sub-tickets were FOLLOWUP, VALIDATE, and MIGRATION. The recommendation was VALIDATE — highest leverage, catches the drift the writers can produce.

The design phase was unusually long. Six shaping questions before any design.md got written:

1. **Scope** — per-feature only vs sweep + per-feature. Picked sweep + per-feature.
2. **Severity model** — advisory always, block-on-error, or configurable threshold. Picked threshold.
3. **ROADMAP source** — and this is where the conversation got pointed. The principled answer is "one project, one ROADMAP." But forge-top has all the COMP-MCP-* rows. The user pushed back: "you are the one who keeps writing to top roadmap." Fair. The reason consolidation hadn't happened was that I was perpetuating the dual-roadmap drift each time I shipped a sub-ticket. The fix wasn't a config option — it was actually moving the rows. Phase 0 of this feature: move six COMP-MCP-* rows from forge to compose, leave a pointer at forge-top, establish the standing rule "a feature's row lives in the project that owns the feature." Forge-top still hosts cross-product strategic items.
4. **Killed-feature handling** — skip / terminal-invariant / full-with-info. Picked terminal-invariant.
5. **Schemas** — infer / ship / separate ticket. Picked ship.
6. **Hook surface** — pre-commit / pre-push / both. Picked pre-push only.

Pre-implementation Codex review went five iterations. The first pass surfaced four high-severity findings that would have caused real problems: `UNLINKED_REQUIRED_ARTIFACT` was wrong-direction (canonical artifacts are auto-discovered, not in `feature.json.artifacts[]`); `MISSING_REQUIRED_ARTIFACT` for COMPLETE was too strict given current writers don't enforce it; the feature-json schema as proposed would have rejected the only existing `feature.json` (`COMP-DEBUG-1` uses numeric complexity, `name`, `depends_on`, `source`); and T7 self-validation under the original severity model would have produced dozens of errors before any user drift, making the pre-push hook useless on day one. We reframed: schemas codify de facto shapes (`additionalProperties: true` initially), severity calibrated against the actual baseline. Codex iter 5 hit the max-5-iterations gate on two human-decision questions: catalog count (recounted to 27, was claiming 25) and `FEATURE_NOT_FOUND` shape (decided as finding rather than throw — uniform shape across callers).

Implementation followed the eight-task plan strictly sequentially: schemas + helper extract, SchemaValidator generalize, library, MCP wrappers, CLI, hook, self-validation, verification. Each task gated on its own tests passing. The sequencing held without rework.

T7 (self-validation) was the most useful task. Running the validator against compose's actual repo immediately surfaced four kinds of issues that 76 unit tests had missed:

1. **Parser regex limitation.** `lib/roadmap-parser.js:15` requires codes to end in `-\d+` (e.g. `STRAT-1`, `COMP-UI-3`). Codes like `COMP-MCP-PUBLISH` end with non-numeric suffixes and become `_anon_*` sentinels. The validator can't depend on `parseRoadmap`. Built a column-aware scanner directly in `feature-validator.js`.
2. **Severity miscalibration on baseline.** The first run produced ~37 errors, mostly `STRAT-*` legacy completes without folders. Reclassified: error reserved for `IN_PROGRESS` (active work) drift; legacy and sub-ticket-parent cases are warnings.
3. **Schema strictness on real shapes.** `COMP-DEBUG-1`'s `profile` is an object, not a string as the initial schema said. Widened to `oneOf: [string, object]`.
4. **Validator's own architectural baseline.** The COMP-MCP-VALIDATE folder is at forge level; the ROADMAP row is at compose level. The validator can see the row, can't see the folder. One stubborn error throughout. We tried a pointer-folder approach — created two new errors. Removed it. Accepted the single error as documented baseline. It auto-resolved when status flipped to COMPLETE in Phase 9 (because COMPLETE without folder is warning, not error).

Implementation Codex review went three iterations. Iter 1 found five real correctness gaps: two finding kinds were declared but unimplemented (`ROADMAP_ROW_SCHEMA_VIOLATION`, `SUPERSEDED_WITHOUT_LINK`); the vision-state schema was incomplete (missing `superseded` status, `specification` phase) AND wasn't being run against the data (`runSchemaChecks` only did inline ad-hoc checks); `readFeature(cwd, code)` ignored the configured features path; `ARTIFACT_OUTSIDE_FEATURE_FOLDER` had a `FEAT-1` vs `FEAT-10` prefix collision; the row scanner only recognized exact "feature"/"code" header names. All real, all missed by 76 unit tests. Iter 2 caught one more: `ARTIFACT_OUTSIDE_FEATURE_FOLDER` was vulnerable to `..` escape in absolute paths because the boundary check didn't normalize via `path.resolve()` first. Iter 3 was REVIEW CLEAN.

This commit ships the validator + Phase 0 ROADMAP consolidation + four T7 baseline fixes (vision-state mismatches for STRAT-COMP-8 and COMP-UI-3, `COMP-DEBUG-1` schema widening, journal-index entry for pre-numbering-rule duplicate). Three migration follow-up tickets to file at completion: `COMP-FEATURE-FOLDER-LOCATION-CONSOLIDATE`, `COMP-VISION-STATE-LIFECYCLE-MIGRATE`, `COMP-FEATURE-FOLDER-BASELINE-CLEANUP`.

## What we built

- `compose/lib/feature-validator.js` — `validateFeature` and `validateProject`. ~600 lines. 27-kind catalog. Custom column-aware ROADMAP scanner. Path-resolve normalization for boundary checks.
- `compose/contracts/{feature-json,vision-state,roadmap-row}.schema.json` — three new JSON Schemas codifying de facto shapes.
- `compose/lib/feature-code.js` — strict regex helper extracted from three writer sites.
- `compose/server/schema-validator.js` — generalized: optional `schemaPath`, per-path cache, `validateRoot`, `loadSchema`. 13 zero-arg test callers untouched.
- `compose/server/compose-mcp.js` + `compose-mcp-tools.js` — `validate_feature` + `validate_project` tools.
- `compose/bin/compose.js` — `compose validate` subcommand + extended hooks installer for `--pre-push` (back-compat: no flag → post-commit).
- `compose/bin/git-hooks/pre-push.template` — runs `compose validate --scope=project --block-on=error`; non-zero exit blocks push.
- 76 new tests across 7 files.

## What we learned

1. **The skill perpetuates its own conventions.** When the user pointed out that I was the one creating the dual-roadmap drift, the answer wasn't a clever auto-router — it was a standing rule and an actual move. "A feature's row lives in the project that owns the feature." Forge-top retains its role for cross-product strategic items; product-internal sub-tickets live in the owning project's roadmap. Without naming the rule explicitly, the next agent (me, next session) will repeat the drift. Memory candidate.

2. **Schema design follows real data, not idealized data.** Codex iter 1 caught that the proposed feature-json schema would have rejected the only existing `feature.json` and `runBuild`'s output. The schema as written would have failed on day one. Reading actual files before locking the schema saved a migration. Apply broadly: any schema codifying existing implicit shapes should be `additionalProperties: true` initially, with tightening tracked separately.

3. **Severity calibration depends on baseline reality.** The intuitive model ("status mismatch is an invariant violation, must be error") fails on a project with 100+ legacy items. The right model treats migration debt as warning by default; pre-push gates only on active-work drift. Migration tickets carry the upgrade-to-error path. Without this calibration, the pre-push hook would have been useless on day one — it would have failed every push.

4. **Self-validation is the most valuable test.** No fixture can substitute for running the validator against the actual codebase. T7 surfaced four kinds of issues that 76 unit tests had missed (parser regex, severity miscalibration, schema strictness on real shapes, validator's own baseline). Worth the time investment. Sketch this into future validator-style features as a required step.

5. **Codex catches release-path / cross-source issues that unit tests can't.** Iter 1 implementation review found five real correctness gaps in code that already passed 76 tests. Pattern: tests verify the cases you wrote; Codex challenges the cases you didn't. Two iterations is the floor, not the ceiling.

## Open threads

- [ ] File `COMP-FEATURE-FOLDER-LOCATION-CONSOLIDATE` follow-up (forge-level vs compose-level feature folders). This is the architectural baseline behind the warnings.
- [ ] File `COMP-VISION-STATE-LIFECYCLE-MIGRATE` follow-up (move 41/42 items from top-level `featureCode` to `lifecycle.featureCode`).
- [ ] File `COMP-FEATURE-FOLDER-BASELINE-CLEANUP` follow-up (44 folders without ROADMAP rows, 26 orphans).
- [ ] File `COMP-MCP-VALIDATE-SCHEMA-TIGHTEN` follow-up (flip `additionalProperties: false` once producers migrate; pick one complexity convention).
- [ ] Decide whether to install the pre-push hook in compose's own repo (would require all the above migrations to land first; otherwise blocks every push on the architectural baseline error — wait, it doesn't anymore, since we shipped this feature COMPLETE).
- [ ] Sub-tickets remaining for `COMP-MCP-FEATURE-MGMT`: `COMP-MCP-FOLLOWUP` and `COMP-MCP-MIGRATION`. Two left.

A validator that catches drift the writers can't, plus a standing rule to stop creating that drift in the first place.

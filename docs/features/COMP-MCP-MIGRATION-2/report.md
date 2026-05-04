# COMP-MCP-MIGRATION-2 — Implementation Report

## Summary

Threaded `paths.features` overrides from `.compose/compose.json` through every lib-side writer. After this change, repos with `"paths": { "features": "specs/features" }` (or any other override) get correct typed-tool behavior — `addRoadmapEntry`, `setFeatureStatus`, `linkFeatures`, `linkArtifact`, `getFeatureArtifacts`, `getFeatureLinks`, `recordCompletion`, `getCompletions`, `proposeFollowup`, the `roadmap-gen` regenerator, the build runner's triage cache + ship staging + staleness check all read and write under the configured root.

## Delivered vs Planned

| Item | Status |
|---|---|
| `lib/project-paths.js` with `loadFeaturesDir(cwd)` helper | ✓ |
| `feature-writer.js`: thread featuresDir through all 6 public writers + `rejectCanonicalArtifact` substring fix | ✓ |
| `followup-writer.js`: thread featuresDir through `nextNumberedCode`, `readFeature` callsites, and `scaffoldDesignWithRationale`'s feature root | ✓ |
| `completion-writer.js`: thread featuresDir through `recordCompletion` + `getCompletions` | ✓ |
| `roadmap-gen.js`: default `opts.featuresDir` to `loadFeaturesDir(cwd)` | ✓ |
| `build.js`: `resolveItemDir`, triage cache, runTriage, isTriageStale, checkStaleness, status flips, executeShipStep all honor override | ✓ |
| `triage.js`: `runTriage` accepts `featuresDir` opt; `isTriageStale` already accepted it | ✓ |
| Unit tests for `loadFeaturesDir` (default / override / malformed / missing / empty / non-string) | ✓ |
| Integration tests for writers under override (`addRoadmapEntry`, `setFeatureStatus`, `linkFeatures`, `proposeFollowup`, `recordCompletion`/`getCompletions`) + default unchanged | ✓ |

## Architecture Deviations

None. The Codex review on the first pass caught three sites I'd missed (`resolveItemDir`, `isTriageStale`, `executeShipStep`); the second pass caught one more (`checkStaleness` should go through the bug-aware `resolveItemDir`, not the feature-only `featuresDir`). All addressed.

## Files Changed

New:
- `compose/lib/project-paths.js` — `loadFeaturesDir(cwd)` helper.
- `compose/test/project-paths.test.js` — 7 unit tests.
- `compose/test/feature-writer-paths.test.js` — 6 integration tests for writers under override.
- `compose/docs/features/COMP-MCP-MIGRATION-2/{design,report}.md`.

Edited:
- `compose/lib/feature-writer.js` — every public writer threads `featuresDir`; `rejectCanonicalArtifact` substring uses resolved root.
- `compose/lib/followup-writer.js` — `nextNumberedCode` + readFeature callsites + scaffoldDesignWithRationale featureRoot.
- `compose/lib/completion-writer.js` — `recordCompletion` + `getCompletions`.
- `compose/lib/roadmap-gen.js` — `generateRoadmap` default.
- `compose/lib/build.js` — `resolveItemDir`, triage cache, runTriage call, isTriageStale call, checkStaleness call (via resolveItemDir), status flips, executeShipStep.
- `compose/lib/triage.js` — `runTriage` accepts `featuresDir` opt.

## Test Coverage

13 new tests:
- 7 unit tests on `loadFeaturesDir` (default, missing config, no `paths` block, empty `paths.features`, non-string value, malformed JSON, override).
- 6 integration tests verifying `addRoadmapEntry`, `setFeatureStatus`, `linkFeatures`, `proposeFollowup`, `recordCompletion` / `getCompletions` all read/write under `specs/features/` when configured, plus a regression test for default behavior.

Full suite: 2541 + 92 UI = 2633 tests, all green.

## Known Limitations

- `paths.docs` and `paths.journal` are still hardcoded in their respective writers. Out of scope for this ticket — separate follow-ups if needed.
- Bug mode (`docs/bugs/`) is not made configurable; its hardcoded path remains. The `resolveItemDir` resolver keeps bug-mode behavior identical and threads the new override through feature-mode only.

## Lessons Learned

- Codex review iterations were necessary here. The first review caught the "main writers, but missed peripherals" gap (`resolveItemDir`, `isTriageStale`, `executeShipStep`). The second caught the cross-mode subtlety (`checkStaleness` should use `resolveItemDir`, not `featuresDir`, so bug-mode keeps working). For wiring-style migrations like this, two narrow review passes are cheaper than self-debugging the misses later.
- The lib/server split paid off here: server-side already had `resolveProjectPath`; lib-side just needed its own tiny equivalent. No need to share state or invalidate caches across the split.

# COMP-MCP-MIGRATION-2: Honor `paths.features` across writers

## Why

Codex flagged this as a known limitation during COMP-MCP-FOLLOWUP review on 2026-05-04. The orchestrator inherits whatever the underlying writers do; today, projects with `paths.features` overrides cannot use the typed feature-management tools correctly. Surfacing as a standalone ticket so it lands once and benefits every writer in the family.

**Status:** DESIGN
**Date:** 2026-05-04
**Parent:** COMP-MCP-MIGRATION

## Problem

`.compose/compose.json` exposes a `paths.features` override (defaults to `docs/features`). The server-side code already honors it via `resolveProjectPath('features')` in `server/project-root.js:117`. But the lib-side writers default the feature root to a hardcoded `docs/features`:

- `lib/feature-json.js:35-104` — `readFeature` / `writeFeature` / `listFeatures` / `updateFeature` accept an optional `featuresDir` 4th arg defaulting to `'docs/features'`.
- `lib/feature-writer.js:22` — imports those readers and calls them without ever passing the override.
- `lib/followup-writer.js` — same; also hardcodes `resolve(cwd, 'docs', 'features')` for `ArtifactManager`.
- `lib/completion-writer.js:27` — same.
- `lib/roadmap-gen.js:9` — uses `listFeatures` without the override.
- `lib/build.js:34` and `lib/migrate-roadmap.js:11` — same.

A repo with `"paths": { "features": "specs/features" }` is silently ignored: typed writers create / read / regenerate the *wrong* directory.

## Goal

Every lib writer reads `.compose/compose.json` once per call (cheap, no caching needed at this layer) and passes the resolved `featuresDir` into `feature-json.js`. ArtifactManager users in lib (only `followup-writer.js` today) compute the feature root the same way.

## Approach

Add a tiny shared helper at `lib/project-paths.js`:

```js
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const DEFAULT_FEATURES_DIR = 'docs/features';

export function loadFeaturesDir(cwd) {
  const cfgPath = join(cwd, '.compose', 'compose.json');
  if (!existsSync(cfgPath)) return DEFAULT_FEATURES_DIR;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    const rel = cfg?.paths?.features;
    return (typeof rel === 'string' && rel.length > 0) ? rel : DEFAULT_FEATURES_DIR;
  } catch {
    return DEFAULT_FEATURES_DIR;
  }
}
```

Then thread it through every writer:

- `feature-writer.js`: resolve once at the top of each public function and pass to `readFeature` / `writeFeature` / `listFeatures` / `updateFeature` calls. Fix the literal `docs/features` substring in `rejectCanonicalArtifact`'s path-suffix check.
- `followup-writer.js`: pass into `readFeature` / `listFeatures` calls; replace the hardcoded `resolve(cwd, 'docs', 'features')` in `scaffoldDesignWithRationale` with `resolve(cwd, loadFeaturesDir(cwd))`.
- `completion-writer.js`: pass into `readFeature` / `updateFeature` / `listFeatures` calls.
- `roadmap-gen.js`: default `opts.featuresDir` to `loadFeaturesDir(cwd)` instead of `'docs/features'`.
- `build.js` and `migrate-roadmap.js`: same pattern.

## Decisions

1. **Read once per call, not cached.** `lib/idempotency.js` already does its own thing for cache files; reading a single small JSON per writer call is cheap and avoids cross-test cache pollution. The server-side `loadProjectConfig` caches because it serves many requests; lib code does not have that hot path.
2. **No new public API.** Existing exports' signatures stay the same (the optional 4th arg on feature-json was already there); writers just stop ignoring the override. No caller migration needed.
3. **`rejectCanonicalArtifact` substring check.** The function rejects paths like `docs/features/<CODE>/design.md`. Fix it to use the resolved `featuresDir` rather than the literal string, otherwise repos with `specs/features` would still trip the check on their own canonical artifacts.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `lib/project-paths.js` | new | `loadFeaturesDir(cwd)` helper |
| `lib/feature-writer.js` | edit | Thread featuresDir through all writers; fix `rejectCanonicalArtifact` literal |
| `lib/followup-writer.js` | edit | Thread featuresDir; fix scaffoldDesignWithRationale's hardcoded path |
| `lib/completion-writer.js` | edit | Thread featuresDir |
| `lib/roadmap-gen.js` | edit | Default featuresDir to `loadFeaturesDir(cwd)` |
| `lib/build.js` | edit | Pass featuresDir into feature-json calls |
| `lib/migrate-roadmap.js` | edit | Same |
| `test/project-paths.test.js` | new | Unit tests for `loadFeaturesDir` |
| `test/feature-writer-paths.test.js` | new | Integration: writer respects `.compose/compose.json` override |

## Test plan

- `loadFeaturesDir` returns default when no `.compose/compose.json`, when JSON is malformed, when `paths.features` is unset, and the override when set.
- `addRoadmapEntry` against a cwd with `paths.features: 'specs/features'` writes to `specs/features/<CODE>/feature.json` and regenerates ROADMAP.md against that root.
- `proposeFollowup` against the same cwd allocates the new feature folder under `specs/features/`.
- `recordCompletion` against the same cwd reads/updates the feature.json under `specs/features/`.
- Default behavior unchanged for repos without an override.

## Out of scope

- Honoring `paths.docs` or `paths.journal` — separate concerns, separate tickets if needed.
- Backfilling existing repos with mismatched config — purely "make writers honor what the user already set."

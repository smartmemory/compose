# COMP-MCP-MIGRATION-1 — Implementation Report

## Summary

Promoted `enforcement.mcpForFeatureMgmt` from prompt-only to a true block-mode enforcement: every audit row now carries a per-build `build_id` stamped from `COMPOSE_BUILD_ID` env, and `executeShipStep`'s pre-stage scan correlates dirty `ROADMAP.md` / `CHANGELOG.md` / `feature.json` files with typed-tool audit events scoped to the current build. Block mode rejects unauthorized edits; new `'log'` mode emits decision events without blocking.

## Delivered vs Planned

| Item | Status |
|---|---|
| `feature-events.appendEvent` stamps `build_id` from env | ✓ |
| `lib/mcp-enforcement.js` helpers (`readEnforcementMode`, `filterGuarded`, `expectedToolsForPath`, `scanGuarded`, `enforcementError`, `featureCodeFromPath`) | ✓ |
| `runBuild` generates `build_id`, sets env, propagates via context, restores on exit, warns on nested env | ✓ |
| `executeShipStep` runs pre-stage scan; emits `mcp_enforcement_violation` decision event | ✓ |
| Block / log / off mode parsing | ✓ |
| Feature.json code correlation (event must match feature code, not just tool) | ✓ |
| Pre-stage scan also includes already-staged files (`git diff --cached`) | ✓ |

## Architecture Deviations

None. Codex review caught three real correctness gaps in the first pass — all addressed:

1. `scanGuarded` was tool-name-only matching, so an event for feature A blessed feature B's `feature.json`. Added `featureCodeFromPath` + per-path code correlation; `ROADMAP.md`/`CHANGELOG.md` keep tool-only matching since they're project-scoped.
2. The dirty-file scan only looked at unstaged + untracked changes, missing files an agent had pre-staged via `git add`. Added `git diff --cached --name-only`.
3. `COMPOSE_BUILD_ID` is process-global. Concurrent in-process builds would clobber each other. Added a warning when `runBuild` enters with the env already set; full save/restore handles the unset case correctly.

## Files Changed

New:
- `compose/lib/mcp-enforcement.js` — shared helpers.
- `compose/test/feature-events-build-id.test.js` — 4 unit tests on `build_id` stamping.
- `compose/test/mcp-enforcement.test.js` — 25 unit tests covering mode parsing, guarded-path matching, `scanGuarded`, `enforcementError`, and the new code-correlation path.
- `compose/docs/features/COMP-MCP-MIGRATION-1/{design,report}.md`.

Edited:
- `compose/lib/feature-events.js` — `appendEvent` stamps `build_id` from `process.env.COMPOSE_BUILD_ID`.
- `compose/lib/build.js` — `runBuild` generates `build_id` (uuid), stamps env, propagates `build_id`/`buildStartedAt`/`featuresDir` through context, warns on nested env, restores in `finally`. `executeShipStep` includes already-staged files in the dirty scan and runs `scanGuarded` between collection and `git add`.

## Test Coverage

29 new tests (4 + 25):
- `appendEvent` stamps env-supplied `build_id`; null when env unset; caller override wins; `readEvents` preserves the field.
- `readEnforcementMode` parses `block` / `log` / `off` from settings, including malformed-JSON and unknown-string fallbacks.
- `isGuardedPath` and `filterGuarded` recognize `ROADMAP.md`, `CHANGELOG.md`, and `<featuresDir>/<CODE>/feature.json`, including override paths.
- `expectedToolsForPath` returns the right tool set per guarded path.
- `scanGuarded` flags unauthorized edits and passes authorized ones; cross-feature blessing rejected via code correlation; project-scoped paths bypass code correlation.
- `enforcementError` sets `code` and `violations`.

Full suite: 2570 + 92 UI = 2662 tests, all green.

## Known Limitations

- Concurrent in-process `runBuild` calls in the same Node process would still mis-stamp events (env is global). Practically not supported — Compose runs one build per process — but the warning surfaces it loudly if it ever happens.
- The scan looks at files dirty at ship time. An agent that produces a guarded-file edit AND a typed-tool event in the same step is fine; one that writes the edit but no event will be flagged.
- Audit appends remain best-effort (`safeAppendEvent`). If an audit append silently fails for a legitimate typed-tool call, the scan will produce a false-positive violation. Logging plus the existing best-effort guarantee is the trade-off the writers chose; tightening it would require a stronger audit primitive.

## Lessons Learned

- Codex review caught what tests missed: tool-name-only matching looked correct under the unit tests because the test setup didn't exercise the cross-feature case. Adding the path-correlation fix flushed out a class of bugs the bare scan would have shipped with.
- Stamping correlation IDs at the `appendEvent` boundary (rather than threading through every writer) keeps the change additive. Spawned agents inherit env, so the cross-process correlation is automatic — no per-writer plumbing needed.
- Two-mode (`block` vs `log`) gives operators a soft rollout path: turn on `'log'` to see violations in production, then flip to `true` once the agent population is clean.

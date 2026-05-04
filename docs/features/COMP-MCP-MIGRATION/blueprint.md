# COMP-MCP-MIGRATION — Blueprint

Reference: `docs/features/COMP-MCP-MIGRATION/design.md`

## Files

| Path | Action | Purpose |
|---|---|---|
| `compose/server/vision-routes.js` | edit | Lifecycle complete handler accepts `commit_sha`/`tests_pass`/`files_changed`/`notes`; calls `recordCompletion` when SHA present |
| `compose/server/compose-mcp.js` | edit | Extend `complete_feature` schema with optional fields (line 178); wire `toolCompleteFeature` to forward them |
| `compose/server/compose-mcp-tools.js` | edit | `toolCompleteFeature` accepts and forwards new fields |
| `compose/lib/build.js` | edit | After commit (around line 2150), call `recordCompletion` with `commit_sha`, `filesChanged`, `tests_pass: true`, `notes` |
| `compose/lib/build.js` | edit | Inject typed-tool prompt instruction when `enforceMcpForFeatureMgmt` is true |
| `compose/lib/settings.js` (or equivalent) | edit | Wire `enforcement.mcpForFeatureMgmt` boolean (default false) into the in-memory settings shape |
| `~/.claude/skills/compose/steps/docs.md` | edit | Replace free-text instructions with typed-tool recipes; remove ROADMAP flip; CHANGELOG via `add_changelog_entry` |
| `~/.claude/skills/compose/steps/ship.md` | edit | Note that build runner records completion automatically; manual fallback recipe |
| `compose/.claude/skills/compose/steps/docs.md` and `ship.md` | edit | Mirror updates if the workspace mirrors exist |
| `compose/test/migration-cockpit.test.js` | new | Integration tests for cockpit `lifecycle/complete` reconciliation paths |
| `compose/test/migration-build-runner.test.js` | new | Integration test for build-runner post-commit `recordCompletion` and prompt-injection enforcement |
| `compose/test/migration-skill-fixtures.test.js` | new | Grep test asserting skill files reference typed tools and avoid free-text Edit instructions |
| `compose/CHANGELOG.md` | edit | Entry under today's date for COMP-MCP-MIGRATION |
| `compose/ROADMAP.md` | edit | Flip COMP-MCP-MIGRATION to COMPLETE; flip umbrella `COMP-MCP-FEATURE-MGMT` to COMPLETE |

## Implementation order

1. Extend `complete_feature` MCP schema + wrapper (mechanical)
2. Update lifecycle/complete route handler with reconciliation (with tests)
3. Wire `recordCompletion` into `build.js` post-commit (with tests)
4. Add `enforcement.mcpForFeatureMgmt` setting + prompt injection (with tests)
5. Update skill files (docs.md, ship.md)
6. Doc + roadmap flips

## File:line verification

| Reference | Verified |
|---|---|
| `compose/server/vision-routes.js:341` lifecycle/complete handler | ✓ |
| `compose/server/compose-mcp.js:178` complete_feature schema | ✓ |
| `compose/server/compose-mcp-tools.js:409` toolCompleteFeature | ✓ |
| `compose/lib/build.js:~2150` post-commit metadata block | ✓ |
| `compose/lib/completion-writer.js:138-192` recordCompletion contract | ✓ |
| `~/.claude/skills/compose/steps/docs.md` exists | ✓ |
| `~/.claude/skills/compose/steps/ship.md` exists | ✓ |

## Settings shape

```json
// .compose/compose.json
{
  "enforcement": {
    "mcpForFeatureMgmt": false
  }
}
```

When `true`, `build.js` prepends a system-prompt fragment to every agent
invocation:

> ENFORCEMENT: do not Edit or Write `ROADMAP.md`, `CHANGELOG.md`, or any
> `feature.json` under `docs/features/`. Use the typed MCP tools
> (`add_roadmap_entry`, `set_feature_status`, `add_changelog_entry`,
> `record_completion`, `propose_followup`).

No auto-rollback in this version.

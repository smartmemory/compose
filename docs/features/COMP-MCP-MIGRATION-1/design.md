# COMP-MCP-MIGRATION-1: Audit-log correlated auto-rollback

## Why

COMP-MCP-MIGRATION shipped `enforcement.mcpForFeatureMgmt` as prompt-only because audit appends are best-effort, the log is global, and `build.js` had no per-build correlation IDs. Adding correlation lets us detect agents that ignore the prompt and reject those edits at stage time. Tracked since 2026-05-04.

**Status:** DESIGN
**Date:** 2026-05-04
**Parent:** COMP-MCP-MIGRATION

## Problem

When `enforcement.mcpForFeatureMgmt: true` is set, the system prompt tells the agent to use typed MCP writers instead of `Edit`/`Write` for `ROADMAP.md`, `CHANGELOG.md`, and `feature.json`. Today the build runner cannot tell whether an agent followed that instruction:

- `feature-events.jsonl` rows have a global timestamp + actor but no per-build correlation ID. A row from another concurrent session "satisfies" any check.
- `appendEvent` is best-effort (`safeAppendEvent` in writers swallows failures). A successful typed write can leave no audit row at all.
- `build.js`'s pre-stage logic (`lib/build.js:~2070`) collects dirty files but does not correlate them with audit rows.

Without correlation, prompt-only enforcement is the only available knob — it relies entirely on the agent's good faith.

## Goal

`enforcement.mcpForFeatureMgmt: true` becomes true block mode:

1. Each build run gets a unique `build_id` (UUID).
2. Every typed-writer event the build's agents emit is stamped with that `build_id` (via `COMPOSE_BUILD_ID` env var that the writer reads when stamping events).
3. `executeShipStep`'s pre-stage scan walks the dirty file list. For any guarded path (`ROADMAP.md`, `CHANGELOG.md`, `docs/features/*/feature.json`), it requires at least one matching typed-tool event with `build_id === <current_build>` in the same window. If absent, the file is **not staged**, a `mcp_enforcement_violation` decision event is emitted, and the build exits non-zero with an actionable error.
4. When `enforcement.mcpForFeatureMgmt` is false (default), the scan runs in **log-only** mode: it still emits the decision event for visibility, but does not block staging.

## Approach

### 1. Generate `build_id` in `runBuild`

In `lib/build.js`'s `runBuild` near the top (right after `featuresDir` is resolved), generate `build_id = randomUUID()`. Add it to the build context so all child code sees it. Set `process.env.COMPOSE_BUILD_ID = build_id` for the duration of the build (restored on exit).

Spawned agent processes already inherit env, so `feature-events.appendEvent` reading `process.env.COMPOSE_BUILD_ID` picks it up automatically — no per-writer change needed beyond the stamp.

### 2. Stamp `build_id` on every audit row

Update `lib/feature-events.js#appendEvent`:

```js
const row = {
  ts: new Date().toISOString(),
  actor: actor(),
  build_id: process.env.COMPOSE_BUILD_ID || null,
  ...event,
};
```

Existing readers (`roadmap_diff`) ignore unknown fields, so this is additive. When `COMPOSE_BUILD_ID` is unset (CLI invocation outside a build), `build_id: null` is preserved — the scan treats null as "not part of any current build."

### 3. Pre-stage scan in `executeShipStep`

Insert the scan in `lib/build.js#executeShipStep` between the dirty-file collection and `git add`. Algorithm:

```
const guardedPaths = filterGuarded(dirtyFiles, featuresDir);
if (guardedPaths.length === 0) return;          // nothing to check

const enforcement = readEnforcementSetting(cwd);  // 'block' | 'log'
const events = readEvents(cwd, { since: buildStartedAt })
  .filter(e => e.build_id === build_id);

const violations = [];
for (const path of guardedPaths) {
  const expected = expectedToolsForPath(path);   // tool names that could mutate path
  const matched = events.some(e => expected.includes(e.tool));
  if (!matched) violations.push({ path, expected });
}

if (violations.length > 0) {
  emitDecisionEvent({type: 'mcp_enforcement_violation', violations, build_id, ...});
  if (enforcement === 'block') {
    throw enforcementError(violations);
  }
  // log mode: warn and proceed
}
```

`filterGuarded`:

- `ROADMAP.md` → `['add_roadmap_entry', 'set_feature_status']`
- `CHANGELOG.md` → `['add_changelog_entry']`
- `<featuresDir>/<CODE>/feature.json` → `['add_roadmap_entry', 'set_feature_status', 'link_artifact', 'link_features', 'record_completion', 'propose_followup']`

Anything else is allowed through.

### 4. Setting key + threshold

`enforcement.mcpForFeatureMgmt` is the existing setting. Extend its meaning:

- `false` (default) — no prompt, no scan.
- `true` — prompt injection (already shipped) **+** scan in `block` mode.
- `'log'` (string) — prompt injection + scan in `log` mode (decision events only, no block). Useful as a soft rollout step before flipping to `true`.

Boolean `true` → block; string `'log'` → log; anything else → off.

## Decisions

1. **`build_id` lives in env, not function args.** Stamping happens at the `appendEvent` boundary so writers don't need new arguments. Env is fine because compose builds spawn child agents that inherit the parent's env; cross-process audit stamping is automatic.
2. **No retroactive build_id.** Audit rows written before this feature ships have `build_id: undefined` (treated as null on read). Scans only match rows with `build_id === <current>`, so legacy rows can never satisfy a current build's check. Correct by construction.
3. **Window filter via `since`.** The scan reads `feature-events` since `buildStartedAt` (set in `runBuild`). Combined with `build_id` match, this is the tightest filter we can offer without a stronger stream abstraction.
4. **Log-only string variant `'log'`.** Soft rollout before block; lets users see violations without breaking builds. Better than a separate setting key.
5. **No `force` override on the scan.** If a user wants to bypass the block, they unset the flag temporarily. `force` flags hide intent.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `lib/feature-events.js` | edit | Stamp `build_id` from env |
| `lib/build.js` | edit | Generate `build_id` in `runBuild`, set env, propagate via context, add pre-stage scan in `executeShipStep` |
| `lib/mcp-enforcement.js` | new | `filterGuarded`, `expectedToolsForPath`, `readEnforcementMode` helpers |
| `test/feature-events-build-id.test.js` | new | `build_id` stamping; legacy rows have null |
| `test/mcp-enforcement.test.js` | new | guarded-path matching, expected-tool mapping, mode parsing |
| `test/migration-build-runner.test.js` | new | Integration: agent edits ROADMAP without typed call → block mode rejects, log mode warns |

## Test plan

- `appendEvent` stamps `build_id` from `COMPOSE_BUILD_ID` env. Without env set, `build_id` is null.
- Existing readers (`roadmap_diff`, `getCompletions`) tolerate the new field.
- `filterGuarded(['ROADMAP.md', 'README.md', 'docs/features/X/feature.json'])` returns the first and third.
- `expectedToolsForPath('ROADMAP.md')` returns `['add_roadmap_entry', 'set_feature_status']`.
- Pre-stage scan, block mode: dirty `ROADMAP.md` with no matching event → throws `MCP_ENFORCEMENT_VIOLATION`, decision event emitted, `git add` not called.
- Pre-stage scan, log mode: same input → decision event emitted, build proceeds, file is staged.
- Pre-stage scan, off (default): no scan runs, no decision event.
- Pre-stage scan, block mode with matching event in window → no violation, build proceeds.
- Build window correctness: a stale event with the same `build_id` from a re-used UUID (artificial) outside the `since` window is filtered out.

## Out of scope

- Generalizing the scan to other artifact families (vision-state.json, lifecycle.json). This ticket targets the three guarded paths only.
- A retroactive backfill of `build_id` on existing audit rows. Legacy rows stay `null` and are correctly excluded from current-build scans.
- Distributed-build correlation (e.g. parallel agents writing across machines). Single-host single-build assumption holds for compose's current execution model.

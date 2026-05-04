# COMP-MCP-MIGRATION — Design

**Parent:** COMP-MCP-FEATURE-MGMT (sub-ticket #9, last in family)
**Status:** PLANNED
**Complexity:** L
**Created:** 2026-05-04

## Problem

The COMP-MCP-FEATURE-MGMT family shipped seven typed writer tools
(`add_roadmap_entry`, `set_feature_status`, `roadmap_diff`,
`add_changelog_entry`, `write_journal_entry`, `record_completion`,
`link_features` + `link_artifact`, `propose_followup`). The producers of
those mutations inside Compose itself, however, still use free-text
`Edit`/`Write` paths:

1. **`/compose` skill — `steps/docs.md`** instructs the agent to "update
   CHANGELOG.md" and "set ROADMAP feature status to COMPLETE" without
   naming the typed tools. Outcomes drift from the typed-tool invariants
   (no audit events, no transition policy, no idempotency).
2. **`/compose` skill — `steps/ship.md`** verifies artifact existence but
   never calls `record_completion`, so the commit-bound completion record
   that COMP-MCP-COMPLETION introduced is never created.
3. **Cockpit lifecycle endpoint** (`POST /api/vision/items/:id/lifecycle/complete`,
   `vision-routes.js:341`) flips `lifecycle.currentPhase` and `item.status`
   but does NOT call `record_completion` or `set_feature_status`. As a
   result, "completed in cockpit" and "completed in CLI" diverge.
4. **Build runner** stages `CHANGELOG.md` / `ROADMAP.md` whenever they are
   dirty (`build.js:2078`), but does not constrain *how* the inner agent
   produced the changes — agents continue to use free-text Edit/Write.

There is no enforcement: an agent that ignores the typed tools and edits
`ROADMAP.md` directly is silently accepted. Drift is detected only by
`validate_feature` after the fact.

## Goal

Two outcomes:

1. **Migrate the three internal producers** to call typed MCP tools (or
   the underlying lib functions in-process). After migration: no Compose
   internal code path edits ROADMAP.md or CHANGELOG.md by hand.
2. **Reconcile `complete_feature` and `record_completion`.** The cockpit
   "complete" action becomes a thin wrapper that calls `record_completion`
   (creating the commit-bound record) and `set_feature_status` (flipping
   ROADMAP) in addition to the existing lifecycle/item-status flips. CLI
   `compose ship` reaches the same outcome via the same wrappers.
3. **Optional enforcement flag.** When `.compose/compose.json` sets
   `enforceMcpForFeatureMgmt: true`, an Edit/Write that touches
   `ROADMAP.md` or `CHANGELOG.md` from inside the agent context is
   refused with a typed error directing the caller to the right tool.

## Migration targets

### Target 1 — `/compose` skill `steps/docs.md` and `steps/ship.md`

Replace the free-text instructions with explicit tool-call recipes
**that respect the commit-boundary contract**: ROADMAP / feature.json /
CHANGELOG flips happen at ship time (post-commit), not during docs.

`steps/docs.md`:

```md
1. **CHANGELOG.md** — call `mcp__compose__add_changelog_entry({
     date_or_version: <today>, code: <FEATURE_CODE>, summary: ... })`.
     Do NOT Edit/Write CHANGELOG.md directly. Run this BEFORE the commit
     so the changelog entry is in the same commit.
2. **README.md** — Edit/Write is fine; README is not under typed-tool
     governance.
3. **ROADMAP / feature.json** — do NOT flip status here. Status moves to
     COMPLETE only at ship time, post-commit, via
     `record_completion` (which atomically writes the completion record
     and flips status). This avoids leaving the feature COMPLETE if ship
     fails.
```

`steps/ship.md`:

```md
The build runner (Target 3) calls `record_completion` automatically
after the commit lands; the skill does NOT call it. The skill's job is
only to verify artifacts, run tests, and hand off to the runner's
commit step. Then call `stratum_audit(flow_id)` and present commit/PR
options.

If you are running ship outside the build runner (e.g. manually after a
hotfix), call `mcp__compose__record_completion({ feature_code,
commit_sha, tests_pass: true, files_changed, notes })` yourself. The
writer flips feature status to COMPLETE atomically. Do NOT call
set_feature_status separately.
```

These are skill-file edits only.

### Target 2 — Cockpit `complete_feature` reconciliation

`POST /api/vision/items/:id/lifecycle/complete` accepts an optional
`commit_sha` field in the request body. Behavior:

```js
// existing (unchanged):
//   - phase guard (must be in 'ship')
//   - update item.lifecycle.currentPhase = 'complete'
//   - append phaseHistory
//   - update item.status = 'complete'
//   - emit phase_transition / status snapshot / drift broadcast

// new (post-existing-transition):
//   - resolve featureCode from item.lifecycle.featureCode
//   - if featureCode is set AND req.body.commit_sha is provided:
//     - call recordCompletion(cwd, {
//         feature_code: featureCode,
//         commit_sha,                         // full 40-char SHA
//         tests_pass: req.body.tests_pass ?? true,
//         files_changed: req.body.files_changed ?? [],
//         notes: req.body.notes ?? `cockpit lifecycle: ${featureCode} complete`
//       })
//     - on success: nothing further; recordCompletion already flips
//         feature.status to COMPLETE and regenerates ROADMAP.md.
//     - on STATUS_FLIP_AFTER_COMPLETION_RECORDED: log warning, emit
//         decision event `cockpit_completion_partial_status_flip` with
//         the original error.cause; response includes a `partial: true`
//         field naming the stuck status.
//     - on other error: log warning, emit
//         `cockpit_completion_failed` decision event; response includes
//         `partial: true, completion_failed: <code>`.
//   - if featureCode is set AND commit_sha is NOT provided: skip the
//     completion record entirely (cockpit cannot fabricate a SHA),
//     emit `cockpit_completion_skipped` decision event explaining the
//     skip. The CLI/agent path will record completion when it commits.
//   - if featureCode is unset: behave exactly as today (legacy items).
```

The `complete_feature` MCP tool wrapper at `compose-mcp-tools.js:400`
gains optional `commit_sha`, `tests_pass`, `files_changed`, `notes`
forwarded into the request body. The lifecycle endpoint stays the
single source of truth; the MCP tool stays a thin POST. The MCP input
schema for `complete_feature` in `compose/server/compose-mcp.js:178`
must add these new optional fields alongside the existing `id`.

**Why this shape, not transactional:** the lifecycle endpoint runs in
the cockpit server process; failing the lifecycle transition because a
downstream typed tool failed would leave cockpit users stuck. Surfacing
the partial state via decision event lets `validate_feature` flag the
drift on the next pass and lets the cockpit UI prompt the user to
retry. Since `recordCompletion` is itself idempotent on `(feature_code,
commit_sha)` (see completion-writer.js), the retry path is safe.

**Why require `commit_sha` to be passed in:** the cockpit doesn't own
the commit (the build runner / human does). Without a SHA, no
commit-bound record can be made. The CLI ship path (Target 3) supplies
the SHA naturally; cockpit users either pass it through the lifecycle
form or accept the skip + manual `record_completion` later.

### Target 3 — Build runner `lib/build.js` (CLI ship path)

The CLI's `ship` step is the one path that owns a commit boundary; it
must be the path that calls `record_completion`, not the skill text.
Targets:

1. After the build runner's commit succeeds (around `build.js:2124-2153`,
   the existing commit + post-commit handling), call
   `recordCompletion` directly with the resolved `commit_sha`,
   `tests_pass: true` (the ship step's pre-flight already gated tests),
   `files_changed` from the staged file list, and a `notes` line
   derived from the feature description.
2. On `STATUS_FLIP_AFTER_COMPLETION_RECORDED`, log + continue (the
   completion record is the durable artifact; the status flip can be
   resolved by `compose validate --code <CODE>` and a manual
   `set_feature_status` retry).
3. On other failure, abort the post-commit phase with a clear error;
   the commit itself stays (do not amend or revert).
4. Removed: any free-text Edit/Write of `ROADMAP.md` or `CHANGELOG.md`
   from inside the build runner. CHANGELOG entries that need to land in
   the same commit must come through `add_changelog_entry` invoked by
   the agent during the `docs` step (Target 1) — which writes the file
   *before* the commit-staging hook runs, so they are picked up by the
   existing dirty-file sweep at `build.js:2078`.

This is the only piece of compose code that changes for migration; the
rest is agent prompt / skill text.

### Target 4 — `enforceMcpForFeatureMgmt` settings flag

A new boolean in `.compose/compose.json` under `enforcement`:

```json
{
  "enforcement": {
    "mcpForFeatureMgmt": false
  }
}
```

When `true`, the build runner injects a hard instruction into the agent
system prompt:

> Do NOT use Edit, Write, or any shell write that targets `ROADMAP.md`,
> `CHANGELOG.md`, or any `feature.json` under `docs/features/`. Use the
> typed MCP tools (`add_roadmap_entry`, `set_feature_status`,
> `add_changelog_entry`, `record_completion`, `propose_followup`)
> instead.

The flag is **prompt-level only** in this version. Audit-log-correlated
auto-rollback was considered (and rejected) because:

- `appendEvent` is best-effort by design (`feature-writer.js`,
  `safeAppendEvent`); a successful typed write can omit an audit row.
- The audit log is global; another session's event in the same window
  would falsely satisfy a "did you use the typed tool?" check.
- `build.js` has no per-build correlation ID stamped onto audit rows.

Adding correlated provenance is its own follow-up
(`COMP-MCP-ENFORCE-AUTO-ROLLBACK`). For now, prompt-level enforcement
plus the existing `validate_project` drift detection is the safety net.

Default is `false` — existing workflows keep working.

## Decisions

1. **Status-to-COMPLETE flip happens at ship time, not docs time.**
   `record_completion` already flips status atomically with the
   completion-record write. Calling `set_feature_status` from `docs`
   (the prior plan) leaves the feature COMPLETE if ship later fails.
2. **Cockpit completion record requires `commit_sha` in the body.** No
   SHA, no record (with a decision event explaining the skip). The
   cockpit cannot fabricate provenance.
3. **No redundant `setFeatureStatus` after `recordCompletion`** —
   `recordCompletion` already does the flip; a second call masks the
   `STATUS_FLIP_AFTER_COMPLETION_RECORDED` partial-failure envelope.
4. **Best-effort cockpit downstream call.** Cockpit must not lock up
   because of typed-tool failures. Drift is recoverable; stuck cockpit
   is not.
5. **No new shared abstraction.** The route handler and `build.js`
   each call `recordCompletion` directly via dynamic import, matching
   the precedent at `compose-mcp-tools.js:204-227`. No new "lifecycle
   finalization" service.
6. **`enforceMcpForFeatureMgmt` is prompt-only in v1.** Audit-log
   correlated auto-rollback needs per-build correlation IDs stamped
   onto audit rows; that's a follow-up
   (`COMP-MCP-ENFORCE-AUTO-ROLLBACK`).
7. **Defaults to `false`** — opt-in in the first version.
8. **Skill-file edits live in `~/.claude/skills/compose/steps/`** —
   they are part of the user's skill tree, not the compose repo. The
   compose PR includes them as separate-file edits but they ship under
   user home. (The `compose/.claude` workspace mirror exists too; both
   paths are updated in the same change.)

## Test plan (for the implementation phase)

- **Cockpit complete with commit_sha:** lifecycle/complete on an item
  with `featureCode` and a `commit_sha` in the body produces (a) the
  existing lifecycle transition (b) a completion record on
  `feature.json.completions[]` via `recordCompletion` (c) status flip
  to COMPLETE on feature.json + ROADMAP.md (the writer does this
  internally).
- **Cockpit complete without commit_sha:** lifecycle/complete on an
  item with `featureCode` but no `commit_sha` → lifecycle transitions
  as today, no completion record is written, decision event
  `cockpit_completion_skipped` is emitted with `reason:
  'no_commit_sha'`.
- **Cockpit complete with typed-tool failure:** simulate
  `recordCompletion` throwing a non-status-flip error → lifecycle
  still transitions, decision event `cockpit_completion_failed`
  emitted, response includes `partial: true` and `completion_failed:
  <code>`, no rollback.
- **Cockpit complete with status-flip partial:** simulate
  `STATUS_FLIP_AFTER_COMPLETION_RECORDED` → completion is persisted,
  decision event `cockpit_completion_partial_status_flip` emitted,
  response includes `partial: true`.
- **No featureCode:** lifecycle/complete on an item without
  `lifecycle.featureCode` works as before — no typed-tool calls.
- **CLI ship path records completion post-commit:** integration test
  invokes `compose ship`-equivalent, asserts a completion entry on
  `feature.json.completions[]` with the real `commit_sha` and
  `tests_pass: true`.
- **CLI ship resilience to STATUS_FLIP_AFTER_COMPLETION_RECORDED:**
  the build runner logs the failure and exits 0; the completion is
  durable. Manual `set_feature_status` retry succeeds.
- **Enforcement off (default):** existing builds proceed unchanged; no
  prompt injection.
- **Enforcement on:** the agent system prompt includes the typed-tool
  instruction; behaviour is otherwise identical (no auto-rollback in
  this version). Verified via prompt-fixture grep in
  `test/build-prompt-injection.test.js`.
- **Skill edits applied:** `steps/docs.md` and `steps/ship.md`
  reference the typed tools by name (assert via grep in a skill smoke
  test).
- **`compose validate_project`:** after running the migrated cockpit
  + ship flow, `validate_project` returns zero drift findings on the
  test feature.

## Out of scope

- Migrating *external* projects' callers. This ticket is Compose's own
  internal callers only.
- Rewriting the typed tools' implementations. They stay as-is.
- Backfilling completion records for features completed via the legacy
  cockpit flow before this migration. A separate `compose backfill`
  command can do that later if needed.
- Tightening the enforcement flag to default-`true`. Filed separately.

## Related Documents

- Parent: `compose/ROADMAP.md` Phase 7 (`COMP-MCP-FEATURE-MGMT`, item 9).
- Sibling: `docs/features/COMP-MCP-FOLLOWUP/design.md` (just shipped).
- Touch points: `compose/server/vision-routes.js:341`,
  `compose/lib/build.js:2078`, `compose/server/compose-mcp-tools.js:400`,
  `~/.claude/skills/compose/steps/docs.md`,
  `~/.claude/skills/compose/steps/ship.md`.

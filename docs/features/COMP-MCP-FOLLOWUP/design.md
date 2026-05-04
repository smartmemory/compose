# COMP-MCP-FOLLOWUP — Design

**Parent:** COMP-MCP-FEATURE-MGMT (sub-ticket #8)
**Status:** PLANNED
**Complexity:** M
**Created:** 2026-05-04

## Problem

When a session surfaces follow-up work — a bug, a missing test surface, a
deferred edge case — recording it requires three sequential calls today:

1. `add_roadmap_entry({code, description, phase, parent, complexity?})`
2. `link_features({from_code: <new>, to_code: parent, kind: 'surfaced_by'})`
3. `scaffold_feature({featureCode: <new>})` + manual rationale block edit

Plus the human picks the code by hand. Recent sessions did this entire dance
inline, sometimes skipping the link, sometimes skipping the scaffold, and the
auto-numbering convention was never enforced. Result: drift between
"the parent has follow-ups" (audit log) and "the parent has typed links"
(feature.json).

## Goal

One typed call — `propose_followup` — files a follow-up against a parent
feature with auto-numbered code, `surfaced_by` link from new → parent, and
a scaffolded `design.md`. Audit-logged. Refuses to file against a
non-existent or terminal-status (KILLED / SUPERSEDED) parent. Retry-safe
via idempotency_key; without one, repeated calls file fresh follow-ups
(this is intentional — see Idempotency).

## Tool Surface

```
propose_followup({
  parent_code:    string,             // required, must match FEATURE_CODE_RE_STRICT
  description:    string,             // required, one-line ROADMAP cell
  rationale:      string,             // required — *why* this follow-up exists
  complexity?:    'S'|'M'|'L'|'XL',   // optional, defaults to omitted
  phase?:         string,             // optional, inherits parent.phase if absent
  status?:        'PLANNED'|...,      // optional, default PLANNED
  idempotency_key?: string,
}) → {
  code:        string,                // generated
  parent_code: string,
  phase:       string,
  position:    number,
  roadmap_path: string,
  scaffolded:  { created: string[], skipped: string[] }, // filenames, scaffold_feature shape
  link:        { kind: 'surfaced_by', from_code: string, to_code: string },
}
```

## Auto-numbering

The new code is `<parent_code>-<N>` where N is `max(existing N) + 1` over
features whose code matches `^<parent_code>-\d+$`. Starts at 1.

This is a new convention for follow-ups and is additive — existing children
of a parent (named children like `COMP-MCP-ROADMAP-WRITER`) are not part of
the numbered namespace and are ignored when computing N.

Generated code is validated against `FEATURE_CODE_RE_STRICT` after assembly
(it will pass by construction, but the assertion guards against future regex
changes).

## Rationale field

`rationale` is a required, free-text reason for filing this follow-up.
Persisted in two places:

1. The audit event under `feature-events.jsonl` — keyed by `tool:
   'propose_followup'`, includes `parent_code`, `code`, `rationale`.
2. The new feature's `design.md` stub — written above the standard scaffold
   sections as a `## Why` block.

It is **not** stored as a top-level field on `feature.json`; that file's shape
is contract-controlled and we don't want to thread a new optional column
through every reader.

## Composition

`propose_followup` is a thin orchestrator. It calls existing typed writers in
order; on any step's failure it surfaces a `PARTIAL_FOLLOWUP` error envelope
(modeled on `ROADMAP_PARTIAL_WRITE`) so the caller knows whether the
feature.json was written, the link was made, or the scaffold ran.

```
1. validate parent: readFeature(cwd, parent_code) — must exist, status not in
   {KILLED, SUPERSEDED}.
2. compute next code under parent_code namespace.
3. addRoadmapEntry({...derived, parent: parent_code})
4. linkFeatures({from_code: <new>, to_code: parent_code, kind: 'surfaced_by'})
5. scaffoldDesignWithRationale({featureCode: <new>, rationale}) — single
   helper in `lib/followup-writer.js`. Internally it dynamically imports
   `server/artifact-manager.js` (mirroring the pattern at
   `feature-writer.js:516`) and calls
   `new ArtifactManager(featureRoot).scaffold(featureCode, { only:
   ['design.md'] })`, then inserts a `## Why` block above the scaffolded
   content. The two writes together form a single retryable unit: if
   rationale insertion fails, the helper deletes the just-created
   design.md before throwing, so the next call (or a fallback
   `scaffold_feature` invocation) starts from a clean slate. The MCP
   `scaffold_feature` tool wrapper is **not** invoked from here — the
   library helper goes directly to `ArtifactManager` to keep the call
   graph in-process.
6. emit composite audit event {tool: 'propose_followup', parent_code, code,
   rationale, idempotency_key, ts}.
```

Failure semantics:

- Step 3 fails before any mutation (validation, duplicate code) → nothing
  written; surface the underlying error verbatim.
- Step 3 throws `ROADMAP_PARTIAL_WRITE` (feature.json committed but
  ROADMAP.md regeneration failed — see
  `compose/lib/feature-writer.js`) → throw `PARTIAL_FOLLOWUP` with `{
  created_code, stage: 'roadmap_regen' }`. The inflight ledger advances to
  a dedicated stage `roadmap_committed_regen_failed`. Recovery: rerun
  `propose_followup` with the same `idempotency_key` — per the resume
  rules below, the orchestrator detects this stage, calls `writeRoadmap`
  directly to regenerate the file (rather than re-running
  `addRoadmapEntry`, which would just throw "already exists" without
  re-attempting regeneration), advances the ledger to `roadmap_done`, and
  continues from step 4. Alternative: call `compose roadmap generate`
  then `link_features` and `scaffold_feature` directly to finish by hand.
- Step 4 fails after step 3 committed → throw `PARTIAL_FOLLOWUP` with `{
  created_code, stage: 'link' }`. Recovery: caller invokes `link_features`
  directly with `from_code: created_code, to_code: parent_code, kind:
  'surfaced_by'`.
- Step 5 fails after 3+4 committed → throw `PARTIAL_FOLLOWUP` with `{
  created_code, stage: 'scaffold' }`. The helper rolls back its own
  design.md write before throwing, so the feature folder may exist but
  contains no canonical artifacts. Recovery: caller invokes
  `scaffold_feature({featureCode: created_code, only: ['design.md']})`
  (narrow form to match the orchestrator's intended state) and writes a
  `## Why` block manually, OR allocates a new follow-up via a fresh
  `propose_followup` call (the abandoned `created_code` remains in
  `feature.json` and will surface in `validate_feature` as an
  artifact-incomplete warning until cleaned up).
- Step 6 (audit emission) is best-effort and never throws — failures are
  warned via `console.warn` and the orchestrator returns success. This
  matches `safeAppendEvent` precedent in `feature-writer.js`.

Replaying `propose_followup` with the **same** `idempotency_key`:

- After full success: returns the cached result via `checkOrInsert` (no
  filesystem checks needed).
- After partial failure: reads the inflight ledger at
  `.compose/inflight-followups/<key>.json`, resumes from the recorded
  `stage`, and uses the recorded `allocated_code` rather than computing a
  new N. See **Idempotency** for the resume rules and stage table.

Replaying without an `idempotency_key` allocates a new code and creates a
second follow-up; that is the same as filing a new ticket and is the
caller's responsibility to avoid. The granular-tool recovery paths
documented above are still valid escape hatches when a caller wants to
finish a partial state by hand instead of replaying.

## Idempotency

`lib/idempotency.js` caches **only successful** results, so a naive
`checkOrInsert` wrapper would re-run the orchestrator on every
post-failure retry and allocate a new code each time. This orchestrator
needs to resume across partial state, so it uses a two-layer strategy:

**Inflight ledger.** Before any mutation, the orchestrator writes
`.compose/inflight-followups/<sha256(key)>.json` (filename derived via
`sha256(idempotency_key).slice(0, 16)` so user-supplied keys cannot
contain path separators, `..`, or unusable characters; the raw key is
stored inside the JSON as `idempotency_key`). The payload is `{
idempotency_key, parent_code, allocated_code, stage: 'pending',
request_fingerprint, ts }` where `request_fingerprint` is
`sha256(JSON.stringify({parent_code, description, rationale, phase: phase
?? null, status: status ?? 'PLANNED', complexity: complexity ?? null}))`.
The file is created with `wx` (exclusive) — if it already exists, the
orchestrator reads it, **verifies** the recorded `idempotency_key`,
`parent_code`, **and** `request_fingerprint` all match the current call
(else throw `INVALID_INPUT: idempotency_key reused with different
arguments`), and resumes from the recorded `stage` rather than allocating
a new code. The `stage` is updated after each successful step
(`pending` → `roadmap_done` → `link_done` → `scaffold_done`). On full
success the result is **first** cached via `checkOrInsert` under
`propose_followup:<parent_code>:<key>` and only then is the inflight
ledger deleted; a crash in this final gap is harmless because the next
same-key replay finds the cache hit before reading the ledger. On
partial failure the ledger remains on disk; the next retry with the same
key resumes from the recorded stage.

**Concurrency.** Two same-parent, no-key (or different-key) callers could
race to allocate the same `<N>`. To prevent the loser from then claiming
the winner's just-created feature as its own, the orchestrator takes an
exclusive file lock on `.compose/locks/followup-<sha256(parent_code).slice(0, 16)>.lock`
around the *allocation + step-3* span only (not held across HTTP retries
or scaffold I/O). Inside the lock: read the namespace to compute N, call
`addRoadmapEntry`, write `stage: 'roadmap_done'` to the ledger, release.
If the lock cannot be acquired within 5 seconds, throw
`FOLLOWUP_BUSY` — the caller retries.

The lock prevents the duplicate-detection-on-resume path from ever
mistakenly inheriting a foreign feature: any time we observe an existing
feature.json at our `allocated_code`, we held the per-parent lock when we
recorded that code, so it must be ours.

**Resume rules.** Resume from `pending` reacquires the per-parent file
lock before reattempting step 3; the lock is released after the ledger
advances to `roadmap_done`. Resume from `roadmap_done`, `link_done`, or
`scaffold_done` does not take the lock — those stages are post-step-3
and operate on the already-allocated code, where no allocation race is
possible.

- `stage === 'pending'`: take per-parent lock; reattempt step 3 with the
  recorded `allocated_code`. `addRoadmapEntry` rejects duplicates — if it
  throws "feature already exists", we know the code was created under our
  prior lock-holding attempt (the lock is reacquired here, so no foreign
  caller could have allocated it in between). Verify the existing
  feature.json's `parent === parent_code` then call `writeRoadmap(cwd)`
  directly to ensure ROADMAP.md is current, advance to `roadmap_done`,
  and continue.
- `stage === 'roadmap_committed_regen_failed'`: do not re-run
  `addRoadmapEntry` (it would re-throw "already exists" without
  regenerating). Call `writeRoadmap(cwd)` directly; advance to
  `roadmap_done` and continue.
- `stage === 'roadmap_done'`: reattempt step 4. `linkFeatures` already
  dedups on `(kind, to_code)` and returns `{noop: true}` if the link
  exists.
- `stage === 'link_done'`: reattempt step 5. `scaffold_feature` skips
  existing files; the rationale-insertion helper checks for an existing
  `## Why` heading at the top of design.md and skips if present.
- `stage === 'scaffold_done'`: nothing to do; emit audit, cache, return.

**Cache key namespacing.** The successful-result cache key is
`propose_followup:<parent_code>:<idempotency_key>` so a key reused with a
different parent (or by another tool) never collides.

**No key.** Without `idempotency_key`, no inflight ledger is written and
each call allocates a new numbered code. This is the same as filing a new
ticket; callers wanting retry safety **must** pass a key.

The inner writer calls (`addRoadmapEntry`, `linkFeatures`,
`scaffoldFeature`) are invoked without their own idempotency keys; the
outer ledger and key gate the whole orchestration.

## Validation rules

| Rule | Error |
|---|---|
| Parent code fails `FEATURE_CODE_RE_STRICT` | `INVALID_INPUT` |
| Parent feature not found | `PARENT_NOT_FOUND` |
| Parent status in {KILLED, SUPERSEDED} | `PARENT_TERMINAL` |
| Empty rationale (whitespace-only) | `INVALID_INPUT` |
| Empty description | `INVALID_INPUT` |

## Known limitations (inherited)

`propose_followup` operates on the same feature root as the underlying
writers it composes (`addRoadmapEntry`, `readFeature`, `linkFeatures` in
`feature-writer.js`; `ArtifactManager` in `artifact-manager.js`). The
writers default to `docs/features`; `ArtifactManager` resolves via
`resolveProjectPath('features')`. In repos with `paths.features`
overridden in `.compose/compose.json`, today's writers do not honour the
override consistently — that gap is not introduced by this feature and
is filed against the underlying writers (track separately under the
`paths`-respect cleanup; not a blocker for shipping FOLLOWUP).

## Out of scope

- Triggering a `/compose` lifecycle on the new feature. `propose_followup`
  files the ticket — the human (or a follow-on automation) decides when to
  build it.
- Cross-project follow-ups (parent in a different repo). The parent must
  resolve under the current `cwd`.
- Promoting an ideabox idea to a follow-up. That's the `ideabox` skill's
  job; if it ever needs to call `propose_followup`, it will via this same
  tool.

## Test plan (for the implementation phase)

- Happy path: parent with one existing follow-up → next is N+1, link added,
  design.md scaffold has rationale block, audit event written.
- Cold start: parent with no numbered children → first follow-up is `-1`.
- Idempotency: same key returns the same `code` without mutating.
- Parent terminal status (KILLED) → `PARENT_TERMINAL`, nothing written.
- Parent not found → `PARENT_NOT_FOUND`, nothing written.
- Phase inherits from parent when omitted.
- Partial-write recovery: simulate a failure between addRoadmapEntry and
  linkFeatures → caller receives `PARTIAL_FOLLOWUP` with `stage: 'link'`
  and the allocated `created_code`; a follow-up `link_features` call wires
  the surfaced_by edge new → parent.
- Partial-write recovery (scaffold stage): simulate a failure during
  scaffold → `PARTIAL_FOLLOWUP` with `stage: 'scaffold'`; calling
  `scaffold_feature({featureCode: created_code, only: ['design.md']})` plus
  a manual `## Why` insertion cleanly finishes.
- Idempotency cache namespacing: same `idempotency_key` against two
  different parents allocates two distinct codes (no collision).
- Request-fingerprint mismatch: same `idempotency_key` reused with a
  different `description` (or any other fingerprinted field) → throws
  `INVALID_INPUT` and does not mutate.
- Concurrent same-parent allocation: simulate two concurrent calls
  contending for the per-parent lock; the loser either waits or throws
  `FOLLOWUP_BUSY`; both end with distinct `<N>` codes (the second sees
  the first's commit and increments).
- Crash between cache-write and ledger-delete: simulate by leaving both
  on disk; same-key replay returns the cached result without touching
  the ledger.

## Open questions

None — the auto-numbering convention is the only design choice; consensus
is to use `<parent>-<N>`.

## Related Documents

- Parent: `compose/ROADMAP.md` Phase 7 (`COMP-MCP-FEATURE-MGMT`)
- Sibling: `docs/features/COMP-MCP-ROADMAP-WRITER/design.md`
- Sibling: `docs/features/COMP-MCP-ARTIFACT-LINKER/design.md`
- Library deps: `compose/lib/feature-writer.js`,
  `compose/server/artifact-manager.js`, `compose/lib/feature-events.js`,
  `compose/lib/idempotency.js`.

---
name: Automatic Roadmap Archival
priority: medium
track: lifecycle
desc: Keep the generated roadmap active-only by moving inactive rows into an archive document automatically as Compose processes feature transitions.
---

# COMP-ROADMAP-ARCHIVE — Automatic Roadmap Archival

Status: PLANNED — design proposal; runtime implementation has not started.
Created: 2026-09-09 (Codex/astra draft). Revised: 2026-09-09 (Fable design review;
Codex sol/high review rounds 1 and 2 folded in, see Review log).
Implementation plan: [plan.md](plan.md).
Related feature: [COMP-ROADMAP-SHARD](../COMP-ROADMAP-SHARD/feature.json).

## Revision note (2026-09-09)

The first draft bundled five features under one L ticket. This revision keeps the
diagnosis and the invariants, and cuts scope to the slice that delivers the user-visible
outcome. Four decisions, each recorded here so they are not re-litigated at blueprint:

1. **No DEFERRED status.** PARKED already means "inactive, not finished, reversible",
   and `setFeatureStatus` accepts a `reason` (optional today, appended to a
   best-effort audit event after the status is already persisted). v1 makes it
   required for PARKED and stores it **in feature.json** in the same write as the
   status (`status_reason`), so it cannot be lost to a projection or audit failure
   (see Behavior 1). A second status for the same state would touch the schema,
   transition table, CLI/MCP/HTTP validation, both providers, parsers and UI to
   gain a synonym. "Deferred" is prose vocabulary; it maps to PARKED with a reason.
2. **Generated-mode workspaces only in v1.** Narrative-owned roadmaps exist precisely
   so that no writer edits their prose. Automatic row moves in a hand-authored file
   are the clobber class `roadmap generate` already committed once. Narrative
   workspaces (forge-top) keep the manual split; automation there is a follow-up
   with its own design.
3. **Local provider in v1.** The GitHub provider publishes one document with a
   Contents API SHA check today; a two-document transactional publish is real work
   with its own failure modes. It is filed as a follow-up and the GitHub provider
   logs that archival is local-only until then. Parity is explicitly deferred, not
   silently skipped.
4. **COMP-ROADMAP-SHARD boundary decided now.** This feature supersedes SHARD's
   "active + archived" shard shape. SHARD keeps size-triggered and per-phase
   splitting. To make that layering real rather than nominal, the document-set
   loader is designed as an **ordered set of documents with a placement policy**,
   of which the active/archive pair is the v1 instance. SHARD adds policies, not a
   new loader.

Also cut from v1: cross-root incoming-link rewriting (v1 rewrites links inside the
roadmap documents themselves and leaves redirect anchors for everyone else), and a
versioned migration of existing projects (v1 is default-on for new projects and a
config flag for existing ones, with the first processing pass after enabling doing
the initial partition).

## Intent

During normal Compose processing, completing, parking, killing or superseding a
feature must move its roadmap row into an archive document and leave the primary
roadmap holding planned and active work only. A manual cleanup, an agent
instruction, a command a person has to remember after every completion, or a cron
job does not satisfy this feature.

This is a Compose capability for generated-mode managed projects. The forge-top
document split of 2026-09-09 is a narrative-owned manual cleanup; it is a fixture
shape for tests, not an implementation and not a v1 target.

## Verified existing seams

- [feature-writer.js](../../../lib/feature-writer.js): `setFeatureStatus` persists
  ordinary transitions, records `reason` when supplied, and calls
  `provider.renderRoadmap()`. It refuses a *transition* to COMPLETE; a same-status
  request (including COMPLETE to COMPLETE) returns early before that check. The
  transition table has no ordinary edge into SUPERSEDED; COMPLETE to SUPERSEDED is
  force-only. Hooking only this writer would miss completion and recovery on retry.
- [completion-gate.js](../../../lib/completion-gate.js): live completion and backfill
  each perform evidence-gated persistence followed by their own
  `provider.renderRoadmap()` call. On a projection failure the live path records
  the failure, **then clears its completion intent**, so a retry finds the guard
  already complete and refuses before reaching the render. Projection repair
  therefore cannot depend on the gate's completion intent (see Automatic
  integration).
- [completion-writer.js](../../../lib/completion-writer.js): completing requests
  delegate to the gate; record-only requests must not archive unfinished work.
- [roadmap-gen.js](../../../lib/roadmap-gen.js) and
  [roadmap-preservers.js](../../../lib/roadmap-preservers.js): render one document
  from feature.json plus **preserved source content**: anonymous rows with no
  feature.json (compose's own roadmap has whole phases of them, e.g. the
  `| — | Discovery, requirements, PRD, UI-BRIEF | COMPLETE |` block), source-only
  phase blocks, phase prose treated as one block, and per-item rows for features
  with item-level statuses. Every one of these needs a placement rule; feature.json
  status alone does not cover the document.
- [bin/compose.js](../../../bin/compose.js) `roadmap generate` and `roadmap check`
  compute and write or verify a single file independently of the provider;
  `compose feature` writes feature.json and edits ROADMAP.md directly.
  [build.js](../../../lib/build.js) raw-writes IN_PROGRESS at start **whatever the
  previous status was** (a PARKED or COMPLETE feature can be built into
  IN_PROGRESS) and PLANNED at teardown, without rendering. [lane-gate.js](../../../lib/lane-gate.js) creates
  features through the provider directly. [followup-writer.js](../../../lib/followup-writer.js)
  calls `writeRoadmap` directly in its recovery paths. These are all producers of
  the document and are in the wiring inventory.
- [local provider](../../../lib/tracker/local-provider.js) renders one document.
  [GitHubProvider](../../../lib/tracker/github-provider.js) separately regenerates
  and publishes that one document (out of v1 scope, see Revision note).
- [roadmap-config.js](../../../lib/roadmap-config.js) marks narrative-owned
  workspaces; the typed writer must keep refusing to regenerate them.
- [get-roadmap.js](../../../lib/get-roadmap.js) is not read-only today: in generated
  mode it calls `generateRoadmap`, whose preserved-override drift check emits an
  audit event. [feature-validator.js](../../../lib/feature-validator.js) treats a
  repeated phase identity as a duplicate and silently keeps the last row per code.
  [roadmap-roundtrip.js](../../../lib/roadmap-roundtrip.js) expects per-item
  statuses and does not reject duplicate non-item rows. All three assume one
  document and move with the writer.
- The [feature schema](../../../contracts/feature-json.schema.json) status enum is
  PLANNED, IN_PROGRESS, PARTIAL, COMPLETE, SUPERSEDED, PARKED, BLOCKED, KILLED.
  This feature adds no status.

## Behavior and invariants

1. **Partition by status, with one authority per row kind.** Active statuses are
   PLANNED, IN_PROGRESS, PARTIAL, BLOCKED; inactive are COMPLETE, PARKED,
   SUPERSEDED, KILLED.
   - A managed feature (has feature.json) is placed by its canonical status.
     All of its rows, including item-level rows, travel with the parent as one
     unit; a PARTIAL parent with COMPLETE items stays active. Archived count is a
     count of features, not rows.
   - An anonymous preserved row has no feature.json, so **its own status column is
     its canonical status** and it is placed by that. A source-only phase block
     with rows moves whole when every row in it is inactive.
   - A source-only phase block with **no rows** is placed by the status token in
     its heading (`## Name — STATUS`, already parsed by the preservers); a heading
     with no status token stays where it currently is. Compose's own roadmap has
     both a rowless SUPERSEDED phase and a rowless PLANNED phase.
   - Body prose never classifies anything. An unrecognised status token leaves
     the row or block where it is and emits a diagnostic.
   - PARKED requires a `reason` through the typed writer in v1, persisted as
     `status_reason` in feature.json in the same write as the status; existing
     PARKED features without one are not rewritten.
2. **Only presentation moves.** Feature directories, artifacts, dependency IDs,
   completion evidence and event history stay where they are. PARKED is inactive,
   not a satisfied dependency.
3. **Mixed-phase ownership is explicit.** While a phase has any active row, the
   **active document owns the phase**: heading, prose block and active rows. The
   archive renders the same heading with only the inactive rows and a one-line
   link back to the owning heading. When the last active row leaves, the whole
   phase (heading, prose, rows) moves to the archive and the active document keeps
   a redirect anchor. The validator learns that a phase identity present in both
   documents of the set is the mixed case, not a duplicate.
4. **Reactivation is symmetric.** A transition back into an active status removes
   the archived row and re-renders it in the active document on the same pass.
   Repeated cycles never produce two authoritative rows.
5. **Stable anchors, redirects with a lifecycle.** Every feature row carries a
   stable per-feature anchor. Exactly one document holds the row; the other holds
   at most one redirect anchor pointing at it. On a move, the redirect at the
   destination is removed and one is written at the source, so a park, restore,
   park cycle leaves one row and one redirect, never two of either. Links inside
   the two documents are rewritten; links from elsewhere keep working through the
   redirect. No other files are scanned or edited.
6. **Collisions are errors, not guesses.** A pre-existing archive is parsed and
   extended. If the same code appears as an authoritative row twice, within one
   document or across the two, the validator reports it (today it silently keeps
   the last row and roundtrip never rejects a multi-row group); the canonical
   status decides placement and the next render repairs it. Config resolving active and archive to the
   same path is rejected at load.
7. **Idempotent and byte-stable.** A second processing pass with no state change
   writes no bytes. `compose roadmap check` treats the set as one fixed point.

## Automatic integration

One shared projection service renders the document set from canonical features
plus preserved source content, and replaces every producer found in the seam
inventory: the three `renderRoadmap()` call sites (ordinary transitions, live
completion, backfill completion), feature creation (writer and lane-gate),
follow-up recovery's `writeRoadmap`, and `compose roadmap generate` / `check`.
Build's start and teardown writes are routed through the service as well: a
build started on a PARKED or COMPLETE feature reactivates it, which is a placement
change, so there is no "both statuses are active" exemption. `compose feature` is
routed the same way. Workflows and prompts contain no archive logic.

**Projection repair is the service's own concern.** The service keeps its own
durable write intent (below), independent of the completion gate's completion
intent. Every producer calls the service **before** mutating canonical state to
finish any pending publication, and again after its write to render. So canon is
never changed on top of an unfinished publication, and a pending publication is
finished by the next producer call whatever it is.
So a live completion whose document write failed is repaired by the next
transition, creation, regeneration or `check` on that workspace, even though the
gate's own retry refuses the completion (correctly: the completion is committed).
`compose roadmap generate` remains the documented `recover` action the gate
already names, and now performs exactly this. `compose roadmap check` stays
read-only: a pending intent is reported as an in-flight failure naming
`generate`, never repaired by `check`.

Canonical state is committed only through its current authority. A failed evidence
gate moves nothing. After an accepted completion, a document write failure reports
committed status plus pending projection repair; it must not fabricate rollback of
the guarded completion. Reads never write, including audit events (see Read
contract).

## Paths and persistence

The archive resolves beside the configured roadmap as `ROADMAP-ARCHIVE.md`, with an
explicit configurable path in `.compose/compose.json` (`roadmap.archive`), honoring
external document roots the same way the roadmap path does. New projects enable
archival by default; existing projects enable it by setting the flag, and the first
processing pass after that performs the initial partition. An existing file at the
archive path is never replaced; it is parsed and extended.

Publication order, under the per-workspace lock:

1. Render both documents in memory; hash-check current on-disk bytes against the
   **persisted baseline** (the post-write hashes recorded by the last successful
   publication, kept in a small manifest beside the intent). A mismatch (hand
   edit) fails with a diagnostic; nothing is written.
2. Write both rendered documents to **staged files** in the workspace state
   directory.
3. **Write the durable intent**: operation id, both target paths, both staged
   paths, pre-write hashes and post-write hashes.
4. Rename the archive staged file into place, then the active one.
5. Update the baseline manifest, clear the intent, remove any leftover staged
   files.

A crash after step 3 leaves an intent whose staged files still hold the complete
target bytes; the next service call renames whichever targets do not yet match
their post-write hash, updates the baseline and clears the intent. A crash before
step 3 leaves only orphan staged files, removed on the next call. Readers that see an intent report the set as
in-flight rather than as duplicate or missing features. Retries, including
same-status retries, run the same repair before returning success.

## Read and validation contract

Reads are read-only: the read path renders through a pure function and emits no
audit event; a no-mutation test pins this. Default roadmap reads and summaries
describe the active document and expose the archive path plus the archived feature
count. `scope: active | archive | all` selects documents, and `code` looks a single
feature up across the set regardless of the row limit, so historical lookup is a
single call. `format: markdown` is served for `scope: active` only; `archive` and
`all` return rows, counts and paths, never a whole archived document. Validators, roundtrip and losslessness checks operate on the document
set, so archival alone cannot produce missing-feature, duplicate-phase or
dangling-artifact findings. Dependency resolution reads canonical features, not
documents, so display placement never affects dependency satisfaction. Reads
return compact counts, paths and diagnostics, never full archived documents.

## Acceptance criteria

- [ ] A normal successful completion (live and backfill) moves the row and rewrites
      in-document links without a second command.
- [ ] An ordinary PARKED or KILLED transition archives the row; a force
      SUPERSEDED does the same; a transition back to an active status restores
      it, leaving one row and at most one redirect.
- [ ] Failed evidence gates and record-only completion writes leave placement
      unchanged.
- [ ] A live completion whose document write is made to fail reports committed
      status plus pending projection; the next ordinary transition on any other
      feature repairs the documents; the gate's own retry still refuses.
- [ ] A mixed-status phase keeps heading and prose in the active document and
      renders inactive rows under the same heading in the archive with a link
      back; when its last active row leaves, the whole phase moves; the validator
      reports no duplicate phase in either case.
- [ ] A feature with item-level rows and a PARTIAL parent stays entirely active;
      when the parent completes, all its rows move together.
- [ ] Anonymous preserved rows and source-only phase blocks are placed by their
      own status column; compose's own roadmap dogfood ends with no inactive rows
      in the active document and no lost prose.
- [ ] A crash injected after the intent write, after the archive write and after
      the active write is repaired by the next service call exactly once, and
      readers report in-flight while the intent exists.
- [ ] Two concurrent completions through the per-workspace lock produce one
      consistent document set.
- [ ] `get_roadmap` default scope shows no inactive rows, reports the archived
      count and writes nothing (no audit event); `scope: all` plus `code` finds an
      archived feature in one call; `format: markdown` with `scope: archive` is
      refused; `compose validate` and roadmap graph resolve archived dependencies.
- [ ] `compose roadmap generate` and `compose roadmap check` operate on the set;
      `check` reports a pending intent as in-flight without writing; a second
      pass changes no bytes.
- [ ] A build started on a PARKED feature, and `compose feature`, both go through
      the service; a PARKED transition persists its reason in feature.json even
      when the document write fails.
- [ ] A rowless SUPERSEDED phase block lands in the archive and a rowless PLANNED
      one stays active; a duplicate authoritative row within one document is
      reported by the validator.
- [ ] A narrative-owned workspace is untouched: the writer keeps refusing, and no
      archive is created there.
- [ ] Dogfooded on a copy of compose's own generated roadmap (374 features,
      ~172KB, including its anonymous phases) before enabling on the real one.

## Follow-ups filed, not in v1

- **COMP-ROADMAP-ARCHIVE-GH**: two-document transactional publication for the
  GitHub provider (one tree, one commit, guarded ref update, conflict retry).
- **COMP-ROADMAP-ARCHIVE-NARRATIVE**: identity-based row moves for narrative-owned
  roadmaps, designed against the narrative guard, with forge-top as the fixture.
- **COMP-ROADMAP-ARCHIVE-LINKS**: incoming-link rewriting across registered
  consumer roots, beyond the redirect anchors v1 leaves.
- **COMP-ROADMAP-SHARD**: size-triggered and per-phase placement policies on the
  ordered document-set loader; its "active + archived" shape is superseded here.

## Review log

**Round 1, Codex gpt-5.6-sol/high, 2026-09-09.** Ten findings, all accepted as
design-actionable and folded in above: anonymous preserved rows need their own
authority (Behavior 1); intent must precede the first write (Publication order);
the seam inventory missed `roadmap generate/check`, build raw writes, lane-gate
creation and follow-up recovery (Verified seams, Automatic integration); the gate
clears its completion intent so projection repair must be the service's own
(Automatic integration); mixed-phase prose needed a single owner (Behavior 3);
item-level rows travel with the parent (Behavior 1); redirect lifecycle and
cross-document collisions (Behaviors 5 and 6); reads currently emit audit events
and lookup needs `code` (Read contract); `reason` is optional and SUPERSEDED is
force-only (Verified seams, Acceptance); the SHARD boundary needed an ordered
document set rather than a pair (Revision note 4).

**Round 2, Codex gpt-5.6-sol/high, 2026-09-09.** Eight findings on the fixes,
all accepted: build's raw IN_PROGRESS write reactivates archived features, so no
exemption (Automatic integration); the intent needs staged bytes and a persisted
baseline, and repair must precede canonical mutation (Publication order,
Automatic integration); a required PARKED reason must live in feature.json, not
a best-effort audit event (Revision note 1, Behavior 1); `check` must stay
read-only (Automatic integration); `compose feature` was missing from the
inventory; same-document duplicates (Behavior 6); rowless source-only blocks
need a heading-status rule (Behavior 1); `format: markdown` with archive scope
(Read contract). No round 3 was run: the remaining risk is in blueprint detail,
not in a contradiction between sections.

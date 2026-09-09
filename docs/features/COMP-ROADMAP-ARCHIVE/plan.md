# COMP-ROADMAP-ARCHIVE — Implementation Plan

Status: PLANNED; no runtime code implemented.
Created: 2026-09-09. Revised: 2026-09-09 (scope cut; Codex rounds 1 and 2 folded in, see design Review log).
Contract: [design.md](design.md). Owner: Compose.

## Scope and dependencies

v1 is: generated-mode workspaces, local provider, no new status, in-document link
rewriting with redirect anchors, default-on for new projects and flag-on for
existing ones. The completion gate stays the only completion authority. No Stratum
change. COMP-ROADMAP-SHARD is not a dependency; it later consumes the document-set
loader this plan introduces.

## 1. Lock the seam inventory and fixtures

- [ ] Enumerate every document producer and every raw status persistence path:
      `feature-writer.js` transitions and create, both `completion-gate.js` paths,
      `completion-writer.js` record-only, `bin/compose.js` `roadmap generate`,
      `roadmap check` and `compose feature` (direct feature.json and ROADMAP.md
      writes), `lane-gate.js` provider-direct creation, `followup-writer.js`
      `writeRoadmap` recovery calls, and `build.js` start/teardown status writes
      (start can reactivate PARKED/COMPLETE, so these are placement changes).
      Record the path-to-test matrix in this plan before code.
- [ ] Define the document-set contract as an ordered set with a placement policy
      (pair is the v1 instance): archive path resolution, per-feature anchor and
      redirect formats and their lifecycle, mixed-phase ownership rule, anonymous-row
      and item-row placement, `scope` and `code` for reads, intent file shape
      (operation id, paths, pre/post hashes) and its diagnostics. Reject
      active/archive resolving to one path.
- [ ] Make `reason` required for PARKED in `feature-writer.js` and persist it as
      `status_reason` in feature.json in the same write as the status (schema
      field added); the audit event stays best-effort.
- [ ] Freeze fixtures: a generated roadmap with mixed-status phases, one with a
      pre-existing `ROADMAP-ARCHIVE.md`, one with an external document root, and a
      narrative-owned workspace that must be left alone. A trimmed copy of compose's
      own roadmap is the dogfood fixture.

## 2. Pure partition and relocation

- [ ] `lib/roadmap-documents.js` (new): load and render the pair; owns anchor and
      redirect rules; no status logic.
- [ ] `lib/roadmap-archive.js` (new): pure `partition(features, preserved, policy)`
      over managed features, anonymous preserved rows (own status column), source-only
      phase blocks and item rows (travel with parent); returns per-document row sets,
      phase ownership, moved-row list and diagnostics. No I/O.
- [ ] Extend `roadmap-gen.js`, `roadmap-parser.js`, `roadmap-preservers.js` and
      `roadmap-roundtrip.js` to render and round-trip the document set, including
      mixed phases split under the same heading and whole-phase prose following the
      heading.
- [ ] In-document link rewriting for inline and reference-style links between the
      two documents; redirect anchors left at old positions.

## 3. Recoverable publication

- [ ] `project-paths.js` and `roadmap-config.js`: `roadmap.archive` path and enable
      flag; default-on when `compose new`/setup writes config.
- [ ] Per-workspace lock; hash check against a **persisted baseline manifest**
      (post-write hashes of the last successful publication); stage both documents;
      **intent written after staging and before any rename** (operation id, target
      paths, staged paths, pre/post hashes); archive then active by atomic rename;
      baseline update; intent clear. Pending intent is completed at the start of
      every service call from the staged bytes, independent of the completion
      gate's own intent; readers surface it as in-flight. Producers call the
      service before mutating canonical state and again after.
- [ ] `tracker/local-provider.js`: `renderRoadmap()` renders the document set
      through the service. `tracker/github-provider.js`: unchanged, and explicitly
      logs that archival is local-only until COMP-ROADMAP-ARCHIVE-GH.

## 4. Wire the writers

- [ ] Route every producer from the step 1 inventory through the shared service:
      the three `renderRoadmap()` sites, writer and lane-gate creation,
      `compose feature`, followup-writer recovery, build start/teardown status
      writes, and `compose roadmap generate` (`check` stays read-only and reports
      a pending intent as in-flight). Preserve
      refusal, record-only and committed-status-with-projection-failure semantics
      exactly; the gate keeps naming `compose roadmap generate` as `recover`.
- [ ] Same-status and retried calls repair a pending projection before returning;
      a completion retry that the gate refuses is still followed by repair on the
      next call from any producer.
- [ ] Pre-persistence roundtrip guard validates the prospective document set.

## 5. Readers, validation and dogfood

- [ ] `get-roadmap.js`: pure read (no `generateRoadmap` side effects, no audit
      event; no-mutation test), default active scope with archive path and archived
      feature count; `scope: active | archive | all` and `code` lookup across the set.
      `feature-validator.js` (mixed phase is not a duplicate; any duplicate
      authoritative row, within or across documents, is reported), drift check,
      roundtrip (rejects multi-row non-item groups) and roadmap graph read the set;
      dependency resolution stays on canonical features. Rowless source-only
      blocks placed by heading status token.
- [ ] MCP/HTTP `get_roadmap` schema gains `scope` and `code`; `format: markdown`
      refused for `scope: archive | all`; docs updated.
- [ ] Dogfood on a copy of compose's roadmap, then enable on the real one through a
      normal transition. Verify byte-stable second pass and `compose roadmap check`.

## Tests

New files are proposed; existing paths are verified to exist.

| Changed code | Test file | Action |
|---|---|---|
| Partition (managed, anonymous, source-only blocks with and without rows, item rows), mixed-phase ownership, anchors and redirect lifecycle, link rewriting, same- and cross-document collisions | `test/roadmap-archive.test.js` (new) | Add |
| Lock, baseline manifest, staged-then-intent-then-rename, crash after staging / after intent / after archive rename / after active rename, repair-before-canonical-mutation, concurrent completions, hand-edit conflict, repair after a refused completion retry | `test/roadmap-archive-recovery.test.js` (new) | Add |
| Ordinary transitions, park/restore, same-status repair | `test/feature-writer.test.js`, `test/feature-writer-mcp.test.js` | Extend |
| Live/backfill completion, failed gate, record-only, projection failure | `test/completion-gate.test.js`, `test/completion-writer.test.js`, `test/build-completion-gate.test.js` | Extend |
| Reads (no-mutation, scope, code), roundtrip, validator duplicate rules, narrative untouched, drift, graph | `test/get-roadmap.test.js`, `test/roadmap-roundtrip.test.js`, `test/feature-validator.test.js`, `test/roadmap-narrative-owned.test.js`, `test/roadmap-drift.test.js` | Extend |
| `roadmap generate` on the set, `check` read-only with pending intent, `compose feature`, build start on PARKED, lane-gate and follow-up producers, `status_reason` persisted on projection failure | `test/roadmap-archive-producers.test.js` (new) | Add |

Targeted runs per slice; one full `npm test` at integration. No live dispatch or
remote publication is involved.

## Documentation

- [ ] `CHANGELOG.md` — archival behavior, config flag, read scope.
- [ ] `README.md` and `docs/mcp.md` — `roadmap.archive`, `get_roadmap` scope.
- [ ] `templates/ROADMAP.md` and setup guidance — active/archive ownership.
- [ ] COMP-ROADMAP-SHARD feature.json — record that its active/archived shape is
      superseded here; it keeps size and per-phase splitting.
- [ ] Forge `CLAUDE.md` maintenance note — unchanged until
      COMP-ROADMAP-ARCHIVE-NARRATIVE ships; forge-top stays manual.

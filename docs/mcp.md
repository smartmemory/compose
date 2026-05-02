# MCP Server

Compose's project state exposed as MCP tools.

Compose exposes project state as MCP tools via `server/compose-mcp.js` (stdio transport). Registered in `.mcp.json` by `compose init`. Available tools:

| Tool | Description |
|------|-------------|
| `get_vision_items` | Query items by phase, status, type, keyword |
| `get_item_detail` | Full item detail with connections |
| `get_phase_summary` | Status/type distribution per phase |
| `get_blocked_items` | Items blocked by non-complete dependencies |
| `get_current_session` | Active session context (tool count, items touched) |
| `bind_session` | Bind agent session to a lifecycle feature |
| `get_feature_lifecycle` | Feature lifecycle state, phase history, artifacts |
| `kill_feature` | Kill a feature with reason |
| `complete_feature` | Mark feature complete (ship phase only) |
| `assess_feature_artifacts` | Quality signals for feature artifacts |
| `scaffold_feature` | Create feature folder with template stubs |
| `approve_gate` | Resolve a pending gate (approved/revised/killed) |
| `get_pending_gates` | List pending gates |
| `add_roadmap_entry` | Register a new feature: writes `feature.json` + regenerates `ROADMAP.md`. Audit-log append is best-effort. Use instead of editing ROADMAP by hand. |
| `set_feature_status` | Flip a feature status with transition-policy enforcement (`force: true` overrides). Appends an audit event (best-effort). |
| `roadmap_diff` | Read the feature-management audit log for a window. Returns `events[]`, `added[]`, `status_changed[]`. |
| `link_artifact` | Register a non-canonical artifact (snapshot, journal, finding, etc.) on a feature. Stores in `feature.json` `artifacts[]`; dedups on `(type, path)`. Audit append best-effort. |
| `link_features` | Register a typed cross-feature relationship (`surfaced_by`, `blocks`, `depends_on`, `follow_up`, `supersedes`, `related`). Stored on the source; query inverse via `get_feature_links(direction:'incoming')`. |
| `get_feature_artifacts` | Read both canonical (auto-discovered) and linked artifacts for a feature in one call. Each linked entry carries a current existence stamp. |
| `get_feature_links` | Read outgoing/incoming/both links for a feature; optional `kind` filter. |
| `add_changelog_entry` | Insert (or replace, with `force: true`) a typed entry in `compose/CHANGELOG.md`. Idempotent on `(date_or_version, code)`; renders canonical `Added`/`Changed`/`Fixed`/`Snapshot` subsections from typed inputs. Audit append best-effort. |
| `get_changelog_entries` | Read parsed entries; filter by `code` (exact) and/or `since` (shorthand `24h`/`7d`/`30m` or ISO date — date surfaces only; version surfaces always pass through). |
| `start_iteration_loop` | Start an iteration loop on a feature |
| `report_iteration_result` | Report an iteration's result; the server decides whether to continue. Terminal outcomes are `clean`, `max_reached`, `action_limit`, or `timeout`; while the loop is still running, `outcome` is `null`. |
| `abort_iteration_loop` | Abort an active iteration loop |

> **Note:** an `agent_run` tool used to live here for LLM-facing dispatch. It was removed on 2026-04-18 (`STRAT-DEDUP-AGENTRUN`); use `mcp__stratum__stratum_agent_run` instead.

## Roadmap writers (COMP-MCP-ROADMAP-WRITER)

`add_roadmap_entry`, `set_feature_status`, and `roadmap_diff` route every roadmap mutation through a typed surface so feature-management state stays consistent across `feature.json`, `ROADMAP.md`, and the audit log.

**Write order** for the two writers (steps 3-4 are committed; step 5 is best-effort):
1. Validate inputs (code shape, status enum, transition policy).
2. Idempotency check (if `idempotency_key` supplied) — replay returns the cached result without re-mutating.
3. Mutate `docs/features/<CODE>/feature.json`.
4. Regenerate `ROADMAP.md` from all `feature.json` files (`lib/roadmap-gen.js:writeRoadmap`).
5. Append a row to `.compose/data/feature-events.jsonl` (canonical audit log).

If step 3 fails, nothing changes. If step 4 fails, `feature.json` is correct but `ROADMAP.md` is stale — recover by running `compose roadmap generate`. If step 5 fails, the mutation succeeded but the audit row is missing; we log a warning and don't roll back.

**Transition policy** enforced by `set_feature_status` (use `force: true` to bypass; force is recorded in audit):

```
PLANNED      → IN_PROGRESS, KILLED, PARKED
IN_PROGRESS  → PARTIAL, COMPLETE, BLOCKED, KILLED, PARKED
PARTIAL      → IN_PROGRESS, COMPLETE, KILLED
COMPLETE     → SUPERSEDED                 (rare; force-only)
BLOCKED      → IN_PROGRESS, KILLED, PARKED
PARKED       → PLANNED, KILLED
KILLED       → (terminal)
SUPERSEDED   → (terminal)
```

**Idempotency keys** are caller-provided strings cached at `.compose/data/idempotency-keys.jsonl` (last 1000 entries, file-locked). Same key replays return the cached result; missing key always executes.

**Audit log** at `.compose/data/feature-events.jsonl` is append-only JSONL. Each row: `{ ts, tool, code, from?, to?, reason?, actor, idempotency_key? }`. Actor is `process.env.COMPOSE_ACTOR` (e.g. `cockpit:user-42`) or `mcp:agent` by default. `roadmap_diff` reads this file.

**Why not call REST?** The writers are pure file-IO in `lib/feature-writer.js` — no HTTP delegation. The COMP-DOCS-FACTS architectural review flagged HTTP-from-MCP as a layering violation; this surface avoids it.

## Artifact + feature links (COMP-MCP-ARTIFACT-LINKER)

`link_artifact`, `link_features`, `get_feature_artifacts`, `get_feature_links` make non-canonical artifacts and cross-feature relationships first-class and queryable. They share the framework established by the roadmap writers: idempotency keys, best-effort audit log, no HTTP.

**Storage:** additive fields on `feature.json`:
- `artifacts: [{ type, path, status? }]` — non-canonical artifacts only. The six canonical files (`design.md`, `prd.md`, `architecture.md`, `blueprint.md`, `plan.md`, `report.md`) inside the feature folder are auto-discovered by `assess_feature_artifacts`; `link_artifact` rejects them.
- `links: [{ kind, to_code, note? }]` — typed cross-feature relationships, stored on the source feature only.

These fields are disjoint from the ROADMAP-WRITER set (`commit_sha`, `tags`, `parent`).

**Path validation** for `link_artifact`: must be repo-relative (no leading `/` or `~`); must not contain `..` after normalization; must resolve under `cwd`; the file must exist; symlink targets must also live under `cwd`; must point at a file (not a directory). Mirrors the hardening pattern in `server/artifact-manager.js`.

**Link kinds** form a closed enum: `surfaced_by`, `blocks`, `depends_on`, `follow_up`, `supersedes`, `related`. Self-links rejected. The target `to_code` does **not** need to exist — this is deliberate, so you can file `link_features({from: 'A', to: 'NEW-1', kind: 'follow_up'})` before `NEW-1` is created.

**Dedup:** `link_artifact` dedups on `(type, path)`; `link_features` dedups on `(kind, to_code)`. Same call twice with the same dedup key returns `{ noop: true }`. `force: true` overwrites the existing entry and emits a fresh audit event with `forced: true`.

**No bidirectional auto-mirroring.** A link from A → B is stored on A only. To find what links to A, use `get_feature_links(direction: 'incoming')`. This is intentional — bidirectional mirroring would double-write and create reconciliation surface.

**Recommended `artifact_type` values:** `journal`, `snapshot`, `finding`, `report-supplement`, `link`, `external`. The field accepts any non-empty string; the recommended set is what existing features use.

## Changelog writer (COMP-MCP-CHANGELOG-WRITER)

`add_changelog_entry` and `get_changelog_entries` route every `compose/CHANGELOG.md` mutation and read through a typed surface. Same framework as the roadmap and linker writers: optional caller-supplied `idempotency_key`, best-effort audit log, no HTTP. Entries render from typed inputs into the canonical layout.

**Tools:**
- `add_changelog_entry({ date_or_version, code, summary, body?, sections?, force?, idempotency_key? })` → `{ inserted_at, idempotent, surface }`. `inserted_at` is the 1-based line number of the entry's `### CODE — summary` header in the post-write file.
- `get_changelog_entries({ since?, code?, limit? })` → `{ entries, count }`.

**Canonical entry layout (rendered):**

```
### <CODE> — <summary>

<body paragraphs, if any>

**Added:**
- …

**Changed:**
- …

**Fixed:**
- …

**Snapshot:**
- …
```

Subsections emit only when non-empty, in the fixed order Added → Changed → Fixed → Snapshot.

**Surfaces** are `## YYYY-MM-DD` (date) or `## vX.Y.Z` (version) headings. New surfaces insert at the top of the file (after the `# Changelog` H1). Within a surface, new entries append at the bottom (chronological landing order).

**Dedup** is two-layered:
1. **Storage-level** (always on): before writing, scan **all** surfaces matching `date_or_version` for an existing entry with the same `code`. If found and `force: false`, the call is a no-op and returns `{ idempotent: true }`. If `force: true`, the existing entry is replaced in place.
2. **Caller-supplied `idempotency_key`** (optional): same key replays return the cached result via `.compose/data/idempotency-keys.jsonl` — opt-in retry safety, identical to the sibling writers.

**Duplicate same-label surfaces** (e.g. two `## 2026-05-02` headings) are tolerated. The writer scans all matching surfaces for the dedup check; new entries land in the **first** (topmost) matching surface. Surfaces are never merged.

**Format enforcement is structural, not lexical.** The writer renders canonical output from typed inputs; the parser is permissive of pre-existing prose variation. Pre-existing entries with non-canonical labels (`**Hardened:**`, `**Knobs:**`, `**Test results:**`, etc.) are preserved as-is on read; structured `sections` parsing is best-effort and unrecognized labels surface as `unknownLabels`. The writer does not rewrite pre-existing entries.

**Audit log:** rows use `tool: 'add_changelog_entry'` (matches sibling-writer convention) plus `code`, `surface_label`, `surface_start_line`, and `idempotency_key` when supplied. Force-replace rows additionally carry `force: true`. Storage-level idempotent no-ops do **not** append an audit row (no file write, no event — design Decision 2). Caller-supplied `idempotency_key` replays are served from the idempotency cache and likewise do not re-append.

**Typed error codes** on tool failures surface via the `Error [CODE]: message` envelope: `INVALID_INPUT` (validation failures: bad code, bad date_or_version, unknown sections key), `CHANGELOG_FORMAT` (pre-existing file lacks `# Changelog` H1).

**Target file:** `compose/CHANGELOG.md` only. Top-level repo-root `CHANGELOG.md` is out of scope.

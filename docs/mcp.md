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
| `write_journal_entry` | Render and write a `compose/docs/journal/<date>-session-<N>-<slug>.md` entry with auto-numbered global session, plus insert a row at the top of the journal index. Idempotent on `(date, slug)`; `force: true` overwrites in place preserving the session number. Two-file write rolls back on partial failure. Audit append best-effort. |
| `get_journal_entries` | Read parsed entries from `compose/docs/journal/`; filter by `feature_code` (exact), `session` (exact), `since` (shorthand or ISO date). Returns each entry's frontmatter-canonical `summary`/`feature_code`/`closing_line`, the four canonical sections, and an ordered `unknownSections` array. |
| `record_completion` | Record a typed completion bound to a full 40-char commit SHA. Stores in `feature.json` `completions[]`; idempotent on `(feature_code, commit_sha)`. With `set_status: true` (default), also flips status to `COMPLETE` via `set_feature_status`. Status-flip failure rethrows as `STATUS_FLIP_AFTER_COMPLETION_RECORDED` with `err.cause`; the completion record is still persisted. Audit append best-effort. |
| `get_completions` | Read completion records from `feature.json` files. Filter by `feature_code` (exact), `commit_sha` (≥4-char prefix or full), `since` (shorthand or ISO date). |
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

## Journal writer (COMP-MCP-JOURNAL-WRITER)

`write_journal_entry` and `get_journal_entries` route every `compose/docs/journal/` mutation and read through a typed surface. Same framework as the roadmap, linker, and changelog writers: optional caller-supplied `idempotency_key`, best-effort audit log, no HTTP. Entries render from typed inputs into the canonical four-section layout.

**Tools:**
- `write_journal_entry({ date, slug, sections: { what_happened, what_we_built, what_we_learned, open_threads }, summary_for_index, feature_code?, closing_line?, force?, idempotency_key? })` → `{ path, session_number, index_line, idempotent }`. `session_number` is global-monotonic (next = `max + 1`); `index_line` is the 1-based line of the row in `docs/journal/README.md`.
- `get_journal_entries({ since?, feature_code?, session?, limit? })` → `{ entries, count }`. Each entry has all documented fields present; `summary`/`feature_code`/`closing_line` may be `null` for pre-frontmatter entries; `unknownSections` is always an ordered array.

**Canonical entry layout (rendered):**

```
---
date: <date>
session_number: <N>
slug: <slug>
summary: <summary_for_index>
feature_code: <feature_code>          ← omitted if not provided
closing_line: <closing_line>          ← omitted if not provided
---

# Session <N> — <feature_code or short title>

**Date:** <date>
**Feature:** `<feature_code>`         ← omitted if not provided

## What happened

…

## What we built

…

## What we learned

…

## Open threads

…

---

*<closing_line>*                      ← only when closing_line was provided
```

The trailing `---` HR plus the italicized one-liner is the **explicit delimiter** for the closing line. Without it, a parser cannot distinguish "last paragraph of Open threads" from "closing line" — so the writer always emits this shape, and `parseJournalEntry` uses it. Frontmatter `closing_line` always wins over body parse for entries this writer produced.

**Session numbering** is **global**, not per-date. Filenames are `YYYY-MM-DD-session-<N>-<slug>.md`; `N` increments across the entire journal, never resets per date. The writer scans `docs/journal/` under an advisory lock to compute `max + 1`. Gaps in the existing sequence are preserved — never auto-filled. The journaling rule (`compose/.claude/rules/journaling.md`) was updated to match.

**Dedup** is two-layered, identical to sibling writers:
1. **Storage-level** (always on): before writing, scan for `<date>-session-*-<slug>.md`. If found and `force: false`, the call is a no-op and returns `{ idempotent: true }` with the existing path/session/index_line. The `index_line` is **recomputed inside the lock** (a second read of `README.md`) so concurrent inserts never produce a stale value.
2. **Caller-supplied `idempotency_key`** (optional): same key replays return the cached result via `.compose/data/idempotency-keys.jsonl`.

**Two-file write with rollback.** The writer mutates two files: the entry file and the index. If the index write fails after the entry write succeeds:
- **New-entry path** — the orphaned entry file is deleted (compensating action).
- **Force-overwrite path** — the prior entry content (read into memory before the first write) is restored.

The rethrown error carries `err.code = 'JOURNAL_PARTIAL_WRITE'` and `err.cause = <original index error>`. The MCP wrapper serializes both as `Error [JOURNAL_PARTIAL_WRITE]: …\n  Caused by [CODE]: …`. The audit log is appended only after both writes succeed — so a retry after a partial failure is also idempotent at the audit level.

**Format enforcement is structural, not lexical.** Pre-existing entries (older sessions without frontmatter) are preserved as-is on read. The reader returns `summary: null`, `feature_code: null`, `closing_line: null` and any non-canonical headings as an ordered `unknownSections` array (preserving file order, tolerating duplicates like two `## Notes` blocks). Headings match canonical names case- and whitespace-insensitively (so `## What  Happened` is recognized as `what_happened`).

**Audit log:** rows use `tool: 'write_journal_entry'` plus `date`, `slug`, `session_number`, optionally `feature_code`, `force`, `idempotency_key`. Storage-level idempotent no-ops do **not** append an audit row.

**Typed error codes** on tool failures: `INVALID_INPUT` (bad date/slug/sections/summary), `JOURNAL_FORMAT` (entry-file frontmatter parse failure on the writer side), `JOURNAL_INDEX_FORMAT` (missing `## Entries`, malformed table header or separator), `JOURNAL_PARTIAL_WRITE` (entry succeeded, index failed; rollback was attempted — see `err.cause` for the original failure).

**Target directory:** `compose/docs/journal/` only.

## Completion writer (COMP-MCP-COMPLETION)

`record_completion` and `get_completions` route every commit-bound completion through a typed surface. Same framework as the prior writers: optional caller-supplied `idempotency_key`, best-effort audit log, no HTTP. Records live as a `completions[]` array on `feature.json` (the canonical per-feature record).

**Tools:**
- `record_completion({ feature_code, commit_sha, tests_pass, files_changed, notes?, set_status?, force?, idempotency_key? })` → `{ feature_code, completion_id, commit_sha, commit_sha_short, status_changed: {from,to}|null, status_flip_partial, idempotent, recorded_at }`. `commit_sha` must be the **full 40-char hex SHA** — short prefixes are rejected on write.
- `get_completions({ feature_code?, commit_sha?, since?, limit? })` → `{ completions, count }`. Read accepts `commit_sha` as a ≥4-char prefix or full SHA. Default `limit` 50, max 500.

**Canonical record (rendered into `feature.json` `completions[]`):**

```jsonc
{
  "completion_id": "<feature_code>:<full-sha>",
  "feature_code": "...",
  "commit_sha": "abd8349123abc456def7890123abc456def78901",
  "commit_sha_short": "abd83491",
  "tests_pass": true,
  "files_changed": ["compose/lib/...", "..."],
  "notes": "...",                 // optional
  "recorded_at": "2026-05-03T...",
  "recorded_by": "mcp:agent"      // env COMPOSE_ACTOR overrides
}
```

`feature_code` is stamped on every record at write time; the reader returns it verbatim and never backfills. Records lacking `feature_code` (legacy/hand-edited) are returned with `feature_code: null` so the reader contract is uniform.

**Identity is the full SHA.** Short prefixes collide; allowing them on write would silently collapse two distinct commits into one record. The 8-char `commit_sha_short` is presentation-only.

**Status flip is opt-in, default on.** With `set_status: true` (default), `record_completion` calls `set_feature_status` internally to flip `feature.status` to `COMPLETE`. The transition policy is enforced by the underlying call; `KILLED` and `SUPERSEDED` reject. For non-terminal states (`PLANNED`, `IN_PROGRESS`, `PARTIAL`, `BLOCKED`, `PARKED`), the flip uses `force: true` so a feature can ship straight to `COMPLETE` without manually walking the policy. With `set_status: false`, the record lands without touching status — useful for partial-completion provenance.

**Three failure subcases for the status flip** (all surface as thrown `STATUS_FLIP_AFTER_COMPLETION_RECORDED`; the completion record is **always persisted** before the flip is attempted):
1. **Transition rejected** (KILLED → COMPLETE, etc.). `err.cause.message` contains `invalid transition`. Status NOT flipped.
2. **`ROADMAP_PARTIAL_WRITE`** — `set_feature_status` flipped `feature.json` but `writeRoadmap` failed. Status WAS flipped on disk; ROADMAP.md is stale. `err.cause.code === 'ROADMAP_PARTIAL_WRITE'`. Recover with `compose roadmap generate`.
3. **Other underlying error.** `err.cause` carries the original.

In all three subcases, the completion record is on disk; only the status flip path failed. Caller can retry the flip via `set_feature_status` directly.

**Per-feature lock.** `record_completion` acquires an advisory lock at `<cwd>/.compose/data/locks/feature-<feature_code>.lock` for the entire read-modify-write critical section, so two parallel calls on the same feature serialize cleanly. Sibling writers (`add_roadmap_entry`, `link_artifact`, etc.) do not yet take this lock — a parallel sibling-writer call can still race at the `updateFeature` layer (pre-existing limitation, deferred to a future cross-cutting follow-up).

**Dedup** is two-layered:
1. **Storage-level** (always on): same `(feature_code, commit_sha)` cannot produce two records unless `force: true`. Idempotent no-ops do **not** append audit events.
2. **Caller `idempotency_key`** (optional): same key replays return the cached result via `.compose/data/idempotency-keys.jsonl`.

**Audit log:** rows use `tool: 'record_completion'` plus `code`, `completion_id`, `commit_sha`, `tests_pass`, `set_status`, optionally `force`, `idempotency_key`.

**Typed error codes:** `INVALID_INPUT`, `FEATURE_NOT_FOUND`, `STATUS_FLIP_AFTER_COMPLETION_RECORDED`. The MCP wrapper serializes both `err.code` and `err.cause` (`Caused by [...]: ...`).

**Coordination with `complete_feature`.** The existing `complete_feature` MCP tool (a thin REST wrapper that drives the cockpit's lifecycle UI) updates the vision-store lifecycle and does not write to `feature.json`. `record_completion` writes to `feature.json` (and via `set_feature_status`, regenerates ROADMAP.md) but does not touch the vision-store lifecycle. Until `COMP-MCP-MIGRATION` reconciles the two stores, callers MUST pick one path:
- **Headless ship flows** (post-commit hook, `/compose` Phase 10, scripts) → `record_completion`.
- **Cockpit-driven completion** (operator hits the Complete button) → `complete_feature`.

**Git post-commit hook (opt-in).** A shipped template at `compose/bin/git-hooks/post-commit.template` is materialized into `.git/hooks/post-commit` by `compose hooks install`, with `__COMPOSE_NODE__` and `__COMPOSE_BIN__` substituted to absolute paths. The runtime hook does not depend on `compose` or `node` being on PATH. The hook reads `Records-completion: <CODE>` trailers via `git interpret-trailers --parse`, computes the commit SHA, and calls `compose record-completion` for each trailer. Failures log to `.compose/data/post-commit.log` and the hook always exits 0. See `docs/cli.md` for the trailer format.

**Target storage:** `compose/docs/features/<CODE>/feature.json` only. ROADMAP.md is regenerated from feature.json files via the existing `lib/roadmap-gen.js` path; completions themselves do not surface in ROADMAP.md.

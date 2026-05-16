# COMP-TRACKER-PROVIDER — Pluggable Tracker Provider Abstraction

**Status:** DESIGN
**Date:** 2026-05-16
**Feature code:** COMP-TRACKER-PROVIDER

## Related Documents

- Forward: `plan.md` (to be written), `blueprint.md` (to be written)
- Context: `lib/feature-json.js`, `lib/roadmap-gen.js`, `lib/feature-writer.js`, `server/compose-mcp-tools.js`

## Problem Statement

Compose hardcodes feature/roadmap/changelog/event persistence to local files (`docs/features/<CODE>/feature.json`, `feature-events.jsonl`, `ROADMAP.md`, `CHANGELOG.md`). Teams that already run their work in GitHub (Issues + Projects v2) — and later Jira, Linear, etc. — cannot make Compose drive or reflect their existing project-management system. We need a provider abstraction so the active tracker backend is pluggable, with the local file model as one provider among several.

## Goals

- A `TrackerProvider` interface that the mutation layer and MCP tools call instead of the local file libs directly.
- `LocalFileProvider` reproducing **today's behavior with zero change** (regression-safe default).
- `GitHubProvider` mapping features→Issues, status→Projects v2, events→issue timeline, roadmap/changelog→committed files.
- Non-blocking writes under a provider-canonical model (write-through cache + async reconcile).
- Capability model: providers declare supported entities; unsupported entities transparently fall back to `LocalFileProvider`.

## Non-Goals (v1)

- Jira / Linear providers (interface must not preclude them; implementation deferred).
- Bidirectional merge semantics beyond "provider-canonical + conflict ledger".
- GitHub Releases as the changelog surface (committed `CHANGELOG.md` only).
- Journal / vision-state native GitHub mapping (capability falls back to local).

## Core Decisions

1. **Provider-canonical, local is a cache.** The active provider is the source of truth. `LocalFileProvider`'s store *is* the local files (unchanged). `GitHubProvider`'s store is GitHub; local cache is a read-through performance/offline layer.
2. **Interface covers all entities; capability model.** `capabilities()` returns a subset of `{FEATURES, EVENTS, ROADMAP, CHANGELOG, JOURNAL, VISION}`. The factory wraps the active provider so uncapable entities route to `LocalFileProvider`.
3. **GitHub mapping:** Issues + Projects v2 (GraphQL) + generated ROADMAP/CHANGELOG committed via Contents API; events from issue timeline/structured comments.
4. **Write-through cache + async reconcile.** Mutations update cache + a durable outbound op-log immediately and return; a reconciler flushes to the provider with retry/backoff/rate-limit awareness; pull-reconcile keeps the cache canonical-consistent; conflicts are logged.
5. **Seam at the data layer.** The existing mutation layer (transition policy in `feature-writer.js`, `completion-writer.js`, `changelog-writer.js`) and all `mcp__compose__*` tools stay; they call `provider.*`. Transition policy remains the single, provider-agnostic enforcement point.

## Mutation Path Inventory (Codex R1 #1, #6)

The seam is **not** just `feature-json`/`roadmap-gen`. Every path that mutates tracker state must route through the provider, or be explicitly scoped out. Audited paths:

| Path | Today | v1 disposition |
|---|---|---|
| `feature-writer.setFeatureStatus` / `addRoadmapEntry` | typed mutation + transition policy + event + roadmap regen | **route through provider** |
| `completion-writer.recordCompletion` | persists completion, then flips status | **route through provider** (see partial-commit contract) |
| `changelog-writer.addChangelogEntry` | atomic parse-and-rewrite of `CHANGELOG.md` | **route through provider** |
| `build.js` direct `readFeature`/`writeFeature` — triage profile cache (`build.js:628`), status flips (`build.js:752`), terminal reset (`build.js:1833`) | bypasses feature-writer, transition policy, events, roadmap regen | **must be re-pointed at the provider.** These become `provider.getFeature`/`provider.putFeature`. The triage profile cache write is metadata-only (no status change) so it skips transition policy legitimately — the provider contract explicitly allows metadata-only `putFeature` that does not emit a status event. |
| `compose-mcp-tools.js` direct reads of vision-state / sessions (`:23,:38,:52`) | local disk reads, not provider-routed | **v1 decision:** vision/sessions are `JOURNAL`/`VISION`-capability — they always resolve through `LocalFileProvider` regardless of active provider. This is **expected mixed-source state**, not a bug: under GitHubProvider, features/roadmap/changelog/events are GitHub-canonical while vision/sessions stay local. `health()` reports `mixedSources: ["vision","sessions"]` and `compose tracker status` prints it so the operator is never surprised. Unifying these is a v2 capability, not a v1 silent behavior change. |

"Zero change for local" is therefore defined precisely: with `provider: "local"`, every path above produces byte-identical files and the same typed errors as today (enforced by the regression golden flow + conformance suite below).

## Architecture

```
mcp__compose__* tools / CLI ─┐
                              ├─→ mutation layer (transition policy, completion, changelog)  [unchanged]
                              └─→ TrackerProvider  (factory: providerFor(cwd))
                                     ├─ LocalFileProvider   (synchronous; canonical = local files)
                                     └─ GitHubProvider       (canonical = GitHub; reads cache; writes via SyncEngine)
                                            └─→ SyncEngine    (remote providers only)
                                                  ├─ op-log     .compose/data/tracker-oplog.jsonl
                                                  ├─ cache      .compose/data/tracker-cache/<provider>/
                                                  ├─ reconciler (flush op-log → provider; retry/backoff/rate-limit)
                                                  ├─ pull       (provider → cache; TTL + explicit)
                                                  └─ conflicts  .compose/data/tracker-conflicts.jsonl
```

New modules under compose `lib/tracker/`: `provider.js` (interface + capability constants), `local-provider.js` (behavior-preserving extraction of current `feature-json`/`roadmap-gen` call paths), `github-provider.js`, `sync-engine.js`, `factory.js`.

## Interface Contract (`lib/tracker/provider.js`)

All methods async. Entities are plain JSON in today's `feature.json` shape.

```
name()                                   "local" | "github"
capabilities()                           Set<FEATURES|EVENTS|ROADMAP|CHANGELOG|JOURNAL|VISION>
init(cwd, config)                        validate auth/config, warm cache; throw TrackerConfigError
health()                                 {ok, provider, canonical, lastSync, pendingOps, conflicts}

getFeature(code)                         feature | null         (cache-consistent for remote)
listFeatures()                           feature[]
putFeature(code, obj)                    idempotent upsert; called AFTER transition policy approved
deleteFeature(code)                      rare

appendEvent(code, event)                 {ts,type,from,to,by,meta}
readEvents(code?)                        event[]

renderRoadmap()                          materialize roadmap view (provider decides where)
getChangelog() / appendChangelog(entry)

readJournal()/writeJournalEntry(e)       deferred-capable
getVisionState()/putVisionState(s)       deferred-capable
```

Contract rules:
1. Providers never enforce status transitions — they receive already-validated writes.
2. `putFeature` is idempotent — same payload twice is a no-op (clean retry/reconcile).
3. Reads return cache-consistent data; staleness/refresh is the SyncEngine's concern, invisible to callers. Drift surfaces via `health()`.

### Commit & partial-failure semantics (Codex R1 #2)

Today's writers have **typed partial-commit contracts** that callers depend on. The provider contract must preserve them, not flatten them into a generic async upsert:

- **Durability boundary at return.** `putFeature`/`appendEvent`/`appendChangelog` return only after the change is durably committed to *the canonical store for the active provider*. For `LocalFileProvider` that is the file on disk (synchronous, unchanged). For remote providers it is **cache + op-log fsync'd** — the op-log is the durable commit record; reconcile-to-remote is asynchronous but the op is never lost (this is the "provider-canonical, eventually" contract; `health()` exposes `pendingOps`).
- **Multi-entity operations are explicit, ordered methods — not callers chaining primitives.** The contract defines composite operations that mirror today's writers and preserve their ordering + typed errors:
  - `setStatus(code, to, meta)` → may throw `ROADMAP_PARTIAL_WRITE` (feature persisted, roadmap regen failed) exactly as `feature-writer.js:233` does today.
  - `recordCompletion(code, rec)` → persists completion **first**, then flips status; rethrows `STATUS_FLIP_AFTER_COMPLETION_RECORDED` if the flip fails (mirrors `completion-writer.js:305`). The provider guarantees the completion is durable before the status step is attempted.
  - `appendChangelog(entry)` → an **atomic whole-file parse-and-rewrite**, not a blind append (mirrors `changelog-writer.js:323/504`). Remote providers fetch the canonical file, parse, splice, and commit the full file in one Contents-API call.
- `putFeature` is the low-level metadata upsert (used by triage cache); the composite methods above are what the mutation layer calls for status/completion/changelog. The transition policy still runs in the mutation layer *before* `setStatus` is invoked.

## GitHub Provider Mapping

| Compose entity | GitHub primitive |
|---|---|
| Feature | 1 Issue. Body = fenced ```compose-feature``` JSON block (canonical metadata) + prose. Title `[CODE] description`. |
| Status | Projects v2 single-select `Status` (GraphQL) + mirror label `status:<value>`; terminal statuses close the issue. |
| Events | Issue timeline + structured `<!--compose-event {json}-->` comments. |
| Roadmap | `roadmap-gen.js` output committed via Contents API to configurable path/branch. |
| Changelog | `CHANGELOG.md` committed via Contents API. |
| Identity map | `.compose/data/tracker-cache/github/idmap.json`: `code ↔ {issueNumber, projectItemId, nodeId}`; rebuildable from `label:compose-feature` search. |

GitHubProvider declares `{FEATURES, EVENTS, ROADMAP, CHANGELOG}`; `{JOURNAL, VISION}` fall back to local.

## Data Flow

- **Write:** mutation layer validates transition (against the **pending-shadowed** view, see below) → composite/`putFeature` → cache write + op-log append (fsync) → return.
- **Reconciler:** FIFO drain of op-log → GraphQL/REST with exponential backoff + rate-limit header awareness. Success → op removed + cache stamped with provider `updatedAt` + provider entity version (issue `updatedAt`/`nodeId` ETag-equivalent). Triggered after mutation batches, on `compose tracker sync`, best-effort at ship.
- **Offline:** reads from cache; writes queue; reconciler resumes on connectivity. `LocalFileProvider` bypasses the engine (synchronous).

### Pending-op shadowing & CAS (Codex R1 #3)

Compose's writers are **read-before-write**: `setFeatureStatus` validates the transition from the *currently read* status (`feature-writer.js:217`), `recordCompletion` dedupes by scanning the current `completions[]` (`completion-writer.js:265`), `addRoadmapEntry` decides uniqueness from current reads (`feature-writer.js:103`). A naive "provider value wins in cache while a local op is pending" rule would let those reads observe rolled-back state and corrupt logic (re-created features, double completions, transition validated against the wrong status). Rules:

1. **Pending writes shadow reads.** While an op for `code` is un-reconciled in the op-log, `getFeature(code)`/`listFeatures()` return the **post-op cache value**, never a remote-rolled-back value. Reads are always consistent with what this process has durably committed.
2. **Optimistic concurrency on reconcile (CAS).** Each cached entity carries the provider version it was last reconciled from. The reconciler sends the mutation conditionally (GraphQL expected `updatedAt` / issue node version). If the remote moved underneath a pending op → the op is **not silently lost**: it goes to the conflict ledger with both values, the op is quarantined, and `health()`/`compose tracker status` surface it for operator resolution. Provider-canonical means the *resolved* state is the provider's — but resolution is explicit, not a silent cache rollback.
3. **No cache rollback under pending ops.** Pull-reconcile only updates cache entries that have **zero** pending ops. Entities with pending ops are reconciled solely via the CAS path in rule 2.

### Curated-merge views: ROADMAP & CHANGELOG (Codex R1 #4)

`ROADMAP.md` and `CHANGELOG.md` are **not pure materialized views today** — `roadmap-gen.js` preserves curated phase prose, anonymous rows, preserved sections, anchors, and heading overrides by reading the *existing on-disk file* as the merge base (`roadmap-gen.js:62/122/196/252`); `changelog-writer.js` surgically rewrites the existing file (`:301/:516`). Therefore:

- For remote providers the **merge base is the provider-canonical file contents**, fetched fresh via the Contents API immediately before regeneration — never the possibly-stale local cache. The flow is: fetch remote `ROADMAP.md`/`CHANGELOG.md` → run the *unchanged* `roadmap-gen`/`changelog-writer` merge logic with that as the base → commit the result back via Contents API with the fetched blob SHA as the expected base (Contents-API optimistic-lock; a 409 → retry with refetch).
- This keeps all curated content intact and makes the existing generators provider-agnostic (they operate on a string, not a fixed path). `roadmapPath`/changelog path are config-driven.

### Position allocation (Codex R1 #5)

`nextPositionInPhase()` (`feature-writer.js:156`) computes `max(existing)+1` from the visible feature set — safe locally because reads/writes are one synchronous store, unsafe under queued writes + stale reads (two writers allocate the same position). Rule for remote providers: **`position` is best-effort and not authoritative for ordering.** Display order is derived from the provider's own ordering primitive (GitHub Projects v2 item position) at render time; the local `position` integer is a hint, and collisions are normalized deterministically (stable sort by `(position, code)`) during roadmap render. The conformance suite asserts two concurrent feature creations in the same phase never error and produce a stable, collision-free rendered order. (Local provider keeps exact current behavior.)

## Configuration & Auth

`.compose/compose.json`:
```json
{ "tracker": {
    "provider": "local",
    "github": {
      "repo": "owner/name",
      "projectNumber": 12,
      "roadmapPath": "ROADMAP.md",
      "branch": "main",
      "cacheTtlSeconds": 60,
      "auth": { "tokenEnv": "COMPOSE_GH_TOKEN" }
    } } }
```
Absent `tracker` key → `provider: "local"` → zero behavior change for existing projects. `init()` validates token scopes (`repo`, `project`), fails fast with `TrackerConfigError` naming the missing scope. Auth is env-only (never written to disk); `gh` CLI token is an accepted fallback source.

## Error Handling

- `TrackerConfigError`: bad/missing config or scopes → fail fast at `init()`; never silently fall back to local (would mask misconfig).
- API failure mid-reconcile: op stays in log, attempts++, backoff; never lost. Poison op (attempts > N) → quarantine + conflict ledger + `health()`.
- Cache corruption: rebuild from provider via full pull-reconcile.
- Capability gap: transparent local fallback, logged once at `init()` (not an error).
- Transition rejection: unchanged, provider-independent, occurs before provider is called.

## Testing (per `~/.claude/rules/testing.md`)

- **Golden flow (local):** scaffold→transitions→complete→roadmap→events; asserts `LocalFileProvider` byte-identical to today (regression gate).
- **Golden flow (github):** recorded GraphQL/REST fixture server (no live API in CI); create→status→reconcile→pull→roadmap commit→event readback.
- **Sync engine unit:** op-log durability, FIFO, retry/backoff, rate-limit parse, conflict detection, poison quarantine.
- **Capability fallback:** GitHubProvider + journal → routed to local, asserted.
- **Contract suite:** both providers pass the same `TrackerProvider` conformance tests (idempotent `putFeature`, cache-consistent reads, capability honesty).
- **Offline:** writes queue, reads serve cache, reconciler resumes.

## LocalFileProvider Conformance Requirements (Codex R1 #7)

`LocalFileProvider` is a behavior-preserving extraction. These currently-implicit behaviors are promoted to **explicit, tested conformance requirements** — the extraction must reproduce them exactly, and the contract suite asserts each:

1. `getFeature` returns `null` (not throw) on malformed/unparseable JSON (`feature-json.js:35`).
2. `listFeatures` silently skips malformed files and applies the existing sort order (`feature-json.js:67`) — order is part of the contract (roadmap-gen + validators depend on it).
3. `putFeature` stamps `updated` — and preserves today's in-place mutation of the caller's object (`feature-json.js:52`) **or** every caller is audited and updated if we make it pure. v1 choice: **preserve in-place stamping** to guarantee zero behavior change; "make it pure" is tracked as a separate cleanup, not bundled here.
4. Only `paths.features` from `.compose/compose.json` is honored for feature dir resolution (`project-paths.js:24`); no new resolution rules introduced.
5. Same typed errors, same messages, same partial-commit ordering as the current writers (covered by the regression golden flow).

A provider that "cleans up" any of these is non-conformant for v1, even if higher-level tests pass.

## Open Questions

1. **Reconciler trigger cadence** beyond mutation-batch/explicit/ship — is a background interval needed, or is on-demand sufficient for v1? (Lean: on-demand only; revisit if drift windows hurt.)
2. **Projects v2 field bootstrapping** — if the target Project lacks a `Status` single-select with Compose's enum values, does `init()` create it (needs write scope) or fail with guidance? (Lean: create-if-missing, documented.)
3. **Multi-repo features** — v1 assumes one repo per Compose project. Cross-repo roadmap is out of scope; confirm no near-term need.

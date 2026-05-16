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

- **Write:** mutation layer validates transition → `provider.putFeature` → cache write + op-log append → return (non-blocking).
- **Reconciler:** FIFO drain of op-log → GraphQL/REST with exponential backoff + rate-limit header awareness. Success → op removed + cache stamped with provider `updatedAt`. Triggered after mutation batches, on `compose tracker sync`, best-effort at ship.
- **Pull-reconcile:** on stale read (TTL default 60s) or explicit sync — fetch provider, diff cache. Provider canonical: remote change w/o pending local op → cache updated; pending local op vs remote change to same field → conflict-ledger entry, provider value wins in cache, local op flagged, surfaced via `health()` / `compose tracker status`.
- **Offline:** reads from cache; writes queue; reconciler resumes on connectivity. `LocalFileProvider` bypasses the engine (synchronous).

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

## Open Questions

1. **Reconciler trigger cadence** beyond mutation-batch/explicit/ship — is a background interval needed, or is on-demand sufficient for v1? (Lean: on-demand only; revisit if drift windows hurt.)
2. **Projects v2 field bootstrapping** — if the target Project lacks a `Status` single-select with Compose's enum values, does `init()` create it (needs write scope) or fail with guidance? (Lean: create-if-missing, documented.)
3. **Multi-repo features** — v1 assumes one repo per Compose project. Cross-repo roadmap is out of scope; confirm no near-term need.

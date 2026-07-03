# COMP-SMARTMEMORY-INGEST: Design

**Status:** DESIGN — this is a pre-implementation design document, not shipped code. Review it as a design: judge decisions, contracts, and implementability, not missing implementation.
**Date:** 2026-07-03

## Related Documents

- Roadmap row: `ROADMAP.md` → "COMP-SMARTMEMORY: SmartMemory Coupling (opt-in)" (originally filed on forge-top ROADMAP, unparked 2026-07-03)
- Dependent feature: [COMP-SMARTMEMORY-RECALL](../COMP-SMARTMEMORY-RECALL/design.md) (consumes what this ingests)
- Explorer findings baked in below: compose write-surface map, SmartMemory API map (2026-07-03)

---

## Problem

Compose accumulates rich lifecycle history — feature-mutation audit events, gate decisions, journal entries, per-feature artifacts — but none of it is queryable by relevance. SmartMemory (the AI memory system at `/Users/ruze/reg/my/SmartMemory`) provides exactly that: content-addressed ingestion plus hybrid recall with spreading activation. This feature couples compose to SmartMemory **behind an opt-in flag, default OFF**, so the coupling costs nothing for users without SmartMemory and can be abandoned without residue if SmartMemory's interfaces move.

## Goal

When `smartmemory.enabled === true` in `.compose/compose.json` and a SmartMemory service is reachable:

1. Live lifecycle events (feature mutations, gate decisions) are ingested into SmartMemory as they happen, fail-open.
2. `compose smartmemory sync` backfills/re-syncs historical events, journal entries, and feature artifacts from the append-only logs and docs — idempotently.
3. Items carry provenance: `context.origin = "cli:compose"`, `context.project = <workspace id>`, `context.source_path` per surface.

**Non-goals:** tier model on events (COMP-ORIGIN-TIER — still deferred, and SmartMemory has no `tier` field anyway); recall UI (that is COMP-SMARTMEMORY-RECALL); async ingest mode (bypasses dedupe); write-back/feedback loops; watching artifact files for live ingestion (artifacts are written by agents directly to disk — there is no compose chokepoint for them, so they sync via the CLI command only); **provider-routed mutation events** — the ingest hook lives at the local sink (`lib/feature-events.js`) and emits **whatever lands there, regardless of tracker provider**; it is never "disabled for github". The scoping consequence, stated precisely: with `tracker.provider=github`, *provider-routed* mutations (status flips, roadmap entries, completions, changelog) go to GitHub issue comments (`lib/tracker/github-provider.js`) and never reach the local sink — those specific events are absent from SmartMemory in v1. But several writers append to the local sink **directly, bypassing the provider** (`lib/journal-writer.js:525,828`, `lib/followup-writer.js:493`, `lib/roadmap-drift.js:47`), so journal/follow-up/drift events ARE emitted and synced even in GitHub mode. `compose smartmemory sync` is fully tracker-independent: it walks whatever exists in feature-events.jsonl, gate-log.jsonl, journal, and artifacts, skipping missing files — it never disables itself by provider. A provider-layer event hook (closing the github-routed gap) is the follow-up if ever needed.

### Corrections to the original roadmap-row assumptions (from exploration)

| Roadmap row said | Reality |
|---|---|
| items with `origin=cli:compose` | `origin` is not a top-level field; it rides in `context.origin` (`routes/ingest.py:142`) |
| `workspace_id` scoped per project | `workspace_id` is derived from the API-key principal, never passed in the body (`routes/ingest.py:166,226`). Per-project scoping = per-project API key (compose.json is per-project, so `apiKeyEnv` can differ per project) |
| "decision events" as a source | Decision events are ephemeral SSE, re-derived from gate-log.jsonl + lifecycle state — no `decision-events.jsonl` exists. We ingest the underlying persisted sources instead |
| "audit traces" as a source | Two surfaces share the name: `feature-events.jsonl` (mutation log — we ingest this) and per-feature `audit.json` (Stratum flow trace — synced as an artifact, not live) |
| batch backfill endpoint | None exists. Backfill = loop over `POST /memory/ingest?mode=sync`, which is content-hash idempotent (`routes/ingest.py:177-202`), so re-runs are no-ops |

---

## Decision 1: Flag shape and read path

New optional block in `.compose/compose.json`:

```json
{
  "smartmemory": {
    "enabled": true,
    "baseUrl": "http://localhost:9001",
    "apiKeyEnv": "SMARTMEMORY_API_KEY",
    "timeoutMs": 3000
  }
}
```

- **Strict-truthy default-OFF**, matching `capabilities.guard` / `gsd.budget` / xref `push:true`: accessor returns `cfg?.smartmemory ?? {}`; every consumer gates on `smConfig.enabled === true`. Absent block ⇒ OFF ⇒ **zero behavior change** (no probe, no log line, no fetch — byte-identical).
- One shared reader `lib/smartmemory-config.js` (uncached direct read of `.compose/compose.json`, try/catch → `{}`), used by both lib- and server-side consumers, sidestepping the cached-vs-uncached split between `server/project-root.js:110` and per-lib readers.
- The API key itself never lives in config — only the **name of the env var** (`apiKeyEnv`, default `SMARTMEMORY_API_KEY`). Missing env var at runtime ⇒ treated as unreachable (warn once, circuit-break), never a crash.

## Decision 1b: HTTP API only (confirmed with user 2026-07-03)

SmartMemory has two storage modes, not two APIs: **Lite** (`smartmemory-core[lite]`, in-process SQLite graph + usearch vectors, no server) and full infra (FalkorDB). Compose integrates with the **HTTP API only** — the FastAPI service at `baseUrl`. Pure in-process Lite is out of reach for compose regardless of preference: it has no HTTP surface (Python library only), and **today the HTTP service cannot boot on Lite storage either** — the service's tenancy layer requires a non-None `scope_provider` (`memory_service/utils/scoped_daemon_memory.py:58-69`) while `SQLiteBackend` hard-raises on any scope provider by design (`backends/sqlite.py:119-124`, "single-tenant by design"). So in practice v1 targets a FalkorDB-backed service deployment.

This costs compose nothing architecturally: the client codes against the wire contract (`/memory/ingest`, `/memory/search`, `/health`). If SmartMemory later ships a single-tenant service mode over Lite, compose works unchanged. (Note for that future: `search_by_activation_from_seeds` exists only in the FalkorDB backend — `backends/falkordb.py:1908`, absent from `sqlite.py` — so recall on Lite would rank via the remaining hybrid channels.)

## Decision 2: Raw HTTP client, no SDK dependency

`lib/smartmemory-client.js` speaks plain HTTP+JSON via Node's global `fetch` (no new package.json dependency — compose requires Node ≥ 18):

- `health()` → `GET /health` (public, no auth — `service.py:167-175`)
- `ingest(content, context)` → `POST /memory/ingest?mode=sync` with `Authorization: Bearer <key>`; body `{content, context}` (`IngestRequest`, `request_models.py:82-90`)
- `search(query, opts)` → `POST /memory/search` (used by RECALL; lives here so both features share one client)

Rejected: importing `@smartmemory/sdk-js` (ESM in-repo workspace package; adds a moving dependency for two endpoints — the wire contract is plain JSON). Sync mode only: async mode bypasses source-path dedupe (`routes/ingest.py:147-157`).

## Decision 3: Emit seams — hook the two real chokepoints, fail-open

There is no universal write chokepoint in compose. The two seams that cover the persisted lifecycle surfaces:

1. **`lib/feature-events.js:44` `appendEvent`** — the mutation-log sink for the **local tracker provider** (status flips, roadmap entries, completions, changelog, journal, follow-ups, drift all funnel here via `safeAppendEvent` → `provider.appendEvent` → this sink). Note the canonical writers call the *provider-level* `appendEvent`; hooking the local sink (not the provider interface) is deliberate — it is the point where "this event was durably persisted locally" is true, and it scopes v1 to the local provider (see Non-goals for `tracker.provider=github`).
2. **`server/gate-log-store.js:46` `appendGateLogEntry`** — sole seam for gate decisions (these bypass feature-events).

After the local append **succeeds**, the emitter (`lib/smartmemory-ingest.js`) fires a non-blocking ingest. Properties:

- **Fail-open, always.** Ingest errors are swallowed (one `console.warn` on first failure); the local write's return value and timing are unaffected. Pattern precedent: `safeAppendEvent` itself.
- **Circuit breaker:** 3 consecutive failures ⇒ emitter disables itself for process lifetime. Long-lived processes (server, build) don't spam a dead service.
- **Pending-promise tracking** with `flushPending(timeoutMs)` awaited at CLI-command end, so short-lived processes don't drop in-flight POSTs. Long-lived processes fire-and-forget.
- **No recursion:** the emitter never writes compose state, so it cannot re-trigger the seams it hooks.

## Decision 4: Two idempotency regimes — events vs files

SmartMemory has two dedupe paths, and they are **origin-gated**: source-path replace-in-place dedupe is only enabled for `import:*` / `code:index*` origins (`smart-memory-core/smartmemory/origin_policy.py:191`, gated in `routes/ingest.py:142`); every other origin falls back to content-hash ids (`routes/ingest.py:181`), where changed content creates a **new** item (`tests/integration/api/test_ingest_dedupe.py:96`). The design uses both deliberately:

- **Event surfaces (immutable lines):** `context.origin = "cli:compose"`. Each event renders to a **deterministic one-line content string** — e.g. `[compose:<project>] 2026-05-02T16:11:11Z add_changelog_entry COMP-MCP-CHANGELOG-WRITER by mcp:agent` — with the full structured event in `context.event`. Events never change, so sha256(content) idempotency is exactly right: the same event ingested live and again by backfill ⇒ `status:"unchanged"` no-op. Live emit + backfill freely overlap with no bookkeeping.
- **File surfaces (mutable docs — artifacts, journal entries):** `context.origin = "import:compose"` with `context.source_path` = the artifact's stable repo-relative path. This opts into source-path dedupe, so re-syncing an **edited** design.md **replaces** the prior item instead of accumulating near-duplicate versions. Unchanged files still short-circuit on content-hash.

`context.source_path` on event items is stamped too (e.g. `compose/<project>/.compose/data/feature-events.jsonl`) but as **provenance only** — it does not participate in dedupe for `cli:compose`. Blueprint must verify the `import:*` gating claim against `origin_policy.py` before implementation.

## Decision 5: Backfill/sync as one idempotent CLI verb

`compose smartmemory sync [--dry-run] [--feature <CODE>]` walks, in order:

1. `.compose/data/feature-events.jsonl` → one item per line (skip malformed lines, mirroring `readGateLog` tolerance)
2. `.compose/data/gate-log.jsonl` → one item per entry
3. Journal entries at `resolveJournalPath(cwd)` (`lib/project-paths.js:29-40` — honors `paths.journal` overrides; never a hardcoded `docs/journal/`) → one item per entry (frontmatter summary + body), `context.origin = "import:compose"` (file regime)
4. Per-feature artifacts via the COMP-PATHS-EXTERNAL resolvers (`lib/project-paths.js` — resolve, never join): `design.md`, `blueprint.md`, `plan.md`, `report.md`, and `audit.json` (the Stratum flow trace, written at `lib/build.js:2629` — ingested as text with `kind:"audit"`) per feature folder → one item each, content = file text, `context.artifact = {feature_code, kind}`, `context.origin = "import:compose"` (Decision 4 file regime)

Sequential sync loop; on `429` (workspace quota middleware, `service.py:188-190`) back off once then stop with a clear count report (`ingested / unchanged / skipped / failed`). `--dry-run` prints counts without POSTing. Re-running is safe (Decision 4). This one verb is both first-time backfill and ongoing artifact re-sync — no separate watcher machinery.

**`--feature <CODE>` filter semantics (pinned):** feature-events lines where `event.code === CODE || event.feature_code === CODE` (both key names occur in the log — e.g. `write_journal_entry` audit rows use `feature_code`); gate-log entries where `entry.feature_code === CODE`; journal entries whose frontmatter `feature_code === CODE`; artifacts under the feature folder for `CODE` only. Entries with no feature association (null/absent code) are **excluded** when `--feature` is given, included in a full sync. Same field per surface the readers already use — no fuzzy matching.

## Decision 6: Scoping and provenance

- **Workspace isolation is authentication**: whoever holds the API key's workspace gets the items. Per-project isolation is achieved by giving each project its own key via its own `.compose/compose.json` `apiKeyEnv`. Documented, not enforced by compose.
- Every item stamps `context.project` with **one canonical value** resolved by a single function `resolveProjectTag(cwd)` in `lib/smartmemory-config.js`: the compose workspace id when the workspace registry defines one for this root, else `basename(projectRoot)`. Emitters, sync walker, and RECALL's route all call this same function, so the cross-project badge comparison (`result.project !== currentProjectTag`) is exact string equality end-to-end. `context.origin` follows Decision 4's two regimes — `"cli:compose"` on event items, `"import:compose"` on file items — never a single blanket value (stamping `cli:compose` on files would silently collapse them back to content-hash-only dedupe and break replace-in-place re-sync).

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `lib/smartmemory-config.js` | new | Shared flag reader: `getSmartmemoryConfig(cwd)` → `{}` when absent |
| `lib/smartmemory-client.js` | new | Raw-HTTP client: `health`, `ingest`, `search`; Bearer auth from `apiKeyEnv` |
| `lib/smartmemory-ingest.js` | new | Emitter: event→content rendering, fail-open emit, circuit breaker, `flushPending` |
| `lib/smartmemory-sync.js` | new | Sync walker over the four surfaces; count report; 429 backoff |
| `lib/feature-events.js` | existing | Post-append hook → emitter (guarded by flag, lazy-imported) |
| `server/gate-log-store.js` | existing | Post-append hook → emitter (same guard) |
| `bin/compose.js` | existing | `smartmemory sync` verb wiring (`--dry-run`, `--feature`) |
| `test/smartmemory-*.test.js` | new | Golden flow vs local HTTP stub; error harness (OFF/unreachable/429/500/missing-key); byte-identical-when-OFF assertions |

Lazy imports at both hook sites (lesson from COMP-CODEX-IMPL: an eager import at module top broke a spawned worker) — the emitter module loads only when the flag is on.

## Testing

- **Golden flow (real backend rule):** spin a local `node:http` stub implementing `/health` + `/memory/ingest` contract shapes verbatim from `request_models.py`; assert live emit on a real `appendEvent`, then `sync` over a seeded `.compose/data/` fixture, then re-`sync` asserting all-`unchanged`.
- **Error harness (table-driven):** flag OFF (zero fetches — spy asserts none), service down, 429, 500, malformed JSONL line, missing env key.
- **Byte-identity:** with flag unset, `appendEvent`/`appendGateLogEntry` outputs and side effects are byte-identical to today (no new log lines, no timing-dependent state).

## Open Questions

None blocking. Deferred by design: per-event granular flags (single `enabled` for v1), live artifact ingestion (no chokepoint exists), `/memory/feedback` reinforcement (RECALL v2 candidate).

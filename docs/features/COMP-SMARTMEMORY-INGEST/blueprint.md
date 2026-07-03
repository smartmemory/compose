# COMP-SMARTMEMORY-INGEST: Implementation Blueprint

**Status:** BLUEPRINT — pre-implementation. Derived from `design.md` (LOCKED, 8 review rounds). Where reality contradicted the design, it is recorded in the Corrections table below rather than redesigned.
**Date:** 2026-07-03
**Design:** [design.md](./design.md)
**Repo:** `/Users/ruze/reg/my/forge/compose` (Node ≥ 18, plain ESM JS, no TypeScript, no new package.json deps — global `fetch` only)

---

## 1. Corrections table (design assumption → verified reality)

Every citation in the design was opened at the cited line. Drift found:

| # | Design says | Verified reality | Impact |
|---|---|---|---|
| C1 | Decision 3 (l.79): status/roadmap/completions/changelog/**journal/follow-ups/drift** "all funnel here via `safeAppendEvent` → `provider.appendEvent` → this sink" | Only **provider-routed** writers (status flip, roadmap entry, completion, changelog) reach the sink through `local-provider.appendEvent` (`lib/tracker/local-provider.js:108`) → `appendEventRaw` (= `feature-events.appendEvent`). **Journal** (`lib/journal-writer.js:525` `safeAppendEvent` → `appendEvent` at l.527; audit write at l.828-837), **follow-ups** (`lib/followup-writer.js:493`), and **drift** (`lib/roadmap-drift.js:47`) import `appendEvent` **directly** from `./feature-events.js` and call it **bypassing the provider**. | None to the hook target: **all** paths terminate at `feature-events.appendEvent` (`lib/feature-events.js:44`), so the single hook there covers every one. Only the design's prose describing the call chain is imprecise. Non-goals paragraph (l.26) already states the direct-append reality correctly; Decision 3's summary contradicts it — trust the Non-goals version. |
| C2 | `audit.json` written at `lib/build.js:2629` | l.2629 is the section comment. The primary writer is `writeFileSync(join(featureDir, 'audit.json'), JSON.stringify(response, null, 2))` at **l.2636-2639** (from the completion envelope `response.trace`), with a fallback `stratum.audit()` writer at **l.2649-2651**. Cited span 2629-2657 is accurate. | None. Sync reads the file off disk; the writer location is informational. |
| C3 | `resolveJournalPath` at `lib/project-paths.js:29-40` | Exported at **l.32** (`export const resolveJournalPath = (cwd) => resolveKey(cwd, 'journal')`); honors `paths.journal` via `resolveKey` → `readConfig(cwd)?.paths?.journal`, absolute-safe through `paths-core.resolvePathValue`. | None. Symbol correct, line off by a few. |
| C4 | Emitter "`flushPending(timeoutMs)` awaited at **CLI-command end**, so short-lived processes don't drop in-flight POSTs" | Compose CLI branches terminate via `process.exit()` (`bin/compose.js:109,145,311,…`), which does **not** fire `beforeExit`. An auto-registered `beforeExit` flush would never run for CLI mutation verbs. | Handled explicitly (see §5): (a) `smartmemory sync` **awaits its own** `ingest` calls inline — never fire-and-forget — so its POSTs cannot drop, and `flushPending` is awaited at the end of that branch as a drain point; (b) live-emit fire-and-forget POSTs from short-lived CLI mutation verbs *may* drop on `process.exit` — **acceptable under fail-open** because the next `sync` re-ingests them (content-hash idempotent, Decision 4). This is a wiring nuance the design under-specified, not a contradiction. |
| C5 | `resolveProjectTag` = "compose workspace id when the workspace registry defines one for this root, else `basename(projectRoot)`" | `deriveId({ root })` at `lib/discover-workspaces.js:117` **already** implements exactly this: honors `.compose/compose.json#workspaceId` when it matches `/^[a-z][a-z0-9-]{1,63}$/`, else `path.basename(root)`. | Enhancement, not contradiction. `resolveProjectTag(cwd)` wraps `deriveId({ root: cwd }).id` — do not reinvent the logic. |
| C6 | Testing: "spin a local `node:http` stub" | The canonical fixture pattern (`test/cli-remote.test.js:28-33`, itself "same pattern as auth-routes.test.js") is `http.createServer(app)` + a `listen(app)` helper returning the server; port via `server.address().port`. It uses `express` (a real dep, `package.json:99`). | Blueprint reuses the `listen()` helper but with a **raw `node:http` request handler** (no express) — the stub is 3 routes and asserting exact wire bytes is cleaner without a framework. Matches the design's literal "node:http stub". |
| C7 | `--feature` filter: gate-log on `entry.feature_code`, events on `event.code \|\| event.feature_code` | Confirmed. `readGateLog` filters `obj.feature_code` (`server/gate-log-store.js:97`); `readEvents` filters `row.code` (`lib/feature-events.js:90`); `write_journal_entry` audit rows carry `feature_code` (`lib/journal-writer.js:834`). Both key names genuinely occur. | None — design is accurate; recorded as a confirmation. |

**Net:** no design decision is overturned. The hook target (`feature-events.appendEvent`), idempotency regimes, flag shape, and wire contract all hold. C4 and C5 change *how* two things are implemented; C1/C2/C3/C6/C7 are citation/description precision.

---

## 2. Wire contract (authoritative — from design, do not re-derive from SmartMemory repo)

The client codes to these shapes verbatim. Exact response-field names for the dedup indicator are tolerated flexibly (see `ingest` classification) and confirmed against the live service during Task T2, not re-derived from the SmartMemory source.

- **`GET {baseUrl}/health`** — public, no auth. 2xx ⇒ reachable. Any non-2xx or network error ⇒ unreachable.
- **`POST {baseUrl}/memory/ingest?mode=sync`** — header `Authorization: Bearer <key>`; JSON body `{ content: string, context: object }` (`IngestRequest`). `mode=sync` is mandatory (async bypasses source-path dedupe). Response 2xx carries a status/dedup signal; a content-hash or source-path match returns a no-op indicator (design: `status:"unchanged"`). `429` ⇒ workspace quota (back off once, then stop). Non-2xx ⇒ error carrying the numeric status.
- **`POST {baseUrl}/memory/search`** — used by COMP-SMARTMEMORY-RECALL; lives in this client so both features share it. Not exercised by INGEST beyond a thin passthrough + one unit test.

`context` fields this feature stamps: `origin` (`"cli:compose"` for events, `"import:compose"` for files), `project` (from `resolveProjectTag`), `source_path` (provenance for events, dedupe key for files), `event`/`artifact` structured payload.

---

## 3. New module export specs

### 3.1 `lib/smartmemory-config.js` (new) — shared reader + provenance helpers

Leaf module. Imports only `node:fs`, `node:path`, and `deriveId` from `./discover-workspaces.js`. No fetch, no compose-state writes → safe to import eagerly at the two hook sites (satisfies "one shared reader"; the emitter stays lazy).

```js
/**
 * Read `.compose/compose.json` → `smartmemory` block. Uncached direct read
 * (Decision 1), try/catch → {} on missing/malformed. Returns the raw block;
 * consumers gate on `.enabled === true`. Does NOT resolve the API key.
 * @param {string} cwd
 * @returns {{ enabled?: boolean, baseUrl?: string, apiKeyEnv?: string, timeoutMs?: number }}
 */
export function getSmartmemoryConfig(cwd)          // → cfg.smartmemory ?? {}

/**
 * Canonical per-project provenance tag. Wraps deriveId (C5): compose.json
 * #workspaceId when valid, else basename(cwd). Same value for emitters, sync,
 * and RECALL → exact string-equality badge comparison end-to-end.
 * @param {string} cwd
 * @returns {string}
 */
export function resolveProjectTag(cwd)             // → deriveId({ root: cwd }).id

/**
 * Deterministic provenance path: `compose/<project>/<repoRel>`. Used for every
 * source_path (events: provenance only; files: dedupe key). Pure/total.
 * @param {string} projectTag
 * @param {string} repoRel  repo-relative path (forward slashes)
 * @returns {string}
 */
export function sourcePathFor(projectTag, repoRel) // → `compose/${projectTag}/${repoRel}`
```

### 3.2 `lib/smartmemory-client.js` (new) — raw HTTP client

Global `fetch` + `AbortController` timeout. No SDK, no new dep.

```js
/** Thrown on non-2xx from ingest/search. Carries the numeric HTTP status. */
export class SmartmemoryHttpError extends Error {
  constructor(message, status) { super(message); this.name = 'SmartmemoryHttpError'; this.status = status; }
}

/**
 * Build a client bound to a resolved config. The API key is read from
 * process.env[cfg.apiKeyEnv] at call time (missing ⇒ treated as unreachable).
 * @param {{ baseUrl: string, apiKeyEnv?: string, timeoutMs?: number }} cfg
 * @returns {{ health, ingest, search }}
 */
export function createSmartmemoryClient(cfg) { … }

//  health()               → Promise<{ ok: boolean, status?: number }>
//    GET {baseUrl}/health, no auth. Never throws: network error / timeout ⇒ { ok:false }.
//  ingest(content, ctx)   → Promise<{ status: string, unchanged: boolean, raw: object }>
//    POST {baseUrl}/memory/ingest?mode=sync, Bearer auth, body { content, context: ctx }.
//    Throws SmartmemoryHttpError(status) on non-2xx (429 ⇒ .status===429).
//    Missing env key ⇒ throws SmartmemoryHttpError('missing api key', 0) BEFORE any fetch.
//    `unchanged` = response indicates a content-hash/source-path no-op.
//  search(query, opts={}) → Promise<object>  (RECALL; POST {baseUrl}/memory/search, Bearer)
//    Returns the RAW SmartMemory SearchResponse envelope verbatim — no reshaping,
//    field renaming, or dropping of hits. Each hit preserves: `content` (or
//    `text`), `score`, `memory_type`, and a `context` object with `context.project`
//    and, for event items, `context.event.ts`. This is the SAME result contract
//    COMP-SMARTMEMORY-RECALL's route depends on (see
//    `COMP-SMARTMEMORY-RECALL/blueprint.md` §"Contract dependency: INGEST client
//    `search()`", ~228-239) — the two blueprints share it verbatim. Passing the
//    envelope through lossily (stripping fields, renaming keys, unwrapping to a
//    bare array) breaks RECALL's `mapHit`.
```

Timeout: `timeoutMs ?? 3000`, enforced with `AbortController` + `setTimeout`, cleared in `finally`.

### 3.3 `lib/smartmemory-ingest.js` (new) — live emitter + shared renderers

Lazy-imported by the hooks. Holds circuit-breaker + pending-promise state at module scope. The **render + context builders are pure and shared with sync** (§4) so live-emit and backfill hash identically.

```js
// ── module state ──
// let consecutiveFailures = 0; let disabled = false; const pending = new Set();

/** PURE. One deterministic line per feature-event row. Shared with sync. */
export function renderFeatureEventContent(row, projectTag)
//   → `[compose:${projectTag}] ${row.ts} ${row.tool} ${row.code ?? row.feature_code ?? '-'} by ${row.actor ?? 'mcp:agent'}`

/** PURE. One deterministic line per gate-log entry. Shared with sync. */
export function renderGateLogContent(entry, projectTag)
//   → `[compose:${projectTag}] ${entry.timestamp} gate:${entry.decision} ${entry.feature_code ?? '-'} ${entry.id}`

/** PURE. context for an event item (cli:compose regime — content-hash dedupe). */
export function buildFeatureEventContext(projectTag, row)
//   → { origin:'cli:compose', project:projectTag,
//       source_path: sourcePathFor(projectTag,'.compose/data/feature-events.jsonl'), event: row }
export function buildGateLogContext(projectTag, entry)
//   → { origin:'cli:compose', project:projectTag,
//       source_path: sourcePathFor(projectTag,'.compose/data/gate-log.jsonl'), event: entry }

/** Fire-and-forget live emit after a durable local append. Never throws. */
export function emitFeatureEvent(cwd, row)   // → void
export function emitGateLogEntry(cwd, entry) // → void

/** Await in-flight POSTs (bounded by timeoutMs). Drain point for callers that exit. */
export function flushPending(timeoutMs = 3000) // → Promise<void>

/** Test hook: clear circuit breaker + pending between cases. */
export function _resetEmitterState()
```

**`emitFeatureEvent`/`emitGateLogEntry` behavior** (identical shape):
1. If `disabled` → return.
2. `cfg = getSmartmemoryConfig(cwd)`; if `cfg.enabled !== true` → return (no fetch — byte-identity).
3. `tag = resolveProjectTag(cwd)`; `content = render…(item, tag)`; `ctx = build…Context(tag, item)`.
4. `client = createSmartmemoryClient(cfg)`; `p = client.ingest(content, ctx)`; add `p` to `pending`.
5. `p.then(ok → { consecutiveFailures = 0 }).catch(err → onFailure(err)).finally(() => pending.delete(p))`.
6. `onFailure`: `if (consecutiveFailures++ === 0) console.warn('[smartmemory] ingest failed (fail-open): ' + err.message)`; `if (consecutiveFailures >= 3) disabled = true`.

Never awaits, never rethrows. The local write's return value/timing is untouched (the hook already returned by the time `.then` runs).

### 3.4 `lib/smartmemory-sync.js` (new) — idempotent backfill walker

```js
/**
 * Walk the four persisted surfaces and ingest each item (idempotent).
 * @param {{ cwd: string, dryRun?: boolean, feature?: string|null }} opts
 * @returns {Promise<{ ingested:number, unchanged:number, skipped:number, failed:number, stoppedOnQuota:boolean }>}
 */
export async function runSync({ cwd, dryRun = false, feature = null }) { … }
```

Order + regimes (Decision 5):
1. `.compose/data/feature-events.jsonl` — `readEvents(cwd)` (`lib/feature-events.js`); per row → `renderFeatureEventContent` + `buildFeatureEventContext` (cli:compose). Malformed lines already skipped by `readEvents` (count them as `skipped` by diffing raw line count vs parsed — or accept reader tolerance and skip counting; see §6).
2. `.compose/data/gate-log.jsonl` — `readGateLog({ featureCode: feature ?? undefined })` (`server/gate-log-store.js`); per entry → `renderGateLogContent` + `buildGateLogContext` (cli:compose).
3. Journal entries at `resolveJournalPath(cwd)` (`lib/project-paths.js:32`) — via `getJournalEntries(cwd, { feature_code })` (`lib/journal-writer.js`); per entry → **file regime**: `content` = frontmatter summary + body; `context = { origin:'import:compose', project:tag, source_path: sourcePathFor(tag, relForDisplay(cwd, entryAbsPath)) }`.
4. Per-feature artifacts — `listFeatures(cwd, loadFeaturesDir(cwd))` (`lib/feature-json.js:128`), then per feature folder read `design.md`, `blueprint.md`, `plan.md`, `report.md`, `audit.json` (skip absent); **file regime**: `content` = file text, `context = { origin:'import:compose', project:tag, source_path: sourcePathFor(tag, relForDisplay(cwd, absPath)), artifact:{ feature_code, kind } }` where `kind` ∈ {design, blueprint, plan, report, audit}.

Filter (`--feature CODE`, Decision 5 semantics, C7): events where `row.code === CODE || row.feature_code === CODE`; gate-log via `readGateLog({ featureCode: CODE })`; journal via `getJournalEntries(cwd,{feature_code:CODE})`; artifacts under the `CODE` folder only. Null/absent-code items excluded when `feature` is set, included otherwise.

Loop: sequential. `dryRun` ⇒ count only, no client construction/POST. Live ⇒ optional `health()` preflight; per item `await client.ingest(...)` → `unchanged ? unchanged++ : ingested++`; on `SmartmemoryHttpError.status===429` back off once (`await sleep(1000)`, retry once) then, if still 429, set `stoppedOnQuota=true` and break; other errors → `failed++`, continue; unreadable file → `skipped++`. Requires `cfg.enabled === true` unless `dryRun` (else throw a clear "smartmemory not enabled" before walking).

---

## 4. Exact hook diffs (fail-open, flag-gated, lazy emitter)

Both hooks: eager top import of the leaf `getSmartmemoryConfig`; **lazy** dynamic import of the emitter so the client/fetch module loads only when the flag is on (COMP-CODEX-IMPL lesson). The emit is dispatched **after** the durable append and wrapped so nothing it does can affect the local write.

### 4.1 `lib/feature-events.js`

Add to the import block (top, after l.26):
```js
import { getSmartmemoryConfig } from './smartmemory-config.js';
```
In `appendEvent`, between the append (l.60) and the return (l.61):
```js
  appendFileSync(path, JSON.stringify(row) + '\n');
  // COMP-SMARTMEMORY-INGEST: fail-open live emit after the durable local append.
  // Flag-gated; emitter is lazy-loaded only when smartmemory.enabled === true.
  try {
    if (getSmartmemoryConfig(cwd).enabled === true) {
      import('./smartmemory-ingest.js')
        .then((m) => m.emitFeatureEvent(cwd, row))
        .catch(() => {});
    }
  } catch { /* fail-open: never let ingest affect the local write */ }
  return row;
```
`row` here is the **post-stamp** object (ts/actor/build_id already merged) — the same bytes sync reads back, guaranteeing identical rendering/hashing.

### 4.2 `server/gate-log-store.js`

Extend the existing import (l.24) and add the config import:
```js
import { getDataDir, getTargetRoot } from './project-root.js';
import { getSmartmemoryConfig } from '../lib/smartmemory-config.js';
```
In `appendGateLogEntry`, immediately after the append (l.67) — reached **only when a new line was actually written**, since the duplicate-id branch returns early at l.60:
```js
  appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
  // COMP-SMARTMEMORY-INGEST: fail-open live emit after the durable append.
  try {
    const cwd = getTargetRoot();
    if (getSmartmemoryConfig(cwd).enabled === true) {
      import('../lib/smartmemory-ingest.js')
        .then((m) => m.emitGateLogEntry(cwd, entry))
        .catch(() => {});
    }
  } catch { /* fail-open */ }
```
`getTargetRoot()` (`server/project-root.js:47`) supplies the project cwd for config + `resolveProjectTag`. When `COMPOSE_GATE_LOG` overrides the path in tests, config is still read from the real target root; with smartmemory absent ⇒ `enabled !== true` ⇒ zero fetch (byte-identity preserved).

---

## 5. Deterministic rendering — pinned templates

Live emit and `sync` must produce **byte-identical `content`** for the same persisted row so `sha256(content)` collides and re-sync is a no-op. This is guaranteed by both paths calling the **same pure functions** in `lib/smartmemory-ingest.js` (§3.3). Templates, pinned:

| Surface | `content` (exact) | `context` |
|---|---|---|
| feature-event | `[compose:<project>] <ts> <tool> <code\|-> by <actor>` | `origin:cli:compose`, `project`, `source_path:compose/<project>/.compose/data/feature-events.jsonl`, `event:<row>` |
| gate-log entry | `[compose:<project>] <timestamp> gate:<decision> <feature_code\|-> <id>` | `origin:cli:compose`, `project`, `source_path:compose/<project>/.compose/data/gate-log.jsonl`, `event:<entry>` |
| journal entry | `<frontmatter summary>\n\n<body>` (entry file text) | `origin:import:compose`, `project`, `source_path:compose/<project>/<repoRel(entry.md)>` |
| artifact file | `<file text>` | `origin:import:compose`, `project`, `source_path:compose/<project>/<repoRel(artifact)>`, `artifact:{feature_code,kind}` |

Determinism guarantees:
- Event fields (`ts`, `actor`, `build_id`) are stamped at write time and read back unchanged by sync ⇒ identical bytes on both paths.
- `<project>` is `resolveProjectTag(cwd)` on both paths ⇒ identical.
- Event `source_path` is **provenance only** for `cli:compose` (no dedupe role); dedupe is content-hash, so an edited event (impossible — events are immutable) would create a new item, which never happens.
- File `source_path` **is** the dedupe key under `import:compose`: re-syncing an edited `design.md` replaces the prior item; unchanged files short-circuit on content-hash.

**Flush wiring (C4):** `flushPending` is exported and awaited at the **end of the `smartmemory sync` CLI branch**. `sync` itself `await`s every `ingest` inline (not fire-and-forget), so its POSTs never drop. Live-emit POSTs from short-lived CLI mutation verbs are fire-and-forget and may drop on `process.exit`; that is acceptable because the next `sync` re-ingests them idempotently. No `beforeExit`/`exit` handler is registered (it would not fire under `process.exit`).

---

## 6. Test plan

Runner: `node --test` (matches repo). All HTTP is a **raw `node:http` stub** via the `listen()` helper pattern from `test/cli-remote.test.js:28-33` (no express). Fixtures via `mkdtempSync` under `tmpdir()`, seeding `.compose/data/*.jsonl`, `.compose/compose.json`, and `docs/features/<CODE>/` + `docs/journal/`.

### Stub server (shared helper)
```js
function makeSmartmemoryStub({ ingest = [], failStatus = null, quota = false, searchResults = [] } = {}) {
  const seen = [];                       // captured {content, context}
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200); return res.end('{"ok":true}'); }
    if (req.url.startsWith('/memory/search')) {           // search passthrough case
      let sb = ''; req.on('data', c => sb += c); req.on('end', () => {
        seen.push({ search: JSON.parse(sb || '{}'), auth: req.headers.authorization });
        res.writeHead(200); res.end(JSON.stringify({ results: searchResults }));  // searchResults: new option, default []
      });
      return;
    }
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const { content, context } = JSON.parse(body || '{}');
      seen.push({ content, context, auth: req.headers.authorization });
      if (quota) { res.writeHead(429); return res.end('{"error":"quota"}'); }
      if (failStatus) { res.writeHead(failStatus); return res.end('{"error":"x"}'); }
      const unchanged = seen.filter(s => s.content === content).length > 1;
      res.writeHead(200); res.end(JSON.stringify({ status: unchanged ? 'unchanged' : 'stored' }));
    });
  });
  return { server, seen };   // listen via listen(server); port = server.address().port
}
```

### `test/smartmemory-config.test.js` (new)
- `getSmartmemoryConfig`: absent block → `{}`; present block → verbatim; malformed JSON → `{}`.
- `resolveProjectTag`: valid `workspaceId` → that id; absent/invalid → `basename(cwd)` (assert against a temp dir name).
- `sourcePathFor`: `('regio','a/b.md')` → `'compose/regio/a/b.md'`.

### `test/smartmemory-client.test.js` (new)
Table-driven against the stub:
- `health` 200 → `{ok:true,status:200}`; server down (bad port) → `{ok:false}` (no throw).
- `ingest` 200 → `{status,'unchanged',raw}`; `Authorization: Bearer <key>` present (env set).
- Missing env key → throws `SmartmemoryHttpError` with `status===0`, **before** any fetch (assert stub `seen` empty).
- `ingest` 429 → throws, `.status===429`. `ingest` 500 → throws, `.status===500`.
- Timeout: stub delays > `timeoutMs` → rejects (AbortError surfaced as `SmartmemoryHttpError`/abort).
- `search` 200 → passthrough object.

### `test/smartmemory-ingest.test.js` (new)
- **Render determinism:** `renderFeatureEventContent(row,tag)` and `renderGateLogContent(entry,tag)` return the pinned strings for a fixed fixture; calling twice is byte-identical.
- **Circuit breaker:** 3 consecutive failing emits → 4th performs no fetch (`seen` unchanged); one `console.warn` only (spy).
- **`flushPending`:** after emits, resolves once all pending settle; respects `timeoutMs`.
- **Fail-open:** emit against a down service does not throw and does not perturb the caller.
- **Error harness (table):** cases `[OFF, down, 429, 500, missing-key]` → asserted outcome `[no-fetch, swallow+count-fail, swallow, swallow, swallow]`.

### `test/smartmemory-sync.test.js` (new — golden flow)
- Seed `feature-events.jsonl` (3 rows, one with `feature_code` only), `gate-log.jsonl` (2 entries), a journal entry, and a feature folder with `design.md` + `audit.json`.
- **Golden:** `runSync({cwd})` over the stub → `ingested` == item count, `unchanged===0`, `failed===0`; assert each `context.origin`/`source_path`/`project` matches §5; assert `seen[i].content` for an event equals `renderFeatureEventContent(row,tag)` (cross-check live/sync identity).
- **Re-sync idempotency:** second `runSync` → all `unchanged`, `ingested===0`.
- **`--feature CODE`:** only items associated with `CODE` ingested; null-code events excluded.
- **`--dry-run`:** counts returned, stub `seen` empty (no POST).
- **Malformed JSONL:** a bad line in `feature-events.jsonl` is skipped, not fatal.
- **429 quota:** stub `quota:true` → `stoppedOnQuota===true`, loop halts after backoff.
- **Not enabled + not dry-run:** throws "smartmemory not enabled".

### `test/smartmemory-hooks.test.js` (new — integration, byte-identity)
- **Flag ON:** real `appendEvent(cwd,{tool:'set_feature_status',code:'X',from:'A',to:'B'})` with a seeded enabled config → stub receives one ingest whose `content` equals `renderFeatureEventContent(writtenRow,tag)`. Same for `appendGateLogEntry`.
- **Flag OFF (byte-identity):** stub + a `fetch` spy; run `appendEvent`/`appendGateLogEntry` with **no** smartmemory block → assert (a) **zero** fetches, (b) the JSONL line written, when JSON-parsed, matches the pre-feature output on **every field except `ts`** — `appendEvent` stamps `ts: new Date().toISOString()` dynamically at call time (`lib/feature-events.js:52-53`; the module has no fixed-clock injection point), so a literal byte-identical golden-string comparison is not executable. Parse both sides and compare with `ts` excluded from the equality check (optionally assert `ts` matches an ISO-8601 shape), (c) return value unchanged (same field-set, `ts` excluded).
- Use `flushPending()`/`_resetEmitterState()` between cases to drain and reset the breaker.

---

## File Plan

| Path | Action | Notes |
|---|---|---|
| `lib/smartmemory-config.js` | new | §3.1 — leaf reader + `resolveProjectTag` (wraps `deriveId`) + `sourcePathFor` |
| `lib/smartmemory-client.js` | new | §3.2 — raw fetch client + `SmartmemoryHttpError` |
| `lib/smartmemory-ingest.js` | new | §3.3 — emitter, breaker, `flushPending`, shared pure renderers |
| `lib/smartmemory-sync.js` | new | §3.4 — 4-surface idempotent walker |
| `lib/feature-events.js` | edit | §4.1 — eager `getSmartmemoryConfig` import + post-append lazy emit |
| `server/gate-log-store.js` | edit | §4.2 — `getTargetRoot`+config imports + post-append lazy emit |
| `bin/compose.js` | edit | §8 T6 — `else if (cmd === 'smartmemory')` branch before l.3781 |
| `test/smartmemory-config.test.js` | new | §6 |
| `test/smartmemory-client.test.js` | new | §6 |
| `test/smartmemory-ingest.test.js` | new | §6 |
| `test/smartmemory-sync.test.js` | new | §6 golden |
| `test/smartmemory-hooks.test.js` | new | §6 byte-identity |

---

## Boundary Map

### S01: config + provenance
Produces:
  lib/smartmemory-config.js → getSmartmemoryConfig, resolveProjectTag, sourcePathFor (function)

Consumes: nothing (leaf node)

### S02: HTTP client
Produces:
  lib/smartmemory-client.js → createSmartmemoryClient (function)
  lib/smartmemory-client.js → SmartmemoryHttpError (class)

Consumes: nothing (leaf node)

### S03: live emitter + shared renderers
Produces:
  lib/smartmemory-ingest.js → emitFeatureEvent, emitGateLogEntry, flushPending (function)
  lib/smartmemory-ingest.js → renderFeatureEventContent, renderGateLogContent (function)
  lib/smartmemory-ingest.js → buildFeatureEventContext, buildGateLogContext (function)

Consumes:
  from S01: lib/smartmemory-config.js → getSmartmemoryConfig, resolveProjectTag, sourcePathFor
  from S02: lib/smartmemory-client.js → createSmartmemoryClient, SmartmemoryHttpError

### S04: emit hooks
Produces: nothing (integration only)

Consumes:
  from S01: lib/smartmemory-config.js → getSmartmemoryConfig
  from S03: lib/smartmemory-ingest.js → emitFeatureEvent, emitGateLogEntry

### S05: sync walker
Produces:
  lib/smartmemory-sync.js → runSync (function)

Consumes:
  from S01: lib/smartmemory-config.js → getSmartmemoryConfig, resolveProjectTag, sourcePathFor
  from S02: lib/smartmemory-client.js → createSmartmemoryClient
  from S03: lib/smartmemory-ingest.js → renderFeatureEventContent, renderGateLogContent, buildFeatureEventContext, buildGateLogContext

### S06: CLI verb
Produces: nothing (integration only)

Consumes:
  from S05: lib/smartmemory-sync.js → runSync


## 8. TDD task ordering

Each task: write the test first, watch it fail, implement to green, run the full suite before moving on. Dependencies are strictly S01 → S02 → S03 → {S04, S05} → S06.

- **T1 — config (S01).** `test/smartmemory-config.test.js` (new) → `lib/smartmemory-config.js` (new). No compose deps except `deriveId`. Gate: config test green.
- **T2 — client (S02).** `test/smartmemory-client.test.js` (new, node:http stub) → `lib/smartmemory-client.js` (new). During this task, confirm the live-service ingest response's unchanged/dedup field name against a running service if available; the classification in §3.2 stays tolerant regardless. Gate: client test green.
- **T3 — emitter + renderers (S03).** `test/smartmemory-ingest.test.js` (new) → `lib/smartmemory-ingest.js` (new). Depends T1, T2. Gate: ingest test green, render determinism asserted.
- **T4 — hooks (S04).** `test/smartmemory-hooks.test.js` (new) → edits `lib/feature-events.js` (existing) + `server/gate-log-store.js` (existing). Depends T3. **The byte-identity-when-OFF assertions live here and must pass before any further work.** Gate: hooks test green + full suite green (no regression to existing feature-events / gate-log tests).
- **T5 — sync walker (S05).** `test/smartmemory-sync.test.js` (new, golden) → `lib/smartmemory-sync.js` (new). Depends T1, T2, T3 (reuses the shared renderers). Gate: golden + re-sync-idempotent + filter + dry-run + 429 cases green.
- **T6 — CLI verb (S06).** Extend `test/smartmemory-sync.test.js` (or a small `test/smartmemory-cli.test.js`) → edit `bin/compose.js` (existing): add `} else if (cmd === 'smartmemory') {` before the unknown-command `else` at l.3781, mirroring the `gates` block (`bin/compose.js:3227`): `const sub = args[0]`; on `sub === 'sync'` parse `--dry-run` (flag) and `--feature <CODE>` (via the `flagVal` indexOf pattern at l.3241-3245), `await runSync({ cwd: getTargetRoot(), dryRun, feature })`, print the `ingested/unchanged/skipped/failed` report, `await flushPending()`, then `process.exit(0)`; unknown sub → usage + exit 1. Depends T5. Gate: CLI test green + full suite green.

Ship gate: full `npm test` green, byte-identity assertions (T4) green, golden re-sync all-`unchanged` (T5) green.

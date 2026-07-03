# COMP-SMARTMEMORY-RECALL: Design

**Status:** DESIGN — this is a pre-implementation design document, not shipped code. Review it as a design: judge decisions, contracts, and implementability, not missing implementation.
**Date:** 2026-07-03

## Related Documents

- Roadmap row: `ROADMAP.md` → "COMP-SMARTMEMORY: SmartMemory Coupling (opt-in)"
- Depends on: [COMP-SMARTMEMORY-INGEST](../COMP-SMARTMEMORY-INGEST/design.md) — shares its flag (`smartmemory.enabled`), config reader, and HTTP client
- Explorer findings baked in below: cockpit panel architecture map, SmartMemory API map (2026-07-03)

---

## Problem

When a user opens a feature in the cockpit, prior context about it — decisions, gate outcomes, journal mentions, related features — is scattered across JSONL logs and docs, discoverable only by linear reading. Once COMP-SMARTMEMORY-INGEST populates SmartMemory, that history is one relevance-ranked query away. This feature surfaces it in the cockpit, behind the same opt-in flag (default OFF).

## Goal

When `smartmemory.enabled === true` and a user selects a feature in the cockpit, a **Recall** tab in the feature's detail panel shows ranked prior context fetched from SmartMemory. When the flag is OFF, the tab does not exist and **no SmartMemory-bound traffic ever occurs**; the only OFF-path footprint is a single memoized probe per UI session to compose's *own* server (`/api/smartmemory/recall`), which answers `{enabled:false}` from config alone — no SmartMemory client is constructed, nothing leaves the machine.

**Backend note (confirmed with user 2026-07-03):** integration is HTTP-API-only against a FalkorDB-backed service deployment — the HTTP service cannot currently boot on Lite/SQLite storage (its tenancy layer requires a scope provider the SQLite backend rejects by design; see INGEST Decision 1b). Compose codes against the wire contract only, so a future single-tenant Lite service mode would work unchanged (with the spreading-activation channel degrading to the other hybrid channels there).

**Non-goals:** replacing the Attention Queue (recall sits beside it; the queue is derived client-side from live items+gates, a different signal); live-streaming updates; recall for the *actively-building* feature (`activeFeatureCode` — different concept from the user-clicked feature); reinforcement feedback (`POST /memory/feedback` — v2 candidate); passing explicit activation seeds (SmartMemory's HTTP surface has none — spreading activation is an internal channel of `POST /memory/search`, seeded from the query's initial matches).

### Corrections to the original roadmap-row assumptions (from exploration)

| Roadmap row said | Reality |
|---|---|
| "auto-issue an activation-based recall" (own endpoint) | Activation is a retrieval channel inside `POST /memory/search` (`channels.py:27`, `search.py:700`) — we call plain hybrid search; no seeds over HTTP |
| "when a feature folder opens" | Two "current feature" signals exist. The user-open event is `handleSelect` → `contextSelection` → `ContextItemDetail` (`src/App.jsx:727-737, 1374-1383`) — recall wires there, NOT to `activeFeatureCode` |
| "new cockpit panel" | No panel registry exists; panels are hand-wired JSX. The lower-risk integration is a new **tab** in `ContextItemDetail`'s `DetailTabs`, localized to the detail panel |
| flag can gate UI visibility | compose.json `capabilities` have **no UI-exposure channel** today. v1: the recall route itself returns `{enabled:false}` and the UI self-hides — zero new config plumbing |

---

## Decision 1: Server route — `GET /api/smartmemory/recall`, modeled on qa-scope

New `server/smartmemory-routes.js`, registered via `attachSmartmemoryRoutes(app, deps)` in `server/vision-server.js` `attach()` (the idiomatic registration point, lines 87-174). Contract:

```
GET /api/smartmemory/recall?featureCode=<CODE>
  flag OFF        → 200 {enabled:false}   (answered from config alone; no client constructed)
  ON, healthy     → 200 {enabled:true, available:true, featureCode, results:[{id, snippet, score, memoryType, ts, project}]}
                    (ts = ISO timestamp from context.event.ts / item temporal fields when present, else null;
                     project = context.project when present, else null — these feed Decision 3's rendering)
  ON, unreachable → 200 {enabled:true, available:false, error:"<short reason>"}
  ON, bad/missing featureCode → 200 {enabled:true, available:true, results:[], invalidFeatureCode:true}
                    (empty + marked, never 4xx/5xx; no SmartMemory query is issued)
```

- **Degrade-never-fail** (the `qa-scope-routes.js` model): the route never 500s; every failure mode is a shaped 200 so the panel renders a state instead of an error boundary.
- **Auth posture:** path `/api/smartmemory/recall` collides with no allowlisted prefix (`server/index.js:91-109`; prefix-matched at `auth-middleware.js:171-188`) and is deliberately left OFF the allowlist — in remote mode it is auth-gated like the vision routes, since results can contain local project context.
- Query construction: `<featureCode> <roadmap description>`, `top_k: 10`, defaults otherwise — hybrid search with activation channel does the ranking (`crud.py:1078`). The description comes from the **local feature.json read**, resolved through the configured features root (`resolveFeaturesPath` / the COMP-PATHS-EXTERNAL resolvers — NOT a helper that hardcodes `docs/features`, which would miss `paths.features` overrides), falling back to plain `featureCode` when absent — NEVER via `providerFor()`: in GitHub tracker mode the provider constructor probes GitHub repo access (`lib/tracker/factory.js:78`, `github-provider.js:26`), which would drag an unrelated auth/network dependency into a route that promises degrade-never-fail. Results map to snippet (content truncated ~280 chars), score, memory type, ts, project.
- Uses INGEST's `lib/smartmemory-client.js` `search()` and `lib/smartmemory-config.js` — no duplicate config/auth logic.

## Decision 2: UI — a "Recall" tab in ContextItemDetail, fetch-on-open

- Add `recall` to `DETAIL_TABS` in `src/components/cockpit/contextPanelState.js`, an icon in `DetailTabs.jsx` ICONS (lines 16-22), and a render branch + `RecallTab` component in `ContextItemDetail.jsx` (alongside lines 108-119).
- **Tab visibility requires a small API addition:** today the tab strip blindly renders every `DETAIL_TABS` entry (`DetailTabs.jsx:24,36`) — there is no filtered-tab mechanism. `DetailTabs` therefore gains a `tabs` prop (default `DETAIL_TABS`, so all existing call sites are untouched), and `ContextItemDetail` passes `DETAIL_TABS` filtered by recall availability. The Recall tab is **hidden until the probe confirms `enabled:true`** — hidden-by-default, never flashed-then-removed.
- **Feature items only:** `ContextItemDetail` is the generic detail view for *any* selected item (`App.jsx:1374-1382`), and the canonical feature code resolution (`ContextItemDetail.jsx:40`) can come up empty. The Recall tab is gated on **both** `enabled:true` **and** a resolvable feature code — non-feature items never grow a Recall tab (not even an empty-state one), and no recall fetch fires for them.
- **Active-tab reset rule:** `activeDetailTab` lives in component state across `itemId` changes (`ContextItemDetail.jsx:37`), so switching from a feature (Recall tab active) to an item where Recall is hidden could strand the panel on a hidden tab. Rule: whenever the visible-tab set is computed and the active tab is not in it, reset to `overview`. This is generic (covers any future conditional tab), asserted by a UI test.
- **Probe is memoized per workspace:** the `{enabled}` bit is cached keyed on the current workspace identity (compose supports in-app workspace switches without a reload — `src/contexts/WorkspaceContext.jsx`, `App.jsx:565-580`), and the cache entry is invalidated on workspace switch. Flag-OFF workspaces pay at most one lightweight local request per workspace per page load, not one per detail-open, and a switch to a workspace with a different `smartmemory.enabled` re-probes. (The ranked-results fetch, by contrast, runs per feature open — that's the point of it.)
- **Fetch-on-open, no streaming:** recall is a point-in-time ranked query. Mirror `ContextFilesTab` — `wsFetch` keyed on the canonical feature code, `AbortController` on code change/unmount. If live refresh is ever wanted, re-query on the existing `buildState` WS message rather than adding a stream.
- **Self-hiding:** the recall response doubles as the visibility probe. `{enabled:false}` ⇒ tab stays hidden. `{enabled:true}` ⇒ tab appears for feature items; `{available:false}` ⇒ tab renders a quiet "SmartMemory unreachable" state. This is the v1 answer to the missing capabilities-to-UI channel; if a `/api/config` exposure ever ships, the tab can gate on it instead.
- States: loading skeleton → ranked list (snippet, score bar, memory-type badge) → empty ("no prior context") → unreachable.

## Decision 3: Rendering ranked items — provenance-first

Each result row shows the snippet, relative time when the ingested event carried one, and the `context.project` badge when it differs from the current project (cross-project results are possible when one API key serves several projects — INGEST Decision 6). No links into SmartMemory itself in v1 (no stable per-item URL surface to link to).

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `server/smartmemory-routes.js` | new | `attachSmartmemoryRoutes` — the recall route, degrade-never-fail |
| `server/vision-server.js` | existing | One `attachSmartmemoryRoutes(app, deps)` registration line |
| `src/components/cockpit/contextPanelState.js` | existing | `recall` entry in `DETAIL_TABS` |
| `src/components/cockpit/DetailTabs.jsx` | existing | Icon map entry; new `tabs` prop (default `DETAIL_TABS` — existing call sites untouched) |
| `src/components/cockpit/ContextItemDetail.jsx` | existing | Mount-time enabled probe; filtered `tabs` pass-down; `RecallTab` render branch |
| `src/components/cockpit/RecallTab.jsx` | new | Fetch-on-open tab body; loading/results/empty/unreachable states |
| `test/smartmemory-recall-route.test.js` | new | Route contract: OFF / ON+healthy / ON+down / missing code (stubbed client) |
| `test/ui/smartmemory-recall.test.jsx` | new | Vitest+jsdom: tab hidden when disabled; loading→results; empty; unreachable (mock fetch, mirror `open-loops-panel.test.jsx`; localStorage polyfill via `test/ui/setup.js`) |

## Testing

- **Route tests** stub `lib/smartmemory-client.js`, assert the four contract shapes, that flag-OFF issues zero client calls, and that an invalid/missing featureCode issues no SmartMemory query.
- **UI tests** in Vitest+jsdom (NO Playwright in this repo's runners): tab absent on `{enabled:false}`; tab absent for items with no resolvable feature code even when enabled; ranked rows render with scores; abort on feature switch; probe memoization (second detail-open issues no second probe when disabled).
- **Byte-identity when OFF:** vision-server attaches the route unconditionally, but with the flag OFF it answers `{enabled:false}` from config alone — no client construction, no fetch, no log. UI renders identically to today (tab list unchanged).

## Open Questions

None blocking. v2 candidates: `POST /memory/feedback` reinforcement when a user acts on a recalled item; `channel_weights` tuning; exposure of the flag via a real `/api/config` channel.

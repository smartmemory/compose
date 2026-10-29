# COMPOSE-APP-INTEGRATION-1: apps in Compose (the wiki first)

**Status:** DESIGN (2026-10-29). Owner ask via s1-chat: "figure out integration for the smartmemory wiki
app into compose, generalized to other apps not just smartmemory". Contract:
[`app-provider-contract.json`](app-provider-contract.json). Report:
`smart-memory-ops/units/COMPOSE-APP-INTEGRATION-1/report.md`. Siblings: COMPOSE-UI-INTEGRATION-1
(read model, not yet written at time of this design), COMPOSE-UI-AUDIT-1, COMPOSE-UI-STEAL-1.
Prior art: [COMP-SMARTMEMORY-RECALL](../COMP-SMARTMEMORY-RECALL/design.md),
[COMP-ROADMAP-PROVIDERS](../COMP-ROADMAP-PROVIDERS/feature.json),
[roadmap planning model](../../plans/2026-06-21-roadmap-planning-model-design.md).

## Plain English

Compose gets an **Apps** shelf. An app (the wiki, SmartMemory, PostHog) plugs in by filling one
form: who it is, what it can do (search, "what do you have about this feature", take in our docs,
"are you up", a few safe buttons), how to reach it, and the *name* of the env var holding its key.
Compose never stores the key. Open a feature in the cockpit and an **Apps** tab shows, per app,
the pages it knows about that feature plus a search box. An app that cannot do something simply
does not show that part; nothing is faked. The wiki is app #1 and needs **no code change**: it
already answers "search" and "docs for feature X" over HTTP.

## 1. Inventory (inventory-before-inventing)

| Surface | Where | Selection | Fit for apps |
|---|---|---|---|
| TrackerProvider | `lib/tracker/provider.js:15-40`, `factory.js:72-93` | one active (`tracker.provider`) | No: it OWNS canon (features, roadmap); apps never do |
| FluidProvider | `lib/fluid/provider.js:35-53`, `factory.js:1-19` | one active (`fluid.provider`) | Reuse its rule: capabilities declared, absent = visibly absent (`PROVIDER-SEAM`) |
| SmartMemory coupling | `lib/smartmemory-config.js:94`, `server/smartmemory-routes.js:1-60`, `src/components/cockpit/RecallTab.jsx` | `smartmemory.enabled` block | The pattern we generalize: env-NAME auth, shaped-200 route, self-hiding tab |
| Maya coupling | `server/maya-routes.js:1-25`, `lib/maya-config.js` | presence of `maya` block | Same pattern, second hand-wired copy |
| xref links | `contracts/feature-json.schema.json:88-110`, `lib/xref-citation.js:29` | closed enum `github..obsidian` | Inert pointers; app hits are live, not persisted |
| Port ladder | planning-model design `:28-50` (REFERENCE/DRIVE/SYNC/SUBSUME) | PLANNED, none built | Apps sit at REFERENCE (+ pull-INGEST); not a canon port |
| MCP client | `lib/stratum-mcp-client.js:22,523-540` (stdio, inherits env) | Stratum only | Reuse the transport; do NOT inherit the whole env for third parties |
| Compose MCP server | `server/mcp-tool-defs.js` (51 tools), `server/compose-mcp.js:116` | n/a | Add 2 read-only tools (`app_search`, `app_links`) |
| Detail tabs | `src/components/cockpit/contextPanelState.js:68-75`, `ContextItemDetail.jsx:55-64,156` | filtered list | Add one `apps` tab, gated like `recall` |

**Wiki surfaces** (`smart-memory-wiki`): HTTP only, no MCP (grep `mcp` in `wiki/` returns only
config source rows). Mac host `127.0.0.1:8791` (`port_check.py 8791`: registered `smWiki`, listening),
every call needs header `x-wiki-owner-token` (`deploy/mac/README.md:3-5`). Routes
(`wiki/spine/api/app.py:227-291`): `GET /identity`, `GET /health`, `POST /query/{name}`,
`GET /feeds/{name}`, `GET /sources`; `GET /pages/{page}` (`api/pages.py:134`); write commands at
`POST /commands/{command}` (`api/commands.py:58`). Named queries (`wiki/contracts/query.schema.json`
`x-named-queries`): `search` (`filters.q` 1-256 chars), `feature_hub` (`filters.feature_id`, kinds
design/plan/report/decision/...), plus `features_table`, `ledger`, `decisions`, `graph`, 7 more.
Workspaces: `wiki-eng`, `wiki-gtm`, `wiki-private`. Ingestion is pull: source bindings in
`config/wiki.{mac,us1}.yaml` (`src_git`, `src_local_fs`); a deterministic rule classifier maps
`features/<ID>/` or `units/<ID>/` to `feature_ids` (`plugins/classifier_rules/classifier.py:8-12`).
**Forge is not a wiki source today** (grep `forge|compose` in both configs: no rows); `smart-memory-ops`
is (`wiki.us1.yaml:80-93`). The wiki's own plugin manifests already declare `capabilities` and
`credential_refs` by name (`plugins/query_search/manifest.yaml`); the app contract borrows that shape.

**Why a new registry, not an existing one:** Tracker and Fluid are single-select seams that back
canon storage. Apps are many-at-once, read-mostly and never canon: a different axis. The new
registry reuses their config conventions (absent = off; malformed = loud) and Fluid's no-faking rule.

## 2. The wiki in the cockpit

Adapter sits in the **Compose server** (`lib/apps/adapters/wiki-http.js`, new); the browser never
talks to an app. Wiki changes: none for W1-W3.

| # | Capability | Flow | Changes | Size |
|---|---|---|---|---|
| W1 | Wiki docs for a feature | cockpit Apps tab → `GET /api/apps/wiki/links?feature=CODE` → adapter `POST /query/feature_hub {workspace:"wiki-eng", filters:{feature_id:CODE}}` → AppHit[] grouped by kind | Compose: route, adapter, tab. Wiki: none | S |
| W2 | Search the wiki from a feature | search box (prefilled `CODE` + feature title) → `/api/apps/wiki/search` → `POST /query/search {filters:{q}}` | same route file | S |
| W3 | Agents ask the wiki | Compose MCP tools `app_search`/`app_links` → same adapter → agents in design/blueprint phases | Compose: 2 tool defs + policy row | S |
| W4 | Compose artifacts into the wiki | wiki **pulls**: one new `src_git` binding on forge `docs/` (features, design, plans, journal) in `wiki-eng`. Classifier files `docs/features/COMP-X/` under `COMP-X`, so W1 lights up for Compose codes | Wiki: config rows only, wiki lane. Compose: none | S |
| W5 | "What the wiki knows" at design time | `compose build` Phase 1 calls `app_links(CODE)` + `app_search(description)`, top 5 titles+snippets into the explorer brief | Compose: step-prompt hook, opt-in | M |

Ledger and unit reports already reach the wiki via `eng-ops`; W4 adds only forge. Compose never
pushes to the wiki in v1 (no wiki write API to use but `/commands`, which is owner-authority).

## 3. The App Provider contract (generalization)

One declaration per app in `.compose/compose.json` `apps[]` (schema: `#/$defs/appDeclaration`):

- **Identity:** `id`, `label`, `homepage` (optional deep-link base).
- **Capabilities** (declared subset): `SEARCH`, `LINKS` (things about one feature), `INGEST`
  (status only: `pull` = app reads paths we name, `push` = Compose sends events), `HEALTH`, `ACTIONS`
  (read-only deep links in v1). Undeclared = absent: no tab section, `capability_unavailable` from
  the route, never an empty "no results" (PROVIDER-SEAM).
- **Transport:** `mcp-stdio` (preferred for third-party apps that ship one), `mcp-http`, `http`,
  `cli`, `files`. `adapter` names a module from a **closed in-repo map** (`lib/apps/adapters/index.js`);
  no config-supplied code paths. `mcp-generic` maps capabilities to tool names plus a field map.
- **Auth:** `none | header | bearer | delegated`. Only env var **names** (`^[A-Z][A-Z0-9_]*$`); keys
  like `token`/`secret`/`password`/`apiKey` are rejected by the schema. `delegated` = the app's own
  MCP server holds its credentials; Compose passes it only the env names in `envAllowlist`.
- **Scope:** `workspaces` allowlist (wiki: `["wiki-eng"]`; `wiki-private` is refused by the adapter
  whatever the config says), `maxResults`, `timeoutMs`, `pathAllowlist` (HTTP adapters call only
  listed routes; the wiki adapter never calls `/commands`).
- **Lifecycle:** register (`compose apps add`, writes the block), validate at load (a bad block
  disables *that* app with a warning; others keep working), health (`GET /api/apps`, cached 60 s),
  disable (`enabled:false` = zero traffic, the SmartMemory flag rule), remove.
- **Wire shape:** every call returns `{ok:true,data}` or `{ok:false,error:{kind,retryable}}`;
  routes answer shaped 200s (the `smartmemory-routes.js` degrade-never-fail model).
- **Read model:** each answer is also a `readModelRecord` (`provider.kind:"app"`) so the
  COMPOSE-UI-INTEGRATION-1 read model can hold it beside Stratum and Cadence records. Until that
  contract lands, the Apps tab reads the route directly; unit A6 switches it.

**Three implementations prove it is not wiki-shaped:**

| App | Transport / auth | Caps | Mapping |
|---|---|---|---|
| wiki (#1) | `http` `127.0.0.1:8791`, `header x-wiki-owner-token` from env `WIKI_OWNER_TOKEN` | SEARCH, LINKS, HEALTH, INGEST pull, ACTIONS (open page) | `query/search`, `query/feature_hub`, `/health` |
| SmartMemory service (#2) | `http` via `lib/smartmemory-client.js` (or `mcp-stdio` smart-memory-mcp), `bearer` env `COMPOSE_SM_KEY` | SEARCH, HEALTH, INGEST **push** | `memory_search`; the existing Recall tab and COMP-SMARTMEMORY-INGEST become this provider |
| PostHog read-only (#3) | `mcp-stdio`, `delegated` (`envAllowlist:[POSTHOG_PERSONAL_API_KEY]`, name unverified) | LINKS, HEALTH, ACTIONS | LINKS = feature flags/experiments whose key contains the feature code; no SEARCH declared |

Stripe read-only fits the same way (LINKS = products/prices with `metadata.feature`), not sketched.

## 4. Units (no dates; pace from `estimate.py`)

1. **COMPOSE-APP-WIKI-TAB-1** (S/M, visible): `apps[]` reader, wiki HTTP adapter (W1+W2),
   `/api/apps/:id/{links,search}`, cockpit **Apps** tab on the feature panel, wiki-eng only.
2. **WIKI-SOURCE-FORGE-1** (S, wiki lane, config only): forge `docs/` as a `wiki-eng` git source (W4).
3. **COMPOSE-APP-REGISTRY-1** (M): schema validation from the contract, adapter map, health cache,
   `GET /api/apps`, Settings > Apps list, `compose apps list|check|add`.
4. **COMPOSE-APP-MCP-TOOLS-1** (S): `app_search`, `app_links` MCP tools, read-only policy rows (W3).
5. **COMPOSE-APP-SM-REHOME-1** (M): SmartMemory as provider #2; Recall becomes an Apps section;
   old route kept as an alias for one release.
6. **COMPOSE-APP-READMODEL-1** (S): emit `readModelRecord`s into the COMPOSE-UI-INTEGRATION-1 read
   model; the tab reads the read model.
7. **COMPOSE-APP-MCP-GENERIC-1** (M): `mcp-generic` adapter (tool + field map, env allowlist) with
   PostHog read-only as provider #3.
8. **COMPOSE-APP-DESIGN-CONTEXT-1** (M, opt-in, owner question first): W5.

## 5. Prior shape decisions

- **Spine fit:** Compose UI shell + one read model + subsystem provider plugins. Apps are one more
  provider kind (`app`) feeding the read model; no second UI, no app-side UI embedded. Fits.
- **COMP-ROADMAP-PROVIDERS / planning model** (`plans/2026-06-21-...:28,50`): "core lifecycle never
  imports a vendor SDK", providers opt-in, depth ladder. Kept: adapters are leaves, apps are REFERENCE
  depth. Deviation: not one of its named ports (Tracker/Document/Design/BuildTarget), because apps
  are many-at-once read sources, not alternative homes for canon. The 2026-07-19 tracker design
  supersedes the ladder for the tracker seam only (`plans/...:11`; its §3.4 not read: unverified).
- **PROVIDER-SEAM** (`lib/fluid/factory.js:1-19`): adopted verbatim for capability absence.
- **FORGE-NEXT-SHAPE-1** (`docs/features/FORGE-NEXT-SHAPE-1/shapes.md:3-7`, owner pick Shape B,
  the evidence loop): this work is off that spine (cockpit, owner-asked). It neither feeds nor blocks
  B; it should not take B's slots without an owner priority call.
- Grep run 2026-10-29: `app[- ]provider|AppProvider|app registry` over forge, compose and stratum
  docs: zero hits. `connector` hits (COMP-TRIAGE-6, COMP-MODEL-ROUTE-1, COMP-CONSENSUS-4,
  STRAT-HERMES-CONNECTOR) are all *agent* dispatch connectors, a different axis. 38 compose
  `design.md` files mention `registry|adapter`; the relevant ones are in the table in section 1.

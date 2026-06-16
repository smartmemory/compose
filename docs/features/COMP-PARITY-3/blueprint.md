# COMP-PARITY-3 — Implementation Blueprint

**Status:** Phase 4 (Blueprint) — gate pending. Verified against codebase 2026-06-16.
**Design:** `/Users/ruze/reg/my/forge/compose/docs/features/COMP-PARITY-3/design.md`

## Overview

Surface `compose doctor` (deps + version drift) and `compose hooks status` (git-hook drift) in the cockpit:
1. Extract the inline CLI hook-status logic into a shared, pure module.
2. Add a thin, read-only `GET /api/environment-health` endpoint reusing the dep/version/hook logic.
3. Add a header health-dot + popover that fetches it.

All file:line references below were read from disk during blueprinting (re-verified in Phase 5).

## File Plan

| File | New/Existing | Work |
|---|---|---|
| `lib/hooks-status.js` | **new** | Pure `computeHooksStatus()` + `HOOK_MARKERS` + CLI/API mappers |
| `bin/compose.js` | existing | `statusOne` delegates to `computeHooksStatus` + CLI mapper; `HOOK_TYPES.marker` sourced from `HOOK_MARKERS`. Output byte-identical. |
| `server/health-routes.js` | **new** | `attachHealthRoutes(app, deps)` → `GET /api/environment-health` |
| `server/vision-server.js` | existing | wire `attachHealthRoutes` in `attach()` |
| `src/components/cockpit/EnvironmentHealthPanel.jsx` | **new** | header dot + popover; fetch + render |
| `src/App.jsx` | existing | mount `<EnvironmentHealthPanel />` in header controls |
| `test/hooks-status.test.js` | **new** | node `--test` unit tests for `computeHooksStatus` states (runs under `npm test`) |
| `test/hooks-status-cli.test.js` | **new** | node `--test` golden: `compose hooks status` output byte-identical pre/post refactor |
| `test/integration/health-routes.test.js` | **new** | node `--test` real-endpoint smoke + degrade + rollup against a temp `.git`/workspace fixture |
| `test/ui/env-health-panel.test.jsx` | **new** | Vitest jsdom component test (dot color, popover sections, refetch) — runs under `npm run test:ui` |

## Verified Reference Facts

### lib/deps.js (import as-is)
- `loadDeps(packageRoot)` — L23. Returns manifest `{...raw, external_skills, external_binaries}` or `null`.
- `checkExternalSkills(deps, home=homedir())` — L96 → `{present[], missing[], scannedPaths[]}`.
- `buildDepReport(result)` — L204 → `{present: ProjectDep[], missing: ProjectDep[], scannedPaths[]}`; `ProjectDep = {id, required_for, install, fallback, optional}`.
- `checkExternalBinaries(deps, opts={})` — L230. Default probe is `spawnSync(detect, {timeout:3000})`; **injectable `opts.probe(detect)=>bool`**. Returns `{present[], missing[]}`.
- `buildBinaryReport(result)` — L252 → `{present: ProjectBin[], missing: ProjectBin[]}`; `ProjectBin = {id, detect, install, recommend, optional}`.

### lib/version-check.js (import as-is)
- `checkLatestVersion(currentVersion, {force=false}={})` — L92. **async**, returns `{current, latest, behind, source:'cache'|'network'}` or `null`. Never throws. Cache `~/.compose/version-cache.json` (24h TTL); network timeout 3000ms.

### bin/compose.js (refactor)
- Imports (L86-87): `{loadDeps, checkExternalSkills, printDepReport, buildDepReport, checkExternalBinaries, printBinaryReport, buildBinaryReport}` from `../lib/deps.js`; `{checkLatestVersion}` from `../lib/version-check.js`. `{resolveWorkspace, getWorkspaceFlag}` from `../lib/resolve-workspace.js`.
- `composeBin` (L1611) `= presolve(presolve(futp(import.meta.url),'..'),'compose.js')` → `compose/bin/compose.js`. `composeNode` (L1612) `= process.execPath`.
- `HOOK_TYPES` (L1615-1626): per type `{template, marker, dest}`. Markers: `'# Compose post-commit hook —'`, `'# Compose pre-push hook —'`. `dest = join(hooksDir, type)`; `hooksDir = join(projectRoot,'.git','hooks')` (L1606).
- `extractBakedWorkspaceId(content)` (L1692) — regex `/^COMPOSE_WORKSPACE_ID="([^"]*)"$/m`.
- `statusOne(type)` (L1697-1734) — current logic + exact printed strings (preserve verbatim).

### server (wiring)
- `server/workspace-middleware.js`: `EXEMPT_PATHS` (L30-34, exact-match `.has`) = `{/api/workspace, /api/project/switch, /api/health}`. `/api/environment-health` is **non-exempt** → header present: `req.workspace = resolveWorkspace(...)` (L63-67, has `{id, root, source}`); header absent + `allowGetFallback=true` (the mounted default, `index.js:146`): `req.workspace = {id:null, root:getTargetRoot(), source:'fallback'}` (L56), **never 400**.
- `server/vision-server.js` `attach()`: route factories called L83-235; `attachSettingsRoutes(app, {settingsStore, broadcastMessage})` at L83-86. **Insert `attachHealthRoutes(app, {})` at ~L87** (after settings).
- `server/project-root.js`: `getTargetRoot()` (L47) → absolute workspace root.
- `server/settings-routes.js` — route-module template (factory `export function attach…(app, deps){ app.get(...) }`).
- **PACKAGE_ROOT in server**: `path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')` from `server/health-routes.js` = `compose/` (pattern used by `project-root.js:22`, `supervisor.js:22`). `composeBin = join(PACKAGE_ROOT,'bin','compose.js')` — matches the CLI-baked value exactly.

### src (cockpit)
- `src/App.jsx` header L1080-1161; controls block `<div className="flex items-center gap-2 shrink-0">` (~L1103); insert dot **before** the pair-device button (~L1112).
- `handleProjectSwitch` (L550-571) calls `refreshWorkspace()` then sets `projectRoot`/`projectName`. Workspace change observable via `useWorkspace()` context (`workspace.id` changes).
- `src/contexts/WorkspaceContext.jsx`: `useWorkspace()` → `{loading, error, workspace:{id, root, source}|null, refresh}`. Resolved when `!loading && workspace`. `workspace.id` is the id.
- `src/lib/wsFetch.js`: `wsFetch(url, opts)` (L58) auto-injects `X-Compose-Workspace-Id` (L68) + token; relative paths OK.
- Popover pattern: `src/components/ProjectSwitchPopover.jsx` — manual absolute panel (`absolute top-full … z-50`), outside-click + Esc close, `role="dialog"`. Reuse this pattern (custom sectioned content, not a menu).
- Status color tokens (`src/index.css`): `hsl(var(--success))` green, `hsl(var(--warning))` amber, `hsl(var(--destructive))` red. Popover bg `hsl(var(--popover))`, border `hsl(var(--border))`.
- Fetch+render template: `src/components/cockpit/OpsStrip.jsx` L32-54 (effect-driven fetch, ref-guarded, `.catch(()=>{})`).
- `data-testid` convention: kebab-case `{region}-{element}` / templated for rows.

## Corrections Table (spec assumption vs. verified reality)

| Design assumption | Reality | Resolution |
|---|---|---|
| Endpoint "nests semantically under health" | `/api/health` is allowlisted **and** prefix-matched (auth-middleware.js:180-189) AND exact-exempt in workspace-middleware | Use `/api/environment-health` (non-allowlisted, non-exempt). Confirmed it gets header-resolved `req.workspace`. ✅ already in design. |
| `req.workspace` may be `exempt` fallback for this route | Non-exempt → header-resolved; no-header GET → `{id:null,…,'fallback'}`, never 400 | Read `req.workspace.id`/`.root` directly; null id → `workspace-unverified`. |
| `computeHooksStatus` returns presentation-ready states | CLI must stay byte-identical, but API needs the honest `workspace-unverified` distinction the CLI hides | `computeHooksStatus` returns **raw facts** (+ `wsVerified` flag); CLI mapper reproduces current output, API mapper derives `workspace-unverified`. (contract below) |
| `composeBin` derivation server-side unknown | `join(PACKAGE_ROOT,'bin','compose.js')`, PACKAGE_ROOT = `resolve(__dirname,'..')` | matches CLI-baked value; pinned. |
| `checkExternalBinaries` may block | default probe `spawnSync` 3s each | acceptable for read-only; document. Optional binaries only (`rtk`), so ≤1 probe. |

## Contracts

### `computeHooksStatus({ projectRoot, expectedWsId, composeNode, composeBin })` → object

Pure. Reads `<projectRoot>/.git/hooks/<type>` for each `type ∈ ['post-commit','pre-push']`. Returns:

```js
{
  'post-commit': {
    state: 'absent' | 'foreign' | 'installed-current' | 'installed-stale',
    reason: null | 'MISSING_WORKSPACE_ID' | 'STALE_WORKSPACE_ID' | 'stale paths',
    bakedWorkspace: string | null,   // extractBakedWorkspaceId(content)
    expectedWorkspace: string | null,// = expectedWsId
    wsVerified: boolean,             // false when expectedWsId == null (could not verify)
    nodeMatch: boolean,              // content includes COMPOSE_NODE="<composeNode>"
    binMatch: boolean,               // content includes COMPOSE_BIN="<composeBin>"
  },
  'pre-push': { ...same shape }
}
```

State derivation (mirrors L1697-1734 exactly; the ONLY new thing is the `wsVerified` flag — it does **not** change `state`, so the CLI is unaffected):
- file absent → `state:'absent'`.
- file present, marker absent → `state:'foreign'`.
- installed: `hasRawToken = content.includes('__COMPOSE_WORKSPACE_ID__')`; `wsMatch = hasRawToken ? false : expectedWsId ? content.includes('COMPOSE_WORKSPACE_ID="'+expectedWsId+'"') : true`.
  - if `nodeMatch && binMatch && wsMatch && !hasRawToken` → `state:'installed-current'`, `reason:null`, `wsVerified = expectedWsId != null`.
  - else → `state:'installed-stale'`, `reason = hasRawToken ? 'MISSING_WORKSPACE_ID' : (expectedWsId && !wsMatch) ? 'STALE_WORKSPACE_ID' : 'stale paths'`.

Also export `HOOK_MARKERS = {'post-commit': '# Compose post-commit hook —', 'pre-push': '# Compose pre-push hook —'}` so `bin/compose.js` `HOOK_TYPES[type].marker` references it (single source of truth; no duplicated strings).

### CLI mapper (in `bin/compose.js`, replaces `statusOne` body)
Given the raw object, print **exactly** today's lines:
- `absent` → `${type}: absent — no hook installed`
- `foreign` → `${type}: foreign — hook exists but is not a Compose hook`
- `installed-current` → `${type}: installed (current)` + if `bakedWorkspace` then `  workspace: ${bakedWorkspace}`
- `installed-stale` → `${type}: installed (${reason} — re-run install)` + conditional `expected …` lines using `expectedWorkspace`/`composeNode`/`composeBin` and `nodeMatch`/`binMatch` (same conditions as L1730-1732).
`expectedWsId` is computed once (hoisted) from `hookFlags['workspace']` via `resolveWorkspace` exactly as today, then passed to `computeHooksStatus`. **CLI output is byte-identical** (golden test asserts this).

### API mapper (in `server/health-routes.js`)
Maps raw → API `HookStatus`:
- `installed-current` && `!wsVerified` → `{state:'workspace-unverified'}`
- `installed-current` && `wsVerified` → `{state:'installed-current', workspace: bakedWorkspace}`
- `installed-stale` → `{state:'installed-stale', reason, expected:{workspaceId?:expectedWorkspace}}`
- `absent` / `foreign` → `{state}`

### `GET /api/environment-health` response (200)
```jsonc
{
  "summary": "ok" | "warn" | "error",          // worst-wins per the design's state→summary table
  "dependencies": { "present": [...], "missing": [...] } | { "unavailable": true },
  "binaries":     { "present": [...], "missing": [...] } | { "unavailable": true },
  "version":      { "current","latest","behind","source" } | null,
  "hooks":        { "post-commit": HookStatus, "pre-push": HookStatus }
}
```
- **`loadDeps` returns `null` on failure (it does NOT throw)** — so the handler must branch explicitly: `const deps = loadDeps(PACKAGE_ROOT); if (!deps) { dependencies = {unavailable:true}; binaries = {unavailable:true}; }` **before** calling `checkExternalSkills`/`checkExternalBinaries` (calling them with `null` would throw or yield a misleading empty report). When `deps` is present, each checker still runs in its own try/catch → `{unavailable:true}` on throw.
- Version: `checkLatestVersion` never throws (returns `null`); still wrapped defensively. A thrown section becomes `{unavailable:true}` (deps/binaries) or `null` (version). Endpoint never 500s on a sub-check; it 500s only on a programming error.
- `summary` rollup (per design table, worst-wins): **error** if any required dep/binary missing OR any hook `foreign`; **warn** if version `behind` OR any hook `installed-stale`/`workspace-unverified` OR any optional dep/binary missing OR a section is `unavailable`; else **ok**. `version:null` and hook `absent` are neutral (→ ok).
- Reads: deps/binaries/version off `PACKAGE_ROOT`; hooks off `req.workspace.root` with `expectedWsId = req.workspace.id`. `?refresh=1` → `checkLatestVersion(current, {force:true})`; default cache-first.

## EnvironmentHealthPanel.jsx (component contract)
- `useWorkspace()` for `{loading, workspace}`. Local state `data`, `loadingHealth`, `error`, `open`.
- Fetch effect: when `!loading && workspace` resolved, `wsFetch('/api/environment-health')`; **deps `[workspace?.id, workspace?.root]`** (NOT id alone — two switch targets can share a basename-derived workspace id while differing by root, `workspace-routes.js`/`project-root.js` don't enforce id uniqueness, so keying on id alone would keep stale health data after such a switch). Not gated on `open` (the dot needs data without opening). `.catch` → `error`, never throws.
- Manual ↻ button → refetch with `?refresh=1`.
- Dot: `summary` → color (`error`→destructive, `warn`→warning, `ok`→success); grey while loading/no-data. `data-testid="env-health-dot"`, the button toggles `open`.
- Popover (ProjectSwitchPopover pattern): sections Dependencies (present/missing skills+binaries), Version (current→latest, behind), Git Hooks (per-type state + reason). Outside-click + Esc close. testids: `env-health-panel`, `env-health-dependency-<id>`, `env-health-binary-<id>`, `env-health-version`, `env-health-hook-<type>`, `env-health-refresh`.
- Mounted in `src/App.jsx` header controls before the pair-device button. Mobile (`src/mobile/`) untouched.

## Test Plan (Phase 7)

Test placement matches the repo's actual runners (verified against `package.json`/`vitest.config.js`): `npm test` runs `test/*.test.js` + `test/integration/*.test.js` (node `--test`) then `npm run test:ui` (Vitest, `test/ui/**/*.test.{js,jsx}`). **There is no Playwright in this repo** — so the Phase 7 "E2E smoke" is satisfied by the integration test (real endpoint) + the Vitest jsdom component test, not a `.spec.js` browser run.

- `test/hooks-status.test.js` (node): each state — absent, foreign, installed-current with `wsVerified` true/false, installed-stale × {MISSING_WORKSPACE_ID, STALE_WORKSPACE_ID, stale paths} — via temp `.git/hooks` fixtures.
- `test/hooks-status-cli.test.js` (node) — **CLI golden**: capture current `compose hooks status` output as a fixture FIRST (before refactor), then assert byte-identical output after.
- `test/integration/health-routes.test.js` (node) — **real-endpoint golden flow**: build the Express app, hit `GET /api/environment-health` against a temp workspace with a real `.git/hooks` fixture; assert full shape; degrade paths (`loadDeps`→null ⇒ both dep sections `unavailable`; `checkLatestVersion`→null ⇒ version null, summary unaffected); summary rollup table cases; `?refresh=1` forces `{force:true}`; null `req.workspace.id` ⇒ hooks `workspace-unverified`. (Real backend per testing rules — no mocked deps.)
- `test/ui/env-health-panel.test.jsx` (Vitest jsdom): mount with `wsFetch` mocked; dot color per `summary`; click opens popover; sections render; ↻ triggers refetch; refetch fires when `workspace.root` changes.

## Boundary Map

Producers/consumers across the work units (every entry names a concrete symbol):

- **`computeHooksStatus`** — `function` — produced by S1 (`lib/hooks-status.js`). Consumed by `bin/compose.js` (S2) and `server/health-routes.js` (S3).
- **`HOOK_MARKERS`** — `const` — produced by S1 (`lib/hooks-status.js`). Consumed by `bin/compose.js` `HOOK_TYPES` (S2).
- **`attachHealthRoutes`** — `function` — produced by S3 (`server/health-routes.js`). Consumed by `server/vision-server.js` `attach()` (S4).
- **`GET /api/environment-health`** (endpoint, prose) — produced by S3. Consumed by `EnvironmentHealthPanel` via `wsFetch` (S5).
- **`EnvironmentHealthPanel`** — `component` — produced by S5 (`src/components/cockpit/EnvironmentHealthPanel.jsx`). Consumed (mounted) by `src/App.jsx` header (S6).
- **`getTargetRoot`** — `function` — existing (`server/project-root.js`), untouched dependency consumed by S3.
- **`useWorkspace`** — `hook` — existing (`src/contexts/WorkspaceContext.jsx`), untouched dependency consumed by S5.
- **`wsFetch`** — `function` — existing (`src/lib/wsFetch.js`), untouched dependency consumed by S5.

### Slice topology
- **S1** `lib/hooks-status.js` (`computeHooksStatus`, `HOOK_MARKERS`) — no intra-feature deps.
- **S2** `bin/compose.js` refactor — `from S1`.
- **S3** `server/health-routes.js` (`attachHealthRoutes`, API mapper, summary rollup) — `from S1`.
- **S4** `server/vision-server.js` wiring — `from S3`.
- **S5** `EnvironmentHealthPanel.jsx` — `from S3` (endpoint contract).
- **S6** `src/App.jsx` mount — `from S5`.

Every `from S##` references an earlier slice. No cycles.

## Phase 5 — Verification Table

Every file:line reference re-read from disk on 2026-06-16; Boundary Map run through `validateBoundaryMap`.

| Reference | Claim | Verified |
|---|---|---|
| `lib/deps.js:23,96,204,230,252` | loadDeps / checkExternalSkills / buildDepReport / checkExternalBinaries / buildBinaryReport exports | ✅ exact lines |
| `lib/version-check.js:65,92` | compareVersions; `async checkLatestVersion(current,{force})` | ✅ exact lines |
| `bin/compose.js:18,86,87` | imports of resolve-workspace / deps / version-check | ✅ |
| `bin/compose.js:1611,1612,1692,1697` | composeBin, composeNode, extractBakedWorkspaceId, statusOne | ✅ exact lines |
| `server/vision-server.js:29,83` | attachSettingsRoutes import + call (insertion anchor) | ✅ |
| `server/project-root.js:47` | `getTargetRoot()` export | ✅ |
| `server/workspace-middleware.js:30-34,46-67` | EXEMPT_PATHS exact-match; non-exempt header-resolve; no-header fallback `{id:null}` (never 400) | ✅ full file read |
| `src/contexts/WorkspaceContext.jsx:76` | `useWorkspace()` export | ✅ |
| `src/lib/wsFetch.js:58,68` | `wsFetch` export + `X-Compose-Workspace-Id` injection | ✅ |
| `src/App.jsx:550,1111-1119` | handleProjectSwitch; pair-device button (dot inserts before) | ✅ |
| PACKAGE_ROOT server-side = `resolve(__dirname,'..')` | matches CLI-baked composeBin | ✅ pattern at project-root.js:22 |
| Boundary Map | `validateBoundaryMap` | ✅ `{ok:true, violations:[], warnings:[]}` |

Zero stale entries. Zero Boundary Map violations. Phase 5 gate criteria met.

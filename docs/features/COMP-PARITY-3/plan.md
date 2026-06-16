# COMP-PARITY-3 — Implementation Plan

**Status:** Phase 6 (Plan) — gate pending.
**Blueprint:** `/Users/ruze/reg/my/forge/compose/docs/features/COMP-PARITY-3/blueprint.md` (contracts, Boundary Map, verified refs)

Execution follows the blueprint's slice topology S1→S6. TDD per slice (write/capture test → fail → implement → pass). Slices are sequential (each `from S##` is an earlier slice).

## Task Order

### Task 1 — `lib/hooks-status.js` (new) + tests  [S1]
- [ ] `test/hooks-status.test.js` (new): fixtures in a temp dir's `.git/hooks`; assert every state — `absent`, `foreign`, `installed-current` (wsVerified true & false), `installed-stale` × {`MISSING_WORKSPACE_ID`, `STALE_WORKSPACE_ID`, `stale paths`}. Write first, watch fail.
- [ ] `lib/hooks-status.js` (new): export `HOOK_MARKERS` and pure `computeHooksStatus({projectRoot, expectedWsId, composeNode, composeBin})` returning the raw-facts object per the blueprint contract (state/reason/bakedWorkspace/expectedWorkspace/wsVerified/nodeMatch/binMatch). State derivation mirrors `bin/compose.js:1697-1734` exactly; only addition is the non-state `wsVerified` flag.
- [ ] Tests pass.

### Task 2 — `bin/compose.js` refactor (CLI byte-identical)  [S2, from S1]
- [ ] `test/hooks-status-cli.test.js` (new): **capture current** `compose hooks status` output (across the hook states reachable in a fixture) as a golden fixture BEFORE editing `bin/compose.js`.
- [ ] Refactor: `HOOK_TYPES[type].marker` references `HOOK_MARKERS` from `lib/hooks-status.js`; hoist the `expectedWsId` resolve (via `resolveWorkspace`/`hookFlags['workspace']`) out of `statusOne`; `statusOne` calls `computeHooksStatus(...)` and a literal CLI mapper that prints today's exact strings.
- [ ] Golden test passes (byte-identical) + existing CLI tests still green.

### Task 3 — `server/health-routes.js` (new) + endpoint tests  [S3, from S1]
- [ ] `test/integration/health-routes.test.js` (new): build the Express app, hit `GET /api/environment-health` against a temp workspace + real `.git/hooks` fixture. Assert full response shape; degrade paths (`loadDeps`→null ⇒ both dep sections `{unavailable:true}`; `checkLatestVersion`→null ⇒ `version:null`, summary unaffected); summary rollup table cases; `?refresh=1` ⇒ `{force:true}`; null `req.workspace.id` ⇒ hooks `workspace-unverified`. Real backends, no mocks.
- [ ] `server/health-routes.js` (new): `attachHealthRoutes(app, deps)` → `app.get('/api/environment-health', ...)`. Resolve `PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')`; `composeBin = join(PACKAGE_ROOT,'bin','compose.js')`, `composeNode = process.execPath`. Explicit `if (!deps)` branch. Reads deps/version off PACKAGE_ROOT, hooks off `req.workspace.root` with `expectedWsId = req.workspace.id`. API mapper + worst-wins summary rollup. Never 500s on a sub-check.
- [ ] Tests pass.

### Task 4 — wire route in `server/vision-server.js`  [S4, from S3]
- [ ] Import `attachHealthRoutes`; call it in `attach()` at ~L87 (after `attachSettingsRoutes`). Confirm the route is reachable (integration test from Task 3 exercises the wired app).

### Task 5 — `EnvironmentHealthPanel.jsx` (new) + component test  [S5, from S3]
- [ ] `test/ui/env-health-panel.test.jsx` (new, Vitest jsdom): mock `wsFetch`; assert dot color per `summary` (ok→success, warn→warning, error→destructive, loading→grey); click opens popover; Dependencies/Version/Git Hooks sections render; ↻ refetches; refetch fires on `workspace.root` change. testids per blueprint.
- [ ] `src/components/cockpit/EnvironmentHealthPanel.jsx` (new): `useWorkspace()`; fetch effect keyed `[workspace?.id, workspace?.root]`, not gated on `open`; manual ↻ with `?refresh=1`; ProjectSwitchPopover-style absolute panel with outside-click + Esc close; status colors from CSS tokens; degrade-friendly (`error`/`unavailable` rendered, never throws).
- [ ] Tests pass.

### Task 6 — mount in `src/App.jsx` header  [S6, from S5]
- [ ] Insert `<EnvironmentHealthPanel />` in the header controls `<div className="flex items-center gap-2 shrink-0">` before the pair-device button (~L1112).
- [ ] `npm run build` smoke (app still loads); existing UI tests green.

## Phase 7 Exit Criteria (all four)
- [ ] **All tasks executed** — every task's tests pass (TDD).
- [ ] **E2E smoke** — integration endpoint test (real backend) + Vitest component test green; manual cockpit check (no Playwright in repo, by design).
- [ ] **Review loop clean** — Codex review of the implementation → REVIEW CLEAN.
- [ ] **Coverage sweep clean** — `npm test` (node suite, with `--test-timeout`) + `npm run test:ui` → TESTS PASSING.

## Notes / Risks
- CLI byte-identical is the highest-risk constraint → golden fixture captured before refactor (Task 2).
- `composeNode`/`composeBin` must match what `compose hooks install` bakes; verified PACKAGE_ROOT resolution. If the server runs under a different node than installed the hook, "stale paths" is the correct (not false) signal.
- Full `npm test` can hang on proof-run; run node suite with `--test-timeout` for a bounded green (per project convention).
- No external blockers — all deps in-repo and shipping.

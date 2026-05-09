# COMP-WORKSPACE-ID: Implementation Plan

**Status:** PLAN
**Date:** 2026-05-09
**Blueprint:** [blueprint.md](blueprint.md)

## Approach

Strict TDD per task: write failing test → implement → watch pass. Tasks are ordered so the codebase is never broken between tasks (per `compose/.claude/rules/incremental-builds.md`). Each task is independently verifiable.

## Task list

### T1 — `lib/discover-workspaces.js` (new)

- [ ] Create `compose/test/discover-workspaces.test.js` with cases:
  - one workspace at anchor → returns one candidate
  - workspace at anchor + descendant → returns two
  - depth-cap: workspace at depth 4 not found
  - visit-cap: tree with 250 dirs throws `WorkspaceDiscoveryTooBroad`
  - skip-dirs: `node_modules/.compose` not visited
  - readdirSync EACCES on a sub-tree → silently skipped, others discovered
  - `deriveId` honors `workspaceId` in `.compose/compose.json`; falls back to basename
- [ ] Implement `compose/lib/discover-workspaces.js` per blueprint pseudocode (incl. exported `deriveId`).
- [ ] All tests pass.

### T2 — `lib/resolve-workspace.js` (new)

- [ ] Create `compose/test/resolve-workspace.test.js` with cases:
  - explicit flag wins over env wins over discovery
  - discovery returns single candidate when only one
  - discovery throws `WorkspaceAmbiguous` with candidate list
  - discovery throws `WorkspaceIdCollision` when two candidates share basename id
  - `getWorkspaceFlag('--workspace=foo' / '--workspace foo')` parses and mutates args
  - **Explicit-flag bypass:** `--workspace=<ancestor-id>` succeeds via upward walk even when descendant tree would throw `WorkspaceDiscoveryTooBroad`
  - **Explicit-flag fallback:** `--workspace=<descendant-id>` (target below cwd) falls through to discovery
  - **`COMPOSE_TARGET=/abs/path` bypass:** unconditional, never invokes discovery
  - `WorkspaceUnknown` when explicit id matches no candidate
- [ ] Implement `compose/lib/resolve-workspace.js` per blueprint pseudocode (incl. `findWorkspaceById`, `resolveByIdScopedCollisionCheck`, error classes, `getWorkspaceFlag`).
- [ ] All tests pass.

### T3 — `bin/compose.js` cwd migration

- [ ] Add imports: `resolveWorkspace`, `getWorkspaceFlag` from `lib/resolve-workspace.js`.
- [ ] Add helpers `dieOnWorkspaceError` and `resolveCwdWithWorkspace(args)` near top of `bin/compose.js` (after imports).
- [ ] Replace 17 cwd sites (lines 270, 519, 626, 667, 795, 961, 970, 989, 1110, 1267, 1335, 1528, 1529, 1572, 1653, 1728, 1815, 1863, 1890, 2189) with `const cwd = resolveCwdWithWorkspace(args)`.
- [ ] Wrap each subcommand's top-level body in `try { … } catch (err) { dieOnWorkspaceError(err) }`.
- [ ] `compose --version` and `compose --help` (lines 35–71) NOT migrated (don't need a workspace).
- [ ] Manual test: `cd compose && compose --help` (no workspace error); `cd /tmp && compose roadmap` exits with `WorkspaceUnset` message; `cd compose && compose roadmap --workspace=compose` works.

### T4 — Hook templates

- [ ] Edit `bin/git-hooks/post-commit.template`: add `COMPOSE_WORKSPACE_ID="__COMPOSE_WORKSPACE_ID__"` at lines 7–8; add `--workspace="$COMPOSE_WORKSPACE_ID"` to record-completion call (line 54–55).
- [ ] Edit `bin/git-hooks/pre-push.template`: same constant; pass `--workspace` on line 12.

### T5 — Hook install / status (in `bin/compose.js`)

- [ ] Test in `compose/test/hooks-workspace.test.js`:
  - install in tmpdir with `.compose/compose.json` containing `workspaceId: "test-ws"` → file contains `COMPOSE_WORKSPACE_ID="test-ws"` and `--workspace="test-ws"`
  - install with multiple sibling `.compose/` dirs → fails with `WorkspaceAmbiguous` unless `--workspace` provided
  - status on stale install (different baked id than current resolution) → reports `STALE_WORKSPACE_ID`
  - status on legacy install (raw `__COMPOSE_WORKSPACE_ID__` token in file) → reports `MISSING_WORKSPACE_ID`
  - status on current install with no `--workspace` flag → "installed (current)" with `workspace: <baked-id>` line
- [ ] Modify `installOne` (line 1371): substitute `__COMPOSE_WORKSPACE_ID__`; require `--workspace` in ambiguous tree.
- [ ] Modify `statusOne` (line 1418): add `extractBakedWorkspaceId`, compare baked vs `expectedWsId`, classify staleness.
- [ ] Tests pass.

### T6 — Stdio MCP wiring

- [ ] Edit `server/compose-mcp-tools.js`:
  - delete line 14 `export const PROJECT_ROOT = getTargetRoot()` (verify no consumers via repo grep first)
  - convert lines 15–16 `VISION_FILE`, `SESSIONS_FILE` to functions `getVisionFile()`, `getSessionsFile()`; update internal use sites (~6).
  - add `toolSetWorkspace`, `toolGetWorkspace`, `_getBinding` per blueprint.
- [ ] Edit `server/compose-mcp.js`:
  - import `toolSetWorkspace`, `toolGetWorkspace`, `_getBinding`, `switchProject`, `getTargetRoot`, `resolveWorkspace`
  - add `set_workspace` and `get_workspace` to `TOOLS` array (~line 153)
  - add dispatch cases (~line 581)
  - add the WORKSPACE_EXEMPT bridge before the dispatch switch (~line 573); errors propagate
- [ ] Edit `server/project-root.js`: add `getCurrentWorkspaceId` / `setCurrentWorkspaceId` exports.
- [ ] Manual smoke: start MCP via `node server/compose-mcp.js` from compose dir; call `get_workspace` via raw JSON-RPC; expect `{current: null, candidates: [...]}`.

### T7 — Golden flow

- [ ] Create `compose/test/golden/multi-workspace.test.js`:
  - tmpdir with `forge-top/.compose/` and `forge-top/compose/.compose/`
  - `cd forge-top && compose feature COMP-FOO --workspace=compose` → feature lands in `forge-top/compose/docs/features/COMP-FOO/`
  - same without `--workspace` → exits 1, stderr contains both candidate IDs
  - same with `COMPOSE_TARGET=$TMPDIR/forge-top/compose` (absolute) → succeeds
  - cleanup: rm tmpdir
- [ ] Test passes.

### T8 — Folder relocation

- [ ] From compose dir, run `compose feature COMP-WORKSPACE-ID --workspace=compose` to scaffold in compose's own `docs/features/`.
- [ ] Move artifacts (`design.md`, `prd.md` (empty), `architecture.md` (empty), `blueprint.md`, `plan.md`, `report.md` (deferred), `feature.json`) from `forge-top/docs/features/COMP-WORKSPACE-ID/` to `compose/docs/features/COMP-WORKSPACE-ID/`.
- [ ] Update vision item to reflect new path; remove the forge-top folder.
- [ ] Verify ROADMAP.md regenerates correctly in compose.

### T9 — File-followups (out-of-scope tickets)

- [ ] `compose/ROADMAP.md` rows for `COMP-WORKSPACE-HTTP`, `COMP-WORKSPACE-WATCHERS`, `COMP-WORKSPACE-RESUME`, `COMP-CLI-GLOBAL-FLAGS` (all PLANNED).

## Phase 7 step 2 — E2E smoke test

After T1–T9: start dev server (`npm run dev`), open compose UI on http://localhost:5195, verify the cockpit still loads and the project-switch works (we deliberately did NOT touch the HTTP server; this is a regression check).

## Phase 7 step 3 — Codex review loop

Run Codex review on the diff once T1–T8 are merged. Convergence target: REVIEW CLEAN.

## Phase 7 step 4 — Coverage sweep

Run full `npm test` from compose root; fix failing tests until all pass.

## Acceptance criteria for the whole feature

- [ ] All 9 tasks complete
- [ ] `cd /Users/ruze/reg/my/forge && compose feature COMP-FOO --workspace=compose` lands in compose, not forge-top
- [ ] `cd /Users/ruze/reg/my/forge && compose feature COMP-FOO` (no flag) prints structured candidates and exits non-zero
- [ ] `compose hooks install --post-commit --workspace=compose` substitutes the ID; `status` reports it
- [ ] `compose hooks status` reports `MISSING_WORKSPACE_ID` for legacy installs
- [ ] Stdio MCP `set_workspace({workspaceId: "compose"})` flips the project; subsequent `add_roadmap_entry` writes to `compose/ROADMAP.md`
- [ ] All new and existing tests pass (`npm test`)
- [ ] Cockpit (HTTP server) still loads after changes — no regression
- [ ] Folder lives at `compose/docs/features/COMP-WORKSPACE-ID/` (forge-top copy removed)

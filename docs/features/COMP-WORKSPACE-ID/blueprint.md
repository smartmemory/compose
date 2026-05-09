# COMP-WORKSPACE-ID: Implementation Blueprint

**Status:** BLUEPRINT
**Date:** 2026-05-09
**Spec:** [`design.md`](./design.md)

## Scope: Path A v1

The design enumerates 11 server-process import-time snapshots that should ultimately migrate to per-request resolution. **This blueprint implements only the surfaces that exhibit the observed bug** — stdio MCP child + CLI + hooks. HTTP server middleware overhaul is filed as a follow-up.

| Surface | In v1 | Why |
|---|---|---|
| Stdio MCP child (`compose-mcp-tools.js:14` cache) | ✅ | The observed bug. `add_roadmap_entry` lives here; reads disk directly. |
| CLI (`bin/compose.js`) | ✅ | 17 `process.cwd()` sites. Drives `compose build`, `compose feature`, `compose hooks`, etc. |
| Git hooks (post-commit, pre-push) | ✅ | Already pass through CLI re-resolution; just needs `__COMPOSE_WORKSPACE_ID__` substitution + `--workspace` plumb. |
| HTTP server import-time snapshots (vision-routes.js:53, vision-utils.js:15, session-manager.js:19, agent-spawn.js:13, file-watcher.js:14, summarizer.js:13) | ❌ | These run in the long-lived HTTP server process. Not the observed bug. The HTTP server already has `switchProject()` (`server/project-root.js:70`) and `POST /api/project/switch` (`server/index.js:63`); existing UX for switching the cockpit's bound workspace continues to work. |

**Follow-up filed as part of this blueprint:** `COMP-WORKSPACE-HTTP` — migrate HTTP server to per-request workspace via Express middleware; needed when cockpit must serve multiple workspaces concurrently.

This re-scoping does NOT contradict the design. It commits to a v1 that fixes the observed defect; the design's broader vision remains the target.

---

## Architecture in one diagram

```
                  CLI (bin/compose.js)
                         │
                         ▼
  ┌──────────────────────────────────────────────────┐
  │   lib/resolve-workspace.js  ← single chokepoint   │
  │   ├─ flag/env precedence                          │
  │   ├─ delegates to lib/discover-workspaces.js      │
  │   └─ throws structured errors                     │
  └──────────────────────────────────────────────────┘
       │                                   │
       │                                   ▼
       │                   ┌────────────────────────────┐
       │                   │ lib/discover-workspaces.js │
       │                   │ bidirectional bounded scan │
       │                   └────────────────────────────┘
       ▼
 ┌─────────────────────┐         ┌──────────────────────────────────┐
 │ Stdio MCP child     │         │ Git hook templates                │
 │ (compose-mcp.js)    │         │ post-commit, pre-push             │
 │                     │         │   __COMPOSE_WORKSPACE_ID__ baked  │
 │ set_workspace tool  │         │   pass --workspace=<id>           │
 │   → switchProject() │         └──────────────────────────────────┘
 │                     │
 │ Existing tools call │
 │   getTargetRoot()   │
 │   per use, no cache │
 └─────────────────────┘
```

Key insight surfaced during exploration: **`server/project-root.js` already has `switchProject()` (line 70) plus an `onProjectSwitch` listener pattern (line 61).** `set_workspace` is a thin wrapper that calls `switchProject(resolved.root)` after resolution.

**However, `switchProject()` alone is not enough for the stdio MCP child.** Two classes of read sites currently snapshot disk paths at import time inside the stdio process:

1. **`PROJECT_ROOT = getTargetRoot()` at `compose-mcp-tools.js:14`** — exported but unused internally; safe to delete.
2. **`VISION_FILE` and `SESSIONS_FILE` constants** at lines 15–16, frozen via `path.join(getDataDir(), …)`. These ARE consumed inside `loadVisionState()` (line ~22) and `loadSessions()` (line ~37). After `switchProject()`, `getDataDir()` returns the new path, but the *already-frozen* constants don't.

These constants must be converted to functions (`getSessionsFile()`, `getVisionFile()`) and every internal reader updated. Plus a `_getBinding()` → `switchProject` bridge in `compose-mcp.js`'s `CallToolRequestSchema` handler so the project flips before each tool runs (cheap; idempotent if already on target).

---

## File-by-file work plan

### NEW files

#### `compose/lib/discover-workspaces.js`
**Purpose:** bounded bidirectional discovery (Decision 3).

Pseudocode:

```js
import path from 'node:path';
import fs from 'node:fs';

const ANCHOR_MARKERS = ['.compose', '.stratum.yaml', '.git'];
const WORKSPACE_MARKER = '.compose';
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo']);
const MAX_DEPTH = 3;
const MAX_VISITED = 200;

export function findAnchor(startDir) { /* upward walk for any ANCHOR_MARKER */ }

export function discoverWorkspaces(startDir) {
  const anchor = findAnchor(startDir) ?? startDir;
  const visited = { count: 0 };
  const candidates = [];
  walkDescendants(anchor, 0, candidates, visited);
  if (fs.existsSync(path.join(anchor, WORKSPACE_MARKER))) {
    if (!candidates.find(c => c.root === anchor)) candidates.unshift({ root: anchor });
  }
  return { anchor, candidates: candidates.map(deriveId) };
}

function walkDescendants(dir, depth, out, visited) {
  if (depth > MAX_DEPTH) return;
  if (++visited.count > MAX_VISITED) {
    const e = new Error('Discovery scope exceeded'); e.code = 'WorkspaceDiscoveryTooBroad'; throw e;
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // EACCES, EPERM, ENOENT (race with rm) — skip silently; missing perms aren't an error.
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const child = path.join(dir, entry.name);
    if (fs.existsSync(path.join(child, WORKSPACE_MARKER))) {
      out.push({ root: child });
    }
    walkDescendants(child, depth + 1, out, visited);
  }
}

// Exported so resolve-workspace.js can reuse it without re-running discovery.
export function deriveId({ root }) {
  const configPath = path.join(root, '.compose', 'compose.json');
  let id = path.basename(root);
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (typeof cfg.workspaceId === 'string' && /^[a-z][a-z0-9-]{1,63}$/.test(cfg.workspaceId)) {
      id = cfg.workspaceId;
    }
  } catch { /* default to basename */ }
  return { id, root, configPath };
}
```

Tests in `compose/test/discover-workspaces.test.js`:
- one workspace at anchor → returns one candidate
- workspace at anchor + descendant → returns two
- depth-cap: workspace at depth 4 not found
- visit-cap: directory tree with 250 dirs throws `WorkspaceDiscoveryTooBroad`
- skip-dirs: `node_modules/.compose` not visited
- collision detection deferred to resolver (discovery returns raw list)

#### `compose/lib/resolve-workspace.js`
**Purpose:** the single resolver chain (Decision 4).

```js
import path from 'node:path';
import fs from 'node:fs';
import { discoverWorkspaces, deriveId } from './discover-workspaces.js';

// Note: deriveId is exported from discover-workspaces.js so resolve-workspace.js
// can use it on an absolute COMPOSE_TARGET path or on an ancestor candidate
// without re-running the full descendant scan.

export class WorkspaceUnknown extends Error { constructor(id) { super(`Unknown workspaceId: ${id}`); this.code='WorkspaceUnknown'; this.id=id; } }
export class WorkspaceAmbiguous extends Error {
  constructor(candidates) { super('Multiple workspaces match cwd'); this.code='WorkspaceAmbiguous'; this.candidates=candidates; }
}
export class WorkspaceIdCollision extends Error {
  constructor(id, roots) { super(`workspaceId "${id}" used by multiple roots`); this.code='WorkspaceIdCollision'; this.id=id; this.roots=roots; }
}
export class WorkspaceUnset extends Error { constructor() { super('No workspace resolved'); this.code='WorkspaceUnset'; } }

export function resolveWorkspace(hint = {}) {
  const cwd = hint.cwd ?? process.cwd();

  // 1. Explicit flag — authoritative. Use cheap upward-walk; do NOT trigger
  //    full descendant discovery (which can throw WorkspaceDiscoveryTooBroad).
  //    This honors the "--workspace skips discovery" UX in dieOnWorkspaceError.
  if (hint.workspaceId) {
    const found = findWorkspaceById(cwd, hint.workspaceId);
    if (found) return { ...found, source: 'explicit-flag' };
    // Fall back to bounded discovery only if upward walk doesn't find it.
    // Discovery may still throw TooBroad — let it propagate; the message tells
    // the user to use COMPOSE_TARGET=<absolute-path> to bypass entirely.
    const { candidates } = discoverWorkspaces(cwd);
    return resolveByIdScopedCollisionCheck(hint.workspaceId, candidates, 'explicit-flag');
  }

  // 2. COMPOSE_TARGET — preserves current behavior: direct path override OR id.
  //    Absolute path is authoritative without requiring discovery membership;
  //    we still derive {id, configPath} for it.
  if (process.env.COMPOSE_TARGET) {
    const t = process.env.COMPOSE_TARGET;
    if (t.startsWith('/')) {
      if (!fs.existsSync(t)) {
        const e = new Error(`COMPOSE_TARGET=${t} does not exist`); e.code = 'WorkspaceUnknown'; throw e;
      }
      return { ...deriveId({ root: t }), source: 'env' };
    }
    const { candidates } = discoverWorkspaces(cwd);
    return resolveByIdScopedCollisionCheck(t, candidates, 'env');
  }

  // 3. MCP binding — same scoped check.
  if (hint.getBinding) {
    const id = hint.getBinding();
    if (id) {
      const { candidates } = discoverWorkspaces(cwd);
      return resolveByIdScopedCollisionCheck(id, candidates, 'mcp-binding');
    }
  }

  // 4. Discovery — collisions matter here because we're auto-picking.
  const { candidates } = discoverWorkspaces(cwd);
  detectCollisions(candidates);
  if (candidates.length === 0) throw new WorkspaceUnset();
  if (candidates.length === 1) return { ...candidates[0], source: 'discovery' };
  throw new WorkspaceAmbiguous(candidates.map(({ id, root }) => ({ id, root })));
}

// Cheap upward-only lookup: walk ancestors, return the first .compose/
// whose workspaceId matches. Used by the explicit-flag path so the user
// can bypass the descendant-cap entirely.
function findWorkspaceById(startDir, targetId) {
  let dir = path.resolve(startDir);
  const { root } = path.parse(dir);
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, '.compose'))) {
      const candidate = deriveId({ root: dir });
      if (candidate.id === targetId) return candidate;
    }
    dir = path.dirname(dir);
  }
  return null;
}

function resolveByIdScopedCollisionCheck(id, candidates, source) {
  const matching = candidates.filter(c => c.id === id);
  if (matching.length === 0) throw new WorkspaceUnknown(id);
  if (matching.length > 1) throw new WorkspaceIdCollision(id, matching.map(m => m.root));
  return { ...matching[0], source };
}

function resolveById(id, candidates, source) {
  const found = candidates.find(c => c.id === id);
  if (!found) throw new WorkspaceUnknown(id);
  return { ...found, source };
}

function detectCollisions(candidates) {
  const byId = new Map();
  for (const c of candidates) {
    if (!byId.has(c.id)) byId.set(c.id, []);
    byId.get(c.id).push(c.root);
  }
  for (const [id, roots] of byId) {
    if (roots.length > 1) throw new WorkspaceIdCollision(id, roots);
  }
}

export function getWorkspaceFlag(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--workspace' && i + 1 < args.length) {
      const id = args[i + 1]; args.splice(i, 2); return id;
    }
    if (a.startsWith('--workspace=')) {
      const id = a.slice('--workspace='.length); args.splice(i, 1); return id;
    }
  }
  return null;
}
```

Tests in `compose/test/resolve-workspace.test.js`:
- explicit flag wins over env
- env wins over discovery
- discovery returns single candidate when only one
- discovery throws `WorkspaceAmbiguous` with candidate list when multiple
- collision throws `WorkspaceIdCollision`
- `getWorkspaceFlag` parses `--workspace=foo`, `--workspace foo`, mutates args correctly
- **Explicit-flag bypass:** `--workspace=<ancestor-id>` resolves via cheap upward walk and does NOT trigger `WorkspaceDiscoveryTooBroad` even when the descendant tree would otherwise blow the cap (regression for the issue caught in Phase 4 review).
- **Explicit-flag fallback:** `--workspace=<descendant-id>` (where target is below cwd, not an ancestor) still falls through to `discoverWorkspaces`; under the cap this succeeds, over the cap it propagates `WorkspaceDiscoveryTooBroad`.
- **`COMPOSE_TARGET=/absolute/path` bypass:** never invokes discovery; resolves directly even when descendant tree would blow the cap.

### MODIFIED files

#### `compose/server/project-root.js`
**Lines 30–40:** keep IIFE (sensible default at startup). Add two new exports for `compose hooks status` to detect drift:

```js
let _currentWorkspaceId = null;
export function getCurrentWorkspaceId() { return _currentWorkspaceId; }
export function setCurrentWorkspaceId(id) { _currentWorkspaceId = id; }
```

`switchProject()` at line 70 stays as-is; the new MCP `set_workspace` tool calls it.

#### `compose/server/compose-mcp-tools.js`
**Line 14:** `export const PROJECT_ROOT = getTargetRoot();` → **DELETE.**

`PROJECT_ROOT` is exported but every internal call already uses `getTargetRoot()` (e.g. line 302). Phase 5 verifies external imports.

**Lines 15–16:** `VISION_FILE` and `SESSIONS_FILE` frozen via `path.join(getDataDir(), …)`. Convert to functions:

```js
export function getSessionsFile() { return path.join(getDataDir(), 'sessions.json'); }
export function getVisionFile()   { return path.join(getDataDir(), 'vision-state.json'); }
```

Update ~6 use sites in this file.

**New tool implementations** (added in this file):

```js
import { switchProject, setCurrentWorkspaceId } from './project-root.js';
import { resolveWorkspace } from '../lib/resolve-workspace.js';
import { discoverWorkspaces } from '../lib/discover-workspaces.js';

let _binding = null;

export function toolSetWorkspace({ workspaceId }) {
  const resolved = resolveWorkspace({ workspaceId });
  switchProject(resolved.root);
  setCurrentWorkspaceId(resolved.id);
  _binding = resolved;
  return { id: resolved.id, root: resolved.root, source: 'mcp-binding' };
}

export function toolGetWorkspace() {
  const { candidates } = discoverWorkspaces(process.cwd());
  return { current: _binding, candidates };
}

export function _getBinding() { return _binding?.id ?? null; }
```

#### `compose/server/compose-mcp.js`
**Add new tools** to `TOOLS` array (around line 153) and dispatch switch (around line 581):

```js
{ name: 'set_workspace', description: 'Bind this MCP session to a workspace. Lives in process memory; lost on MCP restart.',
  inputSchema: { type: 'object', required: ['workspaceId'], properties: { workspaceId: { type: 'string' } } } },
{ name: 'get_workspace', description: 'Get current MCP workspace binding plus all candidates discovered from cwd.',
  inputSchema: { type: 'object', properties: {} } },

// in dispatch
case 'set_workspace': result = toolSetWorkspace(args); break;
case 'get_workspace': result = toolGetWorkspace(); break;
```

Also add these imports to `compose-mcp.js`:

```js
import { toolSetWorkspace, toolGetWorkspace, _getBinding } from './compose-mcp-tools.js';
import { switchProject, getTargetRoot } from './project-root.js';
import { resolveWorkspace } from '../lib/resolve-workspace.js';
```

**switchProject-lazy bridge.** Before the dispatch switch (around line 573, inside the `CallToolRequestSchema` handler) inject:

```js
// Tools that don't need a resolved workspace (must run even pre-binding).
const WORKSPACE_EXEMPT = new Set(['set_workspace', 'get_workspace']);

if (!WORKSPACE_EXEMPT.has(name)) {
  // Resolve and re-target the in-process project root. Errors propagate so
  // Claude sees a structured WorkspaceAmbiguous / WorkspaceUnset and prompts
  // the user to call set_workspace.
  const ws = resolveWorkspace({ getBinding: _getBinding });
  if (ws.root !== getTargetRoot()) switchProject(ws.root);
}
```

**Critical:** errors from `resolveWorkspace` are NOT swallowed. The previous draft's "rely on `getTargetRoot()` as fallback" was unsafe — it would silently write to whatever workspace the MCP happened to boot in (typically the parent), reproducing the original bug under a different code path. The outer `try/catch` in the MCP handler (`compose-mcp.js:618`) already converts thrown errors into `{isError: true, content: [...]}` responses with the error code surfaced. Claude reads `WorkspaceAmbiguous` / `WorkspaceUnset` codes and responds with `set_workspace` per design Decision 6.

`set_workspace` and `get_workspace` are exempt: the former takes its own `workspaceId` arg and resolves explicitly; the latter intentionally returns the candidate list even when ambiguous, so the user can pick.

#### `compose/bin/compose.js`
**17 `process.cwd()` sites** at lines 270, 519, 626, 667, 795, 961, 970, 989, 1110, 1267, 1335, 1528–1529, 1572, 1653, 1728, 1815, 1863, 1890, 2189.

Pattern for each subcommand handler:

```diff
- const cwd = process.cwd()
+ let wsId = getWorkspaceFlag(args)
+ // Legacy hooks may pass the unsubstituted token literally — treat as absent.
+ if (wsId === '__COMPOSE_WORKSPACE_ID__') {
+   console.warn('[compose] hook predates workspace-aware install — re-run `compose hooks install`')
+   wsId = null
+ }
+ const ws = resolveWorkspace({ workspaceId: wsId })
+ const cwd = ws.root
```

Extract this five-line block into a helper `resolveCwdWithWorkspace(args)` in `lib/resolve-workspace.js` so each of the 17 sites is a one-liner.

Sites already using `findProjectRoot(process.cwd())` (1267, 1335, 1863) get the same swap.

Add import at top: `import { resolveWorkspace, getWorkspaceFlag } from '../lib/resolve-workspace.js'`.

`findProjectRoot` import at line 17 stays; still used internally by hooks code (line 1335) until that gets the same migration in step 4.

Errors from `resolveWorkspace` (WorkspaceAmbiguous / WorkspaceIdCollision / WorkspaceUnknown) → catch at top level of each subcommand handler, print structured candidate list, exit 1. Reusable helper:

```js
function dieOnWorkspaceError(err) {
  switch (err.code) {
    case 'WorkspaceAmbiguous':
      console.error('Multiple workspaces match cwd. Add --workspace=<id> or set COMPOSE_TARGET:');
      for (const c of err.candidates) console.error(`  --workspace=${c.id}    (${c.root})`);
      process.exit(1);
    case 'WorkspaceIdCollision':
      console.error(`workspaceId "${err.id}" is used by multiple roots:`);
      for (const r of err.roots) console.error(`  ${r}`);
      console.error('Set an explicit workspaceId in each .compose/compose.json.');
      process.exit(1);
    case 'WorkspaceUnknown':
      console.error(`Unknown workspace: ${err.id}. Run \`compose doctor\` to list candidates.`);
      process.exit(1);
    case 'WorkspaceUnset':
      console.error('No compose workspace found from the current directory.');
      console.error('Run `compose init` to scaffold one, or cd into a project that has a .compose/ directory.');
      process.exit(1);
    case 'WorkspaceDiscoveryTooBroad':
      console.error('Workspace discovery exceeded its bound (>200 directories from anchor).');
      console.error('Set COMPOSE_TARGET=/absolute/path/to/workspace to bypass discovery.');
      console.error('(--workspace=<id> alone also skips the descendant scan when the workspace');
      console.error(' is an ancestor of cwd; it falls back to discovery otherwise.)');
      process.exit(1);
    default:
      throw err;
  }
}
```

**Hook install** — `installOne` at line 1371:

```diff
+ // Hook install must pick exactly one workspace. In a multi-workspace git repo,
+ // require explicit --workspace because git only allows one hook per repo.
+ const wsId = resolveWorkspace({ cwd: projectRoot, workspaceId: hookFlags['workspace'] }).id
  const substituted = template
    .replace(/__COMPOSE_NODE__/g, composeNode)
    .replace(/__COMPOSE_BIN__/g, composeBin)
+   .replace(/__COMPOSE_WORKSPACE_ID__/g, wsId)
```

If the repo has multiple `.compose/` workspaces and the user runs `compose hooks install` without `--workspace`, `resolveWorkspace` throws `WorkspaceAmbiguous`. `dieOnWorkspaceError` prints candidates and instructs the user to re-run with `--workspace=<id>`. **Documented limitation:** one git repo → one hook-bound workspace; switch via `compose hooks install --workspace=<other> --force`.

**Hook status** — `statusOne` at line 1418:

```diff
+ // Status uses the same flag if provided; otherwise the baked ID is the source of truth.
+ const expectedWsId = hookFlags['workspace']
+   ? resolveWorkspace({ cwd: projectRoot, workspaceId: hookFlags['workspace'] }).id
+   : extractBakedWorkspaceId(content) ?? null
  const nodeMatch = content.includes(`COMPOSE_NODE="${composeNode}"`)
  const binMatch  = content.includes(`COMPOSE_BIN="${composeBin}"`)
+ const hasRawToken = content.includes('__COMPOSE_WORKSPACE_ID__')
+ // wsMatch: if user passed --workspace=<id>, compare to baked; else status just reports baked id.
+ const wsMatch = hasRawToken ? false
+               : expectedWsId ? content.includes(`COMPOSE_WORKSPACE_ID="${expectedWsId}"`)
+               : true

- if (nodeMatch && binMatch) {
+ if (nodeMatch && binMatch && wsMatch && !hasRawToken) {
    console.log(`${type}: installed (current)`)
+   const baked = extractBakedWorkspaceId(content)
+   if (baked) console.log(`  workspace: ${baked}`)
  } else {
-   console.log(`${type}: installed (stale paths — re-run install)`)
+   const reason = hasRawToken ? 'MISSING_WORKSPACE_ID'
+                : (expectedWsId && !wsMatch) ? 'STALE_WORKSPACE_ID'
+                : 'stale paths';
+   console.log(`${type}: installed (${reason} — re-run install)`)
+   if (expectedWsId && !wsMatch && !hasRawToken) console.log(`  expected COMPOSE_WORKSPACE_ID="${expectedWsId}"`)
+   if (!nodeMatch) console.log(`  expected COMPOSE_NODE="${composeNode}"`)
+   if (!binMatch)  console.log(`  expected COMPOSE_BIN="${composeBin}"`)
  }
```

Helper `extractBakedWorkspaceId(content)` parses the line `COMPOSE_WORKSPACE_ID="..."` from the script body; lives next to `installOne`/`statusOne`. `expectedWsId` computed once at top of the hook command; passed to `statusOne`.

#### `compose/bin/git-hooks/post-commit.template`
**Lines 7–8** add:

```diff
  COMPOSE_NODE="__COMPOSE_NODE__"
  COMPOSE_BIN="__COMPOSE_BIN__"
+ COMPOSE_WORKSPACE_ID="__COMPOSE_WORKSPACE_ID__"
```

**Lines 54–55** pass workspace to record-completion:

```diff
  if ! echo "$files" | "$COMPOSE_NODE" "$COMPOSE_BIN" record-completion "$code" \
-   --commit-sha="$sha" --tests-pass="$tp" --notes="$notes" \
+   --commit-sha="$sha" --tests-pass="$tp" --notes="$notes" --workspace="$COMPOSE_WORKSPACE_ID" \
    --files-changed-from-stdin >> "$LOG" 2>&1; then
```

#### `compose/bin/git-hooks/pre-push.template`
**Lines 7–8** (add constant), **line 12** (pass flag):

```diff
  COMPOSE_NODE="__COMPOSE_NODE__"
  COMPOSE_BIN="__COMPOSE_BIN__"
+ COMPOSE_WORKSPACE_ID="__COMPOSE_WORKSPACE_ID__"
  …
- OUTPUT=$("$COMPOSE_NODE" "$COMPOSE_BIN" validate --scope=project --block-on=error 2>&1)
+ OUTPUT=$("$COMPOSE_NODE" "$COMPOSE_BIN" validate --scope=project --block-on=error --workspace="$COMPOSE_WORKSPACE_ID" 2>&1)
```

Legacy hooks lacking `__COMPOSE_WORKSPACE_ID__` substitution → variable expands to literal `__COMPOSE_WORKSPACE_ID__` → must be normalized to null **before** `resolveWorkspace` runs (otherwise it throws `WorkspaceUnknown`). The sentinel-normalization step is included in the per-subcommand pattern above and centralized in the `resolveCwdWithWorkspace(args)` helper.

### NEW tests

#### `compose/test/discover-workspaces.test.js`
Tmpdir fixtures with controlled `.compose/` placements. Cases above.

#### `compose/test/resolve-workspace.test.js`
Mock filesystem via tmpdir. Cases above.

#### `compose/test/hooks-workspace.test.js`
- Install hook in tmpdir with `.compose/compose.json` containing `workspaceId: "test-ws"` → file contains `COMPOSE_WORKSPACE_ID="test-ws"`
- `compose hooks status` on stale install → reports `STALE_WORKSPACE_ID`
- `compose hooks status` on legacy install (no token) → reports `MISSING_WORKSPACE_ID`

#### `compose/test/golden/multi-workspace.test.js` (golden flow)
Tmpdir with `forge-top/.compose/` containing nested `forge-top/compose/.compose/`:
1. `cd forge-top && compose feature COMP-FOO --workspace=compose` → feature lands in `forge-top/compose/docs/features/COMP-FOO/`
2. Without `--workspace`, ambiguous → exits 1 with candidate list on stderr
3. After `export COMPOSE_TARGET=$TMPDIR/forge-top/compose` (absolute path) → bypasses discovery entirely, scaffolds correctly even with TooBroad descendants. (Setting `COMPOSE_TARGET=compose` as an ID still works but routes through discovery.)

---

## Order of operations

Phase-7 tasks land in this order (Phase 6 turns these into the task list):

1. **`lib/discover-workspaces.js` + tests** — pure, no integration.
2. **`lib/resolve-workspace.js` + tests** — depends on #1.
3. **`bin/compose.js` cwd migration** — replace 17 sites; add `--workspace` flag; `dieOnWorkspaceError` helper.
4. **Hook templates + install/status update** — depends on #2.
5. **`hooks-workspace.test.js`** — verify install + status.
6. **`compose-mcp.js` + `compose-mcp-tools.js`** — drop line 14 cache; convert VISION_FILE/SESSIONS_FILE to functions; add `set_workspace`/`get_workspace` tools.
7. **`server/project-root.js`** — add `getCurrentWorkspaceId`/`setCurrentWorkspaceId`.
8. **Golden flow** — exercises everything end-to-end.
9. **Folder relocation** — once everything works, run `compose feature` from forge-top with `--workspace=compose` to recreate the COMP-WORKSPACE-ID folder under `compose/docs/features/`. Move artifacts (forge-top isn't a git repo so no rename history to preserve).

---

## Verification table (all file:line refs)

| File | Line | Claim | Verified |
|---|---|---|---|
| `server/find-root.js` | 12 | `MARKERS = ['.compose', '.stratum.yaml', '.git']` | ✓ |
| `server/find-root.js` | 19–28 | `findProjectRoot` walks ancestors only | ✓ |
| `server/project-root.js` | 30–40 | `_targetRoot` IIFE-initialized, never re-evaluated | ✓ |
| `server/project-root.js` | 70 | `switchProject(newRoot)` exists | ✓ |
| `server/project-root.js` | 61 | `onProjectSwitch(fn)` listener registry | ✓ |
| `server/project-root.js` | 105 | `loadProjectConfig()` reads `.compose/compose.json` | ✓ |
| `server/compose-mcp-tools.js` | 14 | `PROJECT_ROOT = getTargetRoot()` import-time snapshot | ✓ |
| `server/compose-mcp-tools.js` | 15–16 | `VISION_FILE`, `SESSIONS_FILE` frozen via `path.join(getDataDir(), …)` | ✓ |
| `server/compose-mcp-tools.js` | 302 | `toolValidateProject` uses `getTargetRoot()` per call | ✓ |
| `server/compose-mcp-tools.js` | 308 | `toolBindSession` POSTs to `/api/session/bind` | ✓ |
| `server/compose-mcp.js` | 144 | `bind_session` tool def begins (semantic: feature lifecycle, not workspace) | ✓ (re-verified by grep) |
| `server/compose-mcp.js` | 581 | dispatch case for `bind_session` | ✓ |
| `server/index.js` | 12 | imports `switchProject` from project-root.js | ✓ |
| `server/index.js` | 63 | `POST /api/project/switch` exists; calls `switchProject` | ✓ |
| `server/session-routes.js` | 75 | `POST /api/session/bind` is feature-lifecycle binding (requires `featureCode`, one-shot) | ✓ |
| `server/session-store.js` | 1–107 | pure helpers; no project-root dependency | ✓ |
| `bin/compose.js` | 17 | imports `findProjectRoot` from `server/find-root.js` | ✓ |
| `bin/compose.js` | 29 | `[,, cmd, ...args] = process.argv` (per-subcommand parsing) | ✓ |
| `bin/compose.js` | 270, 519, 626, 667, 795, 961, 970, 989, 1110, 1528, 1529, 1572, 1653, 1728, 1815, 1890, 2189 | bare `process.cwd()` (17 sites; verified via `grep -n "process.cwd()"` = 20 hits, 3 of which are inside `findProjectRoot()` calls below) | ✓ |
| `bin/compose.js` | 1267, 1335, 1863 | `findProjectRoot(process.cwd())` | ✓ |
| `bin/compose.js` | 1289 | `compose hooks {install,uninstall,status}` entry | ✓ |
| `bin/compose.js` | 1371 | `installOne` substitutes `__COMPOSE_NODE__`, `__COMPOSE_BIN__` | ✓ |
| `bin/compose.js` | 1418 | `statusOne` checks node/bin path freshness | ✓ |
| `bin/git-hooks/post-commit.template` | 7–8 | template tokens for substitution | ✓ |
| `bin/git-hooks/post-commit.template` | 54–55 | calls `record-completion` with flags | ✓ |
| `bin/git-hooks/pre-push.template` | 12 | calls `validate --scope=project` | ✓ |
| `lib/project-paths.js` | 24 | `loadFeaturesDir(cwd)` reads `.compose/compose.json` per call (no cache) | ✓ |

All verified by reading the actual files at the cited lines during Phase 1 + Phase 4 exploration. No stale references.

## Out-of-scope (filed as follow-ups)

- **`COMP-WORKSPACE-HTTP`** — migrate the 6 verified HTTP-server-process import-time snapshots (vision-routes.js:53, vision-utils.js:15, session-manager.js:19, agent-spawn.js:13, file-watcher.js:14, summarizer.js:13) to per-request workspace via Express middleware.
- **`COMP-WORKSPACE-WATCHERS`** — runtime rebinding for long-lived watchers (`file-watcher.js`, `cc-session-watcher.js`).
- **`COMP-WORKSPACE-RESUME`** — persist binding keyed by `CLAUDE_SESSION_ID` env var if Claude Code starts injecting one.
- **`COMP-CLI-GLOBAL-FLAGS`** — pre-subcommand flag parser (would let `compose --workspace=X build …` work; v1 requires post-subcommand).

## Open questions resolved during blueprint

- **Folder relocation:** deferred to step 9 of the order above; v1 implementation lives in `forge-top/docs/features/COMP-WORKSPACE-ID/`.
- **Legacy `.compose/compose.json` without `workspaceId`:** auto-derive from basename on read; never write back. (See `discover-workspaces.js` `deriveId`.)

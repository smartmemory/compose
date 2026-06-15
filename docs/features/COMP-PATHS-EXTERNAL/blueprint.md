# COMP-PATHS-EXTERNAL Implementation Plan (blueprint)

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a Compose workspace point its artifact paths (ROADMAP, features, journal, context, ideabox) at a folder — or a separate repo — outside the workspace root, while `.compose/` (config + state) stays at the root.

**Architecture:** One pure resolver (`lib/paths-core.js`) + one default table, fronted by absolute-returning readers in `lib/project-paths.js`, consumed everywhere. Resolution uses `path.resolve` (handles in-root, `../`-escaping, absolute) — never `path.join`. Three slices: **S1** resolver core, **S2** sweep every consumer + migrate the relative-`featuresDir` API (the core ask), **S3** make `compose build`'s ship/completion/enforcement git-repo-aware.

**Tech Stack:** Node ESM, `node --test` (flat `test/*.test.js`, `--test-timeout=120000`), `node:path`, `node:fs`.

**Source of truth:** `docs/features/COMP-PATHS-EXTERNAL/design.md` (decisions referenced as D1–D7). Run a single test file with `node --test --test-timeout=120000 test/<file>.test.js`.

---

## File Structure

| File | New/Mod | Responsibility |
|------|---------|----------------|
| `lib/paths-core.js` | **new** | Pure `DEFAULT_PATHS` + `resolvePathValue(root,value,key)` + `relForDisplay(root,abs)`. No `fs`. |
| `lib/project-paths.js` | mod | Absolute readers `resolve*Path(root)` + `*FromConfig(root,config)`; import `DEFAULT_PATHS`. |
| `server/project-root.js` | mod | `resolveProjectPath(key)` delegates to `paths-core`; `roadmap` default. |
| `lib/feature-validator.js` | mod | Drop local `DEFAULT_PATHS`; resolve roadmap via reader. |
| `lib/feature-json.js` | mod | Resolve `featuresDir` base (D7) — absolute/escaping safe. |
| `lib/feature-write-guard.js` | mod | `{features,roadmap}` via resolvers (D7). |
| `lib/roadmap-gen.js`, `lib/build-all.js`, `lib/feature-writer.js`, `lib/followup-writer.js`, `lib/roadmap-graph/collect.js`, `lib/get-roadmap.js`, `lib/migrate-roadmap.js` | mod | ROADMAP path via `resolveRoadmapPath`. |
| `server/vision-server.js`, `server/drift-axes.js`, `server/session-routes.js`, `server/design-routes.js`, `lib/checkpoint/checkpoint-writer.js`, `lib/gsd.js`, `server/feature-scan.js` | mod | features path via `resolveFeaturesPath` / `relForDisplay`. |
| `lib/journal-writer.js`, `server/vision-utils.js`, `lib/build.js` (context), `server/ideabox-routes.js`, `bin/compose.js` | mod | journal/context/ideabox via resolvers; kill `join(cwd,rel)`. |
| `lib/xref-sync.js`, `lib/roadmap-graph/collect.js`, `lib/triage.js` | mod | callers: relative `loadFeaturesDir`→absolute `resolveFeaturesPath`. |
| `server/vision-routes.js`, `server/vision-utils.js` | mod | alternate-root: `*FromConfig(root, loadComposeConfig(root))`. |
| `lib/build.js` (ship) | mod | per-file git toplevel commit; call completion on every exit path (S3). |
| `lib/completion-writer.js` | mod | **(Codex)** nullable `commit_sha` (`:154`), sha-less `completion_id` (`:265`), accept absolute `files_changed` (`:173`) — S3. |
| `lib/mcp-enforcement.js` | mod | resolution-aware guarded-path match in `scanGuarded` (`:122`) — S3. |
| `bin/compose.js` (`compose feature`) | mod | **(Codex)** roadmap row-append/reads at `:1045,1160,1353` via `resolveRoadmapPath` (S2). |
| `lib/xref-push.js`, `lib/state-migrations.js`, `lib/roadmap-graph/index.js`, `lib/tracker/local-provider.js`, `lib/build.js:608` | mod | **(Codex)** additional relative-`featuresDir` callers to migrate (S2). |
| `bin/compose.js` (init), config docs | mod | scaffold `paths.roadmap`. |
| `test/paths-core.test.js` | **new** | resolver unit table + relForDisplay + default-identity. |
| `test/project-paths.test.js` | mod | new readers + `*FromConfig`. |
| `test/integration/paths-external.test.js` | **new** | golden flow into an external dir; S3 ship/completion. |

---

# SLICE S1 — Resolver core + default table

*No behavior change for existing workspaces — the default-identity test is the gate.*

### Task 1: Pure resolver `lib/paths-core.js`

**Files:**
- Create: `lib/paths-core.js`
- Test: `test/paths-core.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/paths-core.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DEFAULT_PATHS, resolvePathValue, relForDisplay } from '../lib/paths-core.js';

describe('DEFAULT_PATHS', () => {
  test('has all six artifact keys with legacy values', () => {
    assert.deepEqual(DEFAULT_PATHS, {
      docs: 'docs',
      roadmap: 'ROADMAP.md',
      features: 'docs/features',
      journal: 'docs/journal',
      context: 'docs/context',
      ideabox: 'docs/product/ideabox.md',
    });
  });
});

describe('resolvePathValue', () => {
  const root = '/work/proj';
  test('in-root relative → joined under root', () => {
    assert.equal(resolvePathValue(root, 'docs/features', 'features'), '/work/proj/docs/features');
  });
  test('../-escaping relative → resolves outside root', () => {
    assert.equal(resolvePathValue(root, '../sib/features', 'features'), '/work/sib/features');
  });
  test('absolute → used as-is (normalized), NOT joined under root', () => {
    assert.equal(resolvePathValue(root, '/abs/x/features', 'features'), '/abs/x/features');
  });
  test('absent/empty/whitespace/non-string → default for key, under root', () => {
    for (const v of [undefined, null, '', '   ', 42, {}]) {
      assert.equal(resolvePathValue(root, v, 'roadmap'), '/work/proj/ROADMAP.md');
    }
  });
  test('always returns an absolute, normalized path', () => {
    const out = resolvePathValue(root, 'a/../b/./c', 'features');
    assert.ok(path.isAbsolute(out));
    assert.equal(out, '/work/proj/b/c');
  });
});

describe('relForDisplay', () => {
  const root = '/work/proj';
  test('in-root path → clean relative', () => {
    assert.equal(relForDisplay(root, '/work/proj/docs/features/X'), 'docs/features/X');
  });
  test('escaping path → absolute (no ../ soup)', () => {
    assert.equal(relForDisplay(root, '/work/sib/ROADMAP.md'), '/work/sib/ROADMAP.md');
  });
  test('exact root → "."', () => {
    assert.equal(relForDisplay(root, '/work/proj'), '.');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-timeout=120000 test/paths-core.test.js`
Expected: FAIL — `Cannot find module '../lib/paths-core.js'`.

- [ ] **Step 3: Implement `lib/paths-core.js`**

```js
/**
 * paths-core.js — PURE artifact-path resolution. No fs, no config reading.
 * Single source of truth for default artifact locations (COMP-PATHS-EXTERNAL).
 *
 * `resolvePathValue` uses path.resolve (NOT path.join) so an absolute or
 * ../-escaping `paths.*` override resolves correctly instead of being
 * silently re-rooted under cwd.
 */
import path from 'node:path';

export const DEFAULT_PATHS = Object.freeze({
  docs: 'docs',
  roadmap: 'ROADMAP.md',
  features: 'docs/features',
  journal: 'docs/journal',
  context: 'docs/context',
  ideabox: 'docs/product/ideabox.md',
});

/**
 * @param {string} root  Absolute workspace root.
 * @param {*} value       The configured paths[key] value (any type).
 * @param {string} key    Fallback key into DEFAULT_PATHS when value is unusable.
 * @returns {string}      Absolute, normalized path.
 */
export function resolvePathValue(root, value, key) {
  const v = (typeof value === 'string' && value.trim().length > 0)
    ? value
    : DEFAULT_PATHS[key];
  return path.isAbsolute(v) ? path.normalize(v) : path.resolve(root, v);
}

/**
 * Display-safe relativization: a clean root-relative string when `abs` is
 * inside `root`, else the absolute path (never a `../`-prefixed string).
 */
export function relForDisplay(root, abs) {
  const rel = path.relative(root, abs);
  if (rel === '') return '.';
  return rel.startsWith('..') || path.isAbsolute(rel) ? abs : rel;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test --test-timeout=120000 test/paths-core.test.js`
Expected: PASS (all describes green).

- [ ] **Step 5: Commit**

```bash
git add lib/paths-core.js test/paths-core.test.js
git commit -m "COMP-PATHS-EXTERNAL S1: pure paths-core resolver + default table"
```

---

### Task 2: Absolute readers in `lib/project-paths.js`

**Files:**
- Modify: `lib/project-paths.js`
- Test: `test/project-paths.test.js` (extend)

- [ ] **Step 1: Write the failing test** (append to `test/project-paths.test.js`)

```js
import {
  resolveFeaturesPath, resolveRoadmapPath, resolveJournalPath,
  resolveContextPath, resolveIdeaboxPath, resolveDocsPath,
  resolveFeaturesPathFromConfig,
} from '../lib/project-paths.js';
import { join as pjoin } from 'node:path';

describe('resolve*Path readers (absolute)', () => {
  test('default-identity: unset config → legacy absolute path per key', () => {
    const cwd = freshCwd();
    assert.equal(resolveDocsPath(cwd),    pjoin(cwd, 'docs'));
    assert.equal(resolveRoadmapPath(cwd), pjoin(cwd, 'ROADMAP.md'));
    assert.equal(resolveFeaturesPath(cwd),pjoin(cwd, 'docs/features'));
    assert.equal(resolveJournalPath(cwd), pjoin(cwd, 'docs/journal'));
    assert.equal(resolveContextPath(cwd), pjoin(cwd, 'docs/context'));
    assert.equal(resolveIdeaboxPath(cwd), pjoin(cwd, 'docs/product/ideabox.md'));
  });

  test('honors an absolute override (not re-rooted under cwd)', () => {
    const cwd = freshCwd();
    writeConfig(cwd, { paths: { features: '/external/docs/features', roadmap: '/external/ROADMAP.md' } });
    assert.equal(resolveFeaturesPath(cwd), '/external/docs/features');
    assert.equal(resolveRoadmapPath(cwd), '/external/ROADMAP.md');
  });

  test('honors a ../-escaping override', () => {
    const cwd = freshCwd();
    writeConfig(cwd, { paths: { features: '../shared-docs/features' } });
    assert.equal(resolveFeaturesPath(cwd), pjoin(cwd, '../shared-docs/features'));
  });

  test('*FromConfig resolves against the PASSED root/config, not a file read', () => {
    const out = resolveFeaturesPathFromConfig('/other/root', { paths: { features: 'specs/f' } });
    assert.equal(out, '/other/root/specs/f');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-timeout=120000 test/project-paths.test.js`
Expected: FAIL — `resolveFeaturesPath is not a function`.

- [ ] **Step 3: Implement** — rewrite `lib/project-paths.js` to delegate to `paths-core`

```js
/**
 * project-paths.js — read .compose/compose.json and resolve artifact paths
 * for lib-side code. Delegates all path math to lib/paths-core.js so server
 * and lib never diverge. (COMP-MCP-MIGRATION-2, extended by COMP-PATHS-EXTERNAL.)
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_PATHS, resolvePathValue, relForDisplay } from './paths-core.js';

function readConfig(cwd) {
  const cfgPath = join(cwd, '.compose', 'compose.json');
  if (!existsSync(cfgPath)) return {};
  try { return JSON.parse(readFileSync(cfgPath, 'utf-8')); }
  catch { return {}; }
}

/** Resolve one artifact key against the config on disk at `cwd`. Absolute. */
function resolveKey(cwd, key) {
  return resolvePathValue(cwd, readConfig(cwd)?.paths?.[key], key);
}
/** Resolve one artifact key against an already-loaded config + arbitrary root. Absolute. */
function resolveKeyFromConfig(root, config, key) {
  return resolvePathValue(root, config?.paths?.[key], key);
}

export const resolveDocsPath     = (cwd) => resolveKey(cwd, 'docs');
export const resolveRoadmapPath  = (cwd) => resolveKey(cwd, 'roadmap');
export const resolveFeaturesPath = (cwd) => resolveKey(cwd, 'features');
export const resolveJournalPath  = (cwd) => resolveKey(cwd, 'journal');
export const resolveContextPath  = (cwd) => resolveKey(cwd, 'context');
export const resolveIdeaboxPath  = (cwd) => resolveKey(cwd, 'ideabox');

export const resolveFeaturesPathFromConfig = (root, config) => resolveKeyFromConfig(root, config, 'features');
export const resolveRoadmapPathFromConfig  = (root, config) => resolveKeyFromConfig(root, config, 'roadmap');
export const resolveJournalPathFromConfig  = (root, config) => resolveKeyFromConfig(root, config, 'journal');

export { relForDisplay };

/**
 * @deprecated relative form — use resolveFeaturesPath. Kept until all callers
 * migrate (COMP-PATHS-EXTERNAL S2). Returns the configured RELATIVE string.
 */
export function loadFeaturesDir(cwd) {
  const rel = readConfig(cwd)?.paths?.features;
  return (typeof rel === 'string' && rel.length > 0) ? rel : DEFAULT_PATHS.features;
}

export function loadExternalPrefixes(cwd) {
  const arr = readConfig(cwd)?.externalPrefixes;
  return Array.isArray(arr) ? arr : [];
}

export const _internals = { DEFAULT_FEATURES_DIR: DEFAULT_PATHS.features };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test --test-timeout=120000 test/project-paths.test.js`
Expected: PASS — existing `loadFeaturesDir`/`loadExternalPrefixes` tests still green (behavior preserved) + new readers green.

- [ ] **Step 5: Commit**

```bash
git add lib/project-paths.js test/project-paths.test.js
git commit -m "COMP-PATHS-EXTERNAL S1: absolute path readers + FromConfig form"
```

---

### Task 3: `server/project-root.js` delegates + gains `roadmap`

**Files:**
- Modify: `server/project-root.js:99-126`
- Test: `test/project-config.test.js` (extend) — covers `resolveProjectPath`

- [ ] **Step 1: Write the failing test** (append to `test/project-config.test.js`; follow that file's existing helper for setting target root — it already exercises `resolveProjectPath`)

```js
// Within test/project-config.test.js, in the resolveProjectPath describe block:
test('resolveProjectPath supports roadmap key (default ROADMAP.md)', () => {
  // (uses the file's existing harness to bind a temp target root `root`)
  assert.equal(resolveProjectPath('roadmap'), join(root, 'ROADMAP.md'));
});
test('resolveProjectPath honors an absolute features override', () => {
  writeTargetConfig({ paths: { features: '/ext/features' } }); // harness helper
  assert.equal(resolveProjectPath('features'), '/ext/features');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-timeout=120000 test/project-config.test.js`
Expected: FAIL — roadmap resolves to `join(root,'roadmap')` (the `key` fallback) or absolute override is re-rooted.

- [ ] **Step 3: Implement** — edit `server/project-root.js`

Replace the `DEFAULT_CONFIG.paths` literal (line ~102) and `resolveProjectPath` (lines 121-126):

```js
import { DEFAULT_PATHS, resolvePathValue } from '../lib/paths-core.js';
// ...
const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  capabilities: Object.freeze({ stratum: true, lifecycle: true }),
  paths: DEFAULT_PATHS,                       // <- single source of truth
});
// ...
export function resolveProjectPath(key) {
  const config = loadProjectConfig();
  return resolvePathValue(getTargetRoot(), config.paths?.[key], key);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test --test-timeout=120000 test/project-config.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/project-root.js test/project-config.test.js
git commit -m "COMP-PATHS-EXTERNAL S1: server resolveProjectPath delegates to paths-core, adds roadmap"
```

---

### Task 4: Remove the last duplicated default table

**Files:**
- Modify: `lib/feature-validator.js:54` (`const DEFAULT_PATHS = {...}`) and `:115` (roadmap join)

- [ ] **Step 1: Write the failing test** (append to `test/paths-core.test.js`)

```js
test('feature-validator imports the shared DEFAULT_PATHS (no local copy)', async () => {
  const src = await import('node:fs').then(m => m.readFileSync('lib/feature-validator.js', 'utf-8'));
  assert.ok(!/const\s+DEFAULT_PATHS\s*=\s*\{/.test(src), 'feature-validator must not define its own DEFAULT_PATHS');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-timeout=120000 test/paths-core.test.js`
Expected: FAIL — local `DEFAULT_PATHS` still present.

- [ ] **Step 3: Implement** — in `lib/feature-validator.js`: delete the local `DEFAULT_PATHS` const (line 54); add `import { DEFAULT_PATHS } from './paths-core.js';` and `import { resolveRoadmapPath } from './project-paths.js';`; change line 115 `roadmap: path.join(cwd, 'ROADMAP.md')` → `roadmap: resolveRoadmapPath(cwd)`. Repoint any `DEFAULT_PATHS.x` references to the import (same shape, so values unchanged).

- [ ] **Step 4: Run to verify it passes**

Run: `node --test --test-timeout=120000 test/paths-core.test.js test/feature-validator*.test.js`
Expected: PASS — validator tests unchanged (default-identity holds).

- [ ] **Step 5: Commit**

```bash
git add lib/feature-validator.js test/paths-core.test.js
git commit -m "COMP-PATHS-EXTERNAL S1: drop duplicated DEFAULT_PATHS in feature-validator"
```

---

### Task 5: S1 gate — full suite green, no behavior change

- [ ] **Step 1:** Run the node suite: `npm test 2>&1 | tail -30` (or, to avoid the proof-run hang, `node --test --test-timeout=90000 test/*.test.js test/integration/*.test.js`).
  Expected: same pass/fail set as before S1 (default-identity ⇒ zero behavior change). Investigate any newly-red test before proceeding.
- [ ] **Step 2: Commit** (only if a fixup was needed): `git commit -am "COMP-PATHS-EXTERNAL S1: suite-green fixups"`.

---

# SLICE S2 — Sweep consumers + featuresDir API migration (the core ask)

### Task 6: `feature-json.js` resolves its base (D7)

**Files:**
- Modify: `lib/feature-json.js:36-37,57-69,117-118,157-158`
- Test: `test/feature-json-external.test.js` (**new**)

- [ ] **Step 1: Write the failing test**

```js
// test/feature-json-external.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFeature, readFeature, listFeatures } from '../lib/feature-json.js';

describe('feature-json with absolute featuresDir (D7)', () => {
  test('writes/reads into an ABSOLUTE external dir, not <cwd>/abs', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'fj-cwd-'));
    const ext = mkdtempSync(join(tmpdir(), 'fj-ext-'));      // a different root
    const featuresAbs = join(ext, 'features');
    const feat = { code: 'X-1', description: 'd', status: 'PLANNED' };

    writeFeature(cwd, feat, featuresAbs);
    assert.ok(existsSync(join(featuresAbs, 'X-1', 'feature.json')), 'feature.json lands in the external dir');
    assert.ok(!existsSync(join(cwd, ext, 'features', 'X-1')), 'must NOT be re-rooted under cwd');

    assert.equal(readFeature(cwd, 'X-1', featuresAbs)?.code, 'X-1');
    assert.deepEqual(listFeatures(cwd, featuresAbs).map(f => f.code), ['X-1']);
  });

  test('relative featuresDir still works under cwd (back-compat)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'fj-rel-'));
    writeFeature(cwd, { code: 'Y-1', description: 'd', status: 'PLANNED' }, 'docs/features');
    assert.ok(existsSync(join(cwd, 'docs/features/Y-1/feature.json')));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-timeout=120000 test/feature-json-external.test.js`
Expected: FAIL — `join(cwd, '/abs/...')` re-roots, file lands under `<cwd>/abs`.

- [ ] **Step 3: Implement** — in `lib/feature-json.js` add `import { resolvePathValue } from './paths-core.js';` and a local helper, then replace each `join(cwd, featuresDir, …)` base:

```js
// helper near the top of feature-json.js
function featuresBase(cwd, featuresDir) {
  // absolute/escaping safe; identical to join(cwd, rel) for plain relative dirs
  return resolvePathValue(cwd, featuresDir, 'features');
}
```
Then:
- line 37: `const path = join(featuresBase(cwd, featuresDir), code, 'feature.json');`
- line 69: `const dir = join(featuresBase(cwd, featuresDir), feature.code);`
- line 118: `const dir = featuresBase(cwd, featuresDir);`
- `updateFeature` (157-161) is unchanged (delegates to read/write).

- [ ] **Step 4: Run to verify it passes**

Run: `node --test --test-timeout=120000 test/feature-json-external.test.js test/feature-writer-paths.test.js`
Expected: PASS — external + back-compat both green.

- [ ] **Step 5: Commit**

```bash
git add lib/feature-json.js test/feature-json-external.test.js
git commit -m "COMP-PATHS-EXTERNAL S2: feature-json resolves featuresDir base (absolute-safe, D7)"
```

---

### Task 7: `feature-write-guard.js` via resolvers

**Files:**
- Modify: `lib/feature-write-guard.js:85-89`

- [ ] **Step 1: Write the failing test** (append to `test/feature-json-external.test.js`)

```js
import { computeGuardedPaths } from '../lib/feature-write-guard.js'; // adjust to the real export name
test('write-guard reports the external roadmap/features as guarded', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fg-'));
  // config points features+roadmap outside cwd
  // (use the file's writeConfig helper)
  // ...
  const g = computeGuardedPaths(cwd);
  assert.ok(g.roadmap.startsWith('/'));      // absolute
  assert.ok(g.features.startsWith('/'));
});
```
*(If the function/exports differ, mirror the actual signature — the assertion is: guarded `roadmap`/`features` are the resolved absolute paths, not `join(cwd,…)`.)*

- [ ] **Step 2: Run** — `node --test --test-timeout=120000 test/feature-json-external.test.js` → FAIL (still `join(cwd,…)`).

- [ ] **Step 3: Implement** — in `lib/feature-write-guard.js`, import `resolveFeaturesPath, resolveRoadmapPath` and replace lines 86-87:

```js
return {
  features: resolveFeaturesPath(cwd),
  roadmap: resolveRoadmapPath(cwd),
  visionState: join(cwd, '.compose', 'data', 'vision-state.json'),  // stays at root (D4)
};
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -am "COMP-PATHS-EXTERNAL S2: feature-write-guard uses resolved artifact paths"`.

---

### Task 8: Sweep the ~11 hardcoded ROADMAP sites

**Files (each: replace `join(cwd|root, 'ROADMAP.md')` → `resolveRoadmapPath(cwd|root)`):**
`lib/roadmap-gen.js:210,516` · `lib/build-all.js:34` (keep `opts.roadmapPath ?? resolveRoadmapPath(cwd)`) · `lib/feature-writer.js:241,731` · `lib/followup-writer.js:512` (note: uses `resolve(cwd,'ROADMAP.md')` — same fix) · `lib/roadmap-graph/collect.js:65` · `lib/get-roadmap.js:59` · `lib/migrate-roadmap.js:34`. (`feature-validator.js:115` done in Task 4.)
**CLI (Codex plan-gate — `compose feature` would otherwise write external `feature.json` but append rows to a LOCAL roadmap):** `bin/compose.js:1045` (the row-append in the `compose feature` path — must target `resolveRoadmapPath(cwd)`), plus the hardcoded local roadmap reads at `bin/compose.js:1160,1353`. `bin/compose.js:945` already honors `paths.features`, so the features side is fine — only the roadmap side splits.

- [ ] **Step 1: Write the failing test** (`test/integration/paths-external.test.js`, **new** — the golden gate for the whole sweep; see Task 15 for the full version). Minimal first assertion:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getRoadmap } from '../../lib/get-roadmap.js'; // adjust to real export

test('get-roadmap reads ROADMAP from an external configured path', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pe-cwd-'));
  const ext = mkdtempSync(join(tmpdir(), 'pe-ext-'));
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  writeFileSync(join(cwd, '.compose/compose.json'),
    JSON.stringify({ paths: { roadmap: join(ext, 'ROADMAP.md') } }));
  writeFileSync(join(ext, 'ROADMAP.md'), '# Roadmap\n\n## P\n\n| # | Feature | Description | Status |\n|-|-|-|-|\n| 1 | A-1 | x | PLANNED |\n');
  const rm = getRoadmap(cwd);            // or the real call shape
  assert.ok(JSON.stringify(rm).includes('A-1'), 'reads the external roadmap');
});
```

- [ ] **Step 2: Run** → FAIL (reads `cwd/ROADMAP.md`, which is absent).
- [ ] **Step 3: Implement** — apply the mechanical replacement at every site above. Each file: add `import { resolveRoadmapPath } from './project-paths.js';` (adjust relative depth for `roadmap-graph/collect.js`) and swap the join.
- [ ] **Step 4: Run** → PASS. Also run `node --test --test-timeout=120000 test/roadmap*.test.js test/get-roadmap*.test.js` → unchanged green (default-identity).
- [ ] **Step 5: Commit** — `git commit -am "COMP-PATHS-EXTERNAL S2: route all ROADMAP.md sites through resolveRoadmapPath"`.

---

### Task 9: Sweep the ~7 hardcoded `docs/features` sites

**Files:** `server/vision-server.js:267` · `server/drift-axes.js:358` · `server/session-routes.js:143` · `server/design-routes.js:450` (display string — use `relForDisplay`) · `lib/checkpoint/checkpoint-writer.js:78,124` · `lib/gsd.js:65` · `server/feature-scan.js:626` (display list — `relForDisplay`).

> **Load-bearing (Codex):** `session-routes:143`, `checkpoint-writer:78,124`, `gsd:65`, `drift-axes:358` drive resume / checkpoint / GSD — miss any one and those flows read the *wrong* tree silently. And `feature-scan.js:626` (`item.files = docs/features/...`) is matched by root-relative string-slicing in `vision-server.js:459` — **these two must change together**, or UI file-matching / item resolution drifts. Make both sides go through `relForDisplay(root, abs)` against the resolved features path in the same task.

- [ ] **Step 1:** Add an integration assertion (in `test/integration/paths-external.test.js`): scaffold a feature with an external features dir, assert the lifecycle scan + checkpoint resolve into the external dir (full version in Task 15).
- [ ] **Step 2: Run** → FAIL where a site still hardcodes `docs/features`.
- [ ] **Step 3: Implement** — server sites use `resolveProjectPath('features')`; lib sites use `resolveFeaturesPath(cwd)`. For the two **display** sites (`design-routes.js:450`, `feature-scan.js:626`) build the shown path from the resolved absolute via `relForDisplay(root, abs)` rather than hardcoding `docs/features/...`.
  - e.g. `feature-scan.js:626`: `files: feature.artifacts.map(a => relForDisplay(root, join(resolveFeaturesPath(root), feature.name, a)))`.
- [ ] **Step 4: Run** → PASS; `node --test --test-timeout=120000 test/*checkpoint*.test.js test/*drift*.test.js` unchanged green.
- [ ] **Step 5: Commit** — `git commit -am "COMP-PATHS-EXTERNAL S2: route all docs/features sites through resolveFeaturesPath/relForDisplay"`.

---

### Task 10: journal / context / ideabox consumers + `JOURNAL_DIR`

**Files:** `lib/journal-writer.js:37` (`JOURNAL_DIR` const → resolver) · `server/vision-utils.js:75` (journal; `join`→resolver) · `lib/build.js:666` (context; `join`→`resolveContextPath`) · `server/ideabox-routes.js:44,55` · `bin/compose.js` ideabox reads (`:467,817,2411`).

- [ ] **Step 1:** Integration assertion: with `paths.journal`/`paths.context`/`paths.ideabox` set external, the respective reader/writer resolves into the external dir (extend Task 15 test).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — replace each `config.paths?.x || 'docs/...'` + `join(cwd,rel)` with the matching `resolve*Path(cwd)` (or `*FromConfig` where a config object is already in hand). For `journal-writer.js`, replace the module-level `JOURNAL_DIR` const usage with a call to `resolveJournalPath(cwd)` at the point of use (the writer already receives `cwd`).
- [ ] **Step 4: Run** → PASS; `node --test --test-timeout=120000 test/*journal*.test.js test/*ideabox*.test.js` unchanged green.
- [ ] **Step 5: Commit** — `git commit -am "COMP-PATHS-EXTERNAL S2: journal/context/ideabox via resolvers"`.

---

### Task 11: Migrate relative `loadFeaturesDir` callers → absolute

**Files (Codex-expanded — the migration blast radius is wider than the core CRUD path):** `lib/xref-sync.js:103` · `lib/roadmap-graph/collect.js:31` · `lib/triage.js:240` · `lib/xref-push.js:174` · `lib/state-migrations.js:286` · `lib/roadmap-graph/index.js:25` · `lib/tracker/local-provider.js:41` · `lib/build.js:608`. **Before implementing, run `grep -rn "loadFeaturesDir(" lib server bin` and migrate EVERY hit** — `loadFeaturesDir` (relative) is being retired; any straggler that does `join(cwd, loadFeaturesDir(cwd))` will re-root an external path under `cwd` (or break graph/migration/ship flows) once callers expect absolute.

- [ ] **Step 1: Write the failing test** — add to `test/feature-json-external.test.js`: an `xref-sync` (or `triage`) run against a workspace whose `paths.features` is absolute resolves features from the external dir, not `<cwd>/abs`.
- [ ] **Step 2: Run** → FAIL (caller does `join(cwd, loadFeaturesDir(cwd))`).
- [ ] **Step 3: Implement** — in each caller, replace `const featuresDir = loadFeaturesDir(cwd); … join(cwd, featuresDir)` with `const featuresDir = resolveFeaturesPath(cwd);` and drop the `join(cwd, …)` (the value is already absolute; pass it straight to `feature-json.js`, which now accepts absolute bases). Update imports.
- [ ] **Step 4: Run** → PASS; `node --test --test-timeout=120000 test/*xref*.test.js test/*triage*.test.js` green.
- [ ] **Step 5: Commit** — `git commit -am "COMP-PATHS-EXTERNAL S2: migrate loadFeaturesDir callers to absolute resolveFeaturesPath"`.

---

### Task 12: Alternate-root routes use `*FromConfig` (Codex finding 3)

**Files:** `server/vision-routes.js:169` · `server/vision-utils.js:73`

- [ ] **Step 1: Write the failing test** — a route/unit test that resolves journal/features for a `projectRoot` ≠ bound `getTargetRoot()` returns paths under the *passed* root. (If a focused unit is awkward, assert via `resolveFeaturesPathFromConfig` that the alternate path is used; cover the route in Task 15.)
- [ ] **Step 2: Run** → FAIL (reads global cached `loadProjectConfig()` → resolves under the bound target).
- [ ] **Step 3: Implement** — at these call sites, load the config for the route's own root (`loadComposeConfig(projectRoot)` / `loadProjectConfigFor(projectRoot)`; reuse the lib reader) and call `resolveFeaturesPathFromConfig(projectRoot, cfg)` / `resolveJournalPathFromConfig(projectRoot, cfg)` instead of the cached-singleton resolver. **Note (Codex):** `vision-utils.js:73` currently *ignores its own `projectRoot` parameter* and reads the global cache — wire the passed `projectRoot` through, don't just swap the resolver.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -am "COMP-PATHS-EXTERNAL S2: alternate-root routes resolve against their own root/config"`.

---

### Task 13: `compose init` scaffolds `paths.roadmap` + docs

**Files:** `bin/compose.js` (the init `paths` block, ~`:413-418`) · README / config docs

- [ ] **Step 1: Write the failing test** — `test/config-paths.test.js`: run init scaffolding (or assert the scaffolded `paths` object) and check `paths.roadmap === 'ROADMAP.md'` is written alongside `features/journal/context/ideabox`.
- [ ] **Step 2: Run** → FAIL (no `roadmap` key scaffolded).
- [ ] **Step 3: Implement** — add `roadmap: 'ROADMAP.md'` to the init `paths` literal; document `paths.roadmap` (and that any `paths.*` may be in-root, `../`-escaping, or absolute) in the config section of `README.md`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -am "COMP-PATHS-EXTERNAL S2: init scaffolds paths.roadmap; document relocatable paths"`.

---

### Task 14: `validate` resolves via shared readers + unreachable-parent error

**Files:** `lib/feature-validator.js` (paths map already done Task 4) · the validate entry that checks artifact existence

- [ ] **Step 1: Write the failing test** — `test/<validate>.test.js`: (a) a not-yet-created external features dir does NOT error (writers mkdir); (b) a configured features path whose **parent** does not exist (e.g. `/no/such/root/features`) yields a clear validation error naming the resolved absolute path.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — ensure validate resolves roadmap/features via the readers; add a parent-reachability check: `if (!existsSync(dirname(resolved))) → finding("configured <key> parent unreachable: <resolved>")`. Do **not** error merely because the leaf dir is absent.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -am "COMP-PATHS-EXTERNAL S2: validate resolves external paths; unreachable-parent error"`.

---

### Task 15: S2 golden flow — full lifecycle into an external dir

**Files:** `test/integration/paths-external.test.js` (finalize)

- [ ] **Step 1: Write the golden test**

```js
// test/integration/paths-external.test.js (full)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFeature, readFeature, listFeatures } from '../../lib/feature-json.js';
import { resolveFeaturesPath, resolveRoadmapPath } from '../../lib/project-paths.js';

test('GOLDEN: artifacts land in the external dir, root stays clean', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pe-cwd-'));
  const docs = mkdtempSync(join(tmpdir(), 'pe-docs-'));  // the "smart-memory-docs" stand-in
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  writeFileSync(join(cwd, '.compose/compose.json'), JSON.stringify({
    paths: { roadmap: join(docs, 'ROADMAP.md'), features: join(docs, 'features') },
  }));

  // resolve points outside cwd
  assert.equal(resolveFeaturesPath(cwd), join(docs, 'features'));
  assert.equal(resolveRoadmapPath(cwd), join(docs, 'ROADMAP.md'));

  // scaffold → read → list, all in the external dir
  const fdir = resolveFeaturesPath(cwd);
  writeFeature(cwd, { code: 'EXT-1', description: 'd', status: 'PLANNED' }, fdir);
  assert.ok(existsSync(join(docs, 'features/EXT-1/feature.json')), 'feature in external dir');
  assert.ok(!existsSync(join(cwd, 'docs/features')), 'workspace root has NO docs/features');
  assert.equal(readFeature(cwd, 'EXT-1', fdir)?.status, 'PLANNED');
  assert.deepEqual(listFeatures(cwd, fdir).map(f => f.code), ['EXT-1']);

  // .compose state stays at root (D4)
  assert.ok(existsSync(join(cwd, '.compose/compose.json')));
});
```

- [ ] **Step 2: Run** → PASS (all S2 wiring proven end-to-end).
- [ ] **Step 3:** Full node suite green: `node --test --test-timeout=90000 test/*.test.js test/integration/*.test.js 2>&1 | tail -20`. Default-identity ⇒ existing tests unchanged.
- [ ] **Step 4: Commit** — `git add test/integration/paths-external.test.js && git commit -m "COMP-PATHS-EXTERNAL S2: golden flow — full lifecycle into an external artifact dir"`.

> **After Task 15 the core ask is delivered:** a workspace can manage a relocated roadmap + features (CRUD + render + validate + scaffold) anywhere. S3 only adds `compose build`'s ship/completion/enforcement awareness and can be deferred if not needed day-1.

---

# SLICE S3 — Ship / completion / enforcement git-awareness

### Task 16: Per-file git toplevel for the commit (D6a)

**Files:** `lib/build.js:2284-2294` (staging filter), new helper

- [ ] **Step 1: Write the failing test** (`test/integration/paths-external.test.js`): a synthesized ship over a file set where the feature dir resolves into a *different* temp git repo → that file is excluded from the workspace-repo staging set and a "commit it there" line is logged; no throw. (Use small git fixtures via `execSync('git init')` in temp dirs.)
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — add `function gitToplevel(file)` (`git rev-parse --show-toplevel` from `dirname(file)`, returns null on failure). Replace the `ownedPrefixes.some(startsWith)` test with: a file is staged here iff `gitToplevel(file) === buildRepoToplevel`. Files whose toplevel differs (or is null) are written but excluded; if an excluded file is an owned artifact in a *different* repo, log the one-line "commit it there" message; if null (no repo), stay silent.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -am "COMP-PATHS-EXTERNAL S3: ship stages per-file by git toplevel; logs external artifacts"`.

---

### Task 17: Decouple completion/status-flip from the commit (D6b — the load-bearing fix)

> **Codex plan-gate:** this is NOT a `build.js`-only change. `lib/completion-writer.js` is itself commit-bound — it requires a full `commit_sha` (`:154`), derives `completion_id` from it (`:265`), and rejects non-repo-relative `files_changed` (`:173`). The contract has to change first, then `build.js` calls it on all exit paths. Two sub-tasks.

**Files:** `lib/completion-writer.js:154,173,265` (contract) · `lib/build.js:2242-2246,2421+` (callers)

**Task 17a — completion-writer accepts a commit-less completion**

- [ ] **Step 1: Write the failing test** (`test/completion-writer-mcp.test.js` or a new `test/completion-writer-nocommit.test.js`):

```js
test('records a completion with no commit_sha (external/non-git build)', () => {
  // arrange a temp workspace + feature.json …
  const rec = recordCompletion({
    feature_code: 'EXT-1',
    commit_sha: null,                       // <- the new case
    files_changed: ['/abs/external/docs/features/EXT-1/feature.json'], // absolute, external
    // …other required fields…
  });
  assert.equal(rec.commit_sha, null);
  assert.ok(rec.completion_id && !rec.completion_id.includes('null'));  // stable id derived without sha
});
```

- [ ] **Step 2: Run** → FAIL — writer throws on missing `commit_sha` / rejects absolute `files_changed`.
- [ ] **Step 3: Implement** — in `lib/completion-writer.js`: make `commit_sha` optional/nullable (`:154`); when absent, derive `completion_id` from `feature_code` + a monotonic/run token instead of the sha (`:265`) — never embed the literal `null`; relax the `files_changed` repo-relative check (`:173`) to also accept absolute paths (external artifacts). Status-flip + ROADMAP regen via the resolved path are unchanged.
- [ ] **Step 4: Run** → PASS; `node --test --test-timeout=120000 test/*completion*.test.js` green (existing sha path unchanged — a present sha behaves exactly as before).
- [ ] **Step 5: Commit** — `git commit -am "COMP-PATHS-EXTERNAL S3: completion-writer accepts commit-less completions (nullable sha, absolute files)"`.

**Task 17b — build.js records completion on every ship exit path**

- [ ] **Step 1: Write the failing test** (`test/integration/paths-external.test.js`): ship for a feature whose cwd is **non-git** (or artifacts external) → feature status flips to COMPLETE and a completion record exists with `commit_sha: null`.
- [ ] **Step 2: Run** → FAIL — non-git early-return at `build.js:2242` skips completion entirely.
- [ ] **Step 3: Implement** — restructure `executeShipStep` so the completion/status-flip block (`2421+`) runs on all exits: the non-git branch (`2242`) and the cross-repo/external branch fall through to `recordCompletion({ …, commit_sha: null })`. Keep "commit succeeded" wording only when a real local commit happened.
- [ ] **Step 4: Run** → PASS; `node --test --test-timeout=120000 test/*build*.test.js` green.
- [ ] **Step 5: Commit** — `git commit -am "COMP-PATHS-EXTERNAL S3: ship records completion + flips status without a workspace-repo commit"`.

---

### Task 18: Resolution-aware enforcement guard (D6c)

**Files:** `lib/mcp-enforcement.js:64,122` (`scanGuarded` / guarded-path match) · confirm `feature-write-guard.js` (Task 7 already absolute)

- [ ] **Step 1: Write the failing test**: with `enforcement.mcpForFeatureMgmt: 'block'` and an **external** `feature.json`/`ROADMAP.md`, an edit to that external guarded path is recognized as guarded (block/log behaves identically to an in-root edit).
- [ ] **Step 2: Run** → FAIL — guarded match is repo-relative; the absolute external path doesn't match, escaping the guard.
- [ ] **Step 3: Implement** — make `scanGuarded` compare on resolved-absolute identity: resolve both the dirty path and the guarded set (`resolveRoadmapPath`, `resolveFeaturesPath`, vision-state) to absolute and match by equality / containment, rather than repo-relative `startsWith`.
- [ ] **Step 4: Run** → PASS; `node --test --test-timeout=120000 test/*enforcement*.test.js` green.
- [ ] **Step 5: Commit** — `git commit -am "COMP-PATHS-EXTERNAL S3: enforcement guard matches resolved-absolute guarded paths"`.

---

### Task 19: S3 gate — full suite + design acceptance sweep

- [ ] **Step 1:** Full node suite: `node --test --test-timeout=90000 test/*.test.js test/integration/*.test.js 2>&1 | tail -20`. Then `npm run test:ui` and `npm run test:tracker` if touched UI/tracker paths (this feature does not, but confirm green).
- [ ] **Step 2:** Walk `design.md` acceptance criteria (S1/S2/S3) and check each box against a task. Fill any gap with a follow-up task before declaring done.
- [ ] **Step 3:** Update `CHANGELOG.md` (same commit) + a journal entry per the project rules.
- [ ] **Step 4: Commit** — `git commit -am "COMP-PATHS-EXTERNAL: ship — CHANGELOG + journal; all slices green"`.

---

## Self-Review notes (author)
- **Spec coverage:** D1→T1-3,12; D2→T8-11; D3→T2,3 default-identity tests; D4→T7 (vision-state stays), T15; D5→T1 (`relForDisplay`),T9; D6a→T16; D6b→T17a/17b; D6c→T18; D7→T6,11. Config/init→T13; CLI roadmap→T8; validate→T14; golden→T15.
- **Signatures confirmed by Codex plan-gate (no longer caveats):** `getRoadmap(root, opts={})` `get-roadmap.js:56`; `scanGuarded({ dirtyFiles, featuresDir, buildId, events })` `mcp-enforcement.js:122`; `feature-write-guard` local resolve `:79`; `feature-json.js` `join(cwd, featuresDir, …)` `:36`; `compose init` paths literal `bin/compose.js:413`. The executor still reads each file before editing.
- **Codex plan-gate corrections folded in:** S3 completion needs a `completion-writer.js` contract change (T17a) before `build.js` (T17b); `featuresDir` caller migration is wider (T11 expanded list + mandatory grep); `compose feature` CLI roadmap sites added (T8); `feature-scan.js:626`↔`vision-server.js:459` must change together (T9); `vision-utils.js:73` ignores its `projectRoot` param (T12).
- **TDD:** every task is failing-test-first; default-identity tests guard against silent behavior change across the sweep.

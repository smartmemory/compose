# COMP-UPDATE-NUDGE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Print one line at three entry points naming whichever of compose and stratum is behind, and never mutate an installation.

**Architecture:** Generalize the existing `lib/version-check.js` (which is hardcoded to `@smartmemory/compose`) to any package with a per-package cache, add a resolver that reads the version stratum actually resolved to in `node_modules`, and a pure formatter that turns two version reports into zero or one output lines. Wire the three pieces into `compose init`, `compose build`, and `compose plan`.

**Tech Stack:** Node ESM, `node:test` + `node:assert/strict`, no new dependencies.

**Design:** `docs/features/COMP-UPDATE-NUDGE/design.md`

## Global Constraints

- **Never throw.** Every function added here returns `null` / `[]` on any failure — network down, registry 500, unparseable JSON, malformed semver, missing `node_modules`. Nothing may fail the command it is attached to.
- **No test performs a network fetch.** Unit tests inject `fetchImpl`; the integration test seeds a fresh cache file via `COMPOSE_VERSION_CACHE`.
- **`compose doctor` output must stay byte-identical**, text and `--json`. Its `--json` document includes a `version` key holding the `checkLatestVersion` shape (`bin/compose.js:345`); that shape is `{current, latest, behind, source}` and must not change.
- **Never mutate an install.** No task in this plan may add an `npm install`, a self-update, or any write outside the version cache.
- Existing exported names that must keep working unchanged: `checkLatestVersion`, `compareVersions`.
- Nudge text, exact: `⚠ update available: <parts> — run: compose update`

---

### Task 1: Per-package version checking

**Files:**
- Modify: `lib/version-check.js:13-58` (PACKAGE_NAME, `cachePath`, `readCache`, `writeCache`, `fetchLatest`)
- Modify: `lib/version-check.js:92-110` (`checkLatestVersion`)
- Test: `test/version-check.test.js` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `checkPackageVersion(pkg: string, currentVersion: string, opts?: {force?: boolean, fetchImpl?: (pkg: string) => Promise<string|null>, cacheFile?: string}) => Promise<{current, latest, behind, source}|null>`
  - `cachePath() => string` — honors `process.env.COMPOSE_VERSION_CACHE`
  - `checkLatestVersion(currentVersion, opts?)` — unchanged signature and return shape

- [ ] **Step 1: Write the failing tests**

Create `test/version-check.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkPackageVersion, checkLatestVersion, cachePath } from '../lib/version-check.js';

function tmpCache(t) {
  const dir = mkdtempSync(join(tmpdir(), 'version-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'version-cache.json');
}

/** Fetch stub. Records calls so "did we hit the network" is assertable. */
function stubFetch(byPkg) {
  const calls = [];
  const impl = async (pkg) => { calls.push(pkg); return byPkg[pkg] ?? null; };
  return { impl, calls };
}

test('checkPackageVersion reports behind against a stubbed registry', async (t) => {
  const { impl } = stubFetch({ '@smartmemory/stratum': '0.3.4' });
  const r = await checkPackageVersion('@smartmemory/stratum', '0.3.3', {
    fetchImpl: impl, cacheFile: tmpCache(t),
  });
  assert.deepEqual(r, { current: '0.3.3', latest: '0.3.4', behind: true, source: 'network' });
});

test('checkPackageVersion reports not-behind when current equals latest', async (t) => {
  const { impl } = stubFetch({ '@smartmemory/compose': '0.3.7' });
  const r = await checkPackageVersion('@smartmemory/compose', '0.3.7', {
    fetchImpl: impl, cacheFile: tmpCache(t),
  });
  assert.equal(r.behind, false);
});

test('two packages cache independently and do not clobber each other', async (t) => {
  const cacheFile = tmpCache(t);
  const { impl } = stubFetch({ '@smartmemory/compose': '0.3.9', '@smartmemory/stratum': '0.3.4' });
  await checkPackageVersion('@smartmemory/compose', '0.3.7', { fetchImpl: impl, cacheFile });
  await checkPackageVersion('@smartmemory/stratum', '0.3.3', { fetchImpl: impl, cacheFile });

  const written = JSON.parse(readFileSync(cacheFile, 'utf-8'));
  assert.equal(written['@smartmemory/compose'].latest, '0.3.9');
  assert.equal(written['@smartmemory/stratum'].latest, '0.3.4');
});

test('a fresh cache entry is used instead of fetching', async (t) => {
  const cacheFile = tmpCache(t);
  writeFileSync(cacheFile, JSON.stringify({
    '@smartmemory/stratum': { fetchedAt: Date.now(), latest: '0.3.4' },
  }));
  const { impl, calls } = stubFetch({ '@smartmemory/stratum': '9.9.9' });
  const r = await checkPackageVersion('@smartmemory/stratum', '0.3.3', { fetchImpl: impl, cacheFile });
  assert.equal(r.source, 'cache');
  assert.equal(r.latest, '0.3.4');
  assert.deepEqual(calls, [], 'a fresh cache entry must not trigger a fetch');
});

test('a stale cache entry is refetched', async (t) => {
  const cacheFile = tmpCache(t);
  const DAY = 24 * 60 * 60 * 1000;
  writeFileSync(cacheFile, JSON.stringify({
    '@smartmemory/stratum': { fetchedAt: Date.now() - (DAY + 60_000), latest: '0.3.0' },
  }));
  const { impl, calls } = stubFetch({ '@smartmemory/stratum': '0.3.4' });
  const r = await checkPackageVersion('@smartmemory/stratum', '0.3.3', { fetchImpl: impl, cacheFile });
  assert.equal(r.source, 'network');
  assert.equal(r.latest, '0.3.4');
  assert.deepEqual(calls, ['@smartmemory/stratum']);
});

// The shipped cache is flat ({fetchedAt, latest}) and exists on every install
// today. It must be a miss, never mistaken for an entry, and never throw.
test('a pre-existing FLAT cache file is treated as a miss and replaced', async (t) => {
  const cacheFile = tmpCache(t);
  writeFileSync(cacheFile, JSON.stringify({ fetchedAt: Date.now(), latest: '0.3.0' }));
  const { impl, calls } = stubFetch({ '@smartmemory/compose': '0.3.9' });

  const r = await checkPackageVersion('@smartmemory/compose', '0.3.7', { fetchImpl: impl, cacheFile });
  assert.equal(r.latest, '0.3.9', 'must not read 0.3.0 out of the old flat shape');
  assert.deepEqual(calls, ['@smartmemory/compose']);

  const written = JSON.parse(readFileSync(cacheFile, 'utf-8'));
  assert.equal(written['@smartmemory/compose'].latest, '0.3.9');
  assert.equal(written.fetchedAt, undefined, 'the old flat keys must not survive');
});

test('an unreadable cache file is a miss, not a throw', async (t) => {
  const cacheFile = tmpCache(t);
  writeFileSync(cacheFile, 'not json at all{{{');
  const { impl } = stubFetch({ '@smartmemory/compose': '0.3.9' });
  const r = await checkPackageVersion('@smartmemory/compose', '0.3.7', { fetchImpl: impl, cacheFile });
  assert.equal(r.latest, '0.3.9');
});

test('a failed fetch returns null rather than throwing', async (t) => {
  const impl = async () => { throw new Error('ENETDOWN'); };
  const r = await checkPackageVersion('@smartmemory/compose', '0.3.7', {
    fetchImpl: impl, cacheFile: tmpCache(t),
  });
  assert.equal(r, null);
});

test('an unparseable current version returns null', async (t) => {
  const { impl } = stubFetch({ '@smartmemory/compose': '0.3.9' });
  const r = await checkPackageVersion('@smartmemory/compose', 'not-a-version', {
    fetchImpl: impl, cacheFile: tmpCache(t),
  });
  assert.equal(r, null);
});

test('checkLatestVersion still delegates to compose and keeps its shape', async (t) => {
  const cacheFile = tmpCache(t);
  writeFileSync(cacheFile, JSON.stringify({
    '@smartmemory/compose': { fetchedAt: Date.now(), latest: '0.3.9' },
  }));
  const r = await checkLatestVersion('0.3.7', { cacheFile });
  assert.deepEqual(Object.keys(r).sort(), ['behind', 'current', 'latest', 'source']);
  assert.equal(r.behind, true);
});

test('cachePath honors COMPOSE_VERSION_CACHE', () => {
  const prev = process.env.COMPOSE_VERSION_CACHE;
  process.env.COMPOSE_VERSION_CACHE = '/tmp/explicit-cache.json';
  try {
    assert.equal(cachePath(), '/tmp/explicit-cache.json');
  } finally {
    if (prev === undefined) delete process.env.COMPOSE_VERSION_CACHE;
    else process.env.COMPOSE_VERSION_CACHE = prev;
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/version-check.test.js`
Expected: FAIL — `checkPackageVersion` and `cachePath` are not exported yet (`SyntaxError: The requested module does not provide an export named 'checkPackageVersion'`).

- [ ] **Step 3: Implement**

In `lib/version-check.js`, replace the cache/fetch helpers and `checkLatestVersion`. Keep `compareVersions` exactly as it is.

```js
const PACKAGE_NAME = '@smartmemory/compose'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24h
const FETCH_TIMEOUT_MS = 3000

/** Cache location. The env override exists so tests (and the integration test,
 * which crosses a process boundary) can point at a temp file. */
export function cachePath() {
  return process.env.COMPOSE_VERSION_CACHE || join(homedir(), '.compose', 'version-cache.json')
}

/** Read the whole cache document, or {} for anything unusable.
 *
 * The pre-S5 shape was flat ({fetchedAt, latest}) for compose alone, and every
 * existing install has one on disk. It carries no package keys, so a per-package
 * lookup misses naturally — but it must not be MERGED into the new document
 * either, or those stray top-level keys live forever. Detect and drop it. */
function readCacheDoc(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    if ('fetchedAt' in parsed || 'latest' in parsed) return {}   // legacy flat shape
    return parsed
  } catch {
    return {}
  }
}

function readCache(pkg, file) {
  const entry = readCacheDoc(file)[pkg]
  if (typeof entry?.fetchedAt !== 'number' || typeof entry?.latest !== 'string') return null
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null
  return entry
}

function writeCache(pkg, latest, file) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const doc = readCacheDoc(file)
    doc[pkg] = { fetchedAt: Date.now(), latest }
    writeFileSync(file, JSON.stringify(doc, null, 2))
  } catch {
    // best-effort cache; ignore failures
  }
}

async function fetchLatest(pkg) {
  if (typeof fetch !== 'function') return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const url = `https://registry.npmjs.org/${pkg}/latest`
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!res.ok) return null
    const data = await res.json()
    return typeof data?.version === 'string' ? data.version : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Returns { current, latest, behind, source } or null on failure.
 *   behind: true if current < latest, false otherwise.
 *   source: 'cache' | 'network'
 *
 * Never throws — a caller printing a courtesy nudge must never be able to fail
 * the command it is attached to.
 */
export async function checkPackageVersion(pkg, currentVersion, opts = {}) {
  const { force = false, fetchImpl = fetchLatest, cacheFile = cachePath() } = opts
  if (!currentVersion) return null

  if (!force) {
    const cached = readCache(pkg, cacheFile)
    if (cached) {
      const cmp = compareVersions(currentVersion, cached.latest)
      if (cmp === null) return null
      return { current: currentVersion, latest: cached.latest, behind: cmp < 0, source: 'cache' }
    }
  }

  let latest = null
  try {
    latest = await fetchImpl(pkg)
  } catch {
    return null
  }
  if (!latest) return null
  writeCache(pkg, latest, cacheFile)
  const cmp = compareVersions(currentVersion, latest)
  if (cmp === null) return null
  return { current: currentVersion, latest, behind: cmp < 0, source: 'network' }
}

/** Compose's own check. Shape and behavior unchanged — `compose doctor` and its
 * --json consumers depend on this exact object. */
export async function checkLatestVersion(currentVersion, opts = {}) {
  return checkPackageVersion(PACKAGE_NAME, currentVersion, opts)
}
```

Ensure the imports at the top of the file include `dirname`:

```js
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
```

(`existsSync` was imported but is now unused — remove it if the linter flags it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/version-check.test.js`
Expected: PASS, 11/11.

- [ ] **Step 5: Verify `compose doctor` is unchanged**

Run: `node bin/compose.js doctor --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s).version)))"`
Expected: an object with exactly `current`, `latest`, `behind`, `source` (or `null` if the registry is unreachable). Not an error, not a changed shape.

- [ ] **Step 6: Commit**

```bash
git add lib/version-check.js test/version-check.test.js
git commit -m "feat(COMP-UPDATE-NUDGE): per-package version checking with a per-package cache"
```

---

### Task 2: Stratum resolver and the pure formatter

**Files:**
- Modify: `lib/version-check.js` (append two exports)
- Test: `test/version-check.test.js` (append)

**Interfaces:**
- Consumes: nothing from Task 1 at runtime; shares the file.
- Produces:
  - `resolveStratumVersion(packageRoot: string) => string|null`
  - `formatDriftNudge({compose, stratum}: {compose: object|null, stratum: object|null}) => string[]`

- [ ] **Step 1: Write the failing tests**

Append to `test/version-check.test.js`. Merge these two imports into the existing
import block at the top of the file rather than leaving them mid-file — ESM hoists
them either way, but a reader should not have to know that:

```js
// merge into the existing top-of-file imports:
//   import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
//   import { checkPackageVersion, checkLatestVersion, cachePath,
//            resolveStratumVersion, formatDriftNudge } from '../lib/version-check.js';

function fakeInstall(t, version) {
  const root = mkdtempSync(join(tmpdir(), 'fake-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (version !== null) {
    const dir = join(root, 'node_modules', '@smartmemory', 'stratum');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@smartmemory/stratum', version }));
  }
  return root;
}

test('resolveStratumVersion reads the RESOLVED version from node_modules', (t) => {
  assert.equal(resolveStratumVersion(fakeInstall(t, '0.3.3')), '0.3.3');
});

test('resolveStratumVersion returns null when stratum is absent', (t) => {
  assert.equal(resolveStratumVersion(fakeInstall(t, null)), null);
});

test('resolveStratumVersion returns null on a malformed package.json', (t) => {
  const root = fakeInstall(t, '0.3.3');
  writeFileSync(join(root, 'node_modules', '@smartmemory', 'stratum', 'package.json'), '{{{');
  assert.equal(resolveStratumVersion(root), null);
});

const CURRENT = { current: '0.3.7', latest: '0.3.7', behind: false, source: 'cache' };
const COMPOSE_BEHIND = { current: '0.3.7', latest: '0.3.9', behind: true, source: 'cache' };
const STRATUM_BEHIND = { current: '0.3.3', latest: '0.3.4', behind: true, source: 'cache' };

test('formatDriftNudge: both current is silent', () => {
  assert.deepEqual(formatDriftNudge({ compose: CURRENT, stratum: CURRENT }), []);
});

test('formatDriftNudge: compose behind only', () => {
  assert.deepEqual(formatDriftNudge({ compose: COMPOSE_BEHIND, stratum: CURRENT }), [
    '⚠ update available: compose 0.3.7 → 0.3.9 — run: compose update',
  ]);
});

// The case the caret pin created: compose current, stratum stale. A compose-only
// check calls this healthy, which is the entire reason stratum is covered.
test('formatDriftNudge: stratum behind while compose is current', () => {
  assert.deepEqual(formatDriftNudge({ compose: CURRENT, stratum: STRATUM_BEHIND }), [
    '⚠ update available: stratum 0.3.3 → 0.3.4 — run: compose update',
  ]);
});

test('formatDriftNudge: both behind, one line, compose first', () => {
  assert.deepEqual(formatDriftNudge({ compose: COMPOSE_BEHIND, stratum: STRATUM_BEHIND }), [
    '⚠ update available: compose 0.3.7 → 0.3.9, stratum 0.3.3 → 0.3.4 — run: compose update',
  ]);
});

test('formatDriftNudge: null inputs are silent, never a crash', () => {
  assert.deepEqual(formatDriftNudge({ compose: null, stratum: null }), []);
  assert.deepEqual(formatDriftNudge({}), []);
});

test('formatDriftNudge: absent stratum still reports compose', () => {
  assert.deepEqual(formatDriftNudge({ compose: COMPOSE_BEHIND, stratum: null }), [
    '⚠ update available: compose 0.3.7 → 0.3.9 — run: compose update',
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/version-check.test.js`
Expected: FAIL — no export named `resolveStratumVersion`.

- [ ] **Step 3: Implement**

Append to `lib/version-check.js`:

```js
/** The version stratum ACTUALLY resolved to, read from node_modules.
 *
 * Deliberately not the range declared in compose's package.json. Compose 0.3.7
 * moved that declaration from an exact pin to `^0.3.3`, and npm does not
 * re-resolve a caret unless something triggers an install — so the declared
 * range and the installed version drift apart, and the installed one is the
 * only one that tells the user anything true.
 *
 * Absent stratum is a normal state (not installed, capabilities.stratum off),
 * not an error. */
export function resolveStratumVersion(packageRoot) {
  try {
    const manifest = join(packageRoot, 'node_modules', '@smartmemory', 'stratum', 'package.json')
    const version = JSON.parse(readFileSync(manifest, 'utf-8')).version
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

/** Zero or one lines. Pure: no network, no filesystem, no clock — so every
 * branch is decidable in a unit test.
 *
 * Silence is the default. A nudge that prints on every run gets filtered out by
 * the reader, at which point it has negative value. */
export function formatDriftNudge({ compose = null, stratum = null } = {}) {
  const parts = []
  if (compose?.behind) parts.push(`compose ${compose.current} → ${compose.latest}`)
  if (stratum?.behind) parts.push(`stratum ${stratum.current} → ${stratum.latest}`)
  if (parts.length === 0) return []
  return [`⚠ update available: ${parts.join(', ')} — run: compose update`]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/version-check.test.js`
Expected: PASS, 21/21.

- [ ] **Step 5: Commit**

```bash
git add lib/version-check.js test/version-check.test.js
git commit -m "feat(COMP-UPDATE-NUDGE): resolved-stratum reader and pure drift formatter"
```

---

### Task 3: Wire the nudge into the three entry points

**Files:**
- Modify: `bin/compose.js:94` (import), and add `emitDriftNudge` near `runUpdate`
- Modify: `bin/compose.js:764` (`cmd === 'init'`)
- Modify: `bin/compose.js:2359` (`cmd === 'build'`)
- Modify: `bin/compose.js:2705` (`cmd === 'plan'`)
- Test: `test/version-nudge-cli.test.js` (new)

**Interfaces:**
- Consumes: `checkPackageVersion`, `resolveStratumVersion`, `formatDriftNudge` from Tasks 1-2; the existing `getPkgVersion()` and `PACKAGE_ROOT` (`bin/compose.js:31`).
- Produces: `emitDriftNudge(): Promise<void>` — prints zero or one lines to stdout, never throws.

- [ ] **Step 1: Write the failing test**

Create `test/version-nudge-cli.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_BIN = join(ROOT, 'bin', 'compose.js');

/** A cache pre-seeded fresh, so the CLI never reaches the network. */
function seedCache(t, doc) {
  const dir = mkdtempSync(join(tmpdir(), 'nudge-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'version-cache.json');
  writeFileSync(file, JSON.stringify(doc));
  return file;
}

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nudge-ws-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.compose'), { recursive: true });
  writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({ version: 1, workspaceId: 'nudge-ws' }));
  return dir;
}

function runCompose(args, { cwd, cacheFile }) {
  return spawnSync(process.execPath, [COMPOSE_BIN, ...args], {
    cwd, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, COMPOSE_VERSION_CACHE: cacheFile },
  });
}

const AHEAD = { fetchedAt: Date.now(), latest: '999.0.0' };
const behindCache = () => ({ '@smartmemory/compose': AHEAD, '@smartmemory/stratum': AHEAD });

test('compose init prints the nudge when behind', (t) => {
  const r = runCompose(['init'], { cwd: workspace(t), cacheFile: seedCache(t, behindCache()) });
  assert.match(`${r.stdout}${r.stderr}`, /update available: .*999\.0\.0.*run: compose update/);
});

test('compose plan prints the nudge when behind', (t) => {
  const r = runCompose(['plan'], { cwd: workspace(t), cacheFile: seedCache(t, behindCache()) });
  assert.match(`${r.stdout}${r.stderr}`, /update available: .*run: compose update/);
});

// The nudge is the FIRST statement in the dispatch block, ahead of argument
// parsing, so `build` with no feature code prints it and then errors out. That
// is exactly what we want to assert: the nudge does not depend on the command
// succeeding, and no real build is started here.
test('compose build prints the nudge when behind', (t) => {
  const r = runCompose(['build'], { cwd: workspace(t), cacheFile: seedCache(t, behindCache()) });
  assert.match(`${r.stdout}${r.stderr}`, /update available: .*run: compose update/);
});

// Current on both ends: the nudge must be absent, not merely different.
test('no nudge when both are current', (t) => {
  const current = { fetchedAt: Date.now(), latest: '0.0.1' };  // below anything installed
  const cacheFile = seedCache(t, {
    '@smartmemory/compose': current, '@smartmemory/stratum': current,
  });
  const r = runCompose(['init'], { cwd: workspace(t), cacheFile });
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /update available/);
});

test('non-entry-point commands stay silent even when behind', (t) => {
  const cacheFile = seedCache(t, behindCache());
  const r = runCompose(['roadmap'], { cwd: workspace(t), cacheFile });
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /update available/);
});

test('an unusable cache never breaks the command', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nudge-bad-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cacheFile = join(dir, 'version-cache.json');
  writeFileSync(cacheFile, 'garbage{{{');
  const r = runCompose(['init'], { cwd: workspace(t), cacheFile });
  assert.equal(r.status, 0, `init must still succeed: ${r.stderr}`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/version-nudge-cli.test.js`
Expected: FAIL — the nudge assertions fail because nothing prints it yet.

- [ ] **Step 3: Implement**

In `bin/compose.js`, extend the existing import at line 94:

```js
import {
  checkLatestVersion,
  checkPackageVersion,
  resolveStratumVersion,
  formatDriftNudge,
} from '../lib/version-check.js';
```

Add this function next to `runUpdate` (before the command dispatch section):

```js
/** Print a one-line update nudge at session entry points. NOTIFY ONLY —
 * this must never mutate an installation. Compose has ~109 lazy `await import()`
 * sites, so replacing files under a running process would have it load new
 * modules into an old module graph; safe self-update needs a versioned install
 * (COMP-UPDATE-VERSIONED-INSTALL), not a check here.
 *
 * Swallows everything: a courtesy line may never fail the command it precedes. */
async function emitDriftNudge() {
  try {
    const stratumCurrent = resolveStratumVersion(PACKAGE_ROOT)
    const [composeInfo, stratumInfo] = await Promise.all([
      checkPackageVersion('@smartmemory/compose', getPkgVersion()),
      stratumCurrent
        ? checkPackageVersion('@smartmemory/stratum', stratumCurrent)
        : Promise.resolve(null),
    ])
    for (const line of formatDriftNudge({ compose: composeInfo, stratum: stratumInfo })) {
      console.log(line)
    }
  } catch {
    // never break the command this is attached to
  }
}
```

Then add `await emitDriftNudge()` as the first statement inside each of the three dispatch blocks:

```js
if (cmd === 'init') {
  await emitDriftNudge()
  await runInit(args)
  process.exit(0)
}
```

```js
if (cmd === 'build') {
  await emitDriftNudge()
  // Parse --cwd <path> for cross-repo builds
  let agentWorkDir = null
```

```js
} else if (cmd === 'plan') {
  await emitDriftNudge()
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/version-nudge-cli.test.js`
Expected: PASS, 6/6.

- [ ] **Step 5: Verify against the real drift this repo is living**

This checkout has stratum `0.3.3` in `node_modules` while npm `latest` is `0.3.4` — the exact case the feature exists to catch.

Do NOT run `compose init` in this repo to check it: `runInit` scaffolds and refreshes
workspace artifacts, and this repo is the live compose workspace. Call the functions directly
instead — no CLI side effects, and it exercises the same code path the nudge uses:

```bash
node --input-type=module -e "
import { checkPackageVersion, resolveStratumVersion, formatDriftNudge } from './lib/version-check.js';
const root = process.cwd();
const sv = resolveStratumVersion(root);
const [c, s] = await Promise.all([
  checkPackageVersion('@smartmemory/compose', JSON.parse(require('fs').readFileSync('package.json')).version),
  sv ? checkPackageVersion('@smartmemory/stratum', sv) : null,
]);
console.log(JSON.stringify({ stratumResolved: sv, lines: formatDriftNudge({ compose: c, stratum: s }) }, null, 2));
"
```

Expected: `stratumResolved` is `0.3.3`, and `lines` contains one line naming stratum
`0.3.3 → 0.3.4`. This performs one real registry fetch — that is fine here, it is a manual
verification step, not a test.

- [ ] **Step 6: Run the full suite**

Run: `node --import ./test/suppress-expected-drift.js --test --test-timeout=120000 test/*.test.js test/comp-obs-branch/*.test.js test/integration/*.test.js > /tmp/suite.txt 2>&1; grep -E "^# (tests|pass|fail)|^not ok" /tmp/suite.txt`
Expected: 0 failures. Never pipe this through `tail` — the failure detail is the part you need.

- [ ] **Step 7: Commit**

```bash
git add bin/compose.js test/version-nudge-cli.test.js CHANGELOG.md
git commit -m "feat(COMP-UPDATE-NUDGE): emit the drift nudge at init, build, and plan"
```

(Write the CHANGELOG entry in this same commit — it is the first user-visible behavior in the feature.)

---

## Verification checklist

- [ ] `compose doctor` text output unchanged
- [ ] `compose doctor --json` still carries `version: {current, latest, behind, source}`
- [ ] A flat legacy cache file is replaced, not merged
- [ ] `compose roadmap` prints no nudge
- [ ] No test performs a network fetch (every unit test injects `fetchImpl`; every CLI test seeds a fresh cache)
- [ ] Nothing in the diff installs, downloads, or self-updates anything

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkPackageVersion, checkLatestVersion, cachePath,
  resolveStratumVersion, formatDriftNudge } from '../lib/version-check.js';

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

test('checkPackageVersion handles explicit null options', async (t) => {
  const cacheFile = tmpCache(t);
  const prevCachePath = process.env.COMPOSE_VERSION_CACHE;
  process.env.COMPOSE_VERSION_CACHE = cacheFile;

  try {
    writeFileSync(cacheFile, JSON.stringify({
      '@x/y': { fetchedAt: Date.now(), latest: '1.0.1' },
    }));
    const r = await checkPackageVersion('@x/y', '1.0.0', null);
    assert.equal(r.source, 'cache');
    assert.equal(r.latest, '1.0.1');
  } finally {
    if (prevCachePath === undefined) delete process.env.COMPOSE_VERSION_CACHE;
    else process.env.COMPOSE_VERSION_CACHE = prevCachePath;
  }
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

test('a package literally named latest is cached and read back', async (t) => {
  const cacheFile = tmpCache(t);
  const { impl, calls } = stubFetch({ latest: '1.0.1' });

  const first = await checkPackageVersion('latest', '1.0.0', { fetchImpl: impl, cacheFile });
  assert.equal(first.source, 'network');
  assert.equal(first.latest, '1.0.1');
  assert.deepEqual(calls, ['latest']);

  const second = await checkPackageVersion('latest', '1.0.0', { fetchImpl: impl, cacheFile });
  assert.equal(second.source, 'cache');
  assert.equal(second.latest, '1.0.1');
  assert.deepEqual(calls, ['latest']);

  const written = JSON.parse(readFileSync(cacheFile, 'utf-8'));
  assert.equal(written['latest'].latest, '1.0.1');
});

test('an unreadable cache file is a miss, not a throw', async (t) => {
  const cacheFile = tmpCache(t);
  writeFileSync(cacheFile, 'not json at all{{{');
  const { impl } = stubFetch({ '@smartmemory/compose': '0.3.9' });
  const r = await checkPackageVersion('@smartmemory/compose', '0.3.7', { fetchImpl: impl, cacheFile });
  assert.equal(r.latest, '0.3.9');
});

test('COMPOSE_VERSION_CHECK_OFFLINE skips the default registry fetch', async (t) => {
  const previousOffline = process.env.COMPOSE_VERSION_CHECK_OFFLINE;
  const previousFetch = globalThis.fetch;
  let calls = 0;
  process.env.COMPOSE_VERSION_CHECK_OFFLINE = '1';
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('the offline switch must prevent this fetch');
  };

  try {
    const r = await checkPackageVersion('@smartmemory/compose', '0.3.7', { cacheFile: tmpCache(t) });
    assert.equal(r, null);
    assert.equal(calls, 0, 'offline mode must stop before calling fetch');
  } finally {
    if (previousOffline === undefined) delete process.env.COMPOSE_VERSION_CHECK_OFFLINE;
    else process.env.COMPOSE_VERSION_CHECK_OFFLINE = previousOffline;
    globalThis.fetch = previousFetch;
  }
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
  const r = await checkLatestVersion('0.3.7', {
    cacheFile,
    fetchImpl: async () => { throw new Error('network banned in tests'); },
  });
  assert.deepEqual(Object.keys(r).sort(), ['behind', 'current', 'latest', 'source']);
  assert.equal(r.behind, true);
  assert.equal(r.source, 'cache');
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

test('formatDriftNudge: null argument is silent, never a crash', () => {
  assert.doesNotThrow(() => assert.deepEqual(formatDriftNudge(null), []));
  assert.doesNotThrow(() => assert.deepEqual(formatDriftNudge(undefined), []));
});

test('formatDriftNudge: non-object argument is silent', () => {
  assert.doesNotThrow(() => assert.deepEqual(formatDriftNudge('bad arg'), []));
});

test('formatDriftNudge: incomplete package record is silent', () => {
  assert.deepEqual(formatDriftNudge({ compose: { behind: true } }), []);
  assert.deepEqual(formatDriftNudge({ compose: { behind: true, current: 123, latest: true } }), []);
  assert.deepEqual(formatDriftNudge({ stratum: { behind: true, current: 123, latest: 456 } }), []);
  assert.deepEqual(formatDriftNudge({ compose: COMPOSE_BEHIND, stratum: { behind: true, current: 123, latest: 456 } }), [
    '⚠ update available: compose 0.3.7 → 0.3.9 — run: compose update',
  ]);
});

test('formatDriftNudge: absent stratum still reports compose', () => {
  assert.deepEqual(formatDriftNudge({ compose: COMPOSE_BEHIND, stratum: null }), [
    '⚠ update available: compose 0.3.7 → 0.3.9 — run: compose update',
  ]);
});

// The nudge runs on the startup path of init/build/plan. Non-interactive callers
// (spawned CLIs, CI, the test suite itself) must never pay for a network request
// there: dozens of concurrent spawns with a cold cache once left a fetch
// unsettled, and node killed `compose init` with a top-level-await warning.
test('cacheOnly returns null on a miss instead of fetching', async (t) => {
  const { impl, calls } = stubFetch({ '@smartmemory/compose': '9.9.9' });
  const r = await checkPackageVersion('@smartmemory/compose', '0.3.7', {
    fetchImpl: impl, cacheFile: tmpCache(t), cacheOnly: true,
  });
  assert.equal(r, null);
  assert.deepEqual(calls, [], 'cacheOnly must not reach the fetch path at all');
});

test('cacheOnly still reports a hit from a fresh cache', async (t) => {
  const cacheFile = tmpCache(t);
  writeFileSync(cacheFile, JSON.stringify({
    '@smartmemory/compose': { fetchedAt: Date.now(), latest: '0.3.9' },
  }));
  const { impl, calls } = stubFetch({ '@smartmemory/compose': '9.9.9' });
  const r = await checkPackageVersion('@smartmemory/compose', '0.3.7', {
    fetchImpl: impl, cacheFile, cacheOnly: true,
  });
  assert.equal(r.behind, true);
  assert.equal(r.source, 'cache');
  assert.deepEqual(calls, []);
});

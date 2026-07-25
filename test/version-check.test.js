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

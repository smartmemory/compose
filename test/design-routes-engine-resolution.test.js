/**
 * design-routes-engine-resolution.test.js — H2: the design-conversation Stratum
 * client must resolve the engine from the TARGET PROJECT ROOT and key its cache
 * on that root, so a python-pinned project surfaces the python-legacy error
 * instead of silently reusing a cached TS client from another project.
 *
 * Same class as flag-day C2 (abortBuild threading process.cwd()).
 */
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { _getDesignStratumForTest, closeDesignStratum } =
  await import(`${ROOT}/server/design-routes.js`);

function makeRoot({ engine } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'design-engine-'));
  if (engine) {
    mkdirSync(join(dir, '.compose'), { recursive: true });
    writeFileSync(
      join(dir, '.compose', 'compose.json'),
      JSON.stringify({ capabilities: { stratumEngine: engine } }),
    );
  }
  return dir;
}

// A fake client that "connects" without spawning a subprocess.
function fakeClientFactory(log) {
  return () => {
    const c = {
      connectCalls: 0,
      connect: async () => { c.connectCalls++; log.push('connect'); },
      close: async () => { log.push('close'); },
    };
    log.push('create');
    return c;
  };
}

describe('H2 — design Stratum client resolves engine from target root', () => {
  let savedEnv;
  beforeEach(() => { savedEnv = process.env.COMPOSE_STRATUM_ENGINE; delete process.env.COMPOSE_STRATUM_ENGINE; });
  afterEach(async () => {
    if (savedEnv === undefined) delete process.env.COMPOSE_STRATUM_ENGINE;
    else process.env.COMPOSE_STRATUM_ENGINE = savedEnv;
    await closeDesignStratum();
  });

  test('a python-pinned root rejects with the python-legacy error (no client cached)', async () => {
    const pyRoot = makeRoot({ engine: 'python' });
    const log = [];
    await assert.rejects(
      () => _getDesignStratumForTest(pyRoot, { factory: fakeClientFactory(log) }),
      /Python Stratum engine has been deleted|python-legacy/,
    );
    // The throw is at resolve time — before any client is created/connected.
    assert.deepEqual(log, [], 'no client should be created for a python-pinned root');
  });

  test('a TS root connects once and is cached per root', async () => {
    const tsRoot = makeRoot(); // no pin → defaults to ts
    const log = [];
    const a = await _getDesignStratumForTest(tsRoot, { factory: fakeClientFactory(log) });
    const b = await _getDesignStratumForTest(tsRoot, { factory: fakeClientFactory(log) });
    assert.equal(a, b, 'same root returns the cached client');
    assert.deepEqual(log, ['create', 'connect'], 'connect happens exactly once for the root');
  });

  test('the cache is keyed on root — a python root still throws after a TS root connected', async () => {
    const tsRoot = makeRoot();
    const pyRoot = makeRoot({ engine: 'python' });
    const log = [];
    await _getDesignStratumForTest(tsRoot, { factory: fakeClientFactory(log) });
    // A different, python-pinned root must NOT reuse the cached TS client.
    await assert.rejects(
      () => _getDesignStratumForTest(pyRoot, { factory: fakeClientFactory(log) }),
      /Python Stratum engine has been deleted|python-legacy/,
    );
  });
});

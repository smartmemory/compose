/**
 * checkpoint-store.test.js — Unit tests for lib/checkpoint/store/* and lib/checkpoint/atomic.js
 *
 * Covers (COMP-RESUME slices S4, S5):
 *   - atomic.js: writeAtomic round-trip, appendJsonl + readJsonl, malformed-line tolerance,
 *     readLastJsonl returns last valid object (or null)
 *   - JsonlCheckpointBackend: write→readLatest, write 3 → list newest-first + limit,
 *     idempotent write (same id twice → one line), feature-scoped file separation,
 *     capabilities() empty
 *   - createCheckpointStore registry: jsonl ok, smartmemory throws NOT_IMPLEMENTED,
 *     memory-pointer throws NOT_IMPLEMENTED, unknown throws clear error
 *
 * node:test + node:assert/strict, real fs via mkdtempSync. NOT vitest.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { writeAtomic, appendJsonl, readJsonl, readLastJsonl } = await import(
  `${REPO_ROOT}/lib/checkpoint/atomic.js`
);
const { JsonlCheckpointBackend } = await import(
  `${REPO_ROOT}/lib/checkpoint/store/jsonl.js`
);
const { createCheckpointStore } = await import(
  `${REPO_ROOT}/lib/checkpoint/store/index.js`
);

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'checkpoint-store-test-'));
}

/** Minimal valid-ish checkpoint record (store does not validate the schema). */
function makeCp(id, featureCode = 'COMP-RESUME', extra = {}) {
  return {
    id,
    featureCode,
    phase: 'implement',
    createdAt: new Date().toISOString(),
    trigger: 'phase-transition',
    fingerprint: { capturedAt: new Date().toISOString(), git: { head: null, branch: null, dirty: false, dirtyHash: null } },
    soft: null,
    ...extra,
  };
}

// ── atomic.js ────────────────────────────────────────────────────────────────

describe('atomic.js', () => {
  test('writeAtomic writes the exact string and creates parent dirs', () => {
    const dir = makeTmpDir();
    try {
      const file = join(dir, 'nested', 'deep', 'out.json');
      writeAtomic(file, '{"a":1}\n');
      assert.equal(readFileSync(file, 'utf8'), '{"a":1}\n');
      // overwrite is atomic-clean (no leftover .tmp confusion)
      writeAtomic(file, '{"a":2}\n');
      assert.equal(readFileSync(file, 'utf8'), '{"a":2}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('appendJsonl + readJsonl round-trip multiple objects', () => {
    const dir = makeTmpDir();
    try {
      const file = join(dir, 'sub', 'log.jsonl');
      appendJsonl(file, { n: 1 });
      appendJsonl(file, { n: 2 });
      appendJsonl(file, { n: 3 });
      assert.deepEqual(readJsonl(file), [{ n: 1 }, { n: 2 }, { n: 3 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('readJsonl returns [] when file is absent', () => {
    const dir = makeTmpDir();
    try {
      assert.deepEqual(readJsonl(join(dir, 'missing.jsonl')), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('readJsonl skips blank and malformed lines', () => {
    const dir = makeTmpDir();
    try {
      const file = join(dir, 'log.jsonl');
      appendJsonl(file, { ok: 1 });
      appendFileSync(file, '\n', 'utf8'); // blank
      appendFileSync(file, 'not json at all\n', 'utf8'); // malformed
      appendFileSync(file, '   \n', 'utf8'); // whitespace-only
      appendJsonl(file, { ok: 2 });
      assert.deepEqual(readJsonl(file), [{ ok: 1 }, { ok: 2 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('readLastJsonl returns the last valid object, skipping trailing junk', () => {
    const dir = makeTmpDir();
    try {
      const file = join(dir, 'log.jsonl');
      appendJsonl(file, { v: 'first' });
      appendJsonl(file, { v: 'last' });
      appendFileSync(file, 'garbage\n', 'utf8'); // trailing malformed
      assert.deepEqual(readLastJsonl(file), { v: 'last' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('readLastJsonl returns null when file is absent or empty', () => {
    const dir = makeTmpDir();
    try {
      assert.equal(readLastJsonl(join(dir, 'missing.jsonl')), null);
      const empty = join(dir, 'empty.jsonl');
      appendFileSync(empty, '\n\n', 'utf8');
      assert.equal(readLastJsonl(empty), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── JsonlCheckpointBackend ───────────────────────────────────────────────────

describe('JsonlCheckpointBackend', () => {
  test('write then readLatest returns the written checkpoint', () => {
    const dir = makeTmpDir();
    try {
      const backend = new JsonlCheckpointBackend({ dataDir: dir });
      const cp = makeCp('cp-1');
      const returned = backend.write(cp);
      assert.deepEqual(returned, cp);
      assert.deepEqual(backend.readLatest('COMP-RESUME'), cp);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('readLatest returns null for a feature with no checkpoints', () => {
    const dir = makeTmpDir();
    try {
      const backend = new JsonlCheckpointBackend({ dataDir: dir });
      assert.equal(backend.readLatest('NOPE'), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('write 3 then list returns newest-first and honors limit', () => {
    const dir = makeTmpDir();
    try {
      const backend = new JsonlCheckpointBackend({ dataDir: dir });
      backend.write(makeCp('a'));
      backend.write(makeCp('b'));
      backend.write(makeCp('c'));

      const all = backend.list('COMP-RESUME');
      assert.deepEqual(all.map((c) => c.id), ['c', 'b', 'a']); // newest-first

      const limited = backend.list('COMP-RESUME', { limit: 2 });
      assert.deepEqual(limited.map((c) => c.id), ['c', 'b']);

      // readLatest agrees with the head of the newest-first list
      assert.equal(backend.readLatest('COMP-RESUME').id, 'c');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('list returns [] for an unknown feature', () => {
    const dir = makeTmpDir();
    try {
      const backend = new JsonlCheckpointBackend({ dataDir: dir });
      assert.deepEqual(backend.list('NOPE'), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('write is idempotent on cp.id — same id twice yields one line', () => {
    const dir = makeTmpDir();
    try {
      const backend = new JsonlCheckpointBackend({ dataDir: dir });
      const first = backend.write(makeCp('dup', 'COMP-RESUME', { phase: 'design' }));
      // second write with the same id (different body) must NOT append, and must
      // return the already-persisted record.
      const second = backend.write(makeCp('dup', 'COMP-RESUME', { phase: 'implement' }));

      assert.equal(second.id, 'dup');
      assert.equal(second.phase, 'design', 'returns the originally-persisted record');
      assert.deepEqual(first, second);

      const file = join(dir, 'checkpoints-COMP-RESUME.jsonl');
      const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
      assert.equal(lines.length, 1, 'exactly one line on disk');

      assert.equal(backend.list('COMP-RESUME').length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('two different featureCodes write to separate files', () => {
    const dir = makeTmpDir();
    try {
      const backend = new JsonlCheckpointBackend({ dataDir: dir });
      backend.write(makeCp('x', 'FEAT-A'));
      backend.write(makeCp('y', 'FEAT-B'));

      assert.equal(backend.readLatest('FEAT-A').id, 'x');
      assert.equal(backend.readLatest('FEAT-B').id, 'y');
      // cross-feature isolation
      assert.deepEqual(backend.list('FEAT-A').map((c) => c.id), ['x']);
      assert.deepEqual(backend.list('FEAT-B').map((c) => c.id), ['y']);

      const fileA = join(dir, 'checkpoints-FEAT-A.jsonl');
      const fileB = join(dir, 'checkpoints-FEAT-B.jsonl');
      assert.notEqual(fileA, fileB);
      assert.ok(readFileSync(fileA, 'utf8').includes('"id":"x"'));
      assert.ok(readFileSync(fileB, 'utf8').includes('"id":"y"'));
      assert.ok(!readFileSync(fileA, 'utf8').includes('"id":"y"'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('capabilities() is an empty Set (jsonl is floor-only)', () => {
    const dir = makeTmpDir();
    try {
      const backend = new JsonlCheckpointBackend({ dataDir: dir });
      const caps = backend.capabilities();
      assert.ok(caps instanceof Set);
      assert.equal(caps.size, 0);
      assert.ok(!caps.has('semanticRecall'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── createCheckpointStore registry ───────────────────────────────────────────

describe('createCheckpointStore registry', () => {
  test("default backend is jsonl and is a JsonlCheckpointBackend", () => {
    const dir = makeTmpDir();
    try {
      const store = createCheckpointStore(undefined, { dataDir: dir });
      assert.ok(store instanceof JsonlCheckpointBackend);
      // round-trips like the backend directly
      store.write(makeCp('z'));
      assert.equal(store.readLatest('COMP-RESUME').id, 'z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("'jsonl' returns a JsonlCheckpointBackend", () => {
    const dir = makeTmpDir();
    try {
      const store = createCheckpointStore('jsonl', { dataDir: dir });
      assert.ok(store instanceof JsonlCheckpointBackend);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("'smartmemory' throws with code NOT_IMPLEMENTED", () => {
    assert.throws(
      () => createCheckpointStore('smartmemory', { dataDir: '/tmp' }),
      (err) => err.code === 'NOT_IMPLEMENTED' && /smartmemory/i.test(err.message)
    );
  });

  test("'memory-pointer' throws with code NOT_IMPLEMENTED", () => {
    assert.throws(
      () => createCheckpointStore('memory-pointer', { dataDir: '/tmp' }),
      (err) => err.code === 'NOT_IMPLEMENTED'
    );
  });

  test('unknown backend throws a clear error listing valid ids', () => {
    assert.throws(
      () => createCheckpointStore('bogus', { dataDir: '/tmp' }),
      (err) => err.code !== 'NOT_IMPLEMENTED' && /bogus/.test(err.message) && /jsonl/.test(err.message)
    );
  });
});

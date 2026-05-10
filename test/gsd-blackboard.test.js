/**
 * COMP-GSD-2 T2: gsd-blackboard tests.
 *
 * Verifies read/writeAll/validate against a temp cwd. Real fs, real lock,
 * no mocking.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { read, writeAll, validate } = await import(`${REPO_ROOT}/lib/gsd-blackboard.js`);

let cwd;
before(() => {
  cwd = mkdtempSync(join(tmpdir(), 'gsd-blackboard-'));
});
after(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const sampleResult = {
  status: 'passed',
  files_changed: ['lib/x.js'],
  summary: 'did the thing',
  produces: { x: 'function x()' },
  gates: [{ command: 'pnpm test', status: 'pass', output: '' }],
  attempts: 1,
};

test('read returns {} when blackboard absent', () => {
  const out = read('FOO', { cwd });
  assert.deepEqual(out, {});
});

test('writeAll then read round-trips byte-equal', async () => {
  const taskResults = { t1: sampleResult, t2: { ...sampleResult, summary: 'two' } };
  await writeAll('BAR', taskResults, { cwd });
  const out = read('BAR', { cwd });
  assert.deepEqual(out, taskResults);
});

test('writeAll creates blackboard.json at expected path', async () => {
  await writeAll('BAZ', { t1: sampleResult }, { cwd });
  const path = join(cwd, '.compose', 'gsd', 'BAZ', 'blackboard.json');
  assert.ok(existsSync(path), `expected ${path} to exist`);
  const parsed = JSON.parse(readFileSync(path, 'utf-8'));
  assert.deepEqual(parsed.t1, sampleResult);
});

test('writeAll concurrent writers — one wins, no accumulation', async () => {
  const code = 'CONCUR';
  const submitted = [];
  const writers = [];
  for (let i = 0; i < 8; i++) {
    const m = { [`t${i}`]: { ...sampleResult, summary: `writer-${i}` } };
    submitted.push(m);
    writers.push(writeAll(code, m, { cwd }));
  }
  await Promise.all(writers);
  const out = read(code, { cwd });
  // Final blackboard must equal EXACTLY one of the submitted maps —
  // not an accumulation across writers (writeAll is a one-shot replace).
  const matched = submitted.find((m) => JSON.stringify(m) === JSON.stringify(out));
  assert.ok(matched, `final blackboard should equal exactly one submitted map; got keys=${Object.keys(out)}`);
});

test('writeAll lock is released even on validate failure', async () => {
  const code = 'LOCKREL';
  const invalid = { t1: { status: 'maybe' /* invalid */ } };
  await assert.rejects(() => writeAll(code, invalid, { cwd }), /invalid/i);
  // Lock should be released — a second valid write must succeed
  await writeAll(code, { t1: sampleResult }, { cwd });
  const out = read(code, { cwd });
  assert.deepEqual(out.t1, sampleResult);
});

test('validate accepts valid TaskResult', () => {
  const r = validate(sampleResult);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('validate rejects malformed TaskResult', () => {
  const r = validate({ status: 'maybe', files_changed: [], summary: '', produces: {}, gates: [], attempts: 0 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});

test('validate rejects non-object input', () => {
  const r = validate('not an object');
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});

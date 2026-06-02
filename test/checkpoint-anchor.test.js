/**
 * COMP-RESUME S7 — captureAnchor() best-effort boundary capture.
 *
 * Exercises lib/checkpoint/anchor.js against a real git repo in mkdtempSync and
 * a real JSONL checkpoint store:
 *   - happy path: anchor cp has soft:null, correct featureCode/phase, persisted
 *     and recoverable via store.readLatest
 *   - contract: the produced cp validates clean against contracts/checkpoint.schema.json
 *   - best-effort: a throwing store.write is swallowed (returns null, never throws);
 *     a non-git cwd is also tolerated.
 *
 * node:test + node:assert/strict, real fs via mkdtempSync, real git via execSync.
 * NOT vitest.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { captureAnchor } = await import(`${REPO_ROOT}/lib/checkpoint/anchor.js`);
const { createCheckpointStore } = await import(
  `${REPO_ROOT}/lib/checkpoint/store/index.js`
);
const { SchemaValidator } = await import(`${REPO_ROOT}/server/schema-validator.js`);

const CHECKPOINT_SCHEMA = resolve(REPO_ROOT, 'contracts/checkpoint.schema.json');

// ── Helpers ────────────────────────────────────────────────────────────────

function initRepo(dir) {
  const opts = { cwd: dir, stdio: 'ignore' };
  execSync('git init -q -b main', opts);
  execSync('git config user.email test@example.com', opts);
  execSync('git config user.name Test', opts);
  execSync('git config commit.gpgsign false', opts);
}

function commitAll(dir, msg) {
  execSync('git add -A', { cwd: dir, stdio: 'ignore' });
  execSync(`git commit -q -m "${msg}"`, { cwd: dir, stdio: 'ignore' });
}

/** A fake vision item with just the lifecycle fields captureAnchor reads. */
function makeItem(featureCode = 'COMP-RESUME', currentPhase = 'implementation') {
  return { lifecycle: { featureCode, currentPhase } };
}

// ── Happy path ───────────────────────────────────────────────────────────────

describe('captureAnchor — happy path', () => {
  test('writes an anchor (soft:null) and readLatest recovers it', () => {
    const root = mkdtempSync(join(tmpdir(), 'comp-resume-anchor-'));
    try {
      initRepo(root);
      writeFileSync(join(root, 'README.md'), '# repo\n');
      commitAll(root, 'init');

      const dataDir = join(root, '.compose', 'data');
      const store = createCheckpointStore('jsonl', { dataDir });
      const item = makeItem('COMP-RESUME', 'implementation');

      const cp = captureAnchor({
        item,
        trigger: 'phase-transition',
        cwd: root,
        featureDir: root,
        dataDir,
        store,
      });

      // returned cp shape
      assert.ok(cp, 'captureAnchor returned a checkpoint');
      assert.equal(cp.soft, null, 'anchor checkpoints have soft:null');
      assert.equal(cp.featureCode, 'COMP-RESUME');
      assert.equal(cp.phase, 'implementation');
      assert.equal(cp.trigger, 'phase-transition');
      assert.deepEqual(cp.artifactIds, []);
      assert.equal(typeof cp.id, 'string');
      assert.ok(cp.id.length > 0);
      assert.equal(typeof cp.createdAt, 'string');
      assert.ok(cp.fingerprint && typeof cp.fingerprint === 'object');
      // fingerprint was captured against the real repo
      assert.ok(/^[0-9a-f]{40}$/.test(cp.fingerprint.git.head), 'real HEAD sha');

      // persisted + recoverable
      const latest = store.readLatest('COMP-RESUME');
      assert.deepEqual(latest, cp, 'readLatest returns the written anchor');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Contract ───────────────────────────────────────────────────────────────

describe('captureAnchor — contract', () => {
  test('produced anchor validates against contracts/checkpoint.schema.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'comp-resume-anchor-contract-'));
    try {
      initRepo(root);
      writeFileSync(join(root, 'README.md'), '# repo\n');
      commitAll(root, 'init');

      const dataDir = join(root, '.compose', 'data');
      const store = createCheckpointStore('jsonl', { dataDir });

      const cp = captureAnchor({
        item: makeItem('COMP-RESUME', 'design'),
        trigger: 'manual',
        cwd: root,
        featureDir: root,
        dataDir,
        store,
      });
      assert.ok(cp, 'captureAnchor returned a checkpoint');

      const validator = new SchemaValidator(CHECKPOINT_SCHEMA);
      const { valid, errors } = validator.validateRoot(cp);
      assert.equal(valid, true, `schema errors: ${JSON.stringify(errors)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Best-effort (never throws) ────────────────────────────────────────────────

describe('captureAnchor — best-effort', () => {
  test('a throwing store.write is swallowed → returns null, does not throw', () => {
    const root = mkdtempSync(join(tmpdir(), 'comp-resume-anchor-throw-'));
    try {
      initRepo(root);
      writeFileSync(join(root, 'README.md'), '# repo\n');
      commitAll(root, 'init');

      const boomStore = {
        write() {
          throw new Error('boom: backend exploded');
        },
      };

      let cp;
      assert.doesNotThrow(() => {
        cp = captureAnchor({
          item: makeItem('COMP-RESUME', 'implementation'),
          trigger: 'pre-risky-action',
          cwd: root,
          featureDir: root,
          dataDir: join(root, '.compose', 'data'),
          store: boomStore,
        });
      });
      assert.equal(cp, null, 'failed write yields null, not a throw');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('non-git cwd does not throw (fingerprint degrades gracefully)', () => {
    const root = mkdtempSync(join(tmpdir(), 'comp-resume-anchor-nogit-'));
    try {
      // NOTE: no initRepo — root is NOT a git repo.
      const dataDir = join(root, '.compose', 'data');
      const store = createCheckpointStore('jsonl', { dataDir });

      let cp;
      assert.doesNotThrow(() => {
        cp = captureAnchor({
          item: makeItem('COMP-RESUME', 'implementation'),
          trigger: 'resume-sync',
          cwd: root,
          featureDir: root,
          dataDir,
          store,
        });
      });
      // It still produces a (valid) checkpoint: git fields are null outside a repo.
      assert.ok(cp, 'still returns a checkpoint outside a git repo');
      assert.equal(cp.fingerprint.git.head, null, 'HEAD is null with no repo');
      assert.equal(cp.soft, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

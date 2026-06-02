/**
 * checkpoint-reconciler.test.js — unit tests for lib/checkpoint/reconciler.js
 *
 * COMP-RESUME slice S8 (CORRECTED boundary, per the Codex boundary review):
 * `reconcile()` is DETERMINISTIC. It does NOT write to the store, does NOT
 * mutate any DB, and does NOT call an LLM/connector. It computes and RETURNS a
 * ReconcileResult. Persistence + agent-run happen at the caller (route +
 * orchestrator). It MAY mutate the passed-in `item` object in memory and surface
 * those changes as `lifecycleMutations` for the caller to persist.
 *
 * Covered here:
 *   - decideAfterSync table (pure gate decision)
 *   - classify-path: real jsonl store + real git repo; checkpoint written via
 *     store.write (NOT anchor.js — anchor.js is owned by another subagent):
 *       · no change            → action 'resume', nextStep matches
 *       · new commit, clean    → action 'resume' (advanced)
 *       · dirtied tracked file → action 'needs-sync' + non-empty reconcilePrompt
 *   - backfill: empty phaseHistory + a currentPhase → lifecycleMutations has a
 *     phaseHistory.append descriptor
 *
 * node:test + node:assert/strict, real git via execSync, real jsonl store, real
 * fs via mkdtempSync, cleanup in finally. NOT vitest. No store writes from
 * reconcile itself — the test seeds the store directly.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { reconcile, decideAfterSync } = await import(
  `${REPO_ROOT}/lib/checkpoint/reconciler.js`
);
const { captureFingerprint } = await import(
  `${REPO_ROOT}/lib/checkpoint/fingerprint.js`
);
const { JsonlCheckpointBackend } = await import(
  `${REPO_ROOT}/lib/checkpoint/store/jsonl.js`
);

// ── git helpers (real repo) ──────────────────────────────────────────────────

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

/**
 * Stand up a real repo + feature dir + a JsonlCheckpointBackend, and seed a
 * single narrative checkpoint whose fingerprint is captured at current HEAD.
 * Returns the wiring plus the captured fingerprint and the nextStep recorded.
 */
function setup({ nextStep }) {
  const root = mkdtempSync(join(tmpdir(), 'comp-resume-reconcile-'));
  initRepo(root);
  writeFileSync(join(root, 'README.md'), '# repo\n');

  const featureDir = join(root, 'docs', 'features', 'COMP-RESUME');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'design.md'), '# design\n');
  // keep .compose/ out of the tree so build-stream writes never dirty it
  writeFileSync(join(root, '.gitignore'), '.compose/\n');
  commitAll(root, 'scaffold');

  const dataDir = join(root, '.compose', 'data');
  mkdirSync(dataDir, { recursive: true });

  const store = new JsonlCheckpointBackend({ dataDir });

  // Capture a fingerprint at the current (clean) HEAD and seed a narrative
  // checkpoint with a soft.nextStep. Written via store.write — not anchor.js.
  const fingerprint = captureFingerprint(root, { featureDir, dataDir });
  const cp = {
    id: 'seed-1',
    featureCode: 'COMP-RESUME',
    phase: 'implement',
    createdAt: new Date().toISOString(),
    trigger: 'phase-transition',
    fingerprint,
    soft: { goal: 'ship resume', nextStep, risks: [] },
    artifactIds: [],
  };
  store.write(cp);

  return { root, featureDir, dataDir, store, fingerprint, cp };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

/** A minimal vision item with a lifecycle block. */
function makeItem({ currentPhase = 'implement', phaseHistory = [] } = {}) {
  return {
    code: 'COMP-RESUME',
    lifecycle: { currentPhase, phaseHistory },
  };
}

// ── decideAfterSync (pure gate decision) ─────────────────────────────────────

describe('decideAfterSync', () => {
  const rows = [
    { confidence: 0.7, confidenceThreshold: 0.6, expect: 'resume' },
    { confidence: 0.6, confidenceThreshold: 0.6, expect: 'resume' }, // boundary inclusive
    { confidence: 0.4, confidenceThreshold: 0.6, expect: 'gate' },
  ];
  for (const r of rows) {
    test(`confidence ${r.confidence} vs threshold ${r.confidenceThreshold} → ${r.expect}`, () => {
      assert.equal(
        decideAfterSync({ confidence: r.confidence, confidenceThreshold: r.confidenceThreshold }),
        r.expect,
      );
    });
  }

  test('default threshold is 0.6', () => {
    assert.equal(decideAfterSync({ confidence: 0.6 }), 'resume');
    assert.equal(decideAfterSync({ confidence: 0.59 }), 'gate');
  });
});

// ── classify-path (real store + real git) ────────────────────────────────────

describe('reconcile — classify paths', () => {
  test("no environment change → action 'resume', nextStep matches the checkpoint", () => {
    const { root, featureDir, dataDir, store } = setup({ nextStep: 'wire S10 route' });
    try {
      const item = makeItem();
      const result = reconcile({
        featureCode: 'COMP-RESUME',
        item,
        cwd: root,
        featureDir,
        dataDir,
        store,
      });
      assert.equal(result.action, 'resume');
      assert.equal(result.nextStep, 'wire S10 route');
      assert.equal(result.drift, 'clean');
      assert.ok(Array.isArray(result.lifecycleMutations));
      // no reconcilePrompt on the resume path
      assert.equal(result.reconcilePrompt, undefined);
    } finally {
      cleanup(root);
    }
  });

  test("a new commit on a clean tree → action 'resume' (advanced)", () => {
    const { root, featureDir, dataDir, store } = setup({ nextStep: 'run tests' });
    try {
      // advance HEAD with a clean commit (no artifact removed)
      writeFileSync(join(root, 'NEWFILE.md'), '# added\n');
      commitAll(root, 'advance');

      const item = makeItem();
      const result = reconcile({
        featureCode: 'COMP-RESUME',
        item,
        cwd: root,
        featureDir,
        dataDir,
        store,
      });
      assert.equal(result.drift, 'advanced');
      assert.equal(result.action, 'resume');
      assert.equal(result.nextStep, 'run tests');
    } finally {
      cleanup(root);
    }
  });

  test("a dirtied TRACKED file → action 'needs-sync' with a non-empty reconcilePrompt", () => {
    const { root, featureDir, dataDir, store } = setup({ nextStep: 'finish impl' });
    try {
      // Edit a TRACKED file (README.md) so the fingerprint changes. (dirtyHash
      // hashes `git status --porcelain` + `git diff`, so an untracked file would
      // also change it via its `??` porcelain line — editing a tracked file is
      // simply the most direct way to force a diverged classification here.)
      writeFileSync(join(root, 'README.md'), '# repo\nwork in progress\n');

      const item = makeItem();
      const result = reconcile({
        featureCode: 'COMP-RESUME',
        item,
        cwd: root,
        featureDir,
        dataDir,
        store,
      });
      assert.equal(result.drift, 'diverged');
      assert.equal(result.action, 'needs-sync');
      assert.equal(typeof result.reconcilePrompt, 'string');
      assert.ok(result.reconcilePrompt.length > 0, 'reconcilePrompt is non-empty');
      // needs-sync does not pre-decide a nextStep
      assert.equal(result.nextStep, undefined);
    } finally {
      cleanup(root);
    }
  });

  test('no checkpoint at all → resume with null nextStep (classify treats null prev as clean)', () => {
    const root = mkdtempSync(join(tmpdir(), 'comp-resume-empty-'));
    try {
      initRepo(root);
      writeFileSync(join(root, 'README.md'), '# repo\n');
      writeFileSync(join(root, '.gitignore'), '.compose/\n');
      commitAll(root, 'init');
      const featureDir = join(root, 'docs', 'features', 'COMP-RESUME');
      mkdirSync(featureDir, { recursive: true });
      const dataDir = join(root, '.compose', 'data');
      mkdirSync(dataDir, { recursive: true });
      const store = new JsonlCheckpointBackend({ dataDir });

      const result = reconcile({
        featureCode: 'COMP-RESUME',
        item: makeItem(),
        cwd: root,
        featureDir,
        dataDir,
        store,
      });
      assert.equal(result.drift, 'clean');
      assert.equal(result.action, 'resume');
      assert.equal(result.nextStep, null);
    } finally {
      cleanup(root);
    }
  });
});

// ── backfill (phaseHistory) ──────────────────────────────────────────────────

describe('reconcile — phaseHistory backfill', () => {
  test('empty phaseHistory + a currentPhase → lifecycleMutations has a phaseHistory.append', () => {
    const { root, featureDir, dataDir, store } = setup({ nextStep: 'x' });
    try {
      const item = makeItem({ currentPhase: 'blueprint', phaseHistory: [] });
      const result = reconcile({
        featureCode: 'COMP-RESUME',
        item,
        cwd: root,
        featureDir,
        dataDir,
        store,
      });

      const appends = result.lifecycleMutations.filter((m) => m.type === 'phaseHistory.append');
      assert.equal(appends.length, 1, 'exactly one backfill append');
      const entry = appends[0].entry;
      assert.equal(entry.from, null);
      assert.equal(entry.to, 'blueprint');
      assert.equal(entry.outcome, 'resumed');
      assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    } finally {
      cleanup(root);
    }
  });

  test('already-populated phaseHistory → no backfill append', () => {
    const { root, featureDir, dataDir, store } = setup({ nextStep: 'x' });
    try {
      const item = makeItem({
        currentPhase: 'implement',
        phaseHistory: [{ from: 'design', to: 'blueprint', outcome: 'advanced', timestamp: '2026-06-01T00:00:00.000Z' }],
      });
      const result = reconcile({
        featureCode: 'COMP-RESUME',
        item,
        cwd: root,
        featureDir,
        dataDir,
        store,
      });
      const appends = result.lifecycleMutations.filter((m) => m.type === 'phaseHistory.append');
      assert.equal(appends.length, 0, 'no backfill when history already populated');
    } finally {
      cleanup(root);
    }
  });

  test('no currentPhase → no backfill append even when history empty', () => {
    const { root, featureDir, dataDir, store } = setup({ nextStep: 'x' });
    try {
      // Build the item directly: makeItem()'s destructuring default would turn
      // `currentPhase: undefined` back into 'implement'. We want a genuinely
      // absent currentPhase here.
      const item = { code: 'COMP-RESUME', lifecycle: { phaseHistory: [] } };
      const result = reconcile({
        featureCode: 'COMP-RESUME',
        item,
        cwd: root,
        featureDir,
        dataDir,
        store,
      });
      const appends = result.lifecycleMutations.filter((m) => m.type === 'phaseHistory.append');
      assert.equal(appends.length, 0);
    } finally {
      cleanup(root);
    }
  });
});

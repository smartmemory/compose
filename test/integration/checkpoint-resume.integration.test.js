/**
 * checkpoint-resume.integration.test.js — COMP-RESUME golden flow (S8).
 *
 * The capability: after an interruption, a resumed Compose build feels like
 * CONTINUING, not re-deriving — it reconstructs derived state from ground truth
 * and presents the correct next action. This test exercises that end-to-end with
 * REAL backends (real git repo, real jsonl CheckpointStore, real fs), no mocks.
 *
 * Faithful lifecycle:
 *   1. Build runs across phases, writing anchor-style checkpoints at each
 *      boundary (soft:null) directly via store.write — NOT anchor.js, which is
 *      owned by a concurrent subagent.
 *   2. At a major boundary the scribe records a narrative checkpoint carrying
 *      soft.nextStep ("the intent").
 *   3. Interruption = we simply stop (crash/kill leaves the store + env intact).
 *   4. Resume: reconcile() reads ground truth (latest checkpoint + live env),
 *      classifies drift, and resumes at the recorded nextStep when the env is
 *      unchanged.
 *
 * The boundary under test: reconcile is deterministic — it must NOT have written
 * to the store. We assert the store still holds exactly the checkpoints the build
 * wrote (no reconcile-authored record).
 *
 * node:test + node:assert/strict, mkdtempSync, execSync, cleanup in finally.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const { reconcile } = await import(`${REPO_ROOT}/lib/checkpoint/reconciler.js`);
const { captureFingerprint } = await import(`${REPO_ROOT}/lib/checkpoint/fingerprint.js`);
const { JsonlCheckpointBackend } = await import(`${REPO_ROOT}/lib/checkpoint/store/jsonl.js`);

function git(dir, cmd) {
  execSync(cmd, { cwd: dir, stdio: 'ignore' });
}
function initRepo(dir) {
  git(dir, 'git init -q -b main');
  git(dir, 'git config user.email test@example.com');
  git(dir, 'git config user.name Test');
  git(dir, 'git config commit.gpgsign false');
}
function commitAll(dir, msg) {
  git(dir, 'git add -A');
  git(dir, `git commit -q -m "${msg}"`);
}

const FEATURE = 'COMP-RESUME';

/** An anchor checkpoint (soft:null) — what the hook writes at a boundary. */
function anchorCp(id, phase, fingerprint) {
  return {
    id,
    featureCode: FEATURE,
    phase,
    createdAt: new Date().toISOString(),
    trigger: 'phase-transition',
    fingerprint,
    soft: null,
    artifactIds: [],
  };
}

/** A narrative checkpoint — what the scribe writes at a major boundary. */
function narrativeCp(id, phase, fingerprint, soft) {
  return { ...anchorCp(id, phase, fingerprint), trigger: 'phase-transition', soft };
}

test('golden: write anchors across phases → narrative checkpoint → stop → reconcile resumes at nextStep', () => {
  const root = mkdtempSync(join(tmpdir(), 'comp-resume-golden-'));
  try {
    // ── set up the project: real repo, feature dir, gitignored .compose ──────
    initRepo(root);
    const featureDir = join(root, 'docs', 'features', FEATURE);
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(root, 'README.md'), '# project\n');
    writeFileSync(join(root, '.gitignore'), '.compose/\n');

    const dataDir = join(root, '.compose', 'data');
    mkdirSync(dataDir, { recursive: true });
    const store = new JsonlCheckpointBackend({ dataDir });

    // ── PHASE: design — produce design.md, commit, write an anchor ───────────
    writeFileSync(join(featureDir, 'design.md'), '# design\n');
    commitAll(root, 'design');
    store.write(
      anchorCp('a-design', 'design', captureFingerprint(root, { featureDir, dataDir })),
    );

    // ── PHASE: blueprint — produce blueprint.md, commit, write an anchor ─────
    writeFileSync(join(featureDir, 'blueprint.md'), '# blueprint\n');
    commitAll(root, 'blueprint');
    store.write(
      anchorCp('a-blueprint', 'blueprint', captureFingerprint(root, { featureDir, dataDir })),
    );

    // ── MAJOR BOUNDARY: entering implement — scribe records intent ───────────
    // Simulate active-build.json being present (derived pointer), as it would be
    // mid-build. reconcile reads it tolerantly.
    writeFileSync(
      join(dataDir, 'active-build.json'),
      JSON.stringify({ featureCode: FEATURE, flowId: 'flow-xyz', currentStepId: 'impl-1', status: 'running', pid: 999999 }),
    );
    const intentFp = captureFingerprint(root, { featureDir, dataDir });
    const NEXT_STEP = 'implement reconciler.js: write decideAfterSync + classify branch';
    store.write(
      narrativeCp('n-implement', 'implement', intentFp, {
        goal: 'Ship COMP-RESUME resume capability',
        nextStep: NEXT_STEP,
        risks: ['env may drift if a teammate pushes'],
      }),
    );

    // sanity: the store recorded everything the build wrote, narrative last
    const beforeResume = store.list(FEATURE);
    assert.equal(beforeResume.length, 3);
    assert.equal(store.readLatest(FEATURE).id, 'n-implement');

    // ── INTERRUPTION: the session simply stops here. ─────────────────────────
    // (No further writes. The store + filesystem + git are the only survivors.)

    // ── RESUME: a fresh reconcile against ground truth. Env unchanged since
    //    the narrative checkpoint, so this must resume cleanly at NEXT_STEP. ──
    const item = {
      code: FEATURE,
      // Derived state lost its phaseHistory across the "crash" — reconcile
      // should surface a backfill mutation for the caller to persist.
      lifecycle: { currentPhase: 'implement', phaseHistory: [] },
    };
    const result = reconcile({
      featureCode: FEATURE,
      item,
      cwd: root,
      featureDir,
      dataDir,
      store,
    });

    // resumes at the recorded intent
    assert.equal(result.action, 'resume', 'unchanged env → resume');
    assert.equal(result.drift, 'clean');
    assert.equal(result.nextStep, NEXT_STEP, 'resumes at the scribe-recorded nextStep');

    // backfill mutation surfaced for the caller (reconcile does not persist)
    const appends = result.lifecycleMutations.filter((m) => m.type === 'phaseHistory.append');
    assert.equal(appends.length, 1);
    assert.equal(appends[0].entry.to, 'implement');
    assert.equal(appends[0].entry.outcome, 'resumed');

    // BOUNDARY GUARANTEE: reconcile is deterministic and did NOT write to the
    // store. The store still holds exactly the 3 build-written checkpoints.
    const afterResume = store.list(FEATURE);
    assert.equal(afterResume.length, 3, 'reconcile must not have written a checkpoint');
    assert.deepEqual(
      afterResume.map((c) => c.id).sort(),
      ['a-blueprint', 'a-design', 'n-implement'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

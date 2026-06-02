/**
 * COMP-RESUME S2/S3 — captureFingerprint() integration (real git, real fs).
 *
 * Exercises the git wrapper (lib/checkpoint/git.js) through captureFingerprint
 * against a real repo created in a mkdtempSync tmpdir:
 *   - git.head is a 40-char sha
 *   - dirty toggles false → true when an untracked file appears
 *   - dirtyHash is null on a clean tree, deterministic on a dirty tree,
 *     and changes when the tree changes
 *   - phaseArtifacts.design resolves to the on-disk path (null when absent)
 *   - buildStreamSeq reads the last _seq of build-stream.jsonl
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { captureFingerprint } = await import(`${REPO_ROOT}/lib/checkpoint/fingerprint.js`);

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

test('captureFingerprint: real repo head/dirty/dirtyHash/artifacts/seq', () => {
  const root = mkdtempSync(join(tmpdir(), 'comp-resume-fp-'));
  try {
    // ── set up a real repo with one commit ────────────────────────────────
    initRepo(root);
    writeFileSync(join(root, 'README.md'), '# repo\n');
    commitAll(root, 'init');

    // featureDir with a design.md present, no blueprint/plan
    const featureDir = join(root, 'docs', 'features', 'COMP-RESUME');
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, 'design.md'), '# design\n');

    // .compose/data is gitignored in real projects — keep it out of the tree
    // so the build-stream file below doesn't dirty the working tree.
    writeFileSync(join(root, '.gitignore'), '.compose/\n');

    // Commit the scaffolding so the tree is genuinely clean for fp1.
    commitAll(root, 'scaffold');

    // build-stream.jsonl lives at .compose/ (composeDir), NOT .compose/data —
    // matches lib/build-stream-writer.js:28. captureFingerprint derives
    // composeDir = dirname(dataDir). Last valid line has _seq: 7.
    // (.compose/ is gitignored, so it does not affect dirty state.)
    const dataDir = join(root, '.compose', 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(root, '.compose', 'build-stream.jsonl'),
      [
        JSON.stringify({ type: 'step', _seq: 5 }),
        JSON.stringify({ type: 'step', _seq: 7 }),
        '', // trailing newline → empty last segment, must be tolerated
      ].join('\n'),
    );

    // ── clean-tree capture ────────────────────────────────────────────────
    const fp1 = captureFingerprint(root, {
      featureDir,
      flowId: 'flow-123',
      dataDir,
    });

    // git.head is a 40-char hex sha
    assert.match(fp1.git.head, /^[0-9a-f]{40}$/);
    assert.equal(fp1.git.branch, 'main');
    assert.equal(fp1.git.dirty, false, 'clean tree → dirty=false');
    assert.equal(fp1.git.dirtyHash, null, 'clean tree → dirtyHash=null');

    // phaseArtifacts: design present, blueprint/plan absent
    assert.equal(fp1.phaseArtifacts.design, join(featureDir, 'design.md'));
    assert.equal(fp1.phaseArtifacts.blueprint, null);
    assert.equal(fp1.phaseArtifacts.plan, null);
    assert.deepEqual(fp1.phaseArtifacts.implementFiles, []);
    assert.deepEqual(fp1.phaseArtifacts.contracts, []);

    // passthroughs + seq
    assert.equal(fp1.flowId, 'flow-123');
    assert.equal(fp1.buildStreamSeq, 7);
    assert.equal(fp1.testRef, null);
    assert.match(fp1.capturedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);

    // ── make the tree dirty: untracked file ───────────────────────────────
    writeFileSync(join(root, 'scratch.txt'), 'hello\n');
    const fp2 = captureFingerprint(root, { featureDir, dataDir });
    assert.equal(fp2.git.dirty, true, 'untracked file → dirty=true');
    assert.notEqual(fp2.git.dirtyHash, null, 'dirty tree → dirtyHash set');
    assert.equal(fp2.git.head, fp1.git.head, 'head unchanged by working-tree edits');

    // determinism: same dirty state → same hash
    const fp2b = captureFingerprint(root, { featureDir, dataDir });
    assert.equal(fp2b.git.dirtyHash, fp2.git.dirtyHash, 'dirtyHash deterministic');

    // changing the tree changes the hash. dirtyHash is sha256 of
    // `git status --porcelain` + `git diff`; `git diff` only reflects *tracked*
    // files, so we must edit a tracked file (README.md) — editing an untracked
    // file's body would leave both inputs unchanged.
    writeFileSync(join(root, 'README.md'), '# repo\nmodified\n');
    const fp3 = captureFingerprint(root, { featureDir, dataDir });
    assert.notEqual(fp3.git.dirtyHash, fp2.git.dirtyHash, 'dirtyHash changes with tree');

    // ── flowId/dataDir defaults ───────────────────────────────────────────
    const fpNoData = captureFingerprint(root, { featureDir });
    assert.equal(fpNoData.flowId, null, 'flowId defaults to null');
    assert.equal(fpNoData.buildStreamSeq, null, 'no dataDir → buildStreamSeq null');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('captureFingerprint: outside a git repo → head/branch null, dirty false', () => {
  const root = mkdtempSync(join(tmpdir(), 'comp-resume-nogit-'));
  try {
    const featureDir = join(root, 'feat');
    mkdirSync(featureDir, { recursive: true });
    const fp = captureFingerprint(root, { featureDir });
    assert.equal(fp.git.head, null);
    assert.equal(fp.git.branch, null);
    assert.equal(fp.git.dirty, false);
    assert.equal(fp.git.dirtyHash, null);
    // artifacts still resolve relative to featureDir (all absent here)
    assert.equal(fp.phaseArtifacts.design, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { executeShipStep } from '../lib/build.js';
import {
  computeRecordHashes,
  writeManifest,
} from '../lib/judgment-attest.js';
import { regenerateProjections } from '../lib/judgment-gen.js';

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-ship-fields-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  // Initial commit so HEAD exists
  fs.writeFileSync(path.join(dir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: dir });
  execSync('git commit -q -m "init"', { cwd: dir });
  return dir;
}

function installCleanJudgmentCanon(repo) {
  const record = path.join(repo, 'docs', 'judgment', 'records', 'people', 'ada.json');
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.writeFileSync(record, `${JSON.stringify({
    slug: 'ada',
    display_name: 'Ada',
    facts: [],
    edges: [],
    open_fields: [],
    load_links: [],
  })}\n`);
  regenerateProjections(repo);
  writeManifest(repo, computeRecordHashes(repo));
  execSync('git add docs/judgment .compose/judgment-attest.json', { cwd: repo });
  execSync('git commit -q -m "add clean judgment canon"', { cwd: repo });
}

function commitCount(repo) {
  return Number(execSync('git rev-list --count HEAD', { cwd: repo, encoding: 'utf8' }).trim());
}

test('executeShipStep: repo with no judgment canon commits normally', async () => {
  const repo = makeRepo();
  assert.equal(fs.existsSync(path.join(repo, 'docs', 'judgment')), false);
  // Create a feature dir + file to be staged
  const featureDir = path.join(repo, 'docs/features/TEST-FEAT');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, 'plan.md'), '# plan\n');
  fs.writeFileSync(path.join(repo, 'lib-foo.js'), 'export const x = 1;\n');

  const before = commitCount(repo);
  const context = { mode: 'feature', filesChanged: ['lib-foo.js'] };
  const result = await executeShipStep(
    'TEST-FEAT',
    repo,
    repo,
    context,
    'Add a thing',
    null
  );

  assert.equal(result.outcome, 'complete');
  assert.equal(result.phase, 'ship');
  assert.ok(typeof result.commit === 'string' && result.commit.length >= 7, `commit set: ${result.commit}`);
  assert.ok(Array.isArray(result.filesChanged), 'filesChanged is an array');
  assert.ok(result.filesChanged.includes('lib-foo.js') || result.filesChanged.some(f => f.endsWith('lib-foo.js')), `filesChanged includes lib-foo.js: ${JSON.stringify(result.filesChanged)}`);
  assert.equal(commitCount(repo), before + 1);
});

test('executeShipStep: clean judgment canon proceeds to commit', async () => {
  const repo = makeRepo();
  installCleanJudgmentCanon(repo);
  const featureDir = path.join(repo, 'docs', 'features', 'CANON-CLEAN');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, 'plan.md'), '# plan\n');
  fs.writeFileSync(path.join(repo, 'lib-clean.js'), 'export const clean = true;\n');

  const before = commitCount(repo);
  const result = await executeShipStep(
    'CANON-CLEAN',
    repo,
    repo,
    { mode: 'feature', filesChanged: ['lib-clean.js'] },
    'Ship with clean canon',
    null,
  );

  assert.equal(result.outcome, 'complete', result.summary);
  assert.equal(commitCount(repo), before + 1);
});

test('executeShipStep: pre-staged judgment drift hard-fails before commit', async () => {
  const repo = makeRepo();
  installCleanJudgmentCanon(repo);
  const projectionRel = 'docs/judgment/REGISTER.md';
  const projection = path.join(repo, projectionRel);
  fs.writeFileSync(projection, `${fs.readFileSync(projection, 'utf8')}\nraw edit\n`);
  execSync(`git add -- ${projectionRel}`, { cwd: repo });

  const featureDir = path.join(repo, 'docs', 'features', 'CANON-DRIFT');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, 'plan.md'), '# plan\n');
  fs.writeFileSync(path.join(repo, 'lib-drift.js'), 'export const drift = true;\n');

  const before = commitCount(repo);
  const result = await executeShipStep(
    'CANON-DRIFT',
    repo,
    repo,
    { mode: 'feature', filesChanged: ['lib-drift.js'] },
    'Must not ship drift',
    null,
  );

  assert.equal(result.outcome, 'failed');
  assert.equal(result.error_code, 'JUDGMENT_CANON_DRIFT');
  assert.match(result.summary, /Projection drift:/);
  assert.match(result.summary, /docs\/judgment\/REGISTER\.md/);
  assert.equal(commitCount(repo), before, 'drift must not create a commit');
});

test('executeShipStep: post-commit metadata failure does not downgrade outcome', async () => {
  const repo = makeRepo();
  const featureDir = path.join(repo, 'docs/features/META-FAIL');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, 'plan.md'), '# plan\n');
  fs.writeFileSync(path.join(repo, 'lib-meta.js'), 'export const m = 1;\n');

  // Wrap execSync via PATH/git: simpler approach — corrupt .git/HEAD AFTER the commit but
  // BEFORE the metadata-collection calls. We achieve that by stubbing through a custom git
  // wrapper in PATH that intercepts only `rev-parse HEAD` and `show --name-only` post-commit.
  //
  // Pragmatic alternative: we run the commit "manually" first by pre-staging in a way that
  // makes the ship-step's commit step fail to read HEAD. Instead, simulate via filesystem:
  // remove .git after the function commits is too late because executeShipStep runs all
  // steps in one call. We monkey-patch by renaming .git directly *before* calling
  // executeShipStep but only after running an initial commit so HEAD ref system is broken.
  //
  // Simpler simulation: corrupt refs/heads/main mid-flow by dropping .git after staging
  // is impossible from here. So: run executeShipStep once successfully, then manually break
  // HEAD and call again — verify the second call's metadata returns safe defaults but
  // outcome is still complete (the second call hits "no-changes" path though).
  //
  // The cleanest assertion: corrupt .git/HEAD so that `git rev-parse HEAD` fails, then
  // call executeShipStep — the early `git rev-parse --is-inside-work-tree` succeeds via
  // the `.git/` directory existing, but rev-parse HEAD will error. With S1 fixes,
  // outcome should remain 'complete' with commit=null.
  //
  // We achieve this by: making a real change, then breaking HEAD ref content right
  // before commit. To make commit succeed but rev-parse HEAD fail post-commit, we
  // arrange for HEAD to be unreadable AFTER commit. Simplest: shim `git` in PATH.
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitshim-'));
  const shimPath = path.join(shimDir, 'git');
  // Shim that delegates to real git, but fails on `rev-parse HEAD` and `show --name-only`
  const realGit = execSync('command -v git', { encoding: 'utf-8' }).trim();
  fs.writeFileSync(shimPath, `#!/bin/sh
# args
case " $* " in
  *" rev-parse HEAD "*)
    echo "shim: simulated rev-parse HEAD failure" >&2; exit 1 ;;
  *" show --name-only "*)
    echo "shim: simulated show failure" >&2; exit 1 ;;
  *)
    exec ${realGit} "$@" ;;
esac
`);
  fs.chmodSync(shimPath, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${origPath}`;
  try {
    const context = { mode: 'feature', filesChanged: ['lib-meta.js'] };
    const result = await executeShipStep('META-FAIL', repo, repo, context, 'add meta', null);
    assert.equal(result.outcome, 'complete', `outcome stays complete despite shim failures: ${JSON.stringify(result)}`);
    // commit metadata should be null/falsy (rev-parse failed)
    assert.ok(!result.commit, `commit empty when rev-parse fails: ${result.commit}`);
    // filesChanged falls back to [] (or the staged-file list — accept either as long as no throw)
    assert.ok(Array.isArray(result.filesChanged) || result.filesChanged === undefined, 'filesChanged is array or absent');
  } finally {
    process.env.PATH = origPath;
  }
});

test('executeShipStep: non-git cwd → fields default safely', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-ship-nongit-'));
  const context = { mode: 'feature', filesChanged: [] };
  const result = await executeShipStep(
    'X',
    dir,
    dir,
    context,
    'no-op',
    null
  );
  // Non-git path: outcome=complete, no commit hash
  assert.equal(result.outcome, 'complete');
  // Additive fields should at minimum exist (null/[]/'') and not crash
  assert.ok(result.commit === null || result.commit === undefined || typeof result.commit === 'string');
  assert.ok(result.filesChanged === undefined || Array.isArray(result.filesChanged));
});

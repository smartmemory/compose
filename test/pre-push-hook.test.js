import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_BIN = resolve(__dirname, '..', 'bin', 'compose.js');

function setupGitFixture() {
  const root = mkdtempSync(join(tmpdir(), 'fv-hook-'));
  // git init
  spawnSync('git', ['init', '--initial-branch=main'], { cwd: root });
  // .compose/ required by workspace-aware hooks install (COMP-WORKSPACE-ID)
  mkdirSync(join(root, '.compose'), { recursive: true });
  writeFileSync(join(root, '.compose', 'compose.json'), JSON.stringify({ version: 1, workspaceId: 'fixture-ws' }));
  return root;
}

function runHooks(args, cwd) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [COMPOSE_BIN, 'hooks', ...args], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('exit', (code) => res({ code, stdout, stderr }));
  });
}

test('pre-push template exists with marker and placeholders', () => {
  const tplPath = resolve(__dirname, '..', 'bin', 'git-hooks', 'pre-push.template');
  assert.ok(existsSync(tplPath));
  const content = readFileSync(tplPath, 'utf-8');
  assert.match(content, /^#!\/usr\/bin\/env bash/);
  assert.match(content, /# Compose pre-push hook —/);
  assert.match(content, /__COMPOSE_NODE__/);
  assert.match(content, /__COMPOSE_BIN__/);
  assert.match(content, /validate --scope=project --block-on=error/);
});

test('compose hooks install --pre-push installs the hook', async () => {
  const root = setupGitFixture();
  const r = await runHooks(['install', '--pre-push'], root);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  const hookPath = join(root, '.git', 'hooks', 'pre-push');
  assert.ok(existsSync(hookPath));
  const content = readFileSync(hookPath, 'utf-8');
  assert.match(content, /# Compose pre-push hook —/);
  // Placeholders substituted
  assert.ok(!content.includes('__COMPOSE_NODE__'));
  assert.ok(!content.includes('__COMPOSE_BIN__'));
  // Executable bit
  const mode = statSync(hookPath).mode;
  assert.ok(mode & 0o111, 'hook must be executable');
});

test('hook script syntax-checks via bash -n', async () => {
  const root = setupGitFixture();
  await runHooks(['install', '--pre-push'], root);
  const hookPath = join(root, '.git', 'hooks', 'pre-push');
  const r = spawnSync('bash', ['-n', hookPath]);
  assert.equal(r.status, 0, `bash -n failed: ${r.stderr.toString()}`);
});

test('compose hooks status reports both hook types', async () => {
  const root = setupGitFixture();
  const r = await runHooks(['status'], root);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /post-commit:/);
  assert.match(r.stdout, /pre-push:/);
});

test('compose hooks status: pre-push is "installed (current)" after install', async () => {
  const root = setupGitFixture();
  await runHooks(['install', '--pre-push'], root);
  const r = await runHooks(['status'], root);
  assert.match(r.stdout, /pre-push:\s*installed \(current\)/);
});

test('compose hooks uninstall --pre-push removes only pre-push', async () => {
  const root = setupGitFixture();
  // Install both
  await runHooks(['install', '--post-commit'], root);
  await runHooks(['install', '--pre-push'], root);
  const ppPath = join(root, '.git', 'hooks', 'pre-push');
  const pcPath = join(root, '.git', 'hooks', 'post-commit');
  assert.ok(existsSync(ppPath));
  assert.ok(existsSync(pcPath));
  // Uninstall just pre-push
  await runHooks(['uninstall', '--pre-push'], root);
  assert.ok(!existsSync(ppPath));
  assert.ok(existsSync(pcPath), 'post-commit must remain');
});

test('compose hooks install with no flag defaults to post-commit (back-compat)', async () => {
  const root = setupGitFixture();
  const r = await runHooks(['install'], root);
  assert.equal(r.code, 0);
  assert.ok(existsSync(join(root, '.git', 'hooks', 'post-commit')));
  assert.ok(!existsSync(join(root, '.git', 'hooks', 'pre-push')));
});

// ── Docs-only test-gate skip ────────────────────────────────────────────────
// Run the installed hook directly, feeding ref lines on stdin the way git does.
// The fixture's `npm test` is `exit 1`, so the hook exits non-zero IFF the test
// gate actually ran — letting us assert skip vs run from the exit code alone.
function setupDocsOnlyFixture() {
  const root = setupGitFixture();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', scripts: { test: 'exit 1' } }));
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'base'], { cwd: root });
  return root;
}

function commitFile(root, rel, message) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), 'x\n');
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', message], { cwd: root });
}

function gitSha(root, ref) {
  return spawnSync('git', ['rev-parse', ref], { cwd: root }).stdout.toString().trim();
}

function runHookWithStdin(root, stdinLine) {
  const hookPath = join(root, '.git', 'hooks', 'pre-push');
  const r = spawnSync('bash', [hookPath, 'origin', 'file:///dev/null'], {
    cwd: root, input: stdinLine, timeout: 60_000,
  });
  return { code: r.status, stderr: r.stderr.toString() };
}

test('docs-only push skips the test gate', async () => {
  const root = setupDocsOnlyFixture();
  await runHooks(['install', '--pre-push'], root);
  const base = gitSha(root, 'HEAD');
  commitFile(root, 'docs/features/X-1/feature.json', 'docs change');
  commitFile(root, 'ROADMAP.md', 'roadmap change');
  const head = gitSha(root, 'HEAD');
  const r = runHookWithStdin(root, `refs/heads/main ${head} refs/heads/main ${base}\n`);
  assert.equal(r.code, 0, `expected skip (exit 0), stderr: ${r.stderr}`);
  assert.match(r.stderr, /docs-only push .* skipping test gate/);
});

test('code push still runs the test gate (fails on red suite)', async () => {
  const root = setupDocsOnlyFixture();
  await runHooks(['install', '--pre-push'], root);
  const base = gitSha(root, 'HEAD');
  commitFile(root, 'docs/notes.md', 'docs change');
  commitFile(root, 'lib/code.js', 'code change');
  const head = gitSha(root, 'HEAD');
  const r = runHookWithStdin(root, `refs/heads/main ${head} refs/heads/main ${base}\n`);
  assert.notEqual(r.code, 0, 'mixed docs+code push must run the (red) test gate');
  assert.doesNotMatch(r.stderr, /skipping test gate/);
});

test('new-branch push (zero remote sha) fails closed and runs the gate', async () => {
  const root = setupDocsOnlyFixture();
  await runHooks(['install', '--pre-push'], root);
  commitFile(root, 'docs/notes.md', 'docs change');
  const head = gitSha(root, 'HEAD');
  const zero = '0'.repeat(40);
  const r = runHookWithStdin(root, `refs/heads/feat ${head} refs/heads/feat ${zero}\n`);
  assert.notEqual(r.code, 0, 'unbounded range must fail closed to the (red) test gate');
});

test('empty stdin fails closed and runs the gate', async () => {
  const root = setupDocsOnlyFixture();
  await runHooks(['install', '--pre-push'], root);
  const r = runHookWithStdin(root, '');
  assert.notEqual(r.code, 0, 'no ref lines must fail closed to the (red) test gate');
});

test('foreign pre-push hook is preserved without --force', async () => {
  const root = setupGitFixture();
  // Write a foreign hook
  const ppPath = join(root, '.git', 'hooks', 'pre-push');
  writeFileSync(ppPath, '#!/bin/sh\n# user-written hook\nexit 0\n');
  chmodSync(ppPath, 0o755);
  const r = await runHooks(['install', '--pre-push'], root);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /foreign pre-push hook/);
  // Foreign hook content preserved
  assert.match(readFileSync(ppPath, 'utf-8'), /user-written/);
});

test('foreign pre-push hook can be overwritten with --force', async () => {
  const root = setupGitFixture();
  const ppPath = join(root, '.git', 'hooks', 'pre-push');
  writeFileSync(ppPath, '#!/bin/sh\n# user-written hook\nexit 0\n');
  chmodSync(ppPath, 0o755);
  const r = await runHooks(['install', '--pre-push', '--force'], root);
  assert.equal(r.code, 0);
  assert.match(readFileSync(ppPath, 'utf-8'), /Compose pre-push hook —/);
});

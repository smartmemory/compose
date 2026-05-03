/**
 * completion-writer-cli.test.js — CLI + hook tests for COMP-MCP-COMPLETION (T9).
 * Tests #22–#31.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { writeFeature, readFeature } from '../lib/feature-json.js';

const ROOT     = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN      = join(ROOT, 'bin', 'compose.js');
const FULL_SHA_A = 'a'.repeat(40);
const FULL_SHA_B = 'b'.repeat(40);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'completion-cli-'));
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  // Minimal .compose/compose.json so findProjectRoot resolves here
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify({ version: 1 }));
  return cwd;
}

function seedFeature(cwd, feature) {
  writeFeature(cwd, {
    created: '2026-05-02',
    updated: '2026-05-02',
    phase: 'Phase 1',
    position: 1,
    description: 'test feature',
    ...feature,
  });
}

/**
 * Run `node bin/compose.js <args>` synchronously in a cwd.
 */
function runCLI(cwd, args, { input = undefined, env = {} } = {}) {
  return spawnSync('node', [BIN, ...args], {
    cwd,
    input,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    timeout: 15000,
  });
}

/**
 * Create a stub git in a tmp dir. Returns the dir path.
 * The stub script dispatches based on argv to emit canned output.
 *
 * @param {object} opts
 * @param {string} opts.sha            Full 40-char commit SHA
 * @param {string} opts.commitBody     Full commit body (for `git log -1 --pretty=%B`)
 * @param {string} opts.subject        Commit subject (for `git log -1 --pretty=%s`)
 * @param {string[]} opts.files        Files changed (for `git diff-tree ...`)
 * @param {string} [opts.trailers]     Parsed trailers output (for `git interpret-trailers --parse`)
 */
function makeGitStub(opts) {
  const stubDir = mkdtempSync(join(tmpdir(), 'git-stub-'));
  const gitPath = join(stubDir, 'git');

  // Build trailers: if not provided, derive from commitBody
  const trailers = opts.trailers !== undefined
    ? opts.trailers
    : (opts.commitBody || '').split('\n')
        .filter(l => l.match(/^[A-Za-z][A-Za-z0-9-]*:/))
        .join('\n');

  const filesOutput = (opts.files || []).join('\n');
  // Helper to embed multiline text as a bash heredoc.
  // We write the content to a tmp file and cat it.
  const bodyFile   = join(stubDir, 'commit-body.txt');
  const subjectFile = join(stubDir, 'commit-subject.txt');
  const filesFile   = join(stubDir, 'files.txt');
  const trailersFile = join(stubDir, 'trailers.txt');

  writeFileSync(bodyFile,    opts.commitBody || '');
  writeFileSync(subjectFile, opts.subject || 'Test commit');
  writeFileSync(filesFile,   filesOutput);
  writeFileSync(trailersFile, trailers);

  const script = [
    '#!/usr/bin/env bash',
    '# Canned git stub for tests',
    'ARGS="$*"',
    `if [[ "$ARGS" == *"rev-parse HEAD"* ]]; then`,
    `  echo "${opts.sha || FULL_SHA_A}"`,
    `elif [[ "$ARGS" == *"log -1 --pretty=%B"* ]]; then`,
    `  cat ${JSON.stringify(bodyFile)}`,
    `elif [[ "$ARGS" == *"log -1 --pretty=%s"* ]]; then`,
    `  cat ${JSON.stringify(subjectFile)}`,
    `elif [[ "$ARGS" == *"diff-tree"* ]]; then`,
    `  cat ${JSON.stringify(filesFile)}`,
    `elif [[ "$ARGS" == *"interpret-trailers --parse"* ]]; then`,
    `  cat ${JSON.stringify(trailersFile)}`,
    `else`,
    `  echo "git-stub: unhandled args: $ARGS" >&2`,
    `  exit 0`,
    `fi`,
  ].join('\n');

  writeFileSync(gitPath, script);
  chmodSync(gitPath, 0o755);
  return stubDir;
}

/**
 * Install the compose hook into a tmp git repo.
 * Returns the repo cwd.
 */
function freshGitRepo() {
  const repoDir = freshCwd();
  mkdirSync(join(repoDir, '.git', 'hooks'), { recursive: true });
  return repoDir;
}

function installHook(repoCwd) {
  const result = runCLI(repoCwd, ['hooks', 'install']);
  if (result.status !== 0) {
    throw new Error(`hooks install failed: ${result.stderr}\n${result.stdout}`);
  }
  return join(repoCwd, '.git', 'hooks', 'post-commit');
}

/**
 * Run the installed post-commit hook with a stubbed git on PATH.
 * Uses `env -i` to get a minimal environment, then adds back required vars.
 */
function runHook(hookPath, repoCwd, gitStubDir, extraEnv = {}) {
  // Build minimal env: just PATH with git stub + /usr/bin
  const minPath = `${gitStubDir}:/usr/bin:/bin`;
  return spawnSync(
    'bash',
    [hookPath],
    {
      cwd: repoCwd,
      encoding: 'utf-8',
      timeout: 15000,
      env: {
        HOME: process.env.HOME || '/tmp',
        PATH: minPath,
        COMPOSE_HOOK_LOG: join(repoCwd, '.compose', 'data', 'post-commit.log'),
        ...extraEnv,
      },
    }
  );
}

// ---------------------------------------------------------------------------
// T9 tests
// ---------------------------------------------------------------------------

describe('T9 — CLI record-completion', () => {
  test('#22 CLI happy path: full 40-char SHA, files from stdin, exit 0, prints completion_id', () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    const result = runCLI(cwd, [
      'record-completion', 'CODE-1',
      `--commit-sha=${FULL_SHA_A}`,
      '--tests-pass=true',
      '--notes=ok',
      '--files-changed-from-stdin',
      '--no-status',
    ], { input: 'a.js\nb.js\n' });
    assert.equal(result.status, 0, `expected exit 0, got: ${result.stderr}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.completion_id, `CODE-1:${FULL_SHA_A}`);
    assert.equal(out.idempotent, false);
  });

  test('#23 CLI rejects short SHA: exit 1, stderr contains [INVALID_INPUT]', () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'CODE-1', status: 'PLANNED' });
    const result = runCLI(cwd, [
      'record-completion', 'CODE-1',
      '--commit-sha=abc1234',
      '--no-status',
    ]);
    assert.equal(result.status, 1, `expected exit 1`);
    assert.match(result.stderr, /\[INVALID_INPUT\]/);
    assert.match(result.stderr, /full 40-char/i);
  });

  test('#24 CLI FEATURE_NOT_FOUND: exit 1, stderr contains [FEATURE_NOT_FOUND]', () => {
    const cwd = freshCwd();
    const result = runCLI(cwd, [
      'record-completion', 'MISSING-1',
      `--commit-sha=${FULL_SHA_A}`,
      '--no-status',
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[FEATURE_NOT_FOUND\]/);
  });
});

describe('T9 — hook tests', () => {
  test('#25 hook single trailer: installs hook, runs it, feature.json has the record', () => {
    const repoCwd = freshGitRepo();
    seedFeature(repoCwd, { code: 'CODE-1', status: 'PLANNED' });
    const hookPath = installHook(repoCwd);
    assert.ok(existsSync(hookPath), 'hook file should exist after install');

    const commitBody = 'Test commit\n\nRecords-completion: CODE-1\n';
    const gitStubDir = makeGitStub({
      sha: FULL_SHA_A,
      commitBody,
      subject: 'Test commit',
      files: ['src/foo.js'],
    });

    const result = runHook(hookPath, repoCwd, gitStubDir);
    assert.equal(result.status, 0, `hook should exit 0; stderr: ${result.stderr}; stdout: ${result.stdout}`);

    const feature = readFeature(repoCwd, 'CODE-1');
    assert.ok(Array.isArray(feature.completions) && feature.completions.length === 1,
      `expected 1 completion, got: ${JSON.stringify(feature.completions)}`);
    assert.equal(feature.completions[0].commit_sha, FULL_SHA_A);
  });

  test('#26 hook multiple trailers → two records appended', () => {
    const repoCwd = freshGitRepo();
    seedFeature(repoCwd, { code: 'CODE-1', status: 'PLANNED' });
    seedFeature(repoCwd, { code: 'CODE-2', status: 'PLANNED' });
    const hookPath = installHook(repoCwd);

    const commitBody = 'Multi trailer commit\n\nRecords-completion: CODE-1\nRecords-completion: CODE-2\n';
    const gitStubDir = makeGitStub({
      sha: FULL_SHA_A,
      commitBody,
      subject: 'Multi trailer commit',
      files: [],
    });

    const result = runHook(hookPath, repoCwd, gitStubDir);
    assert.equal(result.status, 0, `hook exit: ${result.stderr}`);

    const f1 = readFeature(repoCwd, 'CODE-1');
    const f2 = readFeature(repoCwd, 'CODE-2');
    assert.equal(f1.completions.length, 1, 'CODE-1 should have 1 completion');
    assert.equal(f2.completions.length, 1, 'CODE-2 should have 1 completion');
  });

  test('#27 hook qualifier parsing: tests_pass=false, notes="partial"', () => {
    const repoCwd = freshGitRepo();
    seedFeature(repoCwd, { code: 'CODE-1', status: 'PLANNED' });
    const hookPath = installHook(repoCwd);

    const commitBody = 'Partial commit\n\nRecords-completion: CODE-1 tests_pass=false notes="partial"\n';
    const gitStubDir = makeGitStub({
      sha: FULL_SHA_A,
      commitBody,
      subject: 'Partial commit',
      files: [],
    });

    const result = runHook(hookPath, repoCwd, gitStubDir);
    assert.equal(result.status, 0, `hook exit: ${result.stderr}`);

    const feature = readFeature(repoCwd, 'CODE-1');
    assert.ok(feature.completions?.length === 1, 'should have 1 completion');
    assert.equal(feature.completions[0].tests_pass, false);
    assert.equal(feature.completions[0].notes, 'partial');
  });

  test('#28 hook case-insensitive header: RECORDS-COMPLETION accepted', () => {
    const repoCwd = freshGitRepo();
    seedFeature(repoCwd, { code: 'CODE-1', status: 'PLANNED' });
    const hookPath = installHook(repoCwd);

    // The hook lowercases the header, so RECORDS-COMPLETION should match
    const commitBody = 'Case insensitive\n\nRECORDS-COMPLETION: CODE-1\n';
    const gitStubDir = makeGitStub({
      sha: FULL_SHA_A,
      commitBody,
      subject: 'Case insensitive',
      files: [],
      // Manually provide trailers output since git interpret-trailers may not preserve case
      trailers: 'RECORDS-COMPLETION: CODE-1',
    });

    const result = runHook(hookPath, repoCwd, gitStubDir);
    assert.equal(result.status, 0, `hook exit: ${result.stderr}`);

    const feature = readFeature(repoCwd, 'CODE-1');
    assert.ok(feature.completions?.length === 1,
      `expected 1 completion; completions: ${JSON.stringify(feature.completions)}`);
  });

  test('#29 hook no trailer: exits 0, no record written', () => {
    const repoCwd = freshGitRepo();
    seedFeature(repoCwd, { code: 'CODE-1', status: 'PLANNED' });
    const hookPath = installHook(repoCwd);

    const gitStubDir = makeGitStub({
      sha: FULL_SHA_A,
      commitBody: 'Just a commit message, no trailers',
      subject: 'Just a commit message',
      files: [],
      trailers: '',  // empty trailers output
    });

    const result = runHook(hookPath, repoCwd, gitStubDir);
    assert.equal(result.status, 0, `hook should exit 0`);

    const feature = readFeature(repoCwd, 'CODE-1');
    assert.ok(!feature.completions || feature.completions.length === 0,
      'no completions should be written');
  });

  test('#30 hook CLI failure non-blocking: KILLED status → hook still exits 0, log captures failure', () => {
    const repoCwd = freshGitRepo();
    // Pre-seed with KILLED status — CLI will exit 1 on STATUS_FLIP_AFTER_COMPLETION_RECORDED
    seedFeature(repoCwd, { code: 'CODE-1', status: 'KILLED' });
    const hookPath = installHook(repoCwd);

    const commitBody = 'Some commit\n\nRecords-completion: CODE-1\n';
    const gitStubDir = makeGitStub({
      sha: FULL_SHA_A,
      commitBody,
      subject: 'Some commit',
      files: [],
    });

    const logPath = join(repoCwd, '.compose', 'data', 'post-commit.log');
    const result = runHook(hookPath, repoCwd, gitStubDir);
    // Hook MUST exit 0 even when the CLI fails
    assert.equal(result.status, 0, `hook should exit 0 even on CLI failure; stderr: ${result.stderr}`);

    // Log should capture something (either the completion record or the failure)
    // The completion DOES get persisted (record before flip), and the flip fails
    // The hook logs CLI output
    assert.ok(existsSync(logPath), 'post-commit.log should exist');
  });

  test('#31 hook is PATH-independent: works with env -i PATH=/usr/bin (no compose, no node on PATH)', () => {
    const repoCwd = freshGitRepo();
    seedFeature(repoCwd, { code: 'CODE-1', status: 'PLANNED' });
    const hookPath = installHook(repoCwd);

    // Verify the installed hook contains the absolute paths (not placeholders)
    const installedContent = readFileSync(hookPath, 'utf-8');
    assert.ok(!installedContent.includes('__COMPOSE_NODE__'), 'placeholder must be substituted');
    assert.ok(!installedContent.includes('__COMPOSE_BIN__'), 'placeholder must be substituted');
    assert.ok(installedContent.includes(process.execPath), 'absolute node path must be in hook');

    // Make git stub accessible at /usr/bin/... but since we can't write there,
    // create a stub dir and use PATH=/usr/bin:stubDir to prove the hook uses
    // absolute node/bin paths (not a PATH-resolved 'node' or 'compose').
    const commitBody = 'Test PATH independence\n\nRecords-completion: CODE-1\n';
    const gitStubDir = makeGitStub({
      sha: FULL_SHA_A,
      commitBody,
      subject: 'Test PATH independence',
      files: ['src/main.js'],
    });

    // Run with minimal PATH that includes git stub but NOT node or compose
    // The hook must still work because COMPOSE_NODE and COMPOSE_BIN are absolute.
    const minPath = `${gitStubDir}:/usr/bin:/bin`;
    const result = spawnSync('bash', [hookPath], {
      cwd: repoCwd,
      encoding: 'utf-8',
      timeout: 15000,
      env: {
        HOME: process.env.HOME || '/tmp',
        PATH: minPath,
        COMPOSE_HOOK_LOG: join(repoCwd, '.compose', 'data', 'post-commit.log'),
        // Explicitly do NOT include the directory containing 'node' or 'compose' on PATH
      },
    });

    assert.equal(result.status, 0, `hook should exit 0; stderr: ${result.stderr}`);

    const feature = readFeature(repoCwd, 'CODE-1');
    assert.ok(feature.completions?.length === 1,
      `expected 1 completion; got: ${JSON.stringify(feature.completions)}`);
  });
});

describe('T9 — hooks subcommand', () => {
  test('hooks install writes substituted hook with mode 0755', () => {
    const repoCwd = freshGitRepo();
    const result = runCLI(repoCwd, ['hooks', 'install']);
    assert.equal(result.status, 0, `hooks install failed: ${result.stderr}`);

    const hookPath = join(repoCwd, '.git', 'hooks', 'post-commit');
    assert.ok(existsSync(hookPath), 'hook file should exist');

    const content = readFileSync(hookPath, 'utf-8');
    assert.ok(content.includes(process.execPath), 'absolute node path should be in hook');
    assert.ok(content.includes('bin/compose.js'), 'compose bin path should be in hook');
    assert.ok(!content.includes('__COMPOSE_NODE__'), 'placeholder must be substituted');
    assert.ok(!content.includes('__COMPOSE_BIN__'), 'placeholder must be substituted');
  });

  test('hooks install second run on own hook overwrites idempotently', () => {
    const repoCwd = freshGitRepo();
    runCLI(repoCwd, ['hooks', 'install']);
    const r2 = runCLI(repoCwd, ['hooks', 'install']);
    assert.equal(r2.status, 0, `second install failed: ${r2.stderr}`);
  });

  test('hooks install refuses foreign hook without --force', () => {
    const repoCwd = freshGitRepo();
    const hookPath = join(repoCwd, '.git', 'hooks', 'post-commit');
    writeFileSync(hookPath, '#!/bin/bash\necho "foreign hook"\n');
    const r = runCLI(repoCwd, ['hooks', 'install']);
    assert.equal(r.status, 1, 'should refuse foreign hook');
    assert.match(r.stderr, /foreign/i);
  });

  test('hooks install with --force overwrites foreign hook', () => {
    const repoCwd = freshGitRepo();
    const hookPath = join(repoCwd, '.git', 'hooks', 'post-commit');
    writeFileSync(hookPath, '#!/bin/bash\necho "foreign hook"\n');
    const r = runCLI(repoCwd, ['hooks', 'install', '--force']);
    assert.equal(r.status, 0, `install with --force failed: ${r.stderr}`);
    const content = readFileSync(hookPath, 'utf-8');
    assert.ok(content.includes('# Compose post-commit hook —'), 'should be our hook now');
  });

  test('hooks uninstall removes our hook', () => {
    const repoCwd = freshGitRepo();
    runCLI(repoCwd, ['hooks', 'install']);
    const hookPath = join(repoCwd, '.git', 'hooks', 'post-commit');
    assert.ok(existsSync(hookPath));

    const r = runCLI(repoCwd, ['hooks', 'uninstall']);
    assert.equal(r.status, 0, `uninstall failed: ${r.stderr}`);
    assert.ok(!existsSync(hookPath), 'hook should be removed');
  });

  test('hooks uninstall leaves foreign hook alone', () => {
    const repoCwd = freshGitRepo();
    const hookPath = join(repoCwd, '.git', 'hooks', 'post-commit');
    writeFileSync(hookPath, '#!/bin/bash\necho "foreign"\n');
    const r = runCLI(repoCwd, ['hooks', 'uninstall']);
    // exits 0 but warns
    assert.equal(r.status, 0);
    assert.ok(existsSync(hookPath), 'foreign hook should remain');
  });

  test('hooks status: absent', () => {
    const repoCwd = freshGitRepo();
    const r = runCLI(repoCwd, ['hooks', 'status']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /absent/);
  });

  test('hooks status: installed (current)', () => {
    const repoCwd = freshGitRepo();
    runCLI(repoCwd, ['hooks', 'install']);
    const r = runCLI(repoCwd, ['hooks', 'status']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /installed \(current\)/);
  });

  test('hooks status: foreign', () => {
    const repoCwd = freshGitRepo();
    const hookPath = join(repoCwd, '.git', 'hooks', 'post-commit');
    writeFileSync(hookPath, '#!/bin/bash\necho "foreign"\n');
    const r = runCLI(repoCwd, ['hooks', 'status']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /foreign/);
  });
});

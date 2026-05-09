/**
 * hooks-workspace.test.js — verify `compose hooks install/status` bakes & checks
 * COMPOSE_WORKSPACE_ID per T5 of COMP-WORKSPACE-ID.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_BIN = join(REPO_ROOT, 'bin', 'compose.js');

function makeWorkspace(root, id) {
  mkdirSync(join(root, '.compose'), { recursive: true });
  writeFileSync(
    join(root, '.compose', 'compose.json'),
    JSON.stringify({ workspaceId: id }),
    'utf-8',
  );
  // git dir so hooks command doesn't bail
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
}

function runCompose(cwd, extraArgs) {
  return spawnSync(
    process.execPath,
    [COMPOSE_BIN, 'hooks', ...extraArgs],
    { cwd, encoding: 'utf-8', env: { ...process.env, COMPOSE_TARGET: '' } },
  );
}

describe('compose hooks install — workspace ID baking', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'compose-hooks-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('install bakes COMPOSE_WORKSPACE_ID and --workspace flag from .compose/compose.json', () => {
    makeWorkspace(dir, 'test-ws');
    const r = runCompose(dir, ['install', '--post-commit']);
    assert.equal(r.status, 0, `expected exit 0; stderr: ${r.stderr}`);
    const hookPath = join(dir, '.git', 'hooks', 'post-commit');
    const content = readFileSync(hookPath, 'utf-8');
    assert.match(content, /COMPOSE_WORKSPACE_ID="test-ws"/, 'baked COMPOSE_WORKSPACE_ID');
    assert.match(content, /--workspace="\$COMPOSE_WORKSPACE_ID"/, 'passes --workspace at runtime');
    assert.ok(!content.includes('__COMPOSE_WORKSPACE_ID__'), 'raw token replaced');
  });

  test('install in ambiguous tree without --workspace fails with WorkspaceAmbiguous-style message', () => {
    // anchor with two sibling .compose dirs underneath
    makeWorkspace(dir, 'parent');
    const childA = join(dir, 'a');
    const childB = join(dir, 'b');
    mkdirSync(childA, { recursive: true });
    mkdirSync(childB, { recursive: true });
    mkdirSync(join(childA, '.compose'), { recursive: true });
    writeFileSync(join(childA, '.compose', 'compose.json'), JSON.stringify({ workspaceId: 'a-ws' }));
    mkdirSync(join(childB, '.compose'), { recursive: true });
    writeFileSync(join(childB, '.compose', 'compose.json'), JSON.stringify({ workspaceId: 'b-ws' }));

    const r = runCompose(dir, ['install', '--post-commit']);
    assert.equal(r.status, 1, `expected exit 1; stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.match(r.stderr, /Multiple workspaces match/i);
  });

  test('install with --workspace=<id> in ambiguous tree succeeds', () => {
    makeWorkspace(dir, 'parent');
    const r = runCompose(dir, ['install', '--post-commit', '--workspace=parent']);
    assert.equal(r.status, 0, `expected exit 0; stderr: ${r.stderr}`);
    const content = readFileSync(join(dir, '.git', 'hooks', 'post-commit'), 'utf-8');
    assert.match(content, /COMPOSE_WORKSPACE_ID="parent"/);
  });
});

describe('compose hooks status — drift detection', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'compose-hooks-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function installFresh(id) {
    const r = runCompose(dir, ['install', '--post-commit', `--workspace=${id}`]);
    assert.equal(r.status, 0, `install failed: ${r.stderr}`);
  }

  test('current install reports installed (current) with workspace line', () => {
    makeWorkspace(dir, 'test-ws');
    installFresh('test-ws');
    const r = runCompose(dir, ['status']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /post-commit: installed \(current\)/);
    assert.match(r.stdout, /workspace: test-ws/);
  });

  test('stale install (different baked id) reports STALE_WORKSPACE_ID', () => {
    makeWorkspace(dir, 'test-ws');
    installFresh('test-ws');
    // simulate drift: rewrite the baked id in the installed hook
    const hookPath = join(dir, '.git', 'hooks', 'post-commit');
    const content = readFileSync(hookPath, 'utf-8')
      .replace('COMPOSE_WORKSPACE_ID="test-ws"', 'COMPOSE_WORKSPACE_ID="other-ws"');
    writeFileSync(hookPath, content, 'utf-8');

    const r = runCompose(dir, ['status']);
    assert.match(r.stdout, /STALE_WORKSPACE_ID/);
  });

  test('legacy install (raw token) reports MISSING_WORKSPACE_ID', () => {
    makeWorkspace(dir, 'test-ws');
    installFresh('test-ws');
    const hookPath = join(dir, '.git', 'hooks', 'post-commit');
    const content = readFileSync(hookPath, 'utf-8')
      .replace('COMPOSE_WORKSPACE_ID="test-ws"', 'COMPOSE_WORKSPACE_ID="__COMPOSE_WORKSPACE_ID__"');
    writeFileSync(hookPath, content, 'utf-8');

    const r = runCompose(dir, ['status']);
    assert.match(r.stdout, /MISSING_WORKSPACE_ID/);
  });
});

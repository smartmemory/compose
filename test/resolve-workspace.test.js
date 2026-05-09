/**
 * resolve-workspace.test.js — single resolver chain for compose workspaces.
 *
 * Covers precedence (explicit-flag > COMPOSE_TARGET > mcp-binding > discovery),
 * collision handling, getWorkspaceFlag arg parsing, and the
 * explicit-flag/COMPOSE_TARGET=/abs bypasses around WorkspaceDiscoveryTooBroad.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {
  resolveWorkspace,
  getWorkspaceFlag,
  WorkspaceUnknown,
  WorkspaceAmbiguous,
  WorkspaceIdCollision,
  WorkspaceUnset,
} = await import(`${REPO_ROOT}/lib/resolve-workspace.js`);

function makeWorkspace(root, opts = {}) {
  mkdirSync(join(root, '.compose'), { recursive: true });
  if (opts.workspaceId) {
    writeFileSync(
      join(root, '.compose', 'compose.json'),
      JSON.stringify({ workspaceId: opts.workspaceId }),
      'utf-8',
    );
  }
}

// COMPOSE_TARGET save/restore helper
function withEnv(fn) {
  const saved = process.env.COMPOSE_TARGET;
  return async (...args) => {
    try {
      return await fn(...args);
    } finally {
      if (saved === undefined) delete process.env.COMPOSE_TARGET;
      else process.env.COMPOSE_TARGET = saved;
    }
  };
}

describe('getWorkspaceFlag', () => {
  test('parses --workspace=foo and mutates args', () => {
    const args = ['build', '--workspace=foo', 'rest'];
    const id = getWorkspaceFlag(args);
    assert.equal(id, 'foo');
    assert.deepEqual(args, ['build', 'rest']);
  });

  test('parses --workspace foo (separate token) and mutates args', () => {
    const args = ['build', '--workspace', 'bar', 'rest'];
    const id = getWorkspaceFlag(args);
    assert.equal(id, 'bar');
    assert.deepEqual(args, ['build', 'rest']);
  });

  test('returns null and leaves args untouched when absent', () => {
    const args = ['build', '--other=val'];
    const id = getWorkspaceFlag(args);
    assert.equal(id, null);
    assert.deepEqual(args, ['build', '--other=val']);
  });
});

describe('resolveWorkspace — precedence', () => {
  let dir;
  let savedTarget;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'resolve-ws-'));
    savedTarget = process.env.COMPOSE_TARGET;
    delete process.env.COMPOSE_TARGET;
  });
  afterEach(() => {
    if (savedTarget === undefined) delete process.env.COMPOSE_TARGET;
    else process.env.COMPOSE_TARGET = savedTarget;
    rmSync(dir, { recursive: true, force: true });
  });

  test('discovery returns single candidate when only one workspace', () => {
    makeWorkspace(dir, { workspaceId: 'solo' });
    const result = resolveWorkspace({ cwd: dir });
    assert.equal(result.id, 'solo');
    assert.equal(result.root, dir);
    assert.equal(result.source, 'discovery');
  });

  test('discovery throws WorkspaceUnset when no workspace found', () => {
    // dir has no .compose marker; tmpdir typically has no anchor either.
    // We use a freshly minted dir that lacks any markers.
    const empty = join(dir, 'empty');
    mkdirSync(empty);
    assert.throws(
      () => resolveWorkspace({ cwd: empty }),
      (err) => err instanceof WorkspaceUnset && err.code === 'WorkspaceUnset',
    );
  });

  test('discovery throws WorkspaceAmbiguous with candidate list', () => {
    makeWorkspace(dir, { workspaceId: 'parent' });
    const child = join(dir, 'child');
    mkdirSync(child);
    makeWorkspace(child, { workspaceId: 'kid' });
    assert.throws(
      () => resolveWorkspace({ cwd: dir }),
      (err) => {
        assert.ok(err instanceof WorkspaceAmbiguous);
        assert.equal(err.code, 'WorkspaceAmbiguous');
        assert.equal(err.candidates.length, 2);
        const ids = err.candidates.map((c) => c.id).sort();
        assert.deepEqual(ids, ['kid', 'parent']);
        return true;
      },
    );
  });

  test('discovery throws WorkspaceIdCollision when two basenames match', () => {
    // Two child dirs both named "samename" — basenames collide.
    const a = join(dir, 'a', 'samename');
    const b = join(dir, 'b', 'samename');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    makeWorkspace(a);
    makeWorkspace(b);
    // Anchor needs to be dir, so put a marker there too (but no .compose so
    // dir itself isn't a workspace candidate).
    writeFileSync(join(dir, '.stratum.yaml'), '', 'utf-8');
    assert.throws(
      () => resolveWorkspace({ cwd: dir }),
      (err) => {
        assert.ok(err instanceof WorkspaceIdCollision, `got ${err.code}: ${err.message}`);
        assert.equal(err.code, 'WorkspaceIdCollision');
        assert.equal(err.id, 'samename');
        assert.equal(err.roots.length, 2);
        return true;
      },
    );
  });

  test('explicit flag wins over COMPOSE_TARGET wins over discovery', () => {
    // Build two workspaces: env-target and flag-target. Flag must win.
    const flagWs = join(dir, 'flag-ws');
    const envWs = join(dir, 'env-ws');
    mkdirSync(flagWs);
    mkdirSync(envWs);
    makeWorkspace(flagWs, { workspaceId: 'flag-id' });
    makeWorkspace(envWs, { workspaceId: 'env-id' });
    // Anchor at dir so discovery sees both.
    writeFileSync(join(dir, '.stratum.yaml'), '', 'utf-8');

    process.env.COMPOSE_TARGET = 'env-id';
    const result = resolveWorkspace({ cwd: dir, workspaceId: 'flag-id' });
    assert.equal(result.id, 'flag-id');
    assert.equal(result.source, 'explicit-flag');

    // Now drop the flag — env should win over discovery.
    const result2 = resolveWorkspace({ cwd: dir });
    assert.equal(result2.id, 'env-id');
    assert.equal(result2.source, 'env');
  });

  test('mcp-binding resolves via getBinding when no flag or env', () => {
    makeWorkspace(dir, { workspaceId: 'parent' });
    const child = join(dir, 'child');
    mkdirSync(child);
    makeWorkspace(child, { workspaceId: 'kid' });
    const result = resolveWorkspace({ cwd: dir, getBinding: () => 'kid' });
    assert.equal(result.id, 'kid');
    assert.equal(result.source, 'mcp-binding');
  });

  test('WorkspaceUnknown thrown when explicit id matches no candidate', () => {
    makeWorkspace(dir, { workspaceId: 'real' });
    assert.throws(
      () => resolveWorkspace({ cwd: dir, workspaceId: 'nonexistent' }),
      (err) => err.code === 'WorkspaceUnknown',
    );
  });
});

describe('resolveWorkspace — bypass paths around discovery cap', () => {
  let dir;
  let savedTarget;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'resolve-bypass-'));
    savedTarget = process.env.COMPOSE_TARGET;
    delete process.env.COMPOSE_TARGET;
  });
  afterEach(() => {
    if (savedTarget === undefined) delete process.env.COMPOSE_TARGET;
    else process.env.COMPOSE_TARGET = savedTarget;
    rmSync(dir, { recursive: true, force: true });
  });

  test('explicit-flag bypass: --workspace=<ancestor-id> succeeds via upward walk under TooBroad tree', () => {
    // Ancestor workspace at dir; deeply broad descendants would blow the cap.
    makeWorkspace(dir, { workspaceId: 'anchor-ws' });
    // Make a subdir to use as cwd, then balloon siblings under dir.
    const cwd = join(dir, 'work');
    mkdirSync(cwd);
    for (let i = 0; i < 250; i++) mkdirSync(join(dir, `pad${i}`));

    // Sanity: discovery would throw — we don't actually call it here, but the
    // explicit-flag path must NOT propagate that. The upward walk from cwd
    // finds dir's .compose first.
    const result = resolveWorkspace({ cwd, workspaceId: 'anchor-ws' });
    assert.equal(result.id, 'anchor-ws');
    assert.equal(result.root, dir);
    assert.equal(result.source, 'explicit-flag');
  });

  test('explicit-flag fallback: --workspace=<descendant-id> falls through to discovery (small tree)', () => {
    // cwd is anchor (dir); descendant has the target id.
    makeWorkspace(dir, { workspaceId: 'top' });
    const child = join(dir, 'child');
    mkdirSync(child);
    makeWorkspace(child, { workspaceId: 'descendant' });
    const result = resolveWorkspace({ cwd: dir, workspaceId: 'descendant' });
    assert.equal(result.id, 'descendant');
    assert.equal(result.root, child);
    assert.equal(result.source, 'explicit-flag');
  });

  test('COMPOSE_TARGET=/abs/path bypass: works without invoking discovery', () => {
    // workspace lives at workspaceDir; cwd is somewhere unrelated with no anchor.
    const workspaceDir = join(dir, 'real-ws');
    mkdirSync(workspaceDir);
    makeWorkspace(workspaceDir, { workspaceId: 'real' });

    const isolatedCwd = mkdtempSync(join(tmpdir(), 'isolated-cwd-'));
    try {
      process.env.COMPOSE_TARGET = workspaceDir; // absolute path
      const result = resolveWorkspace({ cwd: isolatedCwd });
      assert.equal(result.id, 'real');
      assert.equal(result.root, workspaceDir);
      assert.equal(result.source, 'env');
    } finally {
      rmSync(isolatedCwd, { recursive: true, force: true });
    }
  });

  test('COMPOSE_TARGET=/nonexistent throws WorkspaceUnknown', () => {
    process.env.COMPOSE_TARGET = '/this/path/does/not/exist/anywhere';
    assert.throws(
      () => resolveWorkspace({ cwd: dir }),
      (err) => err.code === 'WorkspaceUnknown',
    );
  });
});

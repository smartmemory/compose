/**
 * discover-workspaces.test.js — bounded bidirectional discovery for compose workspaces.
 *
 * Covers anchor lookup, descendant scan, depth/visit caps, skip-dirs, EACCES tolerance,
 * and deriveId basename/config-id behavior.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {
  findAnchor,
  discoverWorkspaces,
  deriveId,
} = await import(`${REPO_ROOT}/lib/discover-workspaces.js`);

function makeWorkspace(root, opts = {}) {
  mkdirSync(join(root, '.compose'), { recursive: true });
  if (opts.workspaceId) {
    writeFileSync(
      join(root, '.compose', 'compose.json'),
      JSON.stringify({ workspaceId: opts.workspaceId }),
      'utf-8',
    );
  } else if (opts.invalidId) {
    writeFileSync(
      join(root, '.compose', 'compose.json'),
      JSON.stringify({ workspaceId: opts.invalidId }),
      'utf-8',
    );
  } else if (opts.emptyConfig) {
    writeFileSync(join(root, '.compose', 'compose.json'), '{}', 'utf-8');
  }
}

describe('findAnchor', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'disc-anchor-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('returns dir containing .compose marker (upward walk)', () => {
    makeWorkspace(dir);
    const sub = join(dir, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    assert.equal(findAnchor(sub), dir);
  });

  test('returns null when no anchor marker on path', () => {
    const sub = join(dir, 'x');
    mkdirSync(sub);
    // no .compose, .stratum.yaml, or .git anywhere upward in this tmpdir tree
    // (tmpdir itself won't have them); but it could be inside a git repo on
    // some CI — accept either null OR a path strictly above dir.
    const found = findAnchor(sub);
    if (found !== null) {
      assert.ok(found.length < dir.length, `findAnchor returned ${found}, expected null or ancestor above tmpdir`);
    }
  });
});

describe('discoverWorkspaces', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'disc-ws-')); });
  afterEach(() => {
    // Restore perms in case a test chmod'd subdirs
    try { chmodSync(dir, 0o755); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  test('one workspace at anchor → returns one candidate', () => {
    makeWorkspace(dir, { workspaceId: 'only' });
    const { candidates } = discoverWorkspaces(dir);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].id, 'only');
    assert.equal(candidates[0].root, dir);
  });

  test('workspace at anchor + descendant → returns two', () => {
    makeWorkspace(dir, { workspaceId: 'parent' });
    const child = join(dir, 'child');
    mkdirSync(child);
    makeWorkspace(child, { workspaceId: 'kid' });
    const { candidates } = discoverWorkspaces(dir);
    const ids = candidates.map(c => c.id).sort();
    assert.deepEqual(ids, ['kid', 'parent']);
  });

  test('depth-cap: workspace beyond MAX_DEPTH is not found', () => {
    makeWorkspace(dir, { workspaceId: 'top' });
    // anchor is dir at depth 0. MAX_DEPTH=3 means children at depth ≤3 are
    // discoverable; a workspace marker found while listing depth-3 dir's
    // entries lives at depth 4 (still found). Past that (depth 5) is not.
    const deep = join(dir, 'a', 'b', 'c', 'd', 'e');
    mkdirSync(deep, { recursive: true });
    makeWorkspace(deep, { workspaceId: 'too-deep' });
    const { candidates } = discoverWorkspaces(dir);
    const ids = candidates.map(c => c.id);
    assert.ok(ids.includes('top'));
    assert.ok(!ids.includes('too-deep'), `did not expect to find too-deep, got ${JSON.stringify(ids)}`);
  });

  test('visit-cap: tree exceeding MAX_VISITED throws WorkspaceDiscoveryTooBroad', () => {
    makeWorkspace(dir, { workspaceId: 'top' });
    // create MAX_VISITED+50 sibling subdirs at depth 1 (under MAX_DEPTH=3)
    for (let i = 0; i < 550; i++) {
      mkdirSync(join(dir, `d${i}`));
    }
    assert.throws(
      () => discoverWorkspaces(dir),
      (err) => err.code === 'WorkspaceDiscoveryTooBroad',
    );
  });

  test('skip-dirs: node_modules/.compose is not visited', () => {
    makeWorkspace(dir, { workspaceId: 'top' });
    const nm = join(dir, 'node_modules', 'pkg');
    mkdirSync(nm, { recursive: true });
    makeWorkspace(nm, { workspaceId: 'should-skip' });
    const { candidates } = discoverWorkspaces(dir);
    const ids = candidates.map(c => c.id);
    assert.deepEqual(ids, ['top']);
  });

  test('readdirSync EACCES on a sub-tree → silently skipped, others discovered', () => {
    if (process.platform === 'win32') return;
    if (process.getuid && process.getuid() === 0) return; // root bypasses perms
    makeWorkspace(dir, { workspaceId: 'top' });
    const ok = join(dir, 'visible');
    mkdirSync(ok);
    makeWorkspace(ok, { workspaceId: 'visible-ws' });
    const denied = join(dir, 'denied');
    mkdirSync(denied);
    makeWorkspace(denied, { workspaceId: 'denied-ws' });
    chmodSync(denied, 0o000);
    try {
      const { candidates } = discoverWorkspaces(dir);
      const ids = candidates.map(c => c.id).sort();
      // 'top' and 'visible-ws' should appear; 'denied-ws' may or may not (the
      // .compose marker was created BEFORE chmod, so its directory entry is
      // discoverable from outside; but reading INSIDE denied is forbidden).
      // The point is: scan does not throw.
      assert.ok(ids.includes('top'));
      assert.ok(ids.includes('visible-ws'));
    } finally {
      chmodSync(denied, 0o755);
    }
  });
});

describe('deriveId', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'disc-id-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('honors workspaceId in .compose/compose.json', () => {
    makeWorkspace(dir, { workspaceId: 'my-cool-id' });
    const result = deriveId({ root: dir });
    assert.equal(result.id, 'my-cool-id');
    assert.equal(result.root, dir);
    assert.equal(result.configPath, join(dir, '.compose', 'compose.json'));
  });

  test('falls back to basename when config missing', () => {
    // no compose.json at all
    mkdirSync(join(dir, '.compose'), { recursive: true });
    const result = deriveId({ root: dir });
    // tmpdir basename — just check it equals path.basename(dir)
    assert.equal(result.id, dir.split('/').pop());
  });

  test('falls back to basename when workspaceId is invalid', () => {
    makeWorkspace(dir, { invalidId: 'BadCaps_NotAllowed' });
    const result = deriveId({ root: dir });
    assert.equal(result.id, dir.split('/').pop());
  });

  test('falls back to basename when config has no workspaceId field', () => {
    makeWorkspace(dir, { emptyConfig: true });
    const result = deriveId({ root: dir });
    assert.equal(result.id, dir.split('/').pop());
  });
});

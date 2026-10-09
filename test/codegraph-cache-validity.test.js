// STRAT-CODEGRAPH-1 cache validity (c): Compose recomputes core's members_sha256 for listing and
// glob resolution dependencies (recipe: smart-memory-docs docs/features/CODE-BUNDLE-CLI-1/design.md,
// "members_sha256 recipe"). The unit tests pin the digest against values computed with Python's
// json/hashlib; the live test SKIPS without a capable `smartmemory` CLI and checks every digest the
// real producer recorded on a tree that exercises all three member shapes and symlinks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Unverifiable, checkResolutionDependencies, digestMembers, membersDigest, pyJsonDumps,
} from '../lib/codegraph/cache-validity.js';
import { detectCodegraph, resetAvailabilityCache } from '../lib/codegraph/availability.js';
import { cliBundleArgs } from '../lib/codegraph/snapshot.js';

test('pyJsonDumps matches Python json.dumps (ensure_ascii, surrogate pairs, separators)', () => {
  // python3 -c 'import json; print(json.dumps(["a\n\t\"\\", None, "é\U0001F600\x7f"]))'
  assert.equal(pyJsonDumps(['a\n\t"\\', null, 'é😀\x7f']), '["a\\n\\t\\"\\\\", null, "\\u00e9\\ud83d\\ude00\\u007f"]');
  assert.equal(pyJsonDumps(['a', ['b', null]], { compact: true }), '["a",["b",null]]');
  assert.throws(() => pyJsonDumps([1]), Unverifiable);
});

test('digestMembers sorts by default-separator JSON text and hashes the compact form, as core does', () => {
  // python3: hashlib.sha256(json.dumps(sorted(m, key=json.dumps), separators=(',', ':')).encode()).hexdigest()
  const members = [['b.ts', 'file', null], ['a', 'dir', null], ['é😀.ts', 'symlink', 'lib/x"y'], ['a b', 'file', null]];
  assert.equal(digestMembers(members), '2e2fe6cbb0faa95a32473a84e3f703ada354a9fa6449dcff18e0d6efa20ae912');
  assert.equal(digestMembers([]), '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
});

test('unported glob shapes, null digests and unknown kinds make the snapshot invalid, never valid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codegraph-cv-'));
  try {
    for (const pattern of ['**/*.ts', 'a/**', '../x/*', '/abs/*']) {
      assert.throws(() => membersDigest({ kind: 'glob', path: '.', pattern }, dir), Unverifiable, pattern);
      const out = checkResolutionDependencies({ resolution_dependencies: [{ kind: 'glob', path: '.', pattern, members_sha256: 'x' }] }, dir);
      assert.equal(out.ok, false, pattern);
      assert.match(out.reason, /unverifiable/);
    }
    const cases = [
      [{ kind: 'listing', path: 'gone', members_sha256: null, members_error: 'FileNotFoundError' }, /could not digest its members \(FileNotFoundError\)/],
      [{ kind: 'glob', path: '.', pattern: '*.ts' }, /no members_sha256/],
      [{ kind: 'content', path: 'x', sha256: null }, /no recorded sha256/],
      [{ kind: 'exists', path: 'x' }, /exists is not a boolean/],
      [{ kind: 'mtime', path: 'x' }, /unknown dependency kind "mtime"/],
      [{ kind: 'exists', exists: true }, /an entry has no path/],
    ];
    for (const [entry, reason] of cases) {
      const out = checkResolutionDependencies({ resolution_dependencies: [entry] }, dir);
      assert.equal(out.ok, false, JSON.stringify(entry));
      assert.match(out.reason, reason);
    }
    assert.equal(checkResolutionDependencies({}, dir).ok, false, 'no resolution_dependencies at all');
    assert.deepEqual(checkResolutionDependencies({ resolution_dependencies: [] }, dir), { ok: true, checked: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const env = { ...process.env, COMPOSE_CODEGRAPH: '1' };
resetAvailabilityCache();
const availability = await detectCodegraph({ cwd: tmpdir(), env });

/** A tree whose resolution dependencies include listings, a pattern glob, an inventory walk and symlinks. */
function writeMiniTree(root) {
  const files = {
    'package.json': '{ "name": "mini", "type": "module", "workspaces": ["packages/*"], "dependencies": { "express": "^4" } }\n',
    'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/lib/*"] } } }\n',
    'packages/a/package.json': '{ "name": "a", "main": "index.ts" }\n',
    'packages/a/index.ts': 'export function x() { return 1; }\n',
    'packages/b/package.json': '{ "name": "b" }\n',
    'packages/b/index.ts': "import { x } from 'a';\nexport function y() { return x(); }\n",
    'src/index.ts': "import { helper } from '@lib/helper';\nimport express from 'express';\nconst app = express();\napp.get('/', () => helper());\nexport function main() { return helper(); }\n",
    'src/lib/helper.ts': 'export function helper() { return 2; }\n',
    'src/lib/types.d.ts': 'export const d = 1;\n',
    'src/tool.py': 'from helper2 import g\nimport pkg.mod\n\ndef f():\n    return g()\n',
    'src/helper2.py': 'def g():\n    return 1\n',
    'pkg/__init__.py': '',
    'pkg/mod.py': 'def m():\n    return 1\n',
    'run.py': 'import os\nfrom src import tool\n',
    'node_modules/dep/index.js': 'module.exports = 1;\n',
    'dist/out.js': 'export {};\n',
    'vendor/v.js': 'export {};\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  symlinkSync(join(root, 'src', 'lib', 'helper.ts'), join(root, 'src', 'abs-link.ts'));
  symlinkSync('lib', join(root, 'src', 'rel-dir'));
  symlinkSync('../pkg', join(root, 'src', 'pkglink'));
}

test('live: every listing and glob digest the real producer recorded is recomputed exactly', {
  skip: availability.available ? false : `codegraph unavailable: ${availability.reason}`, timeout: 120000,
}, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'codegraph-cv-live-'))); // /var is a symlink on macOS
  const root = join(base, 'mini');
  try {
    mkdirSync(root);
    writeMiniTree(root);
    const out = join(base, 'bundle.json');
    execFileSync(availability.command, cliBundleArgs({ root, repo: 'mini', out }), {
      env: { ...process.env, SMARTMEMORY_CODE_CHECKPOINT_DIR: join(base, 'parse-cache') }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    const { source } = JSON.parse(readFileSync(out, 'utf8'));
    const shapes = new Set();
    for (const entry of source.resolution_dependencies) {
      if (entry.kind !== 'listing' && entry.kind !== 'glob') continue;
      shapes.add(entry.kind === 'listing' ? 'listing' : Array.isArray(entry.exclude_dirs) ? 'walk' : 'pattern');
      assert.equal(typeof entry.members_sha256, 'string', `${entry.kind} ${entry.path}: ${entry.members_error}`);
      assert.equal(membersDigest(entry, root), entry.members_sha256, `${entry.kind} ${entry.path} ${entry.pattern ?? ''}`);
    }
    assert.deepEqual([...shapes].sort(), ['listing', 'pattern', 'walk'], 'the tree exercises every member shape');
    assert.equal(checkResolutionDependencies(source, root).ok, true);

    // Each mutation below changes what core would resolve, and (c) must notice it.
    writeFileSync(join(root, 'src', 'lib', 'extra.ts'), 'export {};\n');
    assert.equal(checkResolutionDependencies(source, root).ok, false, 'a new file in an aliased dir');
    rmSync(join(root, 'src', 'lib', 'extra.ts'));
    assert.equal(checkResolutionDependencies(source, root).ok, true);
    mkdirSync(join(root, 'packages', 'c'));
    writeFileSync(join(root, 'packages', 'c', 'package.json'), '{ "name": "c" }\n');
    assert.equal(checkResolutionDependencies(source, root).ok, false, 'a new workspace package');
    rmSync(join(root, 'packages', 'c'), { recursive: true });
    writeFileSync(join(root, 'tsconfig.json'), '{ "compilerOptions": { "baseUrl": "." } }\n');
    assert.equal(checkResolutionDependencies(source, root).ok, false, 'tsconfig paths edited');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

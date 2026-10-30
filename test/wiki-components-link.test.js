/**
 * WIKI-COMPONENTS-PUBLISH-1: where Compose finds `@wiki/components`. One table over a scratch layout: a copy of
 * lib/wiki-components-link.js under `<tmp>/a/b/c/compose/lib/`, so its sibling candidate is
 * `<tmp>/a/b/SmartMemory/smart-memory-wiki/ui/packages/wiki-components` and its installed candidate is
 * `<tmp>/a/b/c/compose/node_modules/@smartmemory/wiki-components`.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = fileURLToPath(new URL('../lib/wiki-components-link.js', import.meta.url));

function fakePackage(dir) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@smartmemory/wiki-components', version: '0.0.0-test', type: 'module', exports: { '.': './src/index.js', './package.json': './package.json' } }));
  writeFileSync(join(dir, 'src', 'index.js'), 'export {};\n');
  writeFileSync(join(dir, 'src', 'data-client.jsx'), 'export {};\n');
  return dir;
}

let root;
before(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'wiki-components-link-'))); });
after(() => { rmSync(root, { recursive: true, force: true }); });

// Each row builds its own layout under root/<name>: sibling and/or installed package present, and an env.
const ROWS = [
  { name: 'neither', sibling: false, installed: false, env: {}, want: null },
  { name: 'installed only', sibling: false, installed: true, env: {}, want: 'installed' },
  { name: 'sibling wins over installed', sibling: true, installed: true, env: {}, want: 'sibling' },
  { name: 'sibling only', sibling: true, installed: false, env: {}, want: 'sibling' },
  { name: 'none forces absent', sibling: true, installed: true, env: { COMPOSE_WIKI_COMPONENTS_DIR: 'none' }, want: null },
  { name: 'override wins', sibling: true, installed: true, env: { COMPOSE_WIKI_COMPONENTS_DIR: 'override' }, want: 'override' },
  { name: 'missing override does not fall back', sibling: true, installed: true, env: { COMPOSE_WIKI_COMPONENTS_DIR: 'missing' }, want: null },
];

describe('resolveWikiComponentsDir', () => {
  for (const row of ROWS) {
    it(row.name, async () => {
      const base = join(root, row.name.replace(/\W+/g, '-'));
      const compose = join(base, 'a', 'b', 'c', 'compose');
      mkdirSync(join(compose, 'lib'), { recursive: true });
      copyFileSync(SRC, join(compose, 'lib', 'wiki-components-link.js'));
      writeFileSync(join(compose, 'package.json'), '{"type":"module"}\n');
      const dirs = {
        sibling: join(base, 'a', 'b', 'SmartMemory', 'smart-memory-wiki', 'ui', 'packages', 'wiki-components'),
        installed: join(compose, 'node_modules', '@smartmemory', 'wiki-components'),
        override: fakePackage(join(base, 'override')),
        missing: join(base, 'missing'),
      };
      if (row.sibling) fakePackage(dirs.sibling);
      if (row.installed) fakePackage(dirs.installed);
      const env = { ...row.env };
      if (env.COMPOSE_WIKI_COMPONENTS_DIR && env.COMPOSE_WIKI_COMPONENTS_DIR !== 'none') env.COMPOSE_WIKI_COMPONENTS_DIR = dirs[env.COMPOSE_WIKI_COMPONENTS_DIR];
      const { resolveWikiComponentsDir } = await import(pathToFileURL(join(compose, 'lib', 'wiki-components-link.js')).href);
      assert.equal(resolveWikiComponentsDir(env), row.want ? dirs[row.want] : null);
    });
  }
});

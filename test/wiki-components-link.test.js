/**
 * WIKI-COMPONENTS-PUBLISH-1: where Compose finds `@wiki/components`. One table over a scratch layout: a copy of
 * lib/wiki-components-link.js under `<tmp>/a/b/forge/compose/lib/`, so its sibling candidate is the forge sibling
 * `<tmp>/a/b/forge/wiki/ui/packages/wiki-components` (WIKI-TO-FORGE-1) and its installed candidate is
 * `<tmp>/a/b/forge/compose/node_modules/@smartmemory/wiki-components`. The pre-move checkout
 * `<tmp>/a/b/SmartMemory/smart-memory-wiki/...` is never a candidate.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = fileURLToPath(new URL('../lib/wiki-components-link.js', import.meta.url));

// The names Compose imports (lib REQUIRED_EXPORTS), written the way the real package writes them.
const MAIN = 'export { default as FeatureHub, prefixOnly } from "./FeatureHub";\nexport { default as Search } from "./Search";\n'
  + 'export { default as Decisions } from "./Decisions";\nexport { default as Sources } from "./Sources";\nexport { default as AreaDocs } from "./AreaDocs";\n'
  + 'export { default as Ledger } from "./Ledger";\nexport { default as Features } from "./Features";\n'
  + 'export { WikiDataProvider, useDataClient } from "./data-client";\nexport { wikiPath, wsName } from "./lib";\n';
const GRAPH = 'export { default as GraphPage, GRAPH_ASPECTS, resetWebGL2Probe, wholeGraph } from "./pages/GraphPage";\nexport { GraphHost } from "./host";\n';

// `stale` = the npm 0.6.0 shape: everything but `Features` (COMPOSE-RELEASE-NPM-1).
function fakePackage(dir, { stale = false } = {}) {
  mkdirSync(join(dir, 'src', 'graph'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@smartmemory/wiki-components', version: '0.0.0-test', type: 'module', exports: { '.': './src/index.js', './package.json': './package.json' } }));
  writeFileSync(join(dir, 'src', 'index.js'), stale ? MAIN.replace('export { default as Features } from "./Features";\n', '') : MAIN);
  writeFileSync(join(dir, 'src', 'graph', 'index.js'), GRAPH);
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
  { name: 'the pre-move SmartMemory checkout is ignored', stale: true, installed: true, env: {}, want: 'installed' },
  { name: 'the pre-move SmartMemory checkout alone is absent', stale: true, installed: false, env: {}, want: null },
  { name: 'none forces absent', sibling: true, installed: true, env: { COMPOSE_WIKI_COMPONENTS_DIR: 'none' }, want: null },
  { name: 'override wins', sibling: true, installed: true, env: { COMPOSE_WIKI_COMPONENTS_DIR: 'override' }, want: 'override' },
  { name: 'missing override does not fall back', sibling: true, installed: true, env: { COMPOSE_WIKI_COMPONENTS_DIR: 'missing' }, want: null },
  // COMPOSE-RELEASE-NPM-1: an installed package older than the source (no `Features`) is absent, not a broken build.
  { name: 'stale installed only is absent', sibling: false, installed: 'stale', env: {}, want: null, warns: /lacks src\/index\.js: Features/ },
  { name: 'stale sibling falls through to a complete installed', sibling: 'stale', installed: true, env: {}, want: 'installed', warns: null },
  { name: 'none warns that the tab is off', sibling: true, installed: true, env: { COMPOSE_WIKI_COMPONENTS_DIR: 'none' }, want: null, warns: /Wiki tab is off/ },
];

describe('resolveWikiComponentsDir', () => {
  for (const row of ROWS) {
    it(row.name, async () => {
      const base = join(root, row.name.replace(/\W+/g, '-'));
      const compose = join(base, 'a', 'b', 'forge', 'compose');
      mkdirSync(join(compose, 'lib'), { recursive: true });
      copyFileSync(SRC, join(compose, 'lib', 'wiki-components-link.js'));
      writeFileSync(join(compose, 'package.json'), '{"type":"module"}\n');
      const dirs = {
        sibling: join(base, 'a', 'b', 'forge', 'wiki', 'ui', 'packages', 'wiki-components'),
        stale: join(base, 'a', 'b', 'SmartMemory', 'smart-memory-wiki', 'ui', 'packages', 'wiki-components'),
        installed: join(compose, 'node_modules', '@smartmemory', 'wiki-components'),
        override: fakePackage(join(base, 'override')),
        missing: join(base, 'missing'),
      };
      if (row.sibling) fakePackage(dirs.sibling, { stale: row.sibling === 'stale' });
      if (row.stale) fakePackage(dirs.stale);
      if (row.installed) fakePackage(dirs.installed, { stale: row.installed === 'stale' });
      const env = { ...row.env };
      if (env.COMPOSE_WIKI_COMPONENTS_DIR && env.COMPOSE_WIKI_COMPONENTS_DIR !== 'none') env.COMPOSE_WIKI_COMPONENTS_DIR = dirs[env.COMPOSE_WIKI_COMPONENTS_DIR];
      const { resolveWikiComponentsDir } = await import(pathToFileURL(join(compose, 'lib', 'wiki-components-link.js')).href);
      const warnings = [];
      const orig = console.warn;
      console.warn = (msg) => warnings.push(String(msg));
      let got;
      try { got = resolveWikiComponentsDir(env); resolveWikiComponentsDir(env); } finally { console.warn = orig; }
      assert.equal(got, row.want ? dirs[row.want] : null);
      if (row.warns) {
        assert.equal(warnings.length, 1, `exactly one WARNING per process, got ${JSON.stringify(warnings)}`);
        assert.match(warnings[0], /^WARNING \[wiki-components\]/);
        assert.match(warnings[0], row.warns);
      } else if (row.warns === null) {
        assert.deepEqual(warnings, []);
      }
    });
  }
});

describe('REQUIRED_EXPORTS matches the stubs', () => {
  it('each stub exports exactly the required names', async () => {
    const { REQUIRED_EXPORTS, exportedNames } = await import(pathToFileURL(SRC).href);
    const stubs = { 'src/index.js': '../src/lib/wiki-components-stub.js', 'src/graph/index.js': '../src/lib/wiki-components-graph-stub.js' };
    for (const [entry, stub] of Object.entries(stubs)) {
      const have = [...exportedNames(fileURLToPath(new URL(stub, import.meta.url)))].sort();
      assert.deepEqual(have, [...REQUIRED_EXPORTS[entry]].sort(), entry);
    }
  });
});

/** STRAT-COMPONENTS-PUBLISH-1: Compose finds @smartmemory/stratum-ui as Mac sibling, else installed package, else nothing. */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStratumUi, stratumUiBuilderContent } from '../lib/stratum-ui-link.js';

function touch(file, body = '') { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, body); }

describe('resolveStratumUi', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stratum-ui-link-')));
  after(() => rmSync(root, { recursive: true, force: true }));
  const sibling = join(root, 'stratum', 'ui');
  touch(join(sibling, 'src', 'index.ts'));
  touch(join(sibling, 'server', 'handler.mjs'));
  const withPkg = join(root, 'with-pkg');
  const pkgDir = join(withPkg, 'node_modules', '@smartmemory', 'stratum-ui');
  touch(join(pkgDir, 'package.json'), JSON.stringify({ name: '@smartmemory/stratum-ui', exports: { './package.json': './package.json' } }));
  touch(join(pkgDir, 'dist', 'index.js'));
  touch(join(pkgDir, 'server', 'handler.mjs'));
  const unbuilt = join(root, 'unbuilt');
  touch(join(unbuilt, 'node_modules', '@smartmemory', 'stratum-ui', 'package.json'), JSON.stringify({ name: '@smartmemory/stratum-ui', exports: { './package.json': './package.json' } }));
  const bare = join(root, 'bare');
  mkdirSync(bare, { recursive: true });
  const gone = join(root, 'no-such-sibling');

  const rows = [
    { name: 'sibling wins over an installed package', env: { COMPOSE_STRATUM_UI_DIR: sibling }, fromDir: withPkg, kind: 'sibling', entry: join(sibling, 'src', 'index.ts'), styles: join(sibling, 'src', 'styles.css') },
    { name: 'no sibling: installed package, built dist', env: { COMPOSE_STRATUM_UI_DIR: gone }, fromDir: withPkg, kind: 'package', entry: join(pkgDir, 'dist', 'index.js'), styles: join(pkgDir, 'dist', 'styles.css') },
    { name: 'none forces the stub even with a package', env: { COMPOSE_STRATUM_UI_DIR: 'none' }, fromDir: withPkg, kind: null },
    { name: 'installed but unbuilt package is absent', env: { COMPOSE_STRATUM_UI_DIR: gone }, fromDir: unbuilt, kind: null },
    { name: 'neither present', env: { COMPOSE_STRATUM_UI_DIR: gone }, fromDir: bare, kind: null },
  ];

  for (const row of rows) {
    it(row.name, () => {
      const got = resolveStratumUi(row.env, { fromDir: row.fromDir });
      if (row.kind === null) return assert.equal(got, null);
      assert.equal(got.kind, row.kind);
      assert.equal(got.entry, row.entry);
      assert.equal(got.styles, row.styles);
      assert.equal(got.handler, join(got.dir, 'server', 'handler.mjs'));
    });
  }
});

// COMP-SUBAPP-STRAT-AUTHOR-1: `@smartmemory/stratum-ui/builder` resolves the same way; a package without
// dist/builder.js (built before the builder) gives builder null, so the alias takes the builder stub.
describe('resolveStratumUi builder entry', () => {
  const started = Date.now();
  const root = realpathSync(mkdtempSync(join(process.env.COMPOSE_TEST_SCRATCH || tmpdir(), 'stratum-ui-builder-link-')));
  after(() => { rmSync(root, { recursive: true, force: true }); console.log(`# stratum-ui-link builder wall ${Date.now() - started} ms`); });
  const sibling = join(root, 'stratum', 'ui');
  touch(join(sibling, 'src', 'index.ts'));
  touch(join(sibling, 'server', 'handler.mjs'));
  touch(join(sibling, 'src', 'builder', 'index.js'));
  const pkgManifest = JSON.stringify({ name: '@smartmemory/stratum-ui', exports: { './package.json': './package.json' } });
  const withBuilder = join(root, 'with-builder');
  const pkgDir = join(withBuilder, 'node_modules', '@smartmemory', 'stratum-ui');
  touch(join(pkgDir, 'package.json'), pkgManifest);
  touch(join(pkgDir, 'dist', 'index.js'));
  touch(join(pkgDir, 'dist', 'builder.js'));
  touch(join(pkgDir, 'server', 'handler.mjs'));
  const oldPkg = join(root, 'old-pkg');
  const oldDir = join(oldPkg, 'node_modules', '@smartmemory', 'stratum-ui');
  touch(join(oldDir, 'package.json'), pkgManifest);
  touch(join(oldDir, 'dist', 'index.js'));
  touch(join(oldDir, 'server', 'handler.mjs'));
  const gone = join(root, 'no-such-sibling');

  it('sibling: src/builder/index.js, Tailwind scans the builder sources', () => {
    const got = resolveStratumUi({ COMPOSE_STRATUM_UI_DIR: sibling }, { fromDir: withBuilder });
    assert.equal(got.builder, join(sibling, 'src', 'builder', 'index.js'));
    assert.deepEqual(stratumUiBuilderContent(got), [join(sibling, 'src', 'builder', '**', '*.{js,jsx}')]);
  });
  it('package: dist/builder.js, Tailwind scans that bundle', () => {
    const got = resolveStratumUi({ COMPOSE_STRATUM_UI_DIR: gone }, { fromDir: withBuilder });
    assert.equal(got.kind, 'package');
    assert.equal(got.builder, join(pkgDir, 'dist', 'builder.js'));
    assert.deepEqual(stratumUiBuilderContent(got), [join(pkgDir, 'dist', 'builder.js')]);
  });
  it('package built before the builder: builder null (stub), nothing extra scanned', () => {
    const got = resolveStratumUi({ COMPOSE_STRATUM_UI_DIR: gone }, { fromDir: oldPkg });
    assert.equal(got.kind, 'package');
    assert.equal(got.builder, null);
    assert.deepEqual(stratumUiBuilderContent(got), []);
  });
  it('none: no package at all, nothing scanned', () => {
    assert.equal(resolveStratumUi({ COMPOSE_STRATUM_UI_DIR: 'none' }, { fromDir: withBuilder }), null);
    assert.deepEqual(stratumUiBuilderContent(null), []);
  });
});


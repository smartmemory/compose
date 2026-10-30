/** STRAT-COMPONENTS-PUBLISH-1: Compose finds @smartmemory/stratum-ui as Mac sibling, else installed package, else nothing. */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStratumUi } from '../lib/stratum-ui-link.js';

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

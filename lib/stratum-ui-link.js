/**
 * stratum-ui-link.js — where Compose finds `@smartmemory/stratum-ui` (COMPOSE-STRAT-TAB-1,
 * STRAT-COMPONENTS-PUBLISH-1).
 *
 * Order: (1) the Mac sibling checkout `../stratum/ui` next to this checkout, built from source
 * (the dev loop); `COMPOSE_STRATUM_UI_DIR` overrides its path. (2) the installed npm package
 * (a normal dependency, so CI and published Compose have it), built `dist/`. (3) neither: the
 * Vite alias points at a stub and the Stratum tab is hidden. `COMPOSE_STRATUM_UI_DIR=none`
 * forces (3) (used to prove the stub build).
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const STRATUM_UI_PACKAGE = '@smartmemory/stratum-ui';

function siblingDir(raw) {
  // Worktrees sit one level deeper (<repo>/.worktrees/<name>), so also try the main checkout's sibling.
  const candidates = raw
    ? [resolve(raw)]
    : [resolve(__dirname, '..', '..', 'stratum', 'ui'), resolve(__dirname, '..', '..', '..', '..', 'stratum', 'ui')];
  return candidates.find((dir) => existsSync(resolve(dir, 'src', 'index.ts')) && existsSync(resolve(dir, 'server', 'handler.mjs'))) ?? null;
}

function installedDir(fromDir) {
  try {
    const dir = dirname(createRequire(resolve(fromDir, 'noop.js')).resolve(`${STRATUM_UI_PACKAGE}/package.json`));
    return existsSync(resolve(dir, 'dist', 'index.js')) && existsSync(resolve(dir, 'server', 'handler.mjs')) ? dir : null;
  } catch {
    return null;
  }
}

/**
 * @returns {{kind: 'sibling'|'package', dir: string, entry: string, styles: string, handler: string}|null}
 *   `entry` / `styles` are what the Vite alias points at, `handler` is the `/api/stratum-ui` server handler.
 */
export function resolveStratumUi(env = process.env, { fromDir = __dirname } = {}) {
  const raw = env.COMPOSE_STRATUM_UI_DIR;
  if (raw === 'none') return null;
  const sibling = siblingDir(raw);
  if (sibling) {
    return { kind: 'sibling', dir: sibling, entry: resolve(sibling, 'src', 'index.ts'), styles: resolve(sibling, 'src', 'styles.css'), handler: resolve(sibling, 'server', 'handler.mjs') };
  }
  const pkg = installedDir(fromDir);
  if (pkg) {
    return { kind: 'package', dir: pkg, entry: resolve(pkg, 'dist', 'index.js'), styles: resolve(pkg, 'dist', 'styles.css'), handler: resolve(pkg, 'server', 'handler.mjs') };
  }
  return null;
}

/** @returns {string|null} absolute path of the package root (sibling or installed), or null when absent. */
export function resolveStratumUiDir(env = process.env) {
  return resolveStratumUi(env)?.dir ?? null;
}

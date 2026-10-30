/**
 * wiki-components-link.js — where Compose finds the sibling `@wiki/components` package (COMPOSE-WIKI-TAB-1).
 *
 * Order: the Mac wiki checkout `<reg>/my/SmartMemory/smart-memory-wiki/ui/packages/wiki-components` (dev loop),
 * else the installed npm package `@smartmemory/wiki-components` (WIKI-COMPONENTS-PUBLISH-1: CI and the
 * published Compose build carry the Wiki tab), else absent. `COMPOSE_WIKI_COMPONENTS_DIR` overrides both; the
 * value `none` forces "absent" (used to prove the stub build). Absent means the Vite alias points at a stub and
 * the Wiki tab is hidden, so a build with neither still goes green.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIBLING = ['SmartMemory', 'smart-memory-wiki', 'ui', 'packages', 'wiki-components'];

/** @returns {string|null} absolute path of the wiki components package, or null when absent. */
export function resolveWikiComponentsDir(env = process.env) {
  const raw = env.COMPOSE_WIKI_COMPONENTS_DIR;
  if (raw === 'none') return null;
  // `<reg>/my/forge/compose/lib` -> `<reg>/my`; worktrees sit two levels deeper (<repo>/.worktrees/<name>).
  const candidates = raw
    ? [resolve(raw)]
    : [resolve(__dirname, '..', '..', '..', ...SIBLING), resolve(__dirname, '..', '..', '..', '..', '..', ...SIBLING)];
  if (!raw) {
    const installed = installedDir();
    if (installed) candidates.push(installed);
  }
  return candidates.find((dir) => existsSync(resolve(dir, 'src', 'index.js')) && existsSync(resolve(dir, 'src', 'data-client.jsx'))) ?? null;
}

/** The installed `@smartmemory/wiki-components` (Node resolution from this file, so a hoisted copy counts), or null. */
function installedDir() {
  try {
    return dirname(createRequire(import.meta.url).resolve('@smartmemory/wiki-components/package.json'));
  } catch {
    return null;
  }
}

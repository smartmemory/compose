/**
 * wiki-components-link.js — where Compose finds the sibling `@wiki/components` package (COMPOSE-WIKI-TAB-1).
 *
 * Mac workspace link, no npm publish: the package lives in the wiki checkout at
 * `<reg>/my/SmartMemory/smart-memory-wiki/ui/packages/wiki-components`. `COMPOSE_WIKI_COMPONENTS_DIR`
 * overrides it; the value `none` forces "absent" (used to prove the stub build). Absent means the Vite
 * alias points at a stub and the Wiki tab is hidden, so CI and the published npm package still build.
 */
import { existsSync } from 'node:fs';
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
  return candidates.find((dir) => existsSync(resolve(dir, 'src', 'index.js')) && existsSync(resolve(dir, 'src', 'data-client.jsx'))) ?? null;
}

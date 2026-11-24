/**
 * wiki-components-link.js — where Compose finds the sibling `@wiki/components` package (COMPOSE-WIKI-TAB-1).
 *
 * Order: the Mac wiki checkout `<reg>/my/forge/wiki/ui/packages/wiki-components`, Compose's forge sibling (dev loop, WIKI-TO-FORGE-1),
 * else the installed npm package `@smartmemory/wiki-components` (WIKI-COMPONENTS-PUBLISH-1: CI and the
 * published Compose build carry the Wiki tab), else absent. `COMPOSE_WIKI_COMPONENTS_DIR` overrides both; the
 * value `none` forces "absent" (used to prove the stub build). Absent means the Vite alias points at a stub and
 * the Wiki tab is hidden, so a build with neither still goes green.
 *
 * COMPOSE-RELEASE-NPM-1: a candidate counts only if its entries export every name Compose imports
 * (`REQUIRED_EXPORTS`, the same names the two stubs in `src/lib/` stand in for). Without this, an npm
 * `@smartmemory/wiki-components` older than the source (0.6.0 lacks `Features`) broke `vite build` from a
 * clean clone. A candidate that lacks a name is skipped with one WARNING naming what is missing, and the
 * tab is off in that build. `none` also prints one WARNING, so a build never drops the tab silently.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIBLING = ['wiki', 'ui', 'packages', 'wiki-components'];

/** Every name Compose imports from the package, per entry file. Keep in step with the stubs (test pins it). */
export const REQUIRED_EXPORTS = {
  'src/index.js': ['WikiDataProvider', 'FeatureHub', 'Features', 'Search', 'Decisions', 'Sources', 'AreaDocs', 'Ledger', 'wikiPath'],
  'src/graph/index.js': ['GraphPage', 'GraphHost', 'GRAPH_ASPECTS', 'resetWebGL2Probe', 'wholeGraph'],
};

// Once per process, not per module copy: Vite bundles vite.config.js and the Tailwind config loads this file
// again, so a module-level flag printed the same WARNING twice in one build. The marker lives in process.env.
const WARNED_ENV = 'COMPOSE_WIKI_COMPONENTS_WARNED';
function warnOnce(msg) {
  if (process.env[WARNED_ENV]) return;
  process.env[WARNED_ENV] = '1';
  console.warn(`WARNING [wiki-components] ${msg}`);
}

/**
 * Names a module file exports, read from its source (no import: the package is JSX for Vite, not Node).
 * Returns null when the file uses `export *`, which this reader cannot expand (treated as complete).
 */
export function exportedNames(file) {
  const src = readFileSync(file, 'utf8');
  if (/^\s*export\s*\*/m.test(src)) return null;
  const names = new Set();
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return names;
}

/** The required names `dir` does not export, as `file: a, b` strings (empty = complete). */
export function missingExports(dir) {
  const missing = [];
  for (const [rel, want] of Object.entries(REQUIRED_EXPORTS)) {
    const file = resolve(dir, rel);
    if (!existsSync(file)) { missing.push(`${rel}: (file absent)`); continue; }
    const have = exportedNames(file);
    if (!have) continue;
    const lack = want.filter((n) => !have.has(n));
    if (lack.length) missing.push(`${rel}: ${lack.join(', ')}`);
  }
  return missing;
}

/** @returns {string|null} absolute path of the wiki components package, or null when absent. */
export function resolveWikiComponentsDir(env = process.env) {
  const raw = env.COMPOSE_WIKI_COMPONENTS_DIR;
  if (raw === 'none') {
    warnOnce('COMPOSE_WIKI_COMPONENTS_DIR=none: the Wiki tab is off in this build (stub aliased).');
    return null;
  }
  // `<reg>/my/forge/compose/lib` -> `<reg>/my/forge`; worktrees sit two levels deeper (<repo>/.worktrees/<name>).
  const candidates = raw
    ? [resolve(raw)]
    : [resolve(__dirname, '..', '..', ...SIBLING), resolve(__dirname, '..', '..', '..', '..', ...SIBLING)];
  if (!raw) {
    const installed = installedDir();
    if (installed) candidates.push(installed);
  }
  const present = candidates.filter((dir) => existsSync(resolve(dir, 'src', 'index.js')) && existsSync(resolve(dir, 'src', 'data-client.jsx')));
  const skipped = [];
  for (const dir of present) {
    const missing = missingExports(dir);
    if (!missing.length) return dir;
    skipped.push(`${dir} lacks ${missing.join('; ')}`);
  }
  if (skipped.length) warnOnce(`the Wiki tab is off in this build: ${skipped.join(' | ')}. Publish a newer @smartmemory/wiki-components or point COMPOSE_WIKI_COMPONENTS_DIR at a checkout that has them.`);
  return null;
}

/** The installed `@smartmemory/wiki-components` (Node resolution from this file, so a hoisted copy counts), or null. */
function installedDir() {
  try {
    return dirname(createRequire(import.meta.url).resolve('@smartmemory/wiki-components/package.json'));
  } catch {
    return null;
  }
}

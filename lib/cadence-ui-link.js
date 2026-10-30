/**
 * cadence-ui-link.js — where Compose finds the sibling `@cadence/ui` package (COMPOSE-CADENCE-TAB-1).
 *
 * Mac workspace link, no npm publish: the package lives in the Cadence checkout at
 * `<reg>/my/SmartMemory/cadence/ui`. `COMPOSE_CADENCE_UI_DIR` overrides it; the value `none` forces
 * "absent" (used to prove the stub build). Absent means the Vite alias points at a stub and the
 * Cadence tab is hidden, so CI and the published npm package still build.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIBLING = ['SmartMemory', 'cadence', 'ui'];

/** @returns {string|null} absolute path of the Cadence ui package, or null when absent. */
export function resolveCadenceUiDir(env = process.env) {
  const raw = env.COMPOSE_CADENCE_UI_DIR;
  if (raw === 'none') return null;
  // `<reg>/my/forge/compose/lib` -> `<reg>/my`; worktrees sit two levels deeper (<repo>/.worktrees/<name>).
  const candidates = raw
    ? [resolve(raw)]
    : [resolve(__dirname, '..', '..', '..', ...SIBLING), resolve(__dirname, '..', '..', '..', '..', '..', ...SIBLING)];
  return candidates.find((dir) => existsSync(resolve(dir, 'src', 'index.ts')) && existsSync(resolve(dir, 'server', 'handler.mjs'))) ?? null;
}

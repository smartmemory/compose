/**
 * stratum-ui-link.js — where Compose finds the sibling `@stratum/ui` package (COMPOSE-STRAT-TAB-1).
 *
 * Mac workspace link, no npm publish: the package lives at `../stratum/ui` next to this
 * checkout. `COMPOSE_STRATUM_UI_DIR` overrides it; the value `none` forces "absent" (used to
 * prove the stub build). Absent means the Vite alias points at a stub and the Stratum tab is
 * hidden, so CI and the published npm package (no siblings) still build.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @returns {string|null} absolute path of the sibling ui package, or null when absent. */
export function resolveStratumUiDir(env = process.env) {
  const raw = env.COMPOSE_STRATUM_UI_DIR;
  if (raw === 'none') return null;
  // Worktrees sit one level deeper (<repo>/.worktrees/<name>), so also try the main checkout's sibling.
  const candidates = raw
    ? [resolve(raw)]
    : [resolve(__dirname, '..', '..', 'stratum', 'ui'), resolve(__dirname, '..', '..', '..', '..', 'stratum', 'ui')];
  return candidates.find((dir) => existsSync(resolve(dir, 'src', 'index.ts')) && existsSync(resolve(dir, 'server', 'handler.mjs'))) ?? null;
}

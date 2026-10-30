/**
 * cadence-ui-routes.js — `/api/cadence-ui/*` for the `@cadence/ui` Cadence tab (COMPOSE-CADENCE-TAB-1).
 *
 * Mounts the sibling package's own read-only (req, res) handler (`cadence/ui/server/handler.mjs`,
 * CADENCE-UI-BOARD-1) with the same defaults its standalone `serve.mjs` uses. The handler owns the
 * command list (four read-only argv lists, `commands()` there); Compose adds none and passes no
 * request input to them. GET/HEAD only (the handler answers 405 otherwise), no static dir.
 * Absent sibling: nothing is mounted. Skipped in remote mode: the handler has no Compose auth gate.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCadenceUiDir } from '../lib/cadence-ui-link.js';

const PREFIX = '/api/cadence-ui';

/** Returns true when mounted, false when skipped. */
// `opsRoot`, `stateDir`, `scriptsDir` and `run` exist for tests (scratch dirs, a fake runner); the cockpit
// passes none of them and gets serve.mjs's defaults.
export async function attachCadenceUiRoutes(app, {
  remote = false,
  uiDir = resolveCadenceUiDir(),
  env = process.env,
  opsRoot = env.CADENCE_UI_OPS_ROOT || join(homedir(), 'reg', 'my', 'SmartMemory', 'smart-memory-ops'),
  stateDir = join(homedir(), '.cadence'),
  scriptsDir = join(homedir(), '.claude', 'scripts'),
  run,
} = {}) {
  if (!uiDir || remote) return false;
  const { createHandler } = await import(pathToFileURL(join(uiDir, 'server', 'handler.mjs')).href);
  const handler = createHandler({
    opsRoot: resolve(opsRoot),
    stateDir: resolve(stateDir),
    scriptsDir: resolve(scriptsDir),
    cadenceRoot: resolve(uiDir, '..'),
    ...(run ? { run } : {}),
  });
  app.get(`${PREFIX}/available`, (_req, res) => res.json({ available: true }));
  // The handler routes on `/api/...`; Express strips the mount path, so put `/api` back.
  app.use(PREFIX, (req, res) => {
    req.url = `/api${req.url === '/' ? '' : req.url}`;
    return handler(req, res);
  });
  return true;
}

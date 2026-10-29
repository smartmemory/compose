/**
 * stratum-ui-routes.js — `/api/stratum-ui/*` for the `@stratum/ui` Stratum tab (COMPOSE-STRAT-TAB-1).
 *
 * Mounts the sibling package's own (req, res) handler (`stratum/ui/server/handler.mjs`, built to be
 * mounted under Express) with Compose's resolved stratum CLI, the same binary `stratum-client.js`
 * uses for query/gate calls. Gate lists and decisions go through that CLI (`query gates`,
 * `gate <action> --token`). Run detail reads the engine's run files read-only, because
 * `stratum query flow` does not return step state or events. Absent sibling: nothing is mounted.
 * Skipped in remote mode: the handler has no Compose auth gate and /api is the gate's scope.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveStratumUiDir } from '../lib/stratum-ui-link.js';
import { resolveStratumBin } from '../lib/stratum-engine.js';
import { getTargetRoot } from './project-root.js';

const PREFIX = '/api/stratum-ui';

/** Returns true when mounted, false when skipped. */
export async function attachStratumUiRoutes(app, { remote = false, uiDir = resolveStratumUiDir(), env = process.env } = {}) {
  if (!uiDir || remote) return false;
  const { createHandler } = await import(pathToFileURL(join(uiDir, 'server', 'handler.mjs')).href);
  const handler = createHandler({
    flowsDir: env.STRATUM_STATE_ROOT || join(homedir(), '.stratum', 'ts', 'flows'),
    stratumBin: resolveStratumBin('cli', getTargetRoot()),
  });
  app.get(`${PREFIX}/available`, (_req, res) => res.json({ available: true }));
  // The handler routes on `/api/...`; Express strips the mount path, so put `/api` back.
  app.use(PREFIX, (req, res) => {
    req.url = `/api${req.url === '/' ? '' : req.url}`;
    return handler(req, res);
  });
  return true;
}

/** Whether the tab can work: a sibling package and a mounted route (hidden otherwise). */
export function stratumUiAvailable(uiDir = resolveStratumUiDir()) {
  return Boolean(uiDir);
}

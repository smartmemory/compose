/**
 * stratum-ui-routes.js — `/api/stratum-ui/*` for the `@smartmemory/stratum-ui` Stratum tab
 * (COMPOSE-STRAT-TAB-1, STRAT-COMPONENTS-PUBLISH-1).
 *
 * Mounts the package's own (req, res) handler (`server/handler.mjs`, its `./server` export, built to be
 * mounted under Express; from the Mac sibling checkout, else the installed npm package) with Compose's resolved stratum CLI, the same binary `stratum-client.js`
 * uses for query/gate calls. Gate lists and decisions go through that CLI (`query gates`,
 * `gate <action> --token`). Run detail reads the engine's run files read-only, because
 * `stratum query flow` does not return step state or events. Neither present: nothing is mounted.
 * Skipped in remote mode: the handler has no Compose auth gate and /api is the gate's scope.
 *
 * COMP-SUBAPP-STRAT-AUTHOR-1: the handler gets `engineDist` (the built engine, installed or sibling,
 * `resolveStratumEngineDist`) so the builder's `POST /validate` and `/plan` answer; none found, it stays
 * unset and those keep returning 501. `/specs` (Save / Open) is NOT the package's: it passes through to
 * `stratum-spec-routes.js`, mounted after the workspace middleware.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveStratumUiDir } from '../lib/stratum-ui-link.js';
import { resolveStratumBin } from '../lib/stratum-engine.js';
import { getTargetRoot } from './project-root.js';
import { resolveStratumEngineDist, SPECS_PATH } from './stratum-spec-routes.js';

const PREFIX = '/api/stratum-ui';

/** Returns true when mounted, false when skipped. */
export async function attachStratumUiRoutes(app, { remote = false, uiDir = resolveStratumUiDir(), env = process.env, engineDist = resolveStratumEngineDist() } = {}) {
  if (!uiDir || remote) return false;
  const { createHandler } = await import(pathToFileURL(join(uiDir, 'server', 'handler.mjs')).href);
  const handler = createHandler({
    flowsDir: env.STRATUM_STATE_ROOT || join(homedir(), '.stratum', 'ts', 'flows'),
    stratumBin: resolveStratumBin('cli', getTargetRoot()),
    ...(engineDist ? { engineDist } : {}),
  });
  app.get(`${PREFIX}/available`, (_req, res) => res.json({ available: true }));
  // The handler routes on `/api/...`; Express strips the mount path, so put `/api` back.
  const specsSub = SPECS_PATH.slice(PREFIX.length);
  app.use(PREFIX, (req, res, next) => {
    if (req.url === specsSub || req.url.startsWith(`${specsSub}/`) || req.url.startsWith(`${specsSub}?`)) return next();
    req.url = `/api${req.url === '/' ? '' : req.url}`;
    return handler(req, res);
  });
  return true;
}

/** Whether the tab can work: the package (sibling or installed) and a mounted route (hidden otherwise). */
export function stratumUiAvailable(uiDir = resolveStratumUiDir()) {
  return Boolean(uiDir);
}

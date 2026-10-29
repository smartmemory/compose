/**
 * ops-status-routes.js — read-only mount of the Ops status pages (COMPOSE-OPS-TAB-1).
 *
 * Routes (only when the directory exists):
 *   GET /ops-status/<name>/status.html   static, GET/HEAD only, no directory listing
 *   GET /api/ops-status/index            { pages: [name, ...] } for subdirs holding status.html
 *
 * The directory comes from COMPOSE_OPS_STATUS_DIR (default: the SmartMemory ops
 * checkout). Published npm installs have no such directory, so nothing is
 * mounted and the cockpit hides the Ops tab. Skipped in remote mode: the pages
 * are internal and /ops-status is outside the /api auth gate.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import express from 'express';

export const DEFAULT_OPS_STATUS_DIR = join(homedir(), 'reg/my/SmartMemory/smart-memory-ops/status/out');

const NAME_RE = /^[A-Za-z0-9._-]+$/;

export function resolveOpsStatusDir(env = process.env) {
  const dir = env.COMPOSE_OPS_STATUS_DIR || DEFAULT_OPS_STATUS_DIR;
  try { return statSync(dir).isDirectory() ? dir : null; } catch { return null; }
}

export function listOpsPages(dir) {
  try {
    return readdirSync(dir)
      .filter((n) => NAME_RE.test(n) && !n.startsWith('.') && existsSync(join(dir, n, 'status.html')))
      .sort();
  } catch { return []; }
}

/** Returns true when mounted, false when skipped (dir absent). */
export function attachOpsStatusRoutes(app, { dir = resolveOpsStatusDir(), remote = false } = {}) {
  if (!dir || remote || !existsSync(dir)) return false;
  app.get('/api/ops-status/index', (_req, res) => res.json({ pages: listOpsPages(dir) }));
  app.use('/ops-status', (req, res, next) => (
    req.method === 'GET' || req.method === 'HEAD' ? next() : res.status(405).end()
  ), express.static(dir, { index: false, redirect: false, dotfiles: 'ignore', fallthrough: false }));
  // fallthrough:false forwards misses to the error handler; answer 404 here.
  app.use('/ops-status', (err, _req, res, _next) => res.status(err.status === 403 ? 404 : (err.status || 404)).end());
  return true;
}

/**
 * unit-index-routes.js — `GET /api/units/index` (COMP-COCKPIT-UNIT-INDEX-1): one server-side index of every lane's
 * units (title, stage, stamp times, waiting-on) that every cockpit part reads. Reads the same stamp files as
 * `/api/process`, with the same path resolution. Read-only; absent in remote mode.
 */
import { dirname, join } from 'node:path';
import { createSourceCache } from './fleet-routes.js';
import { resolveProcessSources } from './process-routes.js';
import { buildUnitIndex } from '../lib/unit-index.js';
import { freshness } from '../lib/process-metrics.js';

export const UNIT_INDEX_ROUTE = '/api/units/index';
const TTL_MS = 120_000; // the stamps TTL of /api/process
const LANE_RE = /^[a-z0-9.-]+$/;

/** Returns true when mounted, false when skipped (remote mode). */
export function attachUnitIndexRoutes(app, {
  remote = false,
  env = process.env,
  sources = resolveProcessSources(env),
  now = Date.now,
  warn = console.warn,
  info = console.log,
  ttlMs = TTL_MS,
} = {}) {
  if (remote) return false;
  // OPS/status holds configs/ and data/; the builder output dir (statusDir) is OPS/status/out.
  const statusRoot = env.COMPOSE_UNIT_INDEX_STATUS_ROOT || dirname(sources.statusDir);
  const unitsDir = env.COMPOSE_UNIT_INDEX_UNITS_DIR || join(dirname(sources.queuesDir), 'units');
  const cache = createSourceCache('unit-index',
    () => buildUnitIndex({ queuesDir: sources.queuesDir, extra: sources.extra, unitsDir, statusRoot, now: now() }),
    { ttlMs, now, warn, info, logPrefix: '[unit-index]' });
  app.get(UNIT_INDEX_ROUTE, async (req, res) => {
    const lane = req.query.lane;
    if (lane !== undefined && (typeof lane !== 'string' || !LANE_RE.test(lane))) {
      return res.status(400).json({ error: 'lane must match [a-z0-9.-]+' });
    }
    try {
      const entry = await cache.get();
      if (!entry.value) return res.status(500).json({ error: entry.error ?? 'unit index unavailable' });
      const { units, coverage, glossary, asOf } = entry.value;
      res.set('cache-control', 'no-store');
      res.json({
        units: lane === undefined ? units : units.filter((u) => u.lane === lane),
        coverage, glossary, asOf,
        ageS: freshness({ mtimeMs: Date.parse(asOf), now: now() }).ageS,
      });
    } catch (error) {
      res.status(500).json({ error: String(error?.message ?? error) });
    }
  });
  return true;
}

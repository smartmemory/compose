/**
 * usage-routes.js — GET /api/usage/stats (COMP-OBS-STATS-1).
 *
 * Read-only aggregates for the cockpit Usage view over the current workspace's
 * dispatch ledger, joined to build-history.jsonl by build id. The numbers come
 * from collectDispatchMetrics (lib/dispatch-metrics.js) so the page and
 * `compose metrics` share one aggregator. Not an extension of GET /api/builds,
 * which is limit-bounded and returns raw records (design D4).
 *
 * Query: from=<iso> (optional, inclusive), to=<iso> (optional, exclusive,
 * default now), compare=1 (needs from: adds the preceding window of equal
 * length). Mounted under /api, so it sits behind the same remote auth gate as
 * the other /api routes; no secret or env value is read or returned.
 */
import { collectDispatchMetrics } from '../lib/dispatch-metrics.js';
import { getDataDir as defaultGetDataDir, getTargetRoot as defaultGetTargetRoot } from './project-root.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

function parseIso(value, name) {
  if (value === undefined || value === '') return { ms: null };
  if (typeof value !== 'string' || !ISO_RE.test(value) || Number.isNaN(Date.parse(value))) {
    return { error: `${name} must be an ISO 8601 timestamp` };
  }
  return { ms: Date.parse(value) };
}

function usageFor(root, dataDir, fromMs, toMs) {
  const report = collectDispatchMetrics(root, {
    since: fromMs ?? undefined, to: toMs, buckets: 'day', historyDir: dataDir,
  });
  return report.usage;
}

export function attachUsageRoutes(app, deps = {}) {
  const getTargetRoot = deps.getTargetRoot || defaultGetTargetRoot;
  const getDataDir = deps.getDataDir || defaultGetDataDir;
  const now = deps.now || (() => Date.now());

  app.get('/api/usage/stats', (req, res) => {
    const from = parseIso(req.query.from, 'from');
    const to = parseIso(req.query.to, 'to');
    const bad = from.error || to.error;
    if (bad) return res.status(400).json({ error: bad });
    const toMs = to.ms ?? now();
    if (from.ms !== null && from.ms >= toMs) {
      return res.status(400).json({ error: 'from must be before to' });
    }
    const compare = req.query.compare === '1' || req.query.compare === 'true';
    if (compare && from.ms === null) {
      return res.status(400).json({ error: 'compare needs a bounded range (from)' });
    }
    try {
      const root = getTargetRoot();
      const dataDir = getDataDir();
      const current = usageFor(root, dataDir, from.ms, toMs);
      let previous = null;
      let previousRange = null;
      if (compare) {
        const span = toMs - from.ms;
        previousRange = { from: new Date(from.ms - span).toISOString(), to: new Date(from.ms).toISOString() };
        previous = usageFor(root, dataDir, from.ms - span, from.ms);
      }
      res.json({
        v: 1,
        generated_at: new Date(now()).toISOString(),
        // Q1/Q2 (design.md): current workspace only; the ledger holds only
        // dispatches Compose made, never hand-driven sessions.
        scope: { workspace: 'current', spend: 'compose-dispatched' },
        range: { from: from.ms === null ? null : new Date(from.ms).toISOString(), to: new Date(toMs).toISOString() },
        previous_range: previousRange,
        current,
        previous,
      });
    } catch (err) {
      const status = err instanceof RangeError ? 400 : 500;
      res.status(status).json({ error: err.message || String(err) });
    }
  });
}

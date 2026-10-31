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
 *
 * GET /api/usage/seats (COMP-COCKPIT-PROCESS-DATA-1): the per-seat quota rows behind the Usage view's
 * "Seats and fleet" scope, from `usage_watch.py status --json` (argv, never a shell; path from
 * COMPOSE_USAGE_WATCH, default ~/.claude/scripts/usage_watch.py). One run takes ~7.5 s (measured
 * 2026-10-31), so it is cached for SEATS_TTL_MS and served stale while one refresh runs. Neither this
 * source nor spend_attr carries per-seat dollars; the day's fleet $ is the sm_status ceiling line the
 * view reads from /api/fleet. A down reader answers 200 with `seats.error`, never a 5xx. Email
 * addresses are cut from account labels.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { collectDispatchMetrics } from '../lib/dispatch-metrics.js';
import { createSourceCache, runReader } from './fleet-routes.js';
import { getDataDir as defaultGetDataDir, getTargetRoot as defaultGetTargetRoot } from './project-root.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;
export const SEATS_TTL_MS = 60_000;
export const SEATS_TIMEOUT_MS = 30_000;
const EMAIL_RE = /\s*\(?[^\s()@]+@[^\s()]+\)?/g;

const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (sec) => (typeof sec === 'number' && Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null);

/** Pure: usage_watch `status --json` -> one row per account, quota windows only (no per-seat $ exists). */
export function seatRows(doc) {
  if (!doc || !Array.isArray(doc.accounts)) throw new Error('usage_watch printed no accounts list');
  return doc.accounts.filter((a) => a && typeof a.id === 'string').map((a) => {
    const w = (k) => ({ used_pct: pct(a.windows?.[k]?.used_pct), resets_at: iso(a.windows?.[k]?.resets_at) });
    return {
      id: a.id,
      label: typeof a.label === 'string' ? a.label.replace(EMAIL_RE, '').trim() : a.id,
      vendor: typeof a.vendor === 'string' ? a.vendor : null,
      status: typeof a.status === 'string' ? a.status : null,
      five_h: w('5h'),
      seven_d: w('7d'),
      today_pts: pct(a.today_pts),
    };
  });
}

export async function readSeats({ python = 'python3', script, env = process.env, timeoutMs = SEATS_TIMEOUT_MS, run = runReader } = {}) {
  if (!existsSync(script)) throw new Error(`reader missing: ${script}`);
  const { stdout } = await run([python, script, 'status', '--json'], { timeoutMs, env });
  let doc;
  try { doc = JSON.parse(stdout); } catch { throw new Error('usage_watch printed no JSON document'); }
  return { generated_at: typeof doc.generated_at === 'string' ? doc.generated_at : null, seats: seatRows(doc) };
}

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
  const env = deps.env || process.env;
  const seatsLoad = deps.readSeats || (() => readSeats({
    python: env.COMPOSE_FLEET_PYTHON || 'python3',
    script: env.COMPOSE_USAGE_WATCH || join(homedir(), '.claude', 'scripts', 'usage_watch.py'),
    env,
  }));
  const seatsCache = createSourceCache('usage_watch', seatsLoad, { ttlMs: deps.seatsTtlMs ?? SEATS_TTL_MS, now, logPrefix: '[usage]' });

  app.get('/api/usage/seats', async (_req, res) => {
    const seats = await seatsCache.get();
    res.json({ v: 1, generated_at: new Date(now()).toISOString(), seats });
  });

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

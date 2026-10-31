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
 *
 * GET /api/usage/credit and GET /api/usage/hourly (COMP-COCKPIT-RIBBON-METER-1): the two readers the Day page's money card
 * needs. `credit` runs `api_credit.py status --json` (COMPOSE_API_CREDIT), `hourly` runs `spend_attr.py series --bucket 1h
 * --json` (COMPOSE_SPEND_ATTR) over today's CLOSED hours only (a warm closed hour is cheap, a window that runs to now takes
 * 8-17 s). Both are cached and answer 200 with an `error`, like seats. No balance and no hold flag is ever turned into $0.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { collectDispatchMetrics } from '../lib/dispatch-metrics.js';
import { createSourceCache, runReader } from './fleet-routes.js';
import { getDataDir as defaultGetDataDir, getTargetRoot as defaultGetTargetRoot } from './project-root.js';

export const CREDIT_TTL_MS = 60_000;
export const HOURLY_TTL_MS = 300_000;
export const HOURLY_TIMEOUT_MS = 90_000;
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
    const st = a.windows?.['7d']?.status;
    const f = a.fable && typeof a.fable === 'object' ? a.fable : null;
    const cd = a.codex_daily && typeof a.codex_daily === 'object' ? a.codex_daily : null;
    const si = a.seat_idle && typeof a.seat_idle === 'object' ? a.seat_idle : null;
    return {
      id: a.id,
      label: typeof a.label === 'string' ? a.label.replace(EMAIL_RE, '').trim() : a.id,
      vendor: typeof a.vendor === 'string' ? a.vendor : null,
      status: typeof a.status === 'string' ? a.status : null,
      five_h: w('5h'),
      seven_d: typeof st === 'string' ? { ...w('7d'), status: st } : w('7d'),
      today_pts: pct(a.today_pts),
      // COMP-COCKPIT-COST-METER-1: the blocks the cost meter needs, each present only when usage_watch printed it.
      ...(typeof a.retired === 'boolean' ? { retired: a.retired } : {}),
      ...(typeof a.retire_state === 'string' ? { retire_state: a.retire_state } : {}),
      ...(f ? { fable: { used_pct: pct(f.reading?.used_pct), resets_at: iso(f.reading?.resets_at), cap_pct: pct(f.cap_pct), pace_pct: pct(f.pace_pct), over_cap: f.over_cap === true } } : {}),
      ...(cd ? { codex_daily: { cap_pct: pct(cd.cap_pct), state: typeof cd.state === 'string' ? cd.state : null, off: cd.off === true } } : {}),
      ...(si ? { seat_idle: { used_pct: pct(si.used_pct), hours_left: pct(si.hours_left), ready_units: pct(si.ready_units) } } : {}),
    };
  });
}

/** Pure: api_credit `status --json` -> `{balance_usd, hold, reserve_usd, as_of}`; a null balance stays null. */
export function creditRow(doc) {
  if (!doc || typeof doc !== 'object' || !('hold' in doc || 'balance_usd' in doc)) throw new Error('api_credit printed no status');
  return { balance_usd: pct(doc.balance_usd), hold: doc.hold === true, reserve_usd: pct(doc.reserve_usd), as_of: typeof doc.as_of === 'string' ? doc.as_of : null };
}

/** Pure: spend_attr `series --json` -> `[{start, usd}]` (engines and sessions are not carried: the card draws bars). */
export function hourlyRows(doc) {
  if (!doc || !Array.isArray(doc.buckets)) throw new Error('spend_attr printed no buckets');
  return doc.buckets.filter((b) => b && typeof b.start === 'string').map((b) => ({ start: b.start, usd: pct(b.usd) ?? 0 }));
}

const pad = (n) => String(n).padStart(2, '0');
/** A Date as local ISO with its UTC offset ("2026-10-31T17:00:00+08:00"), the form spend_attr prints and takes. */
export function localIso(d) {
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** Today's window: local midnight to the top of the current hour. `null` before the first hour has closed. */
export function closedHoursWindow(nowMs) {
  const to = new Date(nowMs); to.setMinutes(0, 0, 0);
  const from = new Date(to); from.setHours(0);
  return from.getTime() < to.getTime() ? { from: localIso(from), to: localIso(to) } : null;
}

export async function readCredit({ python = 'python3', script, env = process.env, timeoutMs = SEATS_TIMEOUT_MS, run = runReader } = {}) {
  if (!existsSync(script)) throw new Error(`reader missing: ${script}`);
  const { stdout } = await run([python, script, 'status', '--json'], { timeoutMs, env });
  let doc;
  try { doc = JSON.parse(stdout); } catch { throw new Error('api_credit printed no JSON document'); }
  return creditRow(doc);
}

export async function readHourly({ python = 'python3', script, env = process.env, timeoutMs = HOURLY_TIMEOUT_MS, run = runReader, now = Date.now } = {}) {
  if (!existsSync(script)) throw new Error(`reader missing: ${script}`);
  const win = closedHoursWindow(now());
  if (!win) return { buckets: [] };
  const { stdout } = await run([python, script, 'series', '--from', win.from, '--to', win.to, '--bucket', '1h', '--json'], { timeoutMs, env });
  let doc;
  try { doc = JSON.parse(stdout); } catch { throw new Error('spend_attr printed no JSON document'); }
  return { buckets: hourlyRows(doc) };
}

export async function readSeats({ python = 'python3', script, env = process.env, timeoutMs = SEATS_TIMEOUT_MS, run = runReader } = {}) {
  if (!existsSync(script)) throw new Error(`reader missing: ${script}`);
  const { stdout } = await run([python, script, 'status', '--json'], { timeoutMs, env });
  let doc;
  try { doc = JSON.parse(stdout); } catch { throw new Error('usage_watch printed no JSON document'); }
  // usage_watch prints `generated_at` as epoch seconds; older fixtures print an ISO string.
  const generated = typeof doc.generated_at === 'string' ? doc.generated_at : iso(doc.generated_at);
  return { generated_at: generated, seats: seatRows(doc) };
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

  const home = homedir();
  const creditCache = createSourceCache('api_credit', deps.readCredit || (() => readCredit({
    python: env.COMPOSE_FLEET_PYTHON || 'python3',
    script: env.COMPOSE_API_CREDIT || join(home, '.claude', 'scripts', 'api_credit.py'),
    env,
  })), { ttlMs: deps.creditTtlMs ?? CREDIT_TTL_MS, now, logPrefix: '[usage]' });
  const hourlyCache = createSourceCache('spend_attr', deps.readHourly || (() => readHourly({
    python: env.COMPOSE_FLEET_PYTHON || 'python3',
    script: env.COMPOSE_SPEND_ATTR || join(home, '.claude', 'scripts', 'spend_attr.py'),
    env,
    now,
  })), { ttlMs: deps.hourlyTtlMs ?? HOURLY_TTL_MS, now, logPrefix: '[usage]' });

  // Boot warm: the first read of this source takes ~29 s, so one read runs now and every later one is served from the cache.
  if (deps.warm) hourlyCache.get().catch(() => {});

  app.get('/api/usage/credit', async (_req, res) => {
    res.json({ v: 1, generated_at: new Date(now()).toISOString(), credit: await creditCache.get() });
  });

  app.get('/api/usage/hourly', async (_req, res) => {
    res.json({ v: 1, generated_at: new Date(now()).toISOString(), hourly: await hourlyCache.get() });
  });

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

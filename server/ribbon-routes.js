/**
 * ribbon-routes.js — `GET /api/ribbon?from=<iso>&to=<iso>` (COMP-COCKPIT-RIBBON-FEED-1): the one feed of the Day ribbon.
 * Reads the stamp files (through the unit index), the quota snapshots, the owner queue, gate.log, the seats, the cadence
 * outage state, the wiki ledger (through this server's own wiki proxy) and the ETA reader, and hands them to `buildRibbon`.
 * Read-only. Loopback only: absent in remote mode, like `/api/process`. One failing source goes to `sourceErrors` and renders
 * as not recorded; the route never answers 500 for one source.
 */
import { appendFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createSourceCache } from './fleet-routes.js';
import { resolveProcessSources } from './process-routes.js';
import { createEtaReader } from './ops-status-routes.js';
import { readSeats } from './usage-routes.js';
import { getDataDir } from './project-root.js';
import { buildUnitIndex } from '../lib/unit-index.js';
import { buildRibbon, computeHistory, etaWithPrev, parseGateLog, remainingByLane } from '../lib/ribbon-feed.js';

export const RIBBON_ROUTE = '/api/ribbon';
const WINDOW_MAX_MS = 31 * 86_400_000;
const RESPONSE_TTL_MS = 120_000;
const RESPONSE_MAX = 20;
const SOURCE_TTL_MS = 120_000;
const HISTORY_TTL_MS = 15 * 60_000;
const ETA_CONCURRENCY = 4;
const LEDGER_PAGE = 50;
const LEDGER_MAX_PAGES = 20;
const LOOPBACK_TIMEOUT_MS = 8_000;
const ISO_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

/** `{ms}` for an ISO instant WITH an offset, else `{error}`. */
function instant(value, name) {
  if (typeof value !== 'string' || !ISO_OFFSET_RE.test(value)) return { error: `${name} must be an ISO 8601 time with an offset, e.g. 2026-10-31T18:00:00+08:00` };
  const t = Date.parse(value);
  return Number.isNaN(t) ? { error: `${name} is not a real time` } : { ms: t };
}

/** Each source reads to `{value}` or `{error}` (never throws). */
const settle = async (fn) => { try { return { value: await fn() }; } catch (e) { return { error: String(e?.message ?? e).slice(0, 200) }; } };

async function readJsonl(file) {
  const out = [];
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn last line */ }
  }
  return out;
}

async function loopbackJson(base, path, init = {}) {
  const res = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(LOOPBACK_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

/** The wiki ledger entries of [from, to], newest first, through this server's wiki proxy (at most LEDGER_MAX_PAGES pages). */
async function readLedger(base, fromMs, toMs) {
  const items = [];
  let cursor;
  for (let i = 0; i < LEDGER_MAX_PAGES; i += 1) {
    const body = { workspace: 'wiki-eng', from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), size: LEDGER_PAGE, ...(cursor ? { cursor } : {}) };
    const doc = await loopbackJson(base, '/api/wiki/query/ledger', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const d = doc?.data ?? doc;
    if (Array.isArray(d?.items)) items.push(...d.items);
    cursor = d?.next_cursor;
    if (!cursor) break;
  }
  return items;
}

/** Returns true when mounted, false when skipped (remote mode). `deps` are for tests. */
export function attachRibbonRoutes(app, { remote = false, env = process.env, deps = {} } = {}) {
  if (remote) return false;
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? console.warn;
  const info = deps.info ?? console.log;
  const sources = deps.sources ?? resolveProcessSources(env);
  const opsRoot = dirname(sources.queuesDir);
  const dataDir = deps.dataDir ?? (() => getDataDir());
  const files = {
    snapshots: env.COMPOSE_RIBBON_SNAPSHOTS || join(homedir(), '.claude', 'usage', 'snapshots.jsonl'),
    ownerQueue: env.COMPOSE_RIBBON_OWNER_QUEUE || join(opsRoot, 'coordination', 'owner-queue.jsonl'),
    gateLog: env.COMPOSE_RIBBON_GATE_LOG || join(opsRoot, 'status', 'launch-gate', 'gate.log'),
  };
  const eta = deps.eta ?? createEtaReader({
    python: env.COMPOSE_FLEET_PYTHON || 'python3',
    script: env.COMPOSE_ESTIMATE_PY || join(homedir(), '.claude', 'scripts', 'estimate.py'),
    env, now,
  });
  const cacheOpts = (ttlMs, logPrefix = '[ribbon]') => ({ ttlMs, now, warn, info, logPrefix });
  const units = createSourceCache('ribbon units', deps.loadUnits ?? (() => buildUnitIndex({
    queuesDir: sources.queuesDir, extra: sources.extra, now: now(), withEvents: true,
    statusRoot: env.COMPOSE_UNIT_INDEX_STATUS_ROOT || dirname(sources.statusDir),
    unitsDir: env.COMPOSE_UNIT_INDEX_UNITS_DIR || join(opsRoot, 'units'),
  })), cacheOpts(SOURCE_TTL_MS));
  const snapshots = createSourceCache('ribbon snapshots', deps.loadSnapshots ?? (() => readJsonl(files.snapshots)), cacheOpts(SOURCE_TTL_MS));
  const ownerQueue = createSourceCache('ribbon owner queue', deps.loadOwnerQueue ?? (() => readJsonl(files.ownerQueue)), cacheOpts(SOURCE_TTL_MS));
  const gateLog = createSourceCache('ribbon gate.log', deps.loadGateLog ?? (async () => parseGateLog(await readFile(files.gateLog, 'utf8'))), cacheOpts(SOURCE_TTL_MS));
  const seats = createSourceCache('ribbon seats', deps.loadSeats ?? (() => readSeats({
    python: env.COMPOSE_FLEET_PYTHON || 'python3',
    script: env.COMPOSE_USAGE_WATCH || join(homedir(), '.claude', 'scripts', 'usage_watch.py'), env,
  })), cacheOpts(60_000));
  // The history of each source is computed once per 15 min from whatever the caches hold then.
  let historyAt = -Infinity;
  let historyValue = null;
  const historyOf = (inputs) => {
    if (historyValue && now() - historyAt < HISTORY_TTL_MS) return historyValue;
    historyValue = computeHistory(inputs);
    historyAt = now();
    return historyValue;
  };
  const responses = new Map(); // key -> {at, body}

  async function etaFor(live, unitList, errors) {
    if (!live) return {};
    const remaining = remainingByLane(unitList);
    const lanes = Object.keys(remaining);
    const out = {};
    const failed = [];
    const histFile = join(dataDir(), 'ribbon-eta-history.jsonl');
    const rows = await readJsonl(histFile).catch(() => []);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(ETA_CONCURRENCY, lanes.length) }, async () => {
      while (i < lanes.length) {
        const lane = lanes[i++];
        const r = await settle(() => eta(lane, remaining[lane]));
        if (r.error || r.value?.error) { failed.push(`${lane}: ${r.error ?? r.value.error}`); out[lane] = null; continue; }
        const { eta: withPrev, append } = etaWithPrev(lane, r.value, rows);
        out[lane] = withPrev;
        if (append) { rows.push(append); await appendFile(histFile, `${JSON.stringify(append)}\n`).catch((e) => warn(`[ribbon] eta history not written: ${e.message}`)); }
      }
    }));
    if (failed.length) errors.eta = `no estimate for ${failed.length} lane(s): ${failed.slice(0, 3).join('; ')}`;
    return out;
  }

  app.get(RIBBON_ROUTE, async (req, res) => {
    res.set('cache-control', 'no-store');
    const a = instant(req.query.from, 'from');
    const b = instant(req.query.to, 'to');
    if (a.error || b.error) return res.status(400).json({ error: a.error ?? b.error });
    if (a.ms >= b.ms) return res.status(400).json({ error: 'from must be before to' });
    if (b.ms - a.ms > WINDOW_MAX_MS) return res.status(400).json({ error: 'the window must be at most 31 days' });
    const minute = (t) => Math.floor(t / 60_000) * 60_000;
    const key = `${minute(a.ms)}|${minute(b.ms)}`;
    const t0 = now();
    const hit = responses.get(key);
    if (hit && t0 - hit.at < RESPONSE_TTL_MS) return res.json({ ...hit.body, ageS: Math.max(0, Math.floor((t0 - Date.parse(hit.body.asOf)) / 1000)) });
    try {
      const base = `http://127.0.0.1:${req.socket.localPort}`;
      const [u, snap, oq, gl, st, ledger, outage] = await Promise.all([
        settle(async () => { const e = await units.get(); if (!e.value) throw new Error(e.error ?? 'unit index unavailable'); return e.value; }),
        settle(async () => { const e = await snapshots.get(); if (!e.value) throw new Error(e.error ?? 'snapshots unavailable'); return e.value; }),
        settle(async () => { const e = await ownerQueue.get(); if (!e.value) throw new Error(e.error ?? 'owner queue unavailable'); return e.value; }),
        settle(async () => { const e = await gateLog.get(); if (!e.value) throw new Error(e.error ?? 'gate.log unavailable'); return e.value; }),
        settle(async () => { const e = await seats.get(); if (!e.value) throw new Error(e.error ?? 'seats unavailable'); return e.value; }),
        settle(() => (deps.loadLedger ?? readLedger)(base, a.ms, b.ms)),
        settle(() => (deps.loadOutage ?? (() => loopbackJson(base, '/api/cadence-ui/outage')))()),
      ]);
      const sourceErrors = {};
      if (u.error) sourceErrors.stamps = u.error;
      if (snap.error) sourceErrors.quota = snap.error;
      if (oq.error) sourceErrors.ownerQueue = oq.error;
      if (gl.error) sourceErrors.holds = gl.error;
      if (ledger.error) sourceErrors.ledger = ledger.error;
      if (outage.error) sourceErrors.outage = outage.error;
      if (st.error) sourceErrors.seats = st.error;
      for (const [lane, c] of Object.entries(u.value?.coverage ?? {})) if (c?.error) sourceErrors.stamps = [sourceErrors.stamps, c.error].filter(Boolean).join('; ');

      const unitList = u.value?.units ?? [];
      const live = t0 >= a.ms && t0 <= b.ms;
      const history = historyOf({ units: unitList, snapshots: snap.value ?? [], ownerQueue: oq.value ?? [], gateEntries: gl.value ?? [] });
      const etas = await etaFor(live, unitList, sourceErrors);
      const body = buildRibbon({
        from: a.ms, to: b.ms, now: t0, asOf: u.value ? Date.parse(u.value.asOf) : t0,
        units: unitList, snapshots: snap.value ?? [], ownerQueue: oq.value ?? [], ledger: ledger.value ?? [],
        gateEntries: gl.value ?? [], outage: outage.value ?? null, seats: st.value?.seats ?? null,
        etas, history, sourceErrors, warn,
      });
      responses.set(key, { at: t0, body });
      while (responses.size > RESPONSE_MAX) responses.delete(responses.keys().next().value);
      res.json(body);
    } catch (error) {
      warn(`[ribbon] failed: ${String(error?.message ?? error)}`);
      res.status(500).json({ error: String(error?.message ?? error) });
    }
  });
  return true;
}

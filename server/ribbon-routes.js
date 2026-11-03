/**
 * ribbon-routes.js — `GET /api/ribbon?from=<iso>&to=<iso>` (COMP-COCKPIT-RIBBON-FEED-1): the one feed of the Day ribbon.
 * Reads the stamp files (through the unit index), the quota snapshots, the owner queue, gate.log, the seats, the cadence
 * outage state, the ops ledger's decisions (the Decisions pane's reader, COMP-COCKPIT-DECISIONS-1) and the ETA reader, and hands them
 * to `buildRibbon`.
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
import { buildRibbon, computeHistory, etaWithPrev, parseGateLog, remainingByLane, safeReason } from '../lib/ribbon-feed.js';
import { queueDecisions, unitsIn } from '../lib/decisions-ledger.js';
import { groupOf, stripTag } from '../lib/owner-queue-class.js';
import { reconcileOwnerSpans } from '../lib/owner-spans.js';
import { ledgerDecisions, ledgerPath } from './decisions-routes.js';

export const RIBBON_ROUTE = '/api/ribbon';
const WINDOW_MAX_MS = 31 * 86_400_000;
const RESPONSE_TTL_MS = 120_000;
const RESPONSE_MAX = 20;
const SOURCE_TTL_MS = 120_000;
const HISTORY_TTL_MS = 15 * 60_000;
const ETA_CONCURRENCY = 4;
const LOOPBACK_TIMEOUT_MS = 8_000;
const ISO_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

/** `{ms}` for an ISO instant WITH an offset, else `{error}`. */
function instant(value, name) {
  if (typeof value !== 'string' || !ISO_OFFSET_RE.test(value)) return { error: `${name} must be an ISO 8601 time with an offset, e.g. 2026-10-31T18:00:00+08:00` };
  const t = Date.parse(value);
  return Number.isNaN(t) ? { error: `${name} is not a real time` } : { ms: t };
}

/**
 * C3 (COMP-DAYVIEW-DESIGN-FIX-1 U1): the owner waits, from the SAME owner queue the WHAT line counts (`ownerAsks`,
 * COUNT-ONE-1), so the ribbon can never show "1 waiting on you" with nothing drawn. The queue is folded the way sm_status
 * folds it (latest record per id); only `asks` and `security` rows count (`groupOf`, the chip's classifier). Each ask goes
 * on a lane: its own `lane`, else its `unit`'s lane, else the lane of the first unit its text names, else the asking
 * session's lane (`forge-main` -> forge), else the ops row with `laneGuess: true` (said in the tip, never silent).
 * Returns `{open, spans}`: `open` are the asks open at `now` in the fleet queue panel's row shape (`{id, by, text, age}`
 * plus `lane`), which `ownerAsks` reads unchanged; `spans` are `{lane, span}` for every ask open at some time in the window.
 */
export function ownerWaits({ queue = [], units = [], lanes = [], from, to, now }) {
  const byId = new Map();
  for (const r of queue) if (r && typeof r.id === 'string') byId.set(r.id, { ...(byId.get(r.id) ?? {}), ...r });
  const laneOfUnit = new Map(units.map((u) => [u.id, u.lane]));
  const has = new Set(lanes);
  const fallback = has.has('ops') ? 'ops' : (lanes[0] ?? null);
  const iso = (t) => new Date(t).toISOString();
  const open = [];
  const spans = [];
  for (const r of byId.values()) {
    if ((r.status !== 'open' && r.status !== 'closed') || typeof r.ts !== 'number' || !Number.isFinite(r.ts)) continue;
    const g = groupOf(r.text);
    if (g !== 'asks' && g !== 'security') continue;
    const named = [r.lane, laneOfUnit.get(r.unit), ...unitsIn(`${r.unit ?? ''} ${r.text ?? ''}`).map((u) => laneOfUnit.get(u)), String(r.by ?? '').replace(/-main$/, '')]
      .find((l) => typeof l === 'string' && has.has(l));
    const lane = named ?? fallback;
    const start = r.ts * 1000;
    if (r.status === 'open') open.push({ id: r.id, by: r.by ?? null, text: String(r.text ?? ''), age: Math.max(0, Math.round((now - start) / 1000)), lane });
    const end = r.status === 'open' ? now : (typeof r.closed_ts === 'number' ? r.closed_ts * 1000 : null);
    if (lane === null || end === null || end < from || start > to) continue;
    const title = stripTag(r.text).slice(0, 160);
    spans.push({
      lane,
      span: {
        kind: 'wait', cause: 'owner', start: iso(Math.max(start, from)), end: iso(Math.min(end, to)), since: iso(start),
        unit: r.unit ?? null, title, job: null, queueId: r.id, laneGuess: !named,
        why: `waiting on your answer (owner queue ${r.id}${named ? '' : ', no lane named: shown on ' + lane})`,
      },
    });
  }
  return { open, spans };
}

/** Each source reads to `{value}` or `{error}` (never throws). */
const settle = async (fn) => { try { return { value: await fn() }; } catch (e) { return { error: safeReason(String(e?.message ?? e)).slice(0, 200) }; } };

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
  const ledger = deps.ledger ?? ledgerDecisions(ledgerPath(env, opsRoot), { now, warn, info });
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
        if (r.error || r.value?.error) { failed.push(`${lane}: ${safeReason(r.error ?? r.value.error)}`); out[lane] = null; continue; }
        const { eta: withPrev, append } = etaWithPrev(lane, r.value, rows);
        out[lane] = withPrev;
        if (append) { rows.push(append); await appendFile(histFile, `${JSON.stringify(append)}\n`).catch((e) => warn(`[ribbon] eta history not written: ${e.message}`)); }
      }
    }));
    if (failed.length) errors.eta = `no estimate for ${failed.length} lane(s): ${failed.slice(0, 3).join('; ')}`;
    return out;
  }

  /**
   * Boot warm (COMP-COCKPIT-RIBBON-LIVE-DATA-1): fills the window-independent caches (units, snapshots, owner queue, gate.log,
   * seats, the parsed ledger, and every lane's estimate) so the first real read waits for neither. The outage read and the
   * response itself depend on the client's window minute, so they stay cold. Never throws: a failed source logs its own WARNING.
   */
  app.locals.warmRibbon = async () => {
    const t0 = now();
    try {
      const [u] = await Promise.all([units.get(), snapshots.get(), ownerQueue.get(), gateLog.get(), seats.get(), ledger.get()]);
      if (u.value) await etaFor(true, u.value.units, {});
      info(`[ribbon] warm done in ${now() - t0} ms`);
    } catch (error) {
      warn(`[ribbon] warm failed: ${String(error?.message ?? error)}`);
    }
  };

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
      const [u, snap, oq, gl, st, led, outage] = await Promise.all([
        settle(async () => { const e = await units.get(); if (!e.value) throw new Error(e.error ?? 'unit index unavailable'); return e.value; }),
        settle(async () => { const e = await snapshots.get(); if (!e.value) throw new Error(e.error ?? 'snapshots unavailable'); return e.value; }),
        settle(async () => { const e = await ownerQueue.get(); if (!e.value) throw new Error(e.error ?? 'owner queue unavailable'); return e.value; }),
        settle(async () => { const e = await gateLog.get(); if (!e.value) throw new Error(e.error ?? 'gate.log unavailable'); return e.value; }),
        settle(async () => { const e = await seats.get(); if (!e.value) throw new Error(e.error ?? 'seats unavailable'); return e.value; }),
        settle(async () => { const e = await ledger.get(); if (!e.value) throw new Error(e.error ?? 'ledger unavailable'); return ledger.rows(e.value); }),
        settle(() => (deps.loadOutage ?? (() => loopbackJson(base, '/api/cadence-ui/outage')))()),
      ]);
      const sourceErrors = {};
      if (u.error) sourceErrors.stamps = u.error;
      if (snap.error) sourceErrors.quota = snap.error;
      if (oq.error) sourceErrors.ownerQueue = oq.error;
      if (gl.error) sourceErrors.holds = gl.error;
      if (led.error) sourceErrors.ledger = led.error;
      if (outage.error) sourceErrors.outage = outage.error;
      if (st.error) sourceErrors.seats = st.error;
      for (const [lane, c] of Object.entries(u.value?.coverage ?? {})) if (c?.error) sourceErrors.stamps = [sourceErrors.stamps, safeReason(c.error)].filter(Boolean).join('; ');

      const unitList = u.value?.units ?? [];
      const live = t0 >= a.ms && t0 <= b.ms;
      // The decide marks read the decisions feed: the ledger's rows and the owner queue's (COMP-COCKPIT-DECISIONS-1).
      const decisions = [...(led.value ?? []), ...queueDecisions(oq.value ?? [])];
      const history = historyOf({ units: unitList, snapshots: snap.value ?? [], ownerQueue: oq.value ?? [], gateEntries: gl.value ?? [], decisions });
      const etas = await etaFor(live, unitList, sourceErrors);
      const body = buildRibbon({
        from: a.ms, to: b.ms, now: t0, asOf: u.value ? Date.parse(u.value.asOf) : t0,
        units: unitList, snapshots: snap.value ?? [], ownerQueue: oq.value ?? [], decisions,
        gateEntries: gl.value ?? [], outage: outage.value ?? null, seats: st.value?.seats ?? null,
        etas, history, sourceErrors, warn,
      });
      // C3: owner waits from the owner queue, on the lane each one belongs to. A queue that could not be read is unknown
      // (`owner.open: null`, the ribbon then drops nothing), never an empty list. The reason stays in `sourceErrors.ownerQueue`
      // only, so a raw error string is not copied into one more field (u2-folds RIBBON-FEED-1 M5).
      if (oq.error) body.owner = { open: null };
      else {
        const ow = ownerWaits({ queue: oq.value ?? [], units: unitList, lanes: body.lanes.map((l) => l.lane), from: a.ms, to: b.ms, now: t0 });
        // FU-1: a `laneGuess` ask (no lane named, parked on ops) is drawn on its stamp's unit lane when a stamp names its id.
        // `laneRule: 'stamp-lane'` says so on the span. A named ask stays where it was named: its stamp's lane mirrors it
        // (`reconcileOwnerSpans`, `laneRule: 'asked-elsewhere'`), one marker and one count, never a false "working".
        const stampLane = new Map();
        for (const l of body.lanes) for (const s of l.spans) if (s.kind === 'wait' && s.cause === 'owner' && !s.queueId && s.qid && !stampLane.has(s.qid)) stampLane.set(s.qid, l.lane);
        const placed = ow.spans.map(({ lane, span }) => {
          const to2 = span.laneGuess ? stampLane.get(span.queueId) : null;
          return to2 && to2 !== lane ? { lane: to2, span: { ...span, laneGuess: false, laneRule: 'stamp-lane', why: `waiting on your answer (owner queue ${span.queueId}, shown on ${to2}, the lane of its unit)` } } : { lane, span };
        });
        const moved = new Map(placed.map((p) => [p.span.queueId, p.lane]));
        ow.open = ow.open.map((o) => (moved.has(o.id) ? { ...o, lane: moved.get(o.id) } : o));
        for (const { lane, span } of placed) {
          const row = body.lanes.find((l) => l.lane === lane);
          row.spans.push(span);
          row.spans.sort((x, y) => Date.parse(x.start) - Date.parse(y.start) || Date.parse(x.end) - Date.parse(y.end));
          row.idle = false;
        }
        // U3-DATA: a stamp is matched to its queue ask by identity, the queue draws the time it covers, an open stamp with no
        // ask is clipped at this read (`reconcileOwnerSpans`). The queue was read, so `asOf` is this request's clock.
        // COMP-DAYVIEW-OWNER-IDENTITY-1: every lane's queue spans are passed, so a stamp finds its ask (`qid`) on any lane.
        const asks = placed.map(({ span }) => span);
        const askLanes = new Map(placed.map(({ lane, span }) => [span.queueId, lane]));
        for (const row of body.lanes) {
          row.spans = reconcileOwnerSpans(row.spans, { asOf: t0, asks, lane: row.lane, askLanes })
            .sort((x, y) => Date.parse(x.start) - Date.parse(y.start) || Date.parse(x.end) - Date.parse(y.end));
          row.idle = !row.current && row.spans.length === 0 && (row.marks || []).length === 0;
        }
        body.owner = { open: ow.open };
      }
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

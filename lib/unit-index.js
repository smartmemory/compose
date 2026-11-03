/**
 * unit-index.js — ONE per-unit index of the lane stamp files (COMP-COCKPIT-UNIT-INDEX-1). WHAT-LINE, RULE-PLAIN,
 * RULE-FRESH and INIT-DATA read this instead of each parsing the stamps. A stamp hole is shown as null, never filled in,
 * and never counted as zero: `coverage` says how many recent landings carry each event.
 *
 * Read-only. Paths come from the caller (server/process-routes.js resolves them); no request input reaches a path.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { laneRows } from './process-metrics.js';

const COVERAGE_WINDOW_MS = 48 * 3600 * 1000;
const EVENTS = ['ready', 'dispatched', 'authorDone', 'review', 'gate', 'landed', 'deployed', 'title'];

/**
 * States of a unit that is finished or set aside: nothing waits on its review or on the owner. ONE home; `ribbon-feed.js`
 * imports it. A unit with a `landed_at` is finished too, whatever its state says.
 */
export const DEAD_STATES = ['retired', 'superseded', 'folded', 'parked', 'held', 'closed', 'done', 'cancelled', 'killed'];

/** The two rules behind `waiting`, exported so WHAT-LINE can show them on hover. First match wins. Neither applies to a landed or dead-state unit. */
export const WAITING_RULES = [
  { waiting: 'owner', rule: 'an owner_waits entry has a start and no end, and the unit has not landed or reached a finished state (retired, superseded, folded, parked, held, closed, done, cancelled, killed)' },
  { waiting: 'review', rule: 'author_done_at is set, no review time is set, and the unit has not landed or reached a finished state (retired, superseded, folded, parked, held, closed, done, cancelled, killed)' },
];

/**
 * The unit's title from its brief: the first `# ` heading, minus a leading `<id>` + `:`, ` (`, ` -` or ` —`; 120 chars max.
 * source: cadence/ui/server/sources.mjs:118-134 (copied, not imported across repos).
 */
export function titleFromBrief(text, id) {
  for (const line of String(text).split('\n')) {
    if (!line.startsWith('# ')) continue;
    let t = line.slice(2).trim();
    if (t.startsWith(id)) {
      const rest = t.slice(id.length);
      const m = /^(:| \(| -| —)\s*/.exec(rest);
      if (m) {
        t = rest.slice(m[0].length);
        if (m[1] === ' (' && t.endsWith(')')) t = t.slice(0, -1);
      }
    }
    t = t.trim().slice(0, 120);
    return t || null;
  }
  return null;
}

const ms = (v) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isNaN(t) ? null : t; };
const str = (v) => (typeof v === 'string' && v.trim() ? v : null);

/** First usable time among `keys`, else the latest `list[].<listKey>` time. Returned as the original string. */
function stampTime(row, keys, list, listKey) {
  for (const k of keys) if (ms(row[k]) !== null) return row[k];
  let best = null;
  if (Array.isArray(row[list])) for (const e of row[list]) { const t = ms(e?.[listKey]); if (t !== null && (best === null || t > ms(best))) best = e[listKey]; }
  return best;
}

/** The open owner wait (a start and no end), or undefined. The one place that decides it, for `waitingOf` and `ownerWaitSince`. */
const openOwnerWait = (row) => (Array.isArray(row.owner_waits) ? row.owner_waits.find((w) => w && ms(w.start) !== null && !w.end) : undefined);

export function waitingOf(row, t) {
  if (t.landedAt || DEAD_STATES.includes(str(row.state) ?? str(row.stage))) return null;
  if (openOwnerWait(row)) return 'owner';
  if (t.authorDoneAt && !t.reviewDoneAt) return 'review';
  return null;
}

async function readOptional(file) {
  try { return await readFile(file, 'utf8'); } catch { return null; }
}

/** A read or parse failure in words, never a path: `not found`, `not JSON`, or the error code. */
const why = (e) => (e?.code === 'ENOENT' ? 'not found' : e instanceof SyntaxError ? 'not JSON' : e?.code ? `unreadable (${e.code})` : 'unreadable');

/**
 * `{glossary: {lane: {code: sentence}}, warnings: {lane: [text]}}` from `<statusRoot>/configs/<lane>.json` `glossary` (a
 * path relative to statusRoot, as OPS/status/build.py:29 reads it). A lane with no config, or a config with no glossary,
 * maps to {} quietly. COMP-COCKPIT-SOURCE-FAULTS-1 (UNIT-INDEX M3): a config that exists but cannot be read, or a
 * configured glossary that cannot be read or parsed, maps to {} WITH a lane warning, so a lost glossary is not a title hole.
 */
async function readGlossaries(statusRoot, lanes) {
  const glossary = {};
  const warnings = {};
  const warn = (lane, text) => { (warnings[lane] ??= []).push(text); };
  for (const lane of lanes) {
    glossary[lane] = {};
    if (!statusRoot) continue;
    let cfg;
    try { cfg = JSON.parse(await readFile(join(statusRoot, 'configs', `${lane}.json`), 'utf8')); } catch (e) {
      if (e?.code !== 'ENOENT') warn(lane, `glossary config ${why(e)}`);
      continue;
    }
    if (cfg?.glossary === undefined || cfg?.glossary === null) continue;
    if (typeof cfg.glossary !== 'string' || cfg.glossary.includes('..')) { warn(lane, 'glossary path rejected'); continue; }
    try {
      const g = JSON.parse(await readFile(join(statusRoot, cfg.glossary), 'utf8'));
      if (g === null || typeof g !== 'object' || Array.isArray(g)) { warn(lane, 'glossary is not a map'); continue; }
      for (const [k, v] of Object.entries(g)) if (typeof v === 'string') glossary[lane][k] = v;
    } catch (e) { warn(lane, `glossary ${why(e)}`); }
  }
  return { glossary, warnings };
}

/**
 * One WARNING log per fault, not one per rebuild: three caches rebuild this index every 120 s. A fault that clears and
 * comes back logs again. Keyed per `warn` function so an injected test logger starts clean.
 */
const LOGGED = new WeakMap();
function logFaults(warn, faults) {
  if (typeof warn !== 'function') return;
  const seen = LOGGED.get(warn) ?? new Set();
  const now = new Set(faults);
  for (const f of now) if (!seen.has(f)) warn(`[unit-index] WARNING ${f}`);
  LOGGED.set(warn, now);
}

async function pickTitle(row, lane, glossary, unitsDir) {
  const own = str(row.title);
  if (own) return { title: own, titleSource: 'stamp' };
  const goal = str(row.goal);
  if (goal) return { title: goal, titleSource: 'goal' };
  const gl = glossary[lane]?.[row.id];
  if (gl) return { title: gl, titleSource: 'glossary' };
  if (unitsDir && /^[A-Za-z0-9._-]+$/.test(String(row.id))) {
    const text = await readOptional(join(unitsDir, String(row.id), 'brief.md'));
    const t = text === null ? null : titleFromBrief(text, String(row.id));
    if (t) return { title: t, titleSource: 'brief' };
  }
  return { title: null, titleSource: 'none' };
}

function coverageOf(units, now) {
  // UNIT-INDEX L1: both bounds, so a future-dated landed_at (typo, clock skew) is not a recent landing.
  const recent = units.filter((u) => { const t = ms(u.landedAt); return t !== null && t <= now && now - t <= COVERAGE_WINDOW_MS; });
  const has = {
    ready: (u) => u.readyAt, dispatched: (u) => u.dispatchedAt, authorDone: (u) => u.authorDoneAt, review: (u) => u.reviewDoneAt,
    gate: (u) => u.gateDoneAt, landed: (u) => u.landedAt, deployed: (u) => u.deployedAt, title: (u) => u.title,
  };
  const c = { n: recent.length, pct: {} };
  for (const e of EVENTS) {
    c[e] = recent.filter((u) => has[e](u)).length;
    c.pct[e] = recent.length ? Math.round((100 * c[e]) / recent.length) : null;
  }
  return c;
}

/**
 * The raw interval lists and stamps the Day ribbon draws (COMP-COCKPIT-RIBBON-FEED-1), shallow copies and nothing interpreted.
 * `fixes` is passed because rule U-c reads it, `account` because it names the lane's seat.
 */
function eventsOf(row) {
  const list = (v) => (Array.isArray(v) ? v.map((e) => (e && typeof e === 'object' ? { ...e } : e)) : []);
  return {
    owner_waits: list(row.owner_waits), reviews: list(row.reviews), fix_runs: list(row.fix_runs), gates: list(row.gates),
    deploys: list(row.deploys), fixes: list(row.fixes),
    ready_at: row.ready_at ?? null, dispatched_at: row.dispatched_at ?? null, author_done_at: row.author_done_at ?? null,
    landed_at: row.landed_at ?? null, account: str(row.account),
  };
}

/**
 * Builds the index. `extra` is `[[lane, file], ...]` as in `resolveProcessSources`. Never throws on one bad lane.
 * `withEvents` (default false, so `/api/units/index` is unchanged) adds `events` (see `eventsOf`) to every unit.
 *
 * COMP-COCKPIT-SOURCE-FAULTS-1, what a fault leaves in the result (each also logs one WARNING through `warn`):
 * - `error`: the queue directory exists but cannot be listed (UNIT-INDEX M1). The extra files still read, so the index
 *   is partial, and a consumer must say so rather than show the missing lanes as empty.
 * - `warnings`: index-wide notes, e.g. `queues dir not found` (no lane files beyond the extras).
 * - `coverage[lane].error`: that lane's stamp file is missing, not JSON or has no units list (as before).
 * - `coverage[lane].warnings`: rows dropped as not objects (UNIT-INDEX M2) and a configured glossary that failed (M3).
 */
export async function buildUnitIndex({ queuesDir, extra = [], unitsDir = null, statusRoot = null, now = Date.now(), withEvents = false, warn = console.warn }) {
  let names = [];
  let error = null;
  const warnings = [];
  if (queuesDir) {
    try { names = (await readdir(queuesDir)).filter((n) => n.endsWith('-units.json')).sort(); } catch (e) {
      // The extra files may still read either way; only a missing directory is an expected configuration.
      if (e?.code === 'ENOENT') warnings.push('queues dir not found');
      else error = `queues dir ${why(e)}`;
    }
  }
  const files = names.map((n) => [n.slice(0, -'-units.json'.length), join(queuesDir, n)]);
  for (const [lane, path] of extra) { const i = files.findIndex(([l]) => l === lane); if (i >= 0) files.splice(i, 1); files.push([lane, path]); }

  const { glossary, warnings: glossaryWarnings } = await readGlossaries(statusRoot, files.map(([l]) => l));
  const units = [];
  const byLane = {};
  const coverage = {};
  for (const [lane, path] of files) {
    let doc;
    try { doc = JSON.parse(await readFile(path, 'utf8')); } catch (e) {
      coverage[lane] = { error: e?.code === 'ENOENT' ? `${lane}: stamp file not found` : `${lane}: not JSON` };
      continue;
    }
    const { rows, skipped, error: rowsError } = laneRows(doc);
    if (rowsError) { coverage[lane] = { error: `${lane}: ${rowsError}` }; continue; }
    byLane[lane] = [];
    for (const row of rows) {
      const t = {
        readyAt: stampTime(row, ['ready_at'], '', ''),
        dispatchedAt: stampTime(row, ['dispatched_at'], '', ''),
        authorDoneAt: stampTime(row, ['author_done_at'], '', ''),
        reviewDoneAt: stampTime(row, ['review_done_at', 'review_r1_done_at'], 'reviews', 'at'),
        gateDoneAt: stampTime(row, ['gate_done_at'], 'gates', 'done_at'),
        landedAt: stampTime(row, ['landed_at'], '', ''),
        deployedAt: stampTime(row, ['deployed_at'], 'deploys', 'at'),
      };
      const waiting = waitingOf(row, t);
      const u = {
        id: String(row.id), lane, ...(await pickTitle(row, lane, glossary, unitsDir)),
        state: str(row.state) ?? str(row.stage), ...t, waiting,
        ownerWaitSince: waiting === 'owner' ? openOwnerWait(row).start : null,
        ...(withEvents ? { events: eventsOf(row) } : {}),
      };
      units.push(u);
      byLane[lane].push(u);
    }
    coverage[lane] = coverageOf(byLane[lane], now);
    const laneWarnings = [...(skipped > 0 ? [`${skipped} row${skipped === 1 ? '' : 's'} skipped (not an object)`] : []), ...(glossaryWarnings[lane] ?? [])];
    if (laneWarnings.length) coverage[lane].warnings = laneWarnings;
  }
  logFaults(warn, [
    ...(error ? [`${error}: lanes in it are missing from the index`] : []),
    ...warnings.map((w) => `${w}: only the extra stamp files were read`),
    ...Object.entries(coverage).flatMap(([lane, c]) => [
      ...(c.error ? [`${c.error}: its units are missing from the index`] : []),
      ...(c.warnings ?? []).map((w) => `${lane}: ${w}`),
    ]),
  ]);
  return { units, coverage, glossary, error, warnings, asOf: new Date(now).toISOString() };
}

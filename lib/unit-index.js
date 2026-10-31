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

/** The two rules behind `waiting`, exported so WHAT-LINE can show them on hover. First match wins. */
export const WAITING_RULES = [
  { waiting: 'owner', rule: 'an owner_waits entry has a start and no end' },
  { waiting: 'review', rule: 'author_done_at is set, no review time is set, and the unit has not landed' },
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

export function waitingOf(row, t) {
  if (Array.isArray(row.owner_waits) && row.owner_waits.some((w) => w && ms(w.start) !== null && !w.end)) return 'owner';
  if (t.authorDoneAt && !t.reviewDoneAt && !t.landedAt) return 'review';
  return null;
}

async function readOptional(file) {
  try { return await readFile(file, 'utf8'); } catch { return null; }
}

/**
 * `{lane: {code: sentence}}` from `<statusRoot>/configs/<lane>.json` `glossary` (a path relative to statusRoot, as
 * OPS/status/build.py:29 reads it). A lane without a readable config or glossary maps to {}.
 */
async function readGlossaries(statusRoot, lanes) {
  const out = {};
  for (const lane of lanes) {
    out[lane] = {};
    if (!statusRoot) continue;
    try {
      const cfg = JSON.parse(await readFile(join(statusRoot, 'configs', `${lane}.json`), 'utf8'));
      if (typeof cfg.glossary !== 'string' || cfg.glossary.includes('..')) continue;
      const g = JSON.parse(await readFile(join(statusRoot, cfg.glossary), 'utf8'));
      for (const [k, v] of Object.entries(g)) if (typeof v === 'string') out[lane][k] = v;
    } catch { /* no config or glossary for this lane */ }
  }
  return out;
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
  const recent = units.filter((u) => { const t = ms(u.landedAt); return t !== null && now - t <= COVERAGE_WINDOW_MS; });
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

/** Builds the index. `extra` is `[[lane, file], ...]` as in `resolveProcessSources`. Never throws on one bad lane. */
export async function buildUnitIndex({ queuesDir, extra = [], unitsDir = null, statusRoot = null, now = Date.now() }) {
  let names = [];
  try { names = (await readdir(queuesDir)).filter((n) => n.endsWith('-units.json')).sort(); } catch { /* the extra files may still read */ }
  const files = names.map((n) => [n.slice(0, -'-units.json'.length), join(queuesDir, n)]);
  for (const [lane, path] of extra) { const i = files.findIndex(([l]) => l === lane); if (i >= 0) files.splice(i, 1); files.push([lane, path]); }

  const glossary = await readGlossaries(statusRoot, files.map(([l]) => l));
  const units = [];
  const byLane = {};
  const coverage = {};
  for (const [lane, path] of files) {
    let doc;
    try { doc = JSON.parse(await readFile(path, 'utf8')); } catch (e) {
      coverage[lane] = { error: e?.code === 'ENOENT' ? `${lane}: stamp file not found` : `${lane}: not JSON` };
      continue;
    }
    const { rows, error } = laneRows(doc);
    if (error) { coverage[lane] = { error: `${lane}: ${error}` }; continue; }
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
      const u = {
        id: String(row.id), lane, ...(await pickTitle(row, lane, glossary, unitsDir)),
        state: str(row.state) ?? str(row.stage), ...t, waiting: waitingOf(row, t),
      };
      units.push(u);
      byLane[lane].push(u);
    }
    coverage[lane] = coverageOf(byLane[lane], now);
  }
  return { units, coverage, glossary, asOf: new Date(now).toISOString() };
}

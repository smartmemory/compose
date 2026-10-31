/**
 * process-routes.js — `GET /api/process`, the read-only data behind the Process view (COMP-COCKPIT-13 U1).
 *
 * Two sources, each in its own single-flight cache:
 *   builder  the status builder's own output (`OPS/status/out/<name>/summary.json`, `master/process.json`) with its
 *            freshness, passed through unchanged: no figure is computed, renamed or rounded here.
 *   stamps   the lane stamp files (`unit_stamps.py`) for the P6 time split, the one derivation the builder lacks.
 *   history  the builder's daily KPI line per lane (`forge/status/kpi-history.jsonl`, U5) for the tile sparklines.
 * Fixed roots only, no request input reaches a path, nothing under ~/.claude is read, nothing is spawned.
 * Not mounted in remote mode (Mac-only).
 *
 * COMP-COCKPIT-FLEET-PROJECTS-1: the envelope also carries `fleet: {known, projects, error}`, the lanes the view can
 * show and the owner's saved order (`fleet.projects` in the active project's `.compose/compose.json`, read fresh on
 * every request; null when the key is absent). `POST /api/fleet/projects` writes that key: loopback callers only,
 * known names only, the path is the server's own target root.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import express from 'express';
import { createSourceCache } from './fleet-routes.js';
import { DEFAULT_OPS_STATUS_DIR, NAME_RE, resolveOpsStatusDir } from './ops-status-routes.js';
import { freshness, laneRows, laneTimeSplit, parseKpiHistory } from '../lib/process-metrics.js';
import { PublishRefused, buildPointer, detectSourceCheckout } from '../lib/process-publish.js';
import { COMPOSE_HOME, getTargetRoot } from './project-root.js';
import { localCaller } from './wiki-routes.js';
import { writeComposeJson } from '../lib/cli-remote.js';

export const PROCESS_ROUTE = '/api/process';
export const PUBLISH_ROUTE = '/api/process/publish';
export const FLEET_PROJECTS_ROUTE = '/api/fleet/projects';
export const BUILDER_TICK_S = 900; // launchd ai.smartmemory.status-build StartInterval; stale at two ticks
const TTL_MS = { builder: 60_000, stamps: 120_000, history: 300_000 };
const LOG = '[process]';
const DEFAULT_QUEUES_DIR = join(homedir(), 'reg/my/SmartMemory/smart-memory-ops/queues');
const DEFAULT_EXTRA = `forge=${join(homedir(), 'reg/my/forge/status/units.json')}`;
const DEFAULT_KPI_HISTORY = join(homedir(), 'reg/my/forge/status/kpi-history.jsonl');

const expandHome = (p) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p);

/** Paths only; nothing is checked here, so a directory that appears after start is picked up by the next load (L6). */
export function resolveProcessSources(env = process.env) {
  const extra = (env.COMPOSE_PROCESS_EXTRA ?? DEFAULT_EXTRA)
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => { const i = s.indexOf('='); return i > 0 ? [s.slice(0, i), expandHome(s.slice(i + 1))] : null; })
    .filter(Boolean);
  return {
    statusDir: resolveOpsStatusDir(env) ?? (env.COMPOSE_OPS_STATUS_DIR || DEFAULT_OPS_STATUS_DIR),
    queuesDir: expandHome(env.COMPOSE_PROCESS_QUEUES_DIR || DEFAULT_QUEUES_DIR),
    historyFile: expandHome(env.COMPOSE_PROCESS_KPI_HISTORY || DEFAULT_KPI_HISTORY),
    extra,
  };
}

const readIfExists = async (file) => {
  try { return await readFile(file, 'utf8'); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
};

/** One builder JSON file: `{value, error, asOf, ageS, stale, failed}`; `value` is the parsed file, unchanged. */
async function readBuilderFile(dir, name, file, label, now) {
  const path = join(dir, name, file);
  let st;
  try { st = await stat(path); } catch (e) {
    if (e?.code === 'ENOENT') return { value: null, error: `${name}: ${label} not found`, asOf: null, ageS: null, stale: false, failed: null };
    throw e;
  }
  const failedText = await readIfExists(join(dir, name, 'BUILD-FAILED.txt'));
  const fresh = freshness({ mtimeMs: st.mtimeMs, now, failedText, staleAfterS: 2 * BUILDER_TICK_S });
  let value = null;
  let error = null;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch { error = `${name}: ${label} not JSON`; }
  const asOf = typeof value?.as_of === 'string' ? value.as_of : null;
  return { value, error, asOf, ...fresh };
}

export async function readBuilderOutput(dir, { now = Date.now() } = {}) {
  let st;
  try { st = await stat(dir); } catch { throw new Error('status dir not found'); }
  if (!st.isDirectory()) throw new Error('status dir not found');

  const master = await readBuilderFile(dir, 'master', 'process.json', 'process.json', now);
  let names;
  if (Array.isArray(master.value?.projects)) {
    names = master.value.projects.map((p) => p?.name).filter((n) => typeof n === 'string' && NAME_RE.test(n) && !n.startsWith('.'));
  } else {
    names = [];
    for (const n of (await readdir(dir)).sort()) {
      if (!NAME_RE.test(n) || n.startsWith('.') || n === 'master') continue;
      try { if ((await stat(join(dir, n, 'summary.json'))).isFile()) names.push(n); } catch { /* no summary: not a page */ }
    }
  }
  const pages = {};
  for (const n of names) pages[n] = await readBuilderFile(dir, n, 'summary.json', 'summary.json', now);
  return {
    table: master.value,
    tableError: master.value ? null : master.error,
    asOf: master.asOf, ageS: master.ageS, stale: master.stale, failed: master.failed,
    pages,
  };
}

export async function readStamps({ queuesDir, extra }, note = () => {}) {
  let names;
  try { names = (await readdir(queuesDir)).filter((n) => n.endsWith('-units.json')).sort(); } catch { throw new Error('queues dir not found'); }
  const files = names.map((n) => [n.slice(0, -'-units.json'.length), join(queuesDir, n)]);
  for (const [lane, path] of extra) { const i = files.findIndex(([l]) => l === lane); if (i >= 0) files.splice(i, 1); files.push([lane, path]); }
  const lanes = {};
  for (const [lane, path] of files) {
    let doc;
    try { doc = JSON.parse(await readFile(path, 'utf8')); } catch (e) {
      const error = e?.code === 'ENOENT' ? `${lane}: stamp file not found` : `${lane}: not JSON`;
      lanes[lane] = { value: null, error, warnings: [], timeSplit: null };
      note(lane, 0, error);
      continue;
    }
    const { rows, skipped, error } = laneRows(doc);
    if (error) { lanes[lane] = { value: null, error: `${lane}: ${error}`, warnings: [], timeSplit: null }; note(lane, 0, `${lane}: ${error}`); continue; }
    const split = laneTimeSplit(rows);
    const warnings = skipped ? [`${skipped} rows skipped (not an object)`] : [];
    lanes[lane] = { value: { rows: rows.length }, error: null, warnings, timeSplit: split };
    note(lane, skipped + split.byRule['U-e'], null, { skipped, rejected: split.byRule['U-e'] });
  }
  return { lanes };
}

/**
 * U5: `{lanes: {lane: [{date, ...kpis}]}, warnings}`. No file yet is the normal first-day state: empty lanes, no
 * warning, nothing logged. A skipped line is counted in `warnings`, the same field the stamps lanes use.
 */
export async function readKpiHistory(file) {
  const text = await readIfExists(file);
  if (text === null) return { lanes: {}, warnings: [] };
  const { lanes, skipped } = parseKpiHistory(text);
  return { lanes, warnings: skipped ? [`${skipped} history lines skipped (not JSON, or no date or lane)`] : [] };
}

/** The lanes the view can show: builder pages in builder order, then lanes only the stamps know, in stamps order. */
export function knownLanes(builder, stamps) {
  const out = [];
  for (const n of [...Object.keys(builder?.value?.pages ?? {}), ...Object.keys(stamps?.value?.lanes ?? {})]) {
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** `fleet.projects` of `<root>/.compose/compose.json`: `{projects, error}`, projects null when the key is absent. */
export async function readFleetProjects(root) {
  const text = await readIfExists(join(root, '.compose', 'compose.json'));
  if (text === null) return { projects: null, error: null };
  let cfg;
  try { cfg = JSON.parse(text); } catch { return { projects: null, error: 'compose.json is not JSON' }; }
  const list = cfg?.fleet?.projects;
  return { projects: Array.isArray(list) ? list.filter((n) => typeof n === 'string') : null, error: null };
}

/** A POST body checked against the known lanes: `{projects}` or `{error}` (no duplicates, known names only). */
export function checkFleetProjects(body, known) {
  const list = body?.projects;
  if (!body || typeof body !== 'object' || !Array.isArray(list)) return { error: 'body must be {"projects": [names]}' };
  if (list.length > known.length) return { error: `at most ${known.length} projects` };
  const seen = new Set();
  for (const n of list) {
    if (typeof n !== 'string' || !known.includes(n)) return { error: `unknown project: ${String(n).slice(0, 80)}` };
    if (seen.has(n)) return { error: `duplicate project: ${n}` };
    seen.add(n);
  }
  return { projects: list };
}

/** Returns true when mounted, false when skipped (remote mode). */
export function attachProcessRoutes(app, {
  remote = false,
  env = process.env,
  sources = resolveProcessSources(env),
  now = Date.now,
  warn = console.warn,
  info = console.log,
  ttlMs = TTL_MS,
  hasSourceCheckout = detectSourceCheckout(COMPOSE_HOME),
  projectRoot = getTargetRoot,
} = {}) {
  if (remote) return false;
  const opts = (name) => ({ ttlMs: ttlMs[name], now, warn, info, logPrefix: LOG });
  const last = new Map(); // lane -> last warned state, so a change (not every refresh) is logged once
  const note = (lane, count, error, detail) => {
    const key = error ?? String(count);
    const prev = last.get(lane) ?? '0';
    if (key === prev) return;
    last.set(lane, key);
    if (error) warn(`${LOG} ${error}`);
    else if (count > 0) warn(`${LOG} ${lane}: ${detail.skipped} rows skipped, ${detail.rejected} units with a rejected stamp`);
    else info(`${LOG} ${lane} recovered`);
  };
  const caches = {
    builder: createSourceCache('builder', () => readBuilderOutput(sources.statusDir, { now: now() }), opts('builder')),
    stamps: createSourceCache('stamps', () => readStamps(sources, note), opts('stamps')),
    history: createSourceCache('history', () => readKpiHistory(sources.historyFile), opts('history')),
  };
  app.get(PROCESS_ROUTE, async (_req, res) => {
    try {
      const [builder, stamps, history] = await Promise.all([caches.builder.get(), caches.stamps.get(), caches.history.get()]);
      const fleet = { known: knownLanes(builder, stamps), ...(await readFleetProjects(projectRoot())) };
      res.set('cache-control', 'no-store');
      res.json({ generated: new Date(now()).toISOString(), sources: { builder, stamps, history }, fleet });
    } catch (error) {
      res.status(500).json({ error: String(error?.message ?? error) });
    }
  });
  // U3: the loopback link for the Publish control. Takes no input (query, body and Host are ignored), reads only env
  // and the checkout check, writes nothing, and carries no Process data. Mounted only here, so not in remote mode.
  app.get(PUBLISH_ROUTE, (_req, res) => {
    res.set('cache-control', 'no-store');
    try {
      res.json(buildPointer({ env, hasSourceCheckout, now }));
    } catch (error) {
      if (!(error instanceof PublishRefused)) return res.status(500).json({ error: 'publish failed' });
      warn(`${LOG} publish refused: ${error.message}`);
      res.status(409).json({ error: error.message });
    }
  });
  // COMP-COCKPIT-FLEET-PROJECTS-1: the left bar's PROJECTS list. The body names lanes only; the file is fixed.
  app.post(FLEET_PROJECTS_ROUTE, express.json({ limit: '16kb' }), async (req, res) => {
    res.set('cache-control', 'no-store');
    if (!localCaller(req)) return res.status(403).json({ error: 'loopback callers only' });
    try {
      const [builder, stamps] = await Promise.all([caches.builder.get(), caches.stamps.get()]);
      const checked = checkFleetProjects(req.body, knownLanes(builder, stamps));
      if (checked.error) return res.status(400).json({ error: checked.error });
      const root = projectRoot();
      const text = await readIfExists(join(root, '.compose', 'compose.json'));
      if (text === null) {
        try { if (!(await stat(join(root, '.compose'))).isDirectory()) throw new Error(); } catch { return res.status(409).json({ error: 'the project has no .compose directory' }); }
      } else {
        try { JSON.parse(text); } catch { return res.status(409).json({ error: 'compose.json is not JSON: not overwriting it' }); }
      }
      writeComposeJson(root, { fleet: { projects: checked.projects } });
      info(`${LOG} fleet.projects saved (${checked.projects.length})`);
      res.json({ projects: checked.projects });
    } catch (error) {
      warn(`${LOG} fleet.projects not saved: ${String(error?.message ?? error)}`);
      res.status(500).json({ error: 'not saved' });
    }
  });
  return true;
}

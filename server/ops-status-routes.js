/**
 * ops-status-routes.js — read-only mount of the Ops status pages (COMPOSE-OPS-TAB-1).
 *
 * Routes (only when the directory exists):
 *   GET /ops-status/<name>/status.html   static, GET/HEAD only, no directory listing
 *   GET /api/ops-status/index            { pages: [name, ...] } for subdirs holding status.html
 *   GET /api/ops-status/:name/data       { name, asOf, ageS, progress, notices, eta } from the builder's data.json
 *                                        (COMP-COCKPIT-INIT-DATA-1; the native Ops view reads this, not the iframe)
 *
 * The directory comes from COMPOSE_OPS_STATUS_DIR (default: the SmartMemory ops
 * checkout). Published npm installs have no such directory, so nothing is
 * mounted and the cockpit hides the Ops tab. Skipped in remote mode: the pages
 * are internal and /ops-status is outside the /api auth gate.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import express from 'express';
import { createSourceCache, runReader } from './fleet-routes.js';
import { freshness } from '../lib/process-metrics.js';
import { buildUnitIndex } from '../lib/unit-index.js';
import { initProgress, noticeCount } from '../lib/init-progress.js';

export const DEFAULT_OPS_STATUS_DIR = join(homedir(), 'reg/my/SmartMemory/smart-memory-ops/status/out');

export const NAME_RE = /^[A-Za-z0-9._-]+$/;

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

const ETA_TTL_MS = 15 * 60_000; // estimate.py reads the whole stamp history; the answer moves by hours, not minutes
const ETA_TIMEOUT_MS = 30_000;
const UNIT_INDEX_TTL_MS = 120_000; // the stamps TTL of /api/units/index
// `estimate.py plan --like` choices, from `estimate.py plan --help` (2026-10-31). A page outside it has no profile.
export const ESTIMATE_PROFILES = ['2.0', 'forge', 'hub', 'trader', 'maya', 'main', 'wiki', 'setup', 'web', 'bench', 'cadence', 'codegen', 'mcp', 'ops', 'sm20'];
const ESTIMATE_RE = /^ESTIMATE\s+\S+\s+P50\s+(\S+)\s+P80\s+(\S+).*?\bas_of\s+(\S+)/;

/**
 * Turns estimate.py's stdout into `{p50, p80, asOf, raw}`, or `{noData: true, raw}` when it says `NO DATA`.
 * `raw` is the one line that decided it. Throws when neither line is there, so the cache records the failure.
 */
export function parseEstimate(stdout) {
  const lines = String(stdout).split('\n').map((l) => l.trim());
  const est = lines.find((l) => ESTIMATE_RE.test(l));
  if (est) { const m = ESTIMATE_RE.exec(est); return { p50: m[1], p80: m[2], asOf: m[3], raw: est }; }
  const nod = lines.find((l) => /NO DATA/.test(l));
  if (nod) return { noData: true, raw: nod };
  throw new Error('estimate.py printed no ESTIMATE or NO DATA line');
}

/** The remaining (not landed) nodes as estimate.py's `[{id, deps}]`; a dep on a landed node is dropped. */
export function remainingForEstimate(nodes) {
  const left = nodes.filter((n) => !n.landedAt);
  const ids = new Set(left.map((n) => n.id));
  return left.map((n) => ({ id: n.id, deps: n.deps.filter((d) => ids.has(d)) }));
}

/** One `estimate.py plan` run per page name, cached `ttlMs`; the tmp input file is removed on every path. */
export function createEtaReader({ python = 'python3', script, env = process.env, run = runReader, now = Date.now, ttlMs = ETA_TTL_MS, warn = console.warn } = {}) {
  const slots = new Map(); // name -> {cache, input}
  return async function eta(name, remaining) {
    if (!ESTIMATE_PROFILES.includes(name)) return { noData: true, raw: `no estimate profile for ${name}` };
    if (!remaining.length) return { noData: true, raw: 'nothing left to estimate' };
    if (!slots.has(name)) {
      const slot = { input: remaining, cache: null };
      slot.cache = createSourceCache(`estimate ${name}`, async () => {
        const dirPath = await mkdtemp(join(tmpdir(), 'compose-eta-'));
        try {
          const file = join(dirPath, 'units.json');
          await writeFile(file, JSON.stringify(slot.input));
          const { stdout } = await run([python, script, 'plan', file, '--like', name, '--name', name], { timeoutMs: ETA_TIMEOUT_MS, env });
          return parseEstimate(stdout);
        } finally {
          await rm(dirPath, { recursive: true, force: true });
        }
      }, { ttlMs, now, warn, logPrefix: '[ops-status]' });
      slots.set(name, slot);
    }
    const slot = slots.get(name);
    slot.input = remaining; // read by the load only when the cache is cold or stale
    const entry = await slot.cache.get();
    return entry.value ?? { error: entry.error ?? 'estimate unavailable' };
  };
}

/** Returns true when mounted, false when skipped (dir absent). `deps` are for tests: eta, loadUnitIndex, now. */
export function attachOpsStatusRoutes(app, { dir = resolveOpsStatusDir(), remote = false, env = process.env, deps = {} } = {}) {
  if (!dir || remote || !existsSync(dir)) return false;
  const now = deps.now ?? Date.now;
  const eta = deps.eta ?? createEtaReader({
    python: env.COMPOSE_FLEET_PYTHON || 'python3',
    script: env.COMPOSE_ESTIMATE_PY || join(homedir(), '.claude', 'scripts', 'estimate.py'),
    env, now,
  });
  // The unit index is built here from the same paths /api/units/index uses; loaded lazily because process-routes imports this file.
  const unitIndexCache = createSourceCache('init-data unit index', deps.loadUnitIndex ?? (async () => {
    const { resolveProcessSources } = await import('./process-routes.js');
    const sources = resolveProcessSources(env);
    return buildUnitIndex({
      queuesDir: sources.queuesDir, extra: sources.extra, now: now(),
      statusRoot: env.COMPOSE_UNIT_INDEX_STATUS_ROOT || dirname(sources.statusDir),
      unitsDir: env.COMPOSE_UNIT_INDEX_UNITS_DIR || join(dirname(sources.queuesDir), 'units'),
    });
  }), { ttlMs: UNIT_INDEX_TTL_MS, now, logPrefix: '[ops-status]' });

  app.get('/api/ops-status/index', (_req, res) => res.json({ pages: listOpsPages(dir) }));
  app.get('/api/ops-status/:name/data', async (req, res) => {
    const { name } = req.params;
    if (!NAME_RE.test(name) || name.startsWith('.')) return res.status(400).json({ error: 'bad page name' });
    let doc;
    let mtimeMs;
    try {
      const file = join(dir, name, 'data.json');
      mtimeMs = (await stat(file)).mtimeMs;
      doc = JSON.parse(await readFile(file, 'utf8'));
    } catch (e) {
      if (e?.code === 'ENOENT') return res.status(404).json({ error: 'no data.json yet; the builder writes it on its next tick' });
      return res.status(500).json({ error: 'data.json is unreadable' });
    }
    const out = { name, asOf: doc.as_of ?? null, ageS: freshness({ mtimeMs, now: now() }).ageS, notices: noticeCount(doc) };
    const index = await unitIndexCache.get();
    if (index.value) {
      out.progress = initProgress(doc, index.value.units.filter((u) => u.lane === name));
      out.eta = await eta(name, remainingForEstimate(out.progress.nodes));
    } else {
      out.progress = null; // never a count of zero landed: the stamps could not be read
      out.progressError = `unit index unavailable: ${index.error ?? 'unknown'}`;
      out.eta = null;
    }
    res.set('cache-control', 'no-store');
    res.json(out);
  });
  app.use('/ops-status', (req, res, next) => (
    req.method === 'GET' || req.method === 'HEAD' ? next() : res.status(405).end()
  ), express.static(dir, { index: false, redirect: false, dotfiles: 'ignore', fallthrough: false }));
  // fallthrough:false forwards misses to the error handler; answer 404 here.
  app.use('/ops-status', (err, _req, res, _next) => res.status(err.status === 403 ? 404 : (err.status || 404)).end());
  return true;
}

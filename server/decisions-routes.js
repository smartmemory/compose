/**
 * decisions-routes.js — `GET /api/decisions` (COMP-COCKPIT-DECISIONS-1): the Decisions pane in Projects › Review.
 *
 *   ?project=<name|fleet|all>&decider=owner,absent,lane,queue&status=standing|all&q=&cursor=&size=50
 *
 * Reads the ops ledger and the owner queue directly (no Python, no wiki), parsed by `lib/decisions-ledger.js` and paged by
 * `lib/decisions-feed.js`. Projects come from COMP-COCKPIT-PROJECT-MODEL-1 (`readProjects` laneIndex + store prefixes).
 * Each row's commit comes from a cached `git blame` of the ledger (`<dataDir>/ledger-blame.json`) built in the background:
 * while it is cold, rows say "commit pending". Read-only. Loopback only: absent in remote mode, like `/api/ribbon`. A
 * failing source goes to `sourceErrors`; the route never answers 500 for one source.
 *
 * The ribbon's `decide` marks read the same ledger reader (`ledgerDecisions`), so both views agree on what a decision is.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import { createSourceCache } from './fleet-routes.js';
import { resolveProcessSources } from './process-routes.js';
import { getDataDir, getTargetRoot } from './project-root.js';
import { readComposeConfig, readProjects } from './project-model.js';
import { buildDecisions, createLedgerBlame, parseLedger, queueDecisions } from '../lib/decisions-ledger.js';
import { buildPrefixMap, makeProjectResolver, pageDecisions, parseFilters } from '../lib/decisions-feed.js';

export const DECISIONS_ROUTE = '/api/decisions';
const SOURCE_TTL_MS = 120_000;
const LOG = '[decisions]';

/** The ledger path: env `COMPOSE_DECISIONS_LEDGER`, else `<ops>/coordination/ledger.md`. */
export function ledgerPath(env, opsRoot) {
  return env.COMPOSE_DECISIONS_LEDGER || join(opsRoot, 'coordination', 'ledger.md');
}

async function readJsonl(file) {
  const out = [];
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn last line */ }
  }
  return out;
}

const shared = new Map(); // ledger file -> source cache of parsed entries
/**
 * One parsed-ledger cache per file, shared by `/api/decisions` and `/api/ribbon` (120 s). `get()` answers `{value, error}`
 * with `value` the parsed entries. `rows(entries, blame)` memoises the classified rows per entries object and blame head.
 */
export function ledgerDecisions(file, { now = Date.now, warn = console.warn, info = console.log } = {}) {
  if (!shared.has(file)) {
    const cache = createSourceCache('decisions ledger', async () => parseLedger(await readFile(file, 'utf8')), { ttlMs: SOURCE_TTL_MS, now, warn, info, logPrefix: LOG });
    const memo = new WeakMap(); // entries -> {key, rows}
    shared.set(file, {
      get: () => cache.get(),
      rows(entries, blame = null) {
        const key = blame ? `${blame.head}:${blame.nlines}` : '-';
        const hit = memo.get(entries);
        if (hit?.key === key) return hit.rows;
        const rows = buildDecisions(entries, { blame });
        memo.set(entries, { key, rows });
        return rows;
      },
    });
  }
  return shared.get(file);
}

/** Feature codes of a store file, `[]` when unreadable (logged). */
async function storeCodes(dir, warn) {
  const file = join(dir, '.compose', 'data', 'vision-state.json');
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    return (Array.isArray(state?.items) ? state.items : []).map((i) => i?.lifecycle?.featureCode ?? i?.featureCode).filter((c) => typeof c === 'string' && c);
  } catch (e) {
    warn(`${LOG} store ${file} unreadable, its prefixes do not attribute rows: ${e.message}`);
    return [];
  }
}

/** The project model -> `{projects, laneIndex, prefixMap}` for `makeProjectResolver`. */
export async function readProjectScope(hostRoot, warn = console.warn) {
  const model = readProjects(hostRoot, []);
  const stores = [];
  const extra = [];
  for (const p of model.projects) {
    const dirs = [...(p.hasStore ? [p.root] : []), ...p.modules.filter((m) => m.hasStore && m.realpath && !m.error).map((m) => m.realpath)];
    for (const dir of dirs) {
      stores.push({ project: p.name, codes: await storeCodes(dir, warn) });
      const ext = readComposeConfig(dir).config?.externalPrefixes;
      if (Array.isArray(ext)) for (const prefix of ext) if (typeof prefix === 'string') extra.push({ prefix, project: p.name });
    }
  }
  return {
    configured: model.configured,
    projects: model.projects.map((p) => ({ name: p.name, label: p.label, root: p.root, modules: p.modules.map((m) => m.realpath).filter(Boolean) })),
    laneIndex: model.laneIndex,
    prefixMap: buildPrefixMap(stores, extra),
  };
}

/** Returns true when mounted, false when skipped (remote mode). `deps` are for tests. */
export function attachDecisionsRoutes(app, { remote = false, env = process.env, deps = {} } = {}) {
  if (remote) return false;
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? console.warn;
  const info = deps.info ?? console.log;
  const sources = deps.sources ?? resolveProcessSources(env);
  const opsRoot = deps.opsRoot ?? dirname(sources.queuesDir);
  const ledgerFile = ledgerPath(env, opsRoot);
  const ownerQueueFile = env.COMPOSE_RIBBON_OWNER_QUEUE || join(opsRoot, 'coordination', 'owner-queue.jsonl');
  const hostRoot = ((root) => () => root)(deps.hostRoot ?? getTargetRoot());
  const cacheOpts = { ttlMs: SOURCE_TTL_MS, now, warn, info, logPrefix: LOG };

  const ledger = deps.ledger ?? ledgerDecisions(ledgerFile, { now, warn, info });
  const queue = createSourceCache('decisions owner queue', deps.loadOwnerQueue ?? (() => readJsonl(ownerQueueFile)), cacheOpts);
  const scope = createSourceCache('decisions projects', deps.loadScope ?? (() => readProjectScope(hostRoot(), warn)), cacheOpts);
  // The blame cache needs the ledger inside the ops git checkout; a ledger elsewhere has no commit links (logged once).
  const rel = relative(opsRoot, ledgerFile);
  const inRepo = rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`);
  if (!inRepo && !deps.blame) warn(`${LOG} ${ledgerFile} is outside ${opsRoot}: rows have no commit links`);
  const blame = deps.blame ?? (inRepo ? createLedgerBlame({ repo: opsRoot, relPath: rel, cacheFile: join((deps.dataDir ?? getDataDir)(), 'ledger-blame.json'), now, warn, info }) : null);

  // No boot warm: the first request starts the blame build in the background (a cold full build is ~90 s, and a git
  // child started at boot would outlive a test server). Until it finishes, rows say "commit pending".
  app.get(DECISIONS_ROUTE, async (req, res) => {
    res.set('cache-control', 'no-store');
    const filters = parseFilters(req.query);
    if (filters.error) return res.status(400).json({ error: filters.error });
    try {
      blame?.refresh();
      const [l, q, s] = await Promise.all([ledger.get(), queue.get(), scope.get()]);
      const sourceErrors = {};
      if (l.error) sourceErrors.ledger = l.error;
      if (q.error) sourceErrors.ownerQueue = q.error;
      if (s.error) sourceErrors.projects = s.error;
      const b = blame ? blame.snapshot() : null;
      if (b?.error) sourceErrors.blame = b.error;
      const warmBlame = b && b.head ? b : null;
      const rows = [...(l.value ? ledger.rows(l.value, warmBlame) : []), ...queueDecisions(q.value ?? [])];
      const sc = s.value ?? { projects: [], laneIndex: {}, prefixMap: new Map() };
      const projectsOf = makeProjectResolver({ laneIndex: sc.laneIndex, prefixMap: sc.prefixMap });
      const page = pageDecisions(rows, filters, projectsOf);
      res.json({
        asOf: new Date(now()).toISOString(),
        filters: { project: filters.project, decider: filters.decider, status: filters.status, q: filters.q },
        total: page.total, nextCursor: page.nextCursor, counts: page.counts,
        rows: page.rows.map(({ ts: _ts, ...r }) => ({ ...r, commitPending: r.source === 'ledger' && !r.commit })),
        projects: sc.projects.map((p) => ({ name: p.name, label: p.label, root: p.root, modules: p.modules })),
        blame: b ? { state: b.state, head: b.head, nlines: b.nlines, lastBuild: b.lastBuild } : { state: 'off' },
        sourceErrors,
      });
    } catch (error) {
      warn(`${LOG} failed: ${String(error?.message ?? error)}`);
      res.status(500).json({ error: String(error?.message ?? error) });
    }
  });
  return true;
}

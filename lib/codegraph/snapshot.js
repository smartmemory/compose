// lib/codegraph/snapshot.js — STRAT-CODEGRAPH-1 (shape C: snapshot file)
//
// SmartMemory parses each repo into a bundle JSON (`smartmemory code bundle`); this module
// spawns it, normalizes the bundle into Compose's internal model, and caches the model under
// .compose/codegraph/<repo>/<key>.json.
//
// ONE envelope reader: `normalizeBundle` is the only code in Compose that reads
// a SmartMemory bundle, and `bundleArgv` is the only code that knows the producer
// argv (CODE-BUNDLE-CLI-1 design.md, Interface). A contract change is a one-file edit here.
//
// Cache validity is cache-validity.js: HEAD, a working-tree state hash, and the resolution
// dependencies the producer recorded. Compose does not copy core's read rules.
//
// The cache holds the normalized model, not the raw bundle: forge's raw bundles
// are 77 MB (stratum/ts) and 248 MB (compose) (measured 2026-10-08, blueprint.md).

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync,
  statSync, writeFileSync, writeSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

import { acquireDirLock } from '../dir-lock.js';
import { readCodegraphConfig, requireCodegraph, warnOnce } from './availability.js';
import { RACY_WINDOW_MS, checkResolutionDependencies, worktreeState } from './cache-validity.js';

// 3: CLI-only producer; edge_state read from relation properties; snapshots carry cache_key (switch-over).
export const MODEL_VERSION = 3;
export const EDGE_STATES = new Set(['resolved', 'ambiguous', 'unresolved', 'unsupported']);
export const SUPPORTED_SCHEMA_VERSIONS = new Set(['1']);
const DEFAULT_TIMEOUT_MS = 300000;
const KEEP_SNAPSHOTS = 3;
const STDERR_TAIL_BYTES = 8192;
const MODEL_RELATION_TYPES = new Set(['CALLS', 'REFERENCES', 'TESTS', 'IMPORTS']);
// Compose's own state (it holds this very cache). Always excluded from the producer, so cache-validity
// can leave it out of the working-tree hash.
const OWN_STATE_DIR = '.compose';
const STALE_TMP = /^bundle\.\d+\.[0-9a-f]+\.tmp\.json/;

export class BundleFormatError extends Error {
  constructor(message) {
    super(`codegraph bundle: ${message}`);
    this.name = 'BundleFormatError';
  }
}

export function codegraphDir(projectRoot) {
  return join(projectRoot, '.compose', 'codegraph');
}

function safeRepoName(name) {
  return String(name).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '_') || 'repo';
}

/**
 * Repos to index. `.compose/compose.json` → `codegraph.repos: [{ name, root, prefix, exclude }]`;
 * default: the project root as one repo. `prefix` maps a repo-relative file_path to a
 * project-relative display path (e.g. `../stratum/ts/`).
 */
export function resolveRepos(projectRoot) {
  const config = readCodegraphConfig(projectRoot);
  const declared = Array.isArray(config.repos) && config.repos.length > 0
    ? config.repos
    : [{ name: basename(resolve(projectRoot)), root: '.' }];
  return declared.map((entry) => {
    const root = resolve(projectRoot, entry.root ?? '.');
    const rel = relative(resolve(projectRoot), root).split('\\').join('/');
    return {
      name: safeRepoName(entry.name ?? basename(root)),
      root,
      prefix: typeof entry.prefix === 'string' ? entry.prefix : (rel ? `${rel}/` : ''),
      exclude: Array.isArray(entry.exclude) ? entry.exclude.filter((d) => typeof d === 'string' && d) : [],
    };
  });
}
/**
 * The producer argv after the command, per CODE-BUNDLE-CLI-1 design.md (Interface):
 * `<path> --repo <name> [--language …] [--exclude <dir> …] --out <file> [--allow-partial]`, plus
 * `--fields minimal` (accepted by SM 2026-10-08). `.compose` is always excluded.
 */
export function bundleArgv({ root, repo, out, exclude = [] }) {
  const dirs = [...new Set([...exclude, OWN_STATE_DIR])];
  return [
    root, '--repo', repo, ...dirs.flatMap((dir) => ['--exclude', dir]), '--out', out, '--allow-partial',
    '--fields', 'minimal',
  ];
}

/** argv for `smartmemory code bundle`. */
export function cliBundleArgs(args) {
  return ['code', 'bundle', ...bundleArgv(args)];
}

function evidenceIsUntraversable(ev, ids) {
  const props = ev?.properties ?? {};
  return props.unresolved === true || !ids.has(ev?.target_id);
}

/**
 * `properties.edge_state` (bundle contract: computed once in core on every relation or evidence entry that
 * carries `resolution` or `candidates`; DEFINES, IMPORTS and INHERITS carry none). Required where the
 * contract requires it, null elsewhere.
 */
function edgeStateOf(row, where) {
  const props = row?.properties ?? {};
  const state = props.edge_state;
  if (state === undefined && !('resolution' in props) && !('candidates' in props)) return null;
  if (!EDGE_STATES.has(state)) {
    throw new BundleFormatError(`${where} edge_state must be one of ${[...EDGE_STATES].join('|')}, got ${JSON.stringify(state)}`);
  }
  return state;
}

/**
 * THE envelope reader. Maps a SmartMemory snapshot bundle (schema_version "1": envelope
 * + hosted bundle, full or `--fields minimal`) to the internal model. Throws BundleFormatError.
 * Required by the snapshot amendment (SM 2026-10-08): `properties.edge_state` on every relation that
 * carries a resolution (edgeStateOf), `files_skipped`, `skipped_paths`, `budget_exhausted`. edge_state is the producer's;
 * Compose never derives it.
 */
export function normalizeBundle(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BundleFormatError('not a JSON object');
  const version = raw.schema_version == null ? null : String(raw.schema_version);
  if (!SUPPORTED_SCHEMA_VERSIONS.has(version)) {
    throw new BundleFormatError(`unsupported schema_version ${JSON.stringify(raw.schema_version)} (supported: ${[...SUPPORTED_SCHEMA_VERSIONS].join(', ')})`);
  }
  if (typeof raw.repo !== 'string' || !raw.repo.trim()) throw new BundleFormatError('repo must be a non-empty string');
  if (!Array.isArray(raw.entities)) throw new BundleFormatError('entities must be an array');
  if (!Array.isArray(raw.relations)) throw new BundleFormatError('relations must be an array');
  if (typeof raw.complete !== 'boolean') throw new BundleFormatError('complete must be a boolean');
  if (!Number.isInteger(raw.files_skipped) || raw.files_skipped < 0) {
    throw new BundleFormatError('files_skipped must be a non-negative integer');
  }
  if (!Array.isArray(raw.skipped_paths)
    || !raw.skipped_paths.every((s) => s && typeof s.path === 'string' && s.path && typeof s.reason === 'string')) {
    throw new BundleFormatError('skipped_paths must be an array of {path, reason}');
  }
  if (typeof raw.budget_exhausted !== 'boolean') throw new BundleFormatError('budget_exhausted must be a boolean');
  raw.relations.forEach((r, i) => edgeStateOf(r, `relation ${i}`));

  const ids = new Set();
  for (const e of raw.entities) {
    if (!e || typeof e.item_id !== 'string' || !e.item_id) throw new BundleFormatError('every entity needs an item_id');
    if (typeof e.name !== 'string' || typeof e.file_path !== 'string') {
      throw new BundleFormatError(`entity ${e.item_id} needs name and file_path`);
    }
    ids.add(e.item_id);
  }
  const entities = raw.entities.map((e) => {
    const line = Number.isInteger(e.line_number) ? e.line_number : 0;
    return {
      id: e.item_id,
      name: e.name,
      qualifiedName: e.qualified_name || e.name,
      type: e.entity_type ?? null,
      file: e.file_path,
      line,
      endLine: Number.isInteger(e.end_line_number) && e.end_line_number >= line ? e.end_line_number : line,
      exported: e.is_exported === true,
      entry: e.is_entry_point === true,
      owner: e.lexical_owner || null,
      doc: typeof e.docstring === 'string' ? e.docstring.slice(0, 300) : '',
      parse: e.parse_diagnostic?.status ?? 'clean', // --fields minimal drops a clean diagnostic
      // Unresolved callee spellings survive only here (prepare_bundle drops relations to absent targets).
      unresolved: (Array.isArray(e.call_evidence) ? e.call_evidence : [])
        .filter((ev) => evidenceIsUntraversable(ev, ids))
        .map((ev) => ({
          callee: ev.properties?.callee ?? null,
          line: ev.properties?.line ?? null,
          edgeState: EDGE_STATES.has(ev.properties?.edge_state) ? ev.properties.edge_state : null,
          resolution: ev.properties?.resolution ?? null,
          moduleResolution: ev.properties?.module_resolution ?? null,
        }))
        .filter((ev) => typeof ev.callee === 'string' && ev.callee),
      untracedTests: (Array.isArray(e.test_evidence) ? e.test_evidence : [])
        .filter((ev) => evidenceIsUntraversable(ev, ids)).length,
    };
  });
  const relations = [];
  for (const r of raw.relations) {
    if (!r || !MODEL_RELATION_TYPES.has(r.relation_type)) continue;
    if (!ids.has(r.source_id) || !ids.has(r.target_id)) continue;
    const p = r.properties ?? {};
    relations.push({
      s: r.source_id,
      t: r.target_id,
      type: r.relation_type,
      edgeState: edgeStateOf(r, 'relation'),
      resolution: p.resolution ?? null,
      confidence: typeof p.confidence === 'number' ? p.confidence : null,
      unresolved: p.unresolved === true,
      callee: p.callee ?? null,
      line: Number.isInteger(p.line) ? p.line : null,
      moduleResolution: p.module_resolution ?? null,
    });
  }
  const summary = raw.parse_summary ?? {};
  return {
    model_version: MODEL_VERSION,
    schema_version: version,
    repo: raw.repo,
    languages: Array.isArray(raw.languages) ? raw.languages : [],
    generator: raw.generator ?? null,
    source: raw.source ?? null,
    complete: raw.complete,
    failed_paths: Array.isArray(raw.failed_paths) ? raw.failed_paths : [],
    files_skipped: raw.files_skipped,
    skipped_paths: raw.skipped_paths.map((s) => ({ path: s.path, reason: s.reason })),
    budget_exhausted: raw.budget_exhausted,
    commit_hash: raw.commit_hash ?? null,
    parse_summary: {
      files_clean: summary.files_clean ?? null,
      files_partial: summary.files_partial ?? null,
      files_failed: summary.files_failed ?? null,
      call_sites: summary.call_sites ?? null,
      resolved_call_edges: summary.resolved_call_edges ?? null,
    },
    entities,
    relations,
  };
}

function readCachedSnapshot(path) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return data?.model_version === MODEL_VERSION ? data : null;
  } catch {
    return null;
  }
}

function writeAtomic(path, content) {
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function pruneSnapshots(dir, keepPath) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f)).map((f) => join(dir, f));
  } catch {
    return;
  }
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const path of files.slice(KEEP_SNAPSHOTS)) {
    if (path !== keepPath) rmSync(path, { force: true });
  }
}

function recordTiming(dir, row) {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'timings.jsonl'), `${JSON.stringify(row)}\n`);
  } catch { /* timing is best effort */ }
}
// A prebuild (build start) may still be producing when the build process exits; do not orphan it.
const liveProducers = new Set();
process.once('exit', () => {
  for (const child of liveProducers) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
});

const WARNING_LINE = /^WARNING\b/;
const ERROR_LINE = /^(ERROR|CRITICAL|Traceback|Error)\b|^\w+Error: /;
const TOTALS_LINE = /^\[code:bundle\] /;
const MAX_ERROR_LINES = 10;

/**
 * Spawn `smartmemory code bundle`. Its stderr (about 22K WARNING lines on forge's stratum/ts) goes to
 * `logPath`, and one summary line is printed instead: the WARNING count, the producer's totals, the
 * log path, and any ERROR lines. Resolves on exit 0, rejects with the ERROR lines or the stderr tail.
 */
export function spawnProducer({ availability, repo, out, timeoutMs, env, logPath }) {
  const args = cliBundleArgs({ root: repo.root, repo: repo.name, out, exclude: repo.exclude });
  return new Promise((resolvePromise, reject) => {
    const fd = logPath ? openSync(logPath, 'w') : null;
    const closeLog = () => { if (fd !== null) try { closeSync(fd); } catch { /* closed */ } };
    const child = spawn(availability.command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    liveProducers.add(child);
    child.on('close', () => liveProducers.delete(child));
    let tail = '';
    let partial = '';
    let warnings = 0;
    let totals = '';
    const errors = [];
    const scan = (line) => {
      if (WARNING_LINE.test(line)) warnings++;
      else if (TOTALS_LINE.test(line)) totals = line.replace(/ out=.*$/, '');
      else if (ERROR_LINE.test(line) && errors.length < MAX_ERROR_LINES) errors.push(line);
    };
    child.stdout.on('data', (chunk) => { if (fd !== null) writeSync(fd, chunk); });
    child.stderr.on('data', (chunk) => {
      if (fd !== null) writeSync(fd, chunk);
      tail = (tail + chunk).slice(-STDERR_TAIL_BYTES);
      const lines = (partial + chunk).split('\n');
      partial = lines.pop();
      lines.forEach(scan);
    });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); closeLog(); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (partial) scan(partial);
      closeLog();
      const where = logPath ? ` (log: ${logPath})` : '';
      console.warn(`[codegraph] ${repo.name}: producer ${killed ? 'timed out' : `exit ${code}`}, ${warnings} WARNING line(s)`
        + `${totals ? `, ${totals}` : ''}${where}${errors.length ? `; ERROR: ${errors.join(' | ')}` : ''}`);
      if (killed) reject(new Error(`bundle producer timed out after ${timeoutMs}ms`));
      else if (code !== 0) {
        const detail = errors.length ? errors.slice(-3).join(' | ') : tail.trim().split('\n').slice(-3).join(' | ');
        reject(new Error(`bundle producer exited ${code}: ${detail}`));
      } else resolvePromise({ warnings, errors });
    });
  });
}

const inflight = new Map();

/**
 * Snapshot for one repo: cache hit, or produce → normalize → cache. Single flight per
 * repo dir (in-process map + cross-process dir lock); a caller that joins a run already in
 * flight (e.g. the build-start prebuild) gets its result with `joined: true`. Throws on
 * producer/format errors; the warn-only callers (loadSnapshots) turn that into a warning.
 *
 * @param {object} args
 * @param {string} args.projectRoot
 * @param {{name, root, prefix, exclude}} args.repo
 * @param {object} args.availability  result of detectCodegraph (available === true)
 * @param {number} [args.timeoutMs]
 * @param {Function} [args.producer]  test seam: ({ availability, repo, out, timeoutMs, env, logPath }) => Promise
 * @param {object} [args.env]
 */
export function ensureSnapshot({ projectRoot, repo, availability, timeoutMs, producer = spawnProducer, env = process.env }) {
  const dir = join(codegraphDir(projectRoot), repo.name);
  const salt = cacheSalt(availability, repo, env);
  const flight = `${dir}\0${salt}`;
  if (inflight.has(flight)) return inflight.get(flight).then((result) => ({ ...result, joined: true }));
  const promise = produceSnapshot({ dir, salt, repo, availability, timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS, producer, env });
  inflight.set(flight, promise);
  const clear = () => { if (inflight.get(flight) === promise) inflight.delete(flight); };
  promise.then(clear, clear);
  return promise;
}

/** Bundle temp files a dead producer stranded (the lock is held, so none is in use by a live run). */
function sweepStaleBundles(dir, keep) {
  for (const name of readdirSync(dir)) {
    if (STALE_TMP.test(name) && !name.startsWith(keep)) rmSync(join(dir, name), { force: true });
  }
}

// SmartMemory's code policy knobs (entity/byte budgets, generated-file patterns) change what the
// producer emits. The parse-cache location does not.
const POLICY_ENV = /^SMARTMEMORY_CODE_/;
const NOT_POLICY_ENV = new Set(['SMARTMEMORY_CODE_CHECKPOINT_DIR']);

/**
 * Anything that changes the producer's output besides the tree: model, CLI, version, repo name, the
 * indexed root, excludes, and SmartMemory's code policy env (hashed: the salt is stored in the snapshot).
 * JSON keeps list boundaries (`["a,b"]` is not `["a","b"]`).
 */
function cacheSalt(availability, repo, env) {
  let root = resolve(repo.root);
  try {
    root = realpathSync(root);
  } catch {
    // a missing root fails later, in worktreeState
  }
  const policy = Object.keys(env ?? {}).filter((k) => POLICY_ENV.test(k) && !NOT_POLICY_ENV.has(k)).sort().map((k) => [k, env[k]]);
  return JSON.stringify([
    `v${MODEL_VERSION}`, availability.command, availability.version, repo.name, root, repo.exclude,
    createHash('sha256').update(JSON.stringify(policy)).digest('hex'),
  ]);
}

/** File key of a snapshot: the cheap half of its validity (salt, HEAD, working-tree hash). */
function cacheFileKey(salt, state) {
  return createHash('sha256').update(`${salt}\0${state.git}\0${state.head}\0${state.hash}`).digest('hex');
}

/**
 * The cached snapshot for this tree state, if it is still valid. (a) and (b) are in the file key and
 * re-checked against the stored cache_key; (c) re-checks every resolution dependency.
 *
 * @returns {{snapshot: object|null, invalid: string|null, depsMs: number}}
 */
function validCached(path, { salt, state, root }) {
  const hit = readCachedSnapshot(path);
  if (!hit) return { snapshot: null, invalid: null, depsMs: 0 };
  const key = hit.cache_key ?? {};
  if (key.salt !== salt || key.git !== state.git || key.head !== state.head || key.worktree !== state.hash) {
    return { snapshot: null, invalid: 'cache key mismatch', depsMs: 0 };
  }
  if (state.git && (hit.source?.head ?? '') !== state.head) {
    return { snapshot: null, invalid: `snapshot HEAD ${hit.source?.head || '(none)'} is not ${state.head}`, depsMs: 0 };
  }
  const started = Date.now();
  const deps = checkResolutionDependencies(hit.source, root);
  const depsMs = Date.now() - started;
  return deps.ok ? { snapshot: hit, invalid: null, depsMs } : { snapshot: null, invalid: deps.reason, depsMs };
}

async function produceSnapshot({ dir, salt, repo, availability, timeoutMs, producer, env }) {
  const started = Date.now();
  let state = await worktreeState(repo.root);
  let keyMs = Date.now() - started;
  let fileKey = state.error ? null : cacheFileKey(salt, state);
  let cachePath = fileKey ? join(dir, `${fileKey}.json`) : null;
  const cachedResult = (found, depsMs) => {
    const timing = { cached: true, keyMs, depsMs, totalMs: Date.now() - started };
    recordTiming(dir, { ts: new Date().toISOString(), repo: repo.name, fingerprint: fileKey, ...timing });
    return { repo, snapshot: found, cached: true, path: cachePath, timing };
  };
  if (cachePath) {
    const found = validCached(cachePath, { salt, state, root: repo.root });
    if (found.snapshot) return cachedResult(found.snapshot, found.depsMs);
  }
  mkdirSync(dir, { recursive: true });
  const release = await acquireDirLock(join(dir, '.lock'), { timeoutMs: timeoutMs + 60000 });
  const tmp = join(dir, `bundle.${process.pid}.${randomBytes(4).toString('hex')}.tmp.json`);
  try {
    // The tree may have moved while this caller waited for the lock: read it again.
    const relocked = Date.now();
    state = await worktreeState(repo.root);
    keyMs += Date.now() - relocked;
    fileKey = state.error ? null : cacheFileKey(salt, state);
    cachePath = fileKey ? join(dir, `${fileKey}.json`) : null;
    if (cachePath) {
      const raced = validCached(cachePath, { salt, state, root: repo.root });
      if (raced.snapshot) return cachedResult(raced.snapshot, raced.depsMs);
    }
    sweepStaleBundles(dir, basename(tmp));
    const bundleStarted = Date.now();
    await producer({
      availability,
      repo,
      out: tmp,
      timeoutMs,
      env: { ...env, SMARTMEMORY_CODE_CHECKPOINT_DIR: env.SMARTMEMORY_CODE_CHECKPOINT_DIR || join(dir, 'parse-cache') },
      logPath: join(dir, 'producer.log'),
    });
    const bundleMs = Date.now() - bundleStarted;
    const normalizeStarted = Date.now();
    const snapshot = {
      fingerprint: fileKey,
      created_at: new Date().toISOString(),
      producer: availability.mode,
      cache_key: state.error ? null : { salt, git: state.git, head: state.head, worktree: state.hash },
      ...normalizeBundle(JSON.parse(readFileSync(tmp, 'utf8'))),
    };
    const normalizeMs = Date.now() - normalizeStarted;
    // Cache only what is valid for the key it is stored under: the tree did not change while the producer
    // ran (same HEAD and working-tree hash before and after), the producer saw the same HEAD, and every
    // dependency it recorded still holds. Otherwise use the snapshot once and do not cache it.
    // (Residual: an edit reverted to the exact pre-run state mid-run is undetectable here.)
    const after = await worktreeState(repo.root);
    let notStored = null;
    let depsMs = 0;
    if (state.error || after.error) notStored = `the working tree could not be read (${state.error ?? after.error})`;
    else if (after.head !== state.head || after.hash !== state.hash) notStored = 'source changed while the snapshot was built';
    else if (state.racy > 0) {
      notStored = `${state.racy} file(s) changed within ${RACY_WINDOW_MS / 1000} s of the run, too recently for their stat keys to be trusted`;
    }
    else if (state.git && (snapshot.source?.head ?? '') !== state.head) {
      notStored = `the producer saw HEAD ${snapshot.source?.head || '(none)'}, not ${state.head}`;
    } else {
      const depsStarted = Date.now();
      const deps = checkResolutionDependencies(snapshot.source, repo.root);
      depsMs = Date.now() - depsStarted;
      if (!deps.ok) notStored = `a resolution dependency cannot be verified (${deps.reason})`;
    }
    const stored = notStored === null;
    if (stored) {
      writeAtomic(cachePath, JSON.stringify(snapshot));
      pruneSnapshots(dir, cachePath);
    } else {
      warnOnce(`unstable:${repo.name}`, `${repo.name}: ${notStored}; using it once without caching`);
    }
    const timing = {
      cached: false, stored, mode: availability.mode, keyMs, depsMs, bundleMs, normalizeMs, totalMs: Date.now() - started,
    };
    recordTiming(dir, {
      ts: new Date().toISOString(), repo: repo.name, fingerprint: fileKey, ...timing, ...(stored ? {} : { notStored }),
      entities: snapshot.entities.length, relations: snapshot.relations.length, complete: snapshot.complete,
      files_skipped: snapshot.files_skipped, budget_exhausted: snapshot.budget_exhausted,
    });
    if (!snapshot.complete) {
      warnOnce(`partial:${repo.name}`, `${repo.name}: snapshot is partial (${snapshot.failed_paths.length} failed path(s)); checks may miss names there`);
    }
    return { repo, snapshot, cached: false, path: stored ? cachePath : null, timing };
  } finally {
    // The producer writes `${out}.tmp.<pid>` then renames; a killed producer can strand that file.
    for (const name of readdirSync(dir)) {
      if (name === basename(tmp) || name.startsWith(`${basename(tmp)}.tmp.`)) rmSync(join(dir, name), { force: true });
    }
    release();
  }
}

/**
 * Snapshots for every configured repo. Warn-only: never throws. One repo failing does not
 * discard the others.
 *
 * @returns {Promise<{ skipped: string|null, availability, snapshots: object[], errors: {repo, message}[] }>}
 */
export async function loadSnapshots({ projectRoot, availability, timeoutMs, producer, env = process.env } = {}) {
  try {
    const avail = availability ?? await requireCodegraph({ cwd: projectRoot, env });
    if (!avail.available) return { skipped: avail.reason, availability: avail, snapshots: [], errors: [] };
    const config = readCodegraphConfig(projectRoot);
    const repos = resolveRepos(projectRoot).filter((repo) => existsSync(repo.root));
    const settled = await Promise.allSettled(repos.map((repo) => ensureSnapshot({
      projectRoot, repo, availability: avail, timeoutMs: timeoutMs ?? config.timeoutMs, producer, env,
    })));
    const snapshots = [];
    const errors = [];
    settled.forEach((outcome, i) => {
      if (outcome.status === 'fulfilled') snapshots.push(outcome.value);
      else {
        errors.push({ repo: repos[i].name, message: outcome.reason?.message ?? String(outcome.reason) });
        warnOnce(`snapshot:${repos[i].name}`, `${repos[i].name}: snapshot failed: ${outcome.reason?.message ?? outcome.reason}`);
      }
    });
    return { skipped: snapshots.length === 0 && errors.length > 0 ? 'every snapshot failed' : null, availability: avail, snapshots, errors };
  } catch (err) {
    warnOnce('snapshot:unexpected', `code graph snapshot skipped: ${err?.message ?? err}`);
    return { skipped: err?.message ?? String(err), availability: availability ?? null, snapshots: [], errors: [] };
  }
}

const CODEGRAPH_STEPS = new Set(['plan_gate', 'explore_design']);

/** Does a parsed lifecycle spec contain a step that runs a code-graph check? */
export function specUsesCodegraph(spec) {
  const stack = [spec];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) stack.push(...node);
    else if (node && typeof node === 'object') {
      if (CODEGRAPH_STEPS.has(node.id)) return true;
      stack.push(...Object.values(node));
    }
  }
  return false;
}

/**
 * Build-start prebuild: start producing every repo's snapshot in the background so the
 * plan gate (and explore_design's prior-art search) usually hits the cache instead of
 * waiting for a cold index. Non-blocking (returns the promise, callers do not await it),
 * single-flight (a gate that runs while it is in flight joins it and waits up to
 * codegraph.timeoutMs), warn-only (loadSnapshots never throws).
 * The NODE_ENV=test disable applies, through requireCodegraph.
 */
export function prebuildSnapshots({ projectRoot, env = process.env, loader = loadSnapshots } = {}) {
  return loader({ projectRoot, env }).catch(() => null);
}

// lib/codegraph/snapshot.js — STRAT-CODEGRAPH-1 (shape C: snapshot file)
//
// SmartMemory parses each repo into a bundle JSON; this module spawns the
// producer, normalizes the bundle into Compose's internal model, and caches
// the model under .compose/codegraph/<repo>/<fingerprint>.json.
//
// ONE envelope reader: `normalizeBundle` is the only code in Compose that reads
// a SmartMemory bundle, and `bundleArgv` is the only code that knows the producer
// argv (CODE-BUNDLE-CLI-1 design.md, Interface; both producers take it). A contract
// change is a one-file edit here.
//
// The cache holds the normalized model, not the raw bundle: forge's raw bundles
// are 77 MB (stratum/ts) and 248 MB (compose) (measured 2026-10-08, blueprint.md).

import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

import { acquireDirLock } from '../dir-lock.js';
import { FALLBACK_SCRIPT, readCodegraphConfig, requireCodegraph, warnOnce } from './availability.js';

// 2: relations carry edgeState; snapshots carry skip coverage and the producer (fix round 1).
export const MODEL_VERSION = 2;
export const EDGE_STATES = new Set(['resolved', 'ambiguous', 'unresolved', 'unsupported']);
export const SUPPORTED_SCHEMA_VERSIONS = new Set(['1']);
const DEFAULT_TIMEOUT_MS = 300000;
const KEEP_SNAPSHOTS = 3;
const STDERR_TAIL_BYTES = 8192;
const MODEL_RELATION_TYPES = new Set(['CALLS', 'REFERENCES', 'TESTS', 'IMPORTS']);
const WALK_SKIP_DIRS = new Set(['node_modules', '.git', '.compose', 'dist', 'build', '__pycache__', '.venv', 'venv']);
const WALK_EXTENSIONS = /\.(py|js|jsx|mjs|cjs|ts|tsx|mts|cts)$/;
// Non-source files SmartMemory reads: TS module resolution (core ts_resolve.py:186,205,224), framework detection
// (framework.py:93) and diagnostics (diagnostics.py:157). Residual: a tsconfig `extends` target with another name.
const PRODUCER_INPUTS = /(^|\/)(tsconfig[^/]*\.json|jsconfig[^/]*\.json|package\.json)$/;
const STALE_TMP = /^bundle\.\d+\.[0-9a-f]+\.tmp\.json/;
const WALK_MAX_FILES = 20000;

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

function git(cwd, args) {
  return new Promise((resolvePromise) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 60000 }, (error, stdout) => {
      resolvePromise({ ok: !error, stdout: String(stdout ?? '') });
    });
  });
}

function statKey(path) {
  try {
    const st = statSync(path);
    return `${st.size}:${Math.trunc(st.mtimeMs)}`;
  } catch {
    return 'missing';
  }
}

function producerInput(path) {
  return WALK_EXTENSIONS.test(path) || PRODUCER_INPUTS.test(path);
}

function walkSourceStats(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0 && out.length < WALK_MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!WALK_SKIP_DIRS.has(entry.name)) stack.push(path);
      } else if (entry.isFile() && WALK_EXTENSIONS.test(entry.name)) {
        out.push(`${relative(root, path)}=${statKey(path)}`);
      }
    }
  }
  return out.sort();
}

/**
 * Cache key for one repo root. Git: the tree hash of the root (subdirectory-aware,
 * so a stratum commit that leaves ts/ alone keeps the cache) + porcelain status +
 * size/mtime of every listed path (porcelain alone does not change when an
 * already-modified file is edited again). Not git: a stat walk of source files.
 * `salt` folds in anything else that changes the output (producer, version, excludes).
 */
export async function computeFingerprint(root, salt = '') {
  const hash = createHash('sha256').update(`v${MODEL_VERSION}\0${salt}\0`);
  const tree = await git(root, ['rev-parse', 'HEAD:./']);
  if (!tree.ok) {
    hash.update('nogit\0').update(walkSourceStats(root).join('\n'));
    return { fingerprint: hash.digest('hex'), head: null, dirty: null, git: false };
  }
  const [top, head, status] = await Promise.all([
    git(root, ['rev-parse', '--show-toplevel']),
    git(root, ['rev-parse', 'HEAD']),
    // --ignored=traditional: SmartMemory's collector does not read .gitignore, so an ignored source
    // file (e.g. a local.js) is indexed and must be in the key. Ignored directories come back collapsed
    // ("dir/") and are skipped: they are node_modules/dist/build-style trees SmartMemory excludes itself.
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=traditional', '--', '.']),
  ]);
  const toplevel = top.stdout.trim() || root;
  // -z records: "XY path\0", renames/copies add "\0origPath". Porcelain paths are top-level relative.
  // Compose's own state (.compose/, which holds this very cache) is not source: counting it would
  // change the key every time a snapshot is written, in any project that does not gitignore it.
  // Only files the producer reads are counted: a build writes design/plan docs and feature.json before plan_gate,
  // and counting those would turn every prebuilt snapshot (build start) into a miss at the gate.
  const parts = status.stdout.split('\0').filter(Boolean);
  const records = [];
  let dirty = false;
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    const xy = record.slice(0, 2);
    const path = record.slice(3);
    const isRename = xy[0] === 'R' || xy[0] === 'C';
    if (isRename) i++; // skip the origin path record
    if (path.split('/').includes('.compose')) continue;
    const origin = isRename ? parts[i] ?? '' : '';
    if (xy === '!!') {
      if (path.endsWith('/') || !WALK_EXTENSIONS.test(path)) continue;
    } else {
      dirty = true;
      if (!producerInput(path) && !(origin && producerInput(origin))) continue;
    }
    records.push(`${record}${isRename ? ` <- ${origin}` : ''}=${statKey(join(toplevel, path))}`);
  }
  hash.update(`${tree.stdout.trim()}\0${records.join('\n')}`);
  return { fingerprint: hash.digest('hex'), head: head.stdout.trim() || null, dirty, git: true };
}

/**
 * The producer argv after the command, per CODE-BUNDLE-CLI-1 design.md (Interface):
 * `<path> --repo <name> [--language …] [--exclude <dir> …] --out <file> [--allow-partial]`, plus
 * `--fields minimal` (accepted by SM 2026-10-08). The fallback adapter takes the same argv.
 */
export function bundleArgv({ root, repo, out, exclude = [] }) {
  return [
    root, '--repo', repo, ...exclude.flatMap((dir) => ['--exclude', dir]), '--out', out, '--allow-partial',
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

function edgeStateOf(row, where) {
  const state = row?.edge_state;
  if (!EDGE_STATES.has(state)) {
    throw new BundleFormatError(`${where} edge_state must be one of ${[...EDGE_STATES].join('|')}, got ${JSON.stringify(state)}`);
  }
  return state;
}

/**
 * THE envelope reader. Maps a SmartMemory snapshot bundle (schema_version "1": envelope
 * + hosted bundle, full or `--fields minimal`) to the internal model. Throws BundleFormatError.
 * Required by the snapshot amendment (SM 2026-10-08): `edge_state` on every relation,
 * `files_skipped`, `skipped_paths`, `budget_exhausted`. edge_state is the producer's;
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
          // Evidence records are not relations; the adapter stamps them, a producer may not.
          edgeState: EDGE_STATES.has(ev.edge_state) ? ev.edge_state : null,
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
      edgeState: r.edge_state,
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

/** Spawn the producer; resolve on exit 0, reject with the stderr tail otherwise. */
export function spawnProducer({ availability, repo, out, timeoutMs, env }) {
  const argv = { root: repo.root, repo: repo.name, out, exclude: repo.exclude };
  const [cmd, args] = availability.mode === 'cli'
    ? ['smartmemory', cliBundleArgs(argv)]
    : [availability.python, ['-I', FALLBACK_SCRIPT, ...bundleArgv(argv)]];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    liveProducers.add(child);
    child.on('close', () => liveProducers.delete(child));
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-STDERR_TAIL_BYTES); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES); });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) reject(new Error(`bundle producer timed out after ${timeoutMs}ms`));
      else if (code !== 0) reject(new Error(`bundle producer exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
      else resolvePromise({ stdout: stdout.trim() });
    });
  });
}

const inflight = new Map();

/**
 * One WARNING per fallback-produced snapshot, every time (sm-coord 2026-10-08: no silent
 * degradation). Deliberately not warnOnce.
 */
function warnFallbackProduced(repo, availability) {
  console.warn(`[codegraph] WARNING: ${repo.name}: snapshot produced by the private-import fallback `
    + `(lib/codegraph/bundle_fallback.py) instead of \`smartmemory code bundle\`, because `
    + `${availability.fallbackReason ?? 'the SmartMemory CLI is not available'}`);
}

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
 * @param {Function} [args.producer]  test seam: ({ availability, repo, out, timeoutMs, env }) => Promise
 * @param {object} [args.env]
 */
export function ensureSnapshot({ projectRoot, repo, availability, timeoutMs, producer = spawnProducer, env = process.env }) {
  const dir = join(codegraphDir(projectRoot), repo.name);
  if (inflight.has(dir)) return inflight.get(dir).then((result) => ({ ...result, joined: true }));
  const promise = produceSnapshot({ dir, repo, availability, timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS, producer, env });
  inflight.set(dir, promise);
  const clear = () => { if (inflight.get(dir) === promise) inflight.delete(dir); };
  promise.then(clear, clear);
  return promise;
}

/** Bundle temp files a dead producer stranded (the lock is held, so none is in use by a live run). */
function sweepStaleBundles(dir, keep) {
  for (const name of readdirSync(dir)) {
    if (STALE_TMP.test(name) && !name.startsWith(keep)) rmSync(join(dir, name), { force: true });
  }
}

async function produceSnapshot({ dir, repo, availability, timeoutMs, producer, env }) {
  const started = Date.now();
  // Anything that changes the producer's output is part of the key: which producer, which Python and
  // smartmemory, whether JS/TS grammars were present, and the repo's excludes.
  const salt = [availability.mode, availability.python, availability.version, availability.typescriptGrammar,
    repo.name, repo.exclude.join(',')].join('|');
  const fp = await computeFingerprint(repo.root, salt);
  const fingerprintMs = Date.now() - started;
  const cachePath = join(dir, `${fp.fingerprint}.json`);
  const hit = readCachedSnapshot(cachePath);
  if (hit) {
    const timing = { cached: true, fingerprintMs, totalMs: Date.now() - started };
    recordTiming(dir, { ts: new Date().toISOString(), repo: repo.name, fingerprint: fp.fingerprint, ...timing });
    return { repo, snapshot: hit, cached: true, path: cachePath, timing };
  }
  mkdirSync(dir, { recursive: true });
  const release = await acquireDirLock(join(dir, '.lock'), { timeoutMs: timeoutMs + 60000 });
  const tmp = join(dir, `bundle.${process.pid}.${randomBytes(4).toString('hex')}.tmp.json`);
  try {
    const raced = readCachedSnapshot(cachePath);
    if (raced) {
      const timing = { cached: true, fingerprintMs, totalMs: Date.now() - started };
      return { repo, snapshot: raced, cached: true, path: cachePath, timing };
    }
    sweepStaleBundles(dir, basename(tmp));
    const bundleStarted = Date.now();
    await producer({
      availability,
      repo,
      out: tmp,
      timeoutMs,
      env: { ...env, SMARTMEMORY_CODE_CHECKPOINT_DIR: env.SMARTMEMORY_CODE_CHECKPOINT_DIR || join(dir, 'parse-cache') },
    });
    if (availability.mode === 'fallback') warnFallbackProduced(repo, availability);
    const bundleMs = Date.now() - bundleStarted;
    const normalizeStarted = Date.now();
    const snapshot = {
      fingerprint: fp.fingerprint,
      created_at: new Date().toISOString(),
      producer: availability.mode,
      ...normalizeBundle(JSON.parse(readFileSync(tmp, 'utf8'))),
    };
    // The tree may have changed while the producer ran; caching that output under the
    // pre-run key would serve the wrong graph for it later. Use it once, do not cache it.
    // (Residual: an edit that is reverted to the exact pre-run state mid-run is undetectable here.)
    const after = await computeFingerprint(repo.root, salt);
    const stable = after.fingerprint === fp.fingerprint;
    if (stable) {
      writeAtomic(cachePath, JSON.stringify(snapshot));
      pruneSnapshots(dir, cachePath);
    } else {
      warnOnce(`unstable:${repo.name}`, `${repo.name}: source changed while the snapshot was built; using it once without caching`);
    }
    const normalizeMs = Date.now() - normalizeStarted;
    const timing = { cached: false, stored: stable, mode: availability.mode, fingerprintMs, bundleMs, normalizeMs, totalMs: Date.now() - started };
    recordTiming(dir, {
      ts: new Date().toISOString(), repo: repo.name, fingerprint: fp.fingerprint, ...timing,
      entities: snapshot.entities.length, relations: snapshot.relations.length, complete: snapshot.complete,
      files_skipped: snapshot.files_skipped, budget_exhausted: snapshot.budget_exhausted,
    });
    if (!snapshot.complete) {
      warnOnce(`partial:${repo.name}`, `${repo.name}: snapshot is partial (${snapshot.failed_paths.length} failed path(s)); checks may miss names there`);
    }
    return { repo, snapshot, cached: false, path: stable ? cachePath : null, timing };
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
 * discard the others. A fallback-produced snapshot this call did not produce itself (a cache
 * hit, or a joined prebuild) gets one WARNING line per call: production already warned with
 * the reason, and a cache hit would otherwise hide the fallback.
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
    const reused = snapshots
      .filter((s) => s.snapshot?.producer === 'fallback' && (s.cached || s.joined))
      .map((s) => `${s.repo.name} (${s.cached ? 'cached' : 'prebuilt this build'})`);
    if (reused.length > 0) {
      console.warn(`[codegraph] WARNING: using snapshot(s) produced by the private-import fallback `
        + `(lib/codegraph/bundle_fallback.py), not \`smartmemory code bundle\`: ${reused.join(', ')}`);
    }
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
 * waiting for a cold index (~170 s on forge compose). Non-blocking (returns the promise,
 * callers do not await it), single-flight (a gate that runs while it is in flight joins
 * it and waits up to codegraph.timeoutMs), warn-only (loadSnapshots never throws).
 * The NODE_ENV=test disable applies, through requireCodegraph.
 */
export function prebuildSnapshots({ projectRoot, env = process.env, loader = loadSnapshots } = {}) {
  return loader({ projectRoot, env }).catch(() => null);
}

// lib/codegraph/snapshot.js — STRAT-CODEGRAPH-1 (shape C: snapshot file)
//
// SmartMemory parses each repo into a bundle JSON; this module spawns the
// producer, normalizes the bundle into Compose's internal model, and caches
// the model under .compose/codegraph/<repo>/<fingerprint>.json.
//
// ONE envelope reader: `normalizeBundle` is the only code in Compose that reads
// a SmartMemory bundle, and `cliBundleArgs` is the only code that knows the CLI's
// argv. The CODE-BUNDLE-CLI-1 contract is still pending, so a contract change is
// a one-file edit here.
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

export const MODEL_VERSION = 1;
export const SUPPORTED_SCHEMA_VERSIONS = new Set(['1']);
const DEFAULT_TIMEOUT_MS = 300000;
const KEEP_SNAPSHOTS = 3;
const STDERR_TAIL_BYTES = 8192;
const MODEL_RELATION_TYPES = new Set(['CALLS', 'REFERENCES', 'TESTS', 'IMPORTS']);
const WALK_SKIP_DIRS = new Set(['node_modules', '.git', '.compose', 'dist', 'build', '__pycache__', '.venv', 'venv']);
const WALK_EXTENSIONS = /\.(py|js|jsx|mjs|cjs|ts|tsx|mts|cts)$/;
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
    if (xy === '!!') {
      if (path.endsWith('/') || !WALK_EXTENSIONS.test(path)) continue;
    } else {
      dirty = true;
    }
    records.push(`${record}${isRename ? ` <- ${parts[i] ?? ''}` : ''}=${statKey(join(toplevel, path))}`);
  }
  hash.update(`${tree.stdout.trim()}\0${records.join('\n')}`);
  return { fingerprint: hash.digest('hex'), head: head.stdout.trim() || null, dirty, git: true };
}

/** Provisional argv for `smartmemory code bundle` (CODE-BUNDLE-CLI-1 contract pending). */
export function cliBundleArgs({ root, repo, out, exclude = [] }) {
  return [
    'code', 'bundle', '--repo-root', root, '--repo', repo, '--out', out, '--allow-partial',
    ...exclude.flatMap((dir) => ['--exclude', dir]),
  ];
}

function evidenceIsUntraversable(ev, ids) {
  const props = ev?.properties ?? {};
  return props.unresolved === true || !ids.has(ev?.target_id);
}

/**
 * THE envelope reader. Maps a SmartMemory snapshot bundle (schema_version "1": envelope
 * + hosted bundle, full or --slim) to the internal model. Throws BundleFormatError.
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
      parse: e.parse_diagnostic?.status ?? null,
      // Unresolved callee spellings survive only here (prepare_bundle drops relations to absent targets).
      unresolved: (Array.isArray(e.call_evidence) ? e.call_evidence : [])
        .filter((ev) => evidenceIsUntraversable(ev, ids))
        .map((ev) => ({
          callee: ev.properties?.callee ?? null,
          line: ev.properties?.line ?? null,
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

/** Spawn the producer; resolve on exit 0, reject with the stderr tail otherwise. */
export function spawnProducer({ availability, repo, out, timeoutMs, env }) {
  const [cmd, args] = availability.mode === 'cli'
    ? ['smartmemory', cliBundleArgs({ root: repo.root, repo: repo.name, out, exclude: repo.exclude })]
    : [availability.python, [
      '-I', FALLBACK_SCRIPT, '--repo-root', repo.root, '--repo', repo.name, '--out', out,
      '--allow-partial', '--slim', ...repo.exclude.flatMap((dir) => ['--exclude', dir]),
    ]];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
 * Snapshot for one repo: cache hit, or produce → normalize → cache. Single flight per
 * repo dir (in-process map + cross-process dir lock). Throws on producer/format errors;
 * the warn-only callers (loadSnapshots) turn that into a warning.
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
  if (inflight.has(dir)) return inflight.get(dir);
  const promise = produceSnapshot({ dir, repo, availability, timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS, producer, env });
  inflight.set(dir, promise);
  const clear = () => { if (inflight.get(dir) === promise) inflight.delete(dir); };
  promise.then(clear, clear);
  return promise;
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
    const bundleStarted = Date.now();
    await producer({
      availability,
      repo,
      out: tmp,
      timeoutMs,
      env: { ...env, SMARTMEMORY_CODE_CHECKPOINT_DIR: env.SMARTMEMORY_CODE_CHECKPOINT_DIR || join(dir, 'parse-cache') },
    });
    const bundleMs = Date.now() - bundleStarted;
    const normalizeStarted = Date.now();
    const snapshot = { fingerprint: fp.fingerprint, created_at: new Date().toISOString(), ...normalizeBundle(JSON.parse(readFileSync(tmp, 'utf8'))) };
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

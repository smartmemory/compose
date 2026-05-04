/**
 * completion-writer.js — typed writer for per-feature completion records.
 *
 * Sub-ticket #5 of COMP-MCP-FEATURE-MGMT (COMP-MCP-COMPLETION).
 *
 * Two operations:
 *   recordCompletion(cwd, args)  — append (or replace) a completion record on feature.json
 *   getCompletions(cwd, opts)    — read + filter completion records across features
 *
 * Storage: feature.json completions[] (append-mostly, oldest-first on disk).
 * Idempotency: storage-level dedup on completion_id = <feature_code>:<commit_sha>;
 *              optional caller-supplied idempotency_key via checkOrInsert.
 * Concurrency: per-feature advisory lock at
 *   <cwd>/.compose/data/locks/feature-<feature_code>.lock
 *   (Decision 10; mirrors acquireLock pattern from lib/idempotency.js:42).
 *
 * setFeatureStatus is lazy-imported inside the writer to avoid circular load.
 * (feature-writer.js must NOT import completion-writer.js — that would create
 *  a cycle. The lazy import here is intentional and must stay inside the function.)
 *
 * No HTTP, no transport awareness.
 */

import { mkdirSync, rmSync, statSync } from 'fs';
import { join, dirname, posix } from 'path';

import { readFeature, updateFeature, listFeatures } from './feature-json.js';
import { loadFeaturesDir } from './project-paths.js';
import { appendEvent, normalizeSince } from './feature-events.js';
import { checkOrInsert } from './idempotency.js';
import { FEATURE_CODE_RE_STRICT as FEATURE_CODE_RE } from './feature-code.js';

// ---------------------------------------------------------------------------
// Constants + regexes
// ---------------------------------------------------------------------------
const SHA_RE          = /^[0-9a-f]{40}$/i;   // FULL SHA only (Decision 9). Case-insensitive input; normalize to lowercase.
const SHORT_LEN       = 8;                    // Display only — never the dedup key.
const DEFAULT_LIMIT   = 50;
const MAX_LIMIT       = 500;

// ---------------------------------------------------------------------------
// Lock helpers (mirrors idempotency.js:42)
// ---------------------------------------------------------------------------

const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS   = 25;

function featureLockFile(cwd, featureCode) {
  return join(cwd, '.compose', 'data', 'locks', `feature-${featureCode}.lock`);
}

function ensureLockDir(lockPath) {
  mkdirSync(dirname(lockPath), { recursive: true });
}

async function acquireFeatureLock(cwd, featureCode) {
  const lockPath = featureLockFile(cwd, featureCode);
  ensureLockDir(lockPath);

  const start = Date.now();
  while (true) {
    try {
      mkdirSync(lockPath);
      return () => {
        try { rmSync(lockPath, { recursive: true, force: true }); } catch { /* best-effort */ }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Stale lock recovery
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_TIMEOUT_MS) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch { /* stat raced; loop and retry */ }

      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`completion-writer: feature lock timeout after ${LOCK_TIMEOUT_MS}ms: ${lockPath}`);
      }
      await new Promise(r => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}

// ---------------------------------------------------------------------------
// Typed-error helpers
// ---------------------------------------------------------------------------

function inputError(message) {
  const e = new Error(message);
  e.code = 'INVALID_INPUT';
  return e;
}

function notFoundError(code) {
  const e = new Error(`completion-writer: feature "${code}" not found`);
  e.code = 'FEATURE_NOT_FOUND';
  return e;
}

function statusFlipError(message, cause) {
  const e = new Error(message);
  e.code = 'STATUS_FLIP_AFTER_COMPLETION_RECORDED';
  if (cause) e.cause = cause;
  return e;
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

function validateRepoRelativePath(p) {
  if (typeof p !== 'string' || p.length === 0) {
    throw inputError('files_changed: each entry must be a non-empty string');
  }
  if (p.includes('\0')) {
    throw inputError(`files_changed: entry contains NUL byte: "${p}"`);
  }
  if (p.startsWith('/')) {
    throw inputError(`files_changed: absolute paths not allowed: "${p}"`);
  }
  if (p.includes('\\')) {
    throw inputError(`files_changed: use POSIX separators (no backslashes): "${p}"`);
  }
  const normalized = posix.normalize(p);
  if (normalized !== p) {
    throw inputError(`files_changed: path "${p}" must already be normalized (got "${normalized}")`);
  }
  if (normalized.startsWith('../') || normalized === '..') {
    throw inputError(`files_changed: ".." escape rejected: "${p}"`);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate(args) {
  // feature_code
  if (typeof args.feature_code !== 'string' || !FEATURE_CODE_RE.test(args.feature_code)) {
    throw inputError(
      `completion-writer: invalid feature_code "${args.feature_code}" — must match ${FEATURE_CODE_RE}`
    );
  }

  // commit_sha — full 40-char hex required (Decision 9)
  if (typeof args.commit_sha !== 'string' || args.commit_sha.trim().length === 0) {
    throw inputError('completion-writer: commit_sha is required (non-empty string)');
  }
  const trimmedSha = args.commit_sha.trim();
  if (!SHA_RE.test(trimmedSha)) {
    throw inputError(
      `completion-writer: commit_sha must be a full 40-char hex SHA (Decision 9). ` +
      `Got "${trimmedSha}" (length ${trimmedSha.length}). Short prefixes are rejected on write.`
    );
  }

  // tests_pass — strict boolean
  if (typeof args.tests_pass !== 'boolean') {
    throw inputError(
      `completion-writer: tests_pass must be a boolean, got ${typeof args.tests_pass} "${args.tests_pass}"`
    );
  }

  // files_changed — array of normalized repo-relative paths
  if (!Array.isArray(args.files_changed)) {
    throw inputError('completion-writer: files_changed must be an array');
  }
  for (const p of args.files_changed) {
    validateRepoRelativePath(p);
  }

  // notes — if present, non-empty string, no NUL
  if (args.notes !== undefined && args.notes !== null) {
    if (typeof args.notes !== 'string') {
      throw inputError('completion-writer: notes must be a string');
    }
    if (args.notes.includes('\0')) {
      throw inputError('completion-writer: notes must not contain NUL bytes');
    }
  }

  // set_status — boolean if present
  if (args.set_status !== undefined && typeof args.set_status !== 'boolean') {
    throw inputError('completion-writer: set_status must be a boolean');
  }

  // force — boolean if present
  if (args.force !== undefined && typeof args.force !== 'boolean') {
    throw inputError('completion-writer: force must be a boolean');
  }
}

// ---------------------------------------------------------------------------
// maybeIdempotent helper (mirrors feature-writer.js pattern)
// ---------------------------------------------------------------------------

function maybeIdempotent(args, fn) {
  if (args.idempotency_key) {
    return checkOrInsert(args.cwd, args.idempotency_key, fn).then(({ result }) => result);
  }
  return Promise.resolve().then(fn);
}

// ---------------------------------------------------------------------------
// safeAppendEvent — best-effort; failed append must NOT roll back a committed
// mutation (per sibling-writer convention).
// ---------------------------------------------------------------------------

function safeAppendEvent(cwd, event) {
  try {
    appendEvent(cwd, event);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[completion-writer] audit append failed for ${event.tool} ${event.code ?? ''}: ${err.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// recordCompletion
// ---------------------------------------------------------------------------

/**
 * Record a completion bound to a commit SHA on feature.json.
 *
 * @param {string} cwd
 * @param {object} args
 * @param {string}   args.feature_code
 * @param {string}   args.commit_sha       Full 40-char hex SHA (Decision 9)
 * @param {boolean}  args.tests_pass
 * @param {string[]} args.files_changed    Repo-relative normalized POSIX paths
 * @param {string}   [args.notes]
 * @param {boolean}  [args.set_status]     Default true — flip status to COMPLETE
 * @param {boolean}  [args.force]          Replace existing same-(code,sha) record
 * @param {string}   [args.idempotency_key]
 *
 * @returns {{ feature_code, completion_id, commit_sha, commit_sha_short,
 *             status_changed, status_flip_partial, idempotent, recorded_at }}
 */
export async function recordCompletion(cwd, args) {
  // 1. Validate
  validate(args);

  // 2. Normalize SHA
  const commit_sha       = args.commit_sha.trim().toLowerCase();
  const commit_sha_short = commit_sha.slice(0, SHORT_LEN);
  const feature_code     = args.feature_code;

  // 3. Compute completion_id
  const completion_id = `${feature_code}:${commit_sha}`;

  const featuresDir = loadFeaturesDir(cwd);
  // 4. Wrap in maybeIdempotent for caller-key path
  return maybeIdempotent({ ...args, cwd }, async () => {
    // 5a. Acquire per-feature advisory lock (Decision 10)
    const release = await acquireFeatureLock(cwd, feature_code);
    try {
      // 5b. Read feature
      const feature = readFeature(cwd, feature_code, featuresDir);
      if (!feature) throw notFoundError(feature_code);

      // 5c. Snapshot completions array
      const completions = Array.isArray(feature.completions) ? [...feature.completions] : [];

      // 5d. Find existing index
      const idx = completions.findIndex(c => c.completion_id === completion_id);

      // 5e. Idempotent no-op
      if (idx !== -1 && !args.force) {
        return {
          feature_code,
          completion_id,
          commit_sha,
          commit_sha_short,
          status_changed: null,
          status_flip_partial: false,
          idempotent: true,
          recorded_at: completions[idx].recorded_at,
        };
      }

      // 5f. Build record
      const record = {
        completion_id,
        feature_code,                          // stamped at write time (Decision 11)
        commit_sha,
        commit_sha_short,
        tests_pass: args.tests_pass,
        files_changed: [...args.files_changed],
        recorded_at: new Date().toISOString(),
        recorded_by: process.env.COMPOSE_ACTOR || 'mcp:agent',
      };
      if (args.notes) record.notes = args.notes;

      // 5g. Replace or append
      if (idx !== -1) {
        completions[idx] = record;
      } else {
        completions.push(record);
      }

      // 5h. Persist completion record BEFORE status flip (so flip failure doesn't lose the record)
      updateFeature(cwd, feature_code, { completions }, featuresDir);

      // 5i. Status flip (default on)
      const set_status = args.set_status !== false;
      let status_changed = null;

      if (set_status && feature.status !== 'COMPLETE') {
        const fromStatus = feature.status;
        // Terminal states (KILLED, SUPERSEDED) have no valid outgoing transitions.
        // We deliberately do NOT force for terminal states so that the transition
        // policy enforcement fires and produces the STATUS_FLIP_AFTER_COMPLETION_RECORDED
        // error (test #11 / Decision 4). For non-terminal states we pass force: true
        // so that intermediate-state features (e.g. PLANNED → COMPLETE) succeed without
        // requiring callers to manually walk through IN_PROGRESS first.
        const TERMINAL_STATES = new Set(['KILLED', 'SUPERSEDED']);
        const flipForce = !TERMINAL_STATES.has(fromStatus);
        try {
          // Lazy-import setFeatureStatus to avoid circular load
          // (completion-writer.js must not be statically imported by feature-writer.js)
          const { setFeatureStatus } = await import('./feature-writer.js');
          await setFeatureStatus(cwd, {
            code: feature_code,
            status: 'COMPLETE',
            commit_sha,
            reason: 'record_completion',
            force: flipForce,
          });
          status_changed = { from: fromStatus, to: 'COMPLETE' };
        } catch (flipErr) {
          // Both failure sub-cases (transition rejected AND ROADMAP_PARTIAL_WRITE) rethrow
          // as STATUS_FLIP_AFTER_COMPLETION_RECORDED. The completion record IS persisted (step h).
          throw statusFlipError(
            flipErr.code === 'ROADMAP_PARTIAL_WRITE'
              ? `completion-writer: completion recorded for "${feature_code}" but ROADMAP regen failed after status flip. ` +
                `This is the ROADMAP_PARTIAL_WRITE subcase (Decision 4). ` +
                `Recover with \`compose roadmap generate\`.`
              : `completion-writer: completion recorded for "${feature_code}" but status flip to COMPLETE failed. ` +
                `err.cause carries the underlying transition error.`,
            flipErr,
          );
        }
      }

      // 5j. Audit event (not appended for idempotent no-ops — they return early at 5e)
      const auditEvent = {
        tool: 'record_completion',
        code: feature_code,
        completion_id,
        commit_sha,
        tests_pass: args.tests_pass,
        set_status,
      };
      if (args.force) auditEvent.force = args.force;
      if (args.idempotency_key) auditEvent.idempotency_key = args.idempotency_key;
      safeAppendEvent(cwd, auditEvent);

      // 5l. Return
      return {
        feature_code,
        completion_id,
        commit_sha,
        commit_sha_short,
        status_changed,
        status_flip_partial: false,
        idempotent: false,
        recorded_at: record.recorded_at,
      };
    } finally {
      release();
    }
  });
}

// ---------------------------------------------------------------------------
// getCompletions
// ---------------------------------------------------------------------------

/**
 * Read completion records across features, with optional filtering.
 *
 * @param {string} cwd
 * @param {object} [opts]
 * @param {string}  [opts.feature_code]  Exact feature code filter
 * @param {string}  [opts.commit_sha]    Full or short-prefix SHA filter (permissive at read time)
 * @param {string}  [opts.since]         Shorthand "7d"/"24h" or ISO date
 * @param {number}  [opts.limit]         Default 50, max 500
 *
 * @returns {{ completions: Array, count: number }}
 */
export function getCompletions(cwd, opts = {}) {
  // 1. Parse filters
  const sinceMs = opts.since ? normalizeSince(opts.since) : null;
  let limit = typeof opts.limit === 'number' ? opts.limit : DEFAULT_LIMIT;
  if (limit < 0) limit = 0;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  // 2. Gather candidate features
  const featuresDir = loadFeaturesDir(cwd);
  let features;
  if (opts.feature_code) {
    const f = readFeature(cwd, opts.feature_code, featuresDir);
    features = f ? [f] : [];
  } else {
    features = listFeatures(cwd, featuresDir);
  }

  // 3. Flatten all completions[] arrays
  // Normalize always-present nullable fields so readers get a uniform shape
  // regardless of hand-edited or legacy records (Decision 11).
  const all = [];
  for (const feature of features) {
    if (!Array.isArray(feature.completions)) continue;
    for (const rec of feature.completions) {
      const normalized = { ...rec };
      if (!Object.prototype.hasOwnProperty.call(normalized, 'feature_code')) {
        normalized.feature_code = null;
      }
      if (!Object.prototype.hasOwnProperty.call(normalized, 'commit_sha_short')) {
        normalized.commit_sha_short = null;
      }
      all.push(normalized);
    }
  }

  // 4. Filter
  let filtered = all;

  if (opts.commit_sha) {
    const filterSha = opts.commit_sha.trim().toLowerCase();
    if (filterSha.length > 0 && filterSha.length < 4) {
      const err = new Error(
        `commit_sha prefix too short: got ${filterSha.length} char(s), minimum is 4`
      );
      err.code = 'INVALID_INPUT';
      throw err;
    }
    filtered = filtered.filter(rec => {
      if (typeof rec.commit_sha !== 'string') return false;
      return rec.commit_sha === filterSha || rec.commit_sha.startsWith(filterSha);
    });
  }

  if (sinceMs !== null) {
    filtered = filtered.filter(rec => {
      const ms = Date.parse(rec.recorded_at);
      return !isNaN(ms) && ms >= sinceMs;
    });
  }

  // 5. Sort desc by recorded_at
  filtered.sort((a, b) => {
    const ta = Date.parse(a.recorded_at) || 0;
    const tb = Date.parse(b.recorded_at) || 0;
    return tb - ta;
  });

  // 6. Truncate
  const completions = filtered.slice(0, limit);

  // 7. Return — feature_code from the record itself (Decision 11; null if absent)
  return { completions, count: completions.length };
}

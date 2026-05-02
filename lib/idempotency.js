/**
 * idempotency.js — caller-provided idempotency keys with persistent cache.
 *
 * Used by the feature-management writers (COMP-MCP-FEATURE-MGMT) so that the
 * same logical operation invoked twice with the same key returns the first
 * result without re-mutating state.
 *
 * Cache file: <cwd>/.compose/data/idempotency-keys.jsonl
 * Lock file:  <cwd>/.compose/data/idempotency-keys.lock  (advisory mkdir lock)
 *
 * Each cache row is JSON: { key, result, ts }.
 * Cap at MAX_ENTRIES (default 1000). When the cap is exceeded, the oldest
 * entries are dropped on the next write. No background sweep — drop happens
 * inline so we never block on large rewrites unnecessarily.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';

const MAX_ENTRIES = 1000;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 25;

function cacheFile(cwd) {
  return join(cwd, '.compose', 'data', 'idempotency-keys.jsonl');
}

function lockFile(cwd) {
  return join(cwd, '.compose', 'data', 'idempotency-keys.lock');
}

function ensureDir(file) {
  mkdirSync(dirname(file), { recursive: true });
}

/**
 * Acquire an advisory lock by creating a directory (atomic on POSIX). Caller
 * is responsible for releasing via the returned function. Stale locks older
 * than LOCK_TIMEOUT_MS are forcibly cleared so a crashed prior holder can't
 * deadlock the next caller.
 */
async function acquireLock(cwd) {
  const path = lockFile(cwd);
  ensureDir(path);

  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      mkdirSync(path);
      return () => {
        try { rmSync(path, { recursive: true, force: true }); } catch { /* best-effort */ }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Stale lock recovery: if older than timeout, clear and retry.
      try {
        const { mtimeMs } = (await import('fs')).statSync(path);
        if (Date.now() - mtimeMs > LOCK_TIMEOUT_MS) {
          rmSync(path, { recursive: true, force: true });
          continue;
        }
      } catch { /* stat raced; loop and retry */ }

      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`idempotency lock timeout after ${LOCK_TIMEOUT_MS}ms: ${path}`);
      }
      await new Promise(r => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}

function readEntries(cwd) {
  const path = cacheFile(cwd);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf-8');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

function writeEntries(cwd, entries) {
  const path = cacheFile(cwd);
  ensureDir(path);
  const trimmed = entries.length > MAX_ENTRIES
    ? entries.slice(entries.length - MAX_ENTRIES)
    : entries;
  const body = trimmed.map(e => JSON.stringify(e)).join('\n') + (trimmed.length ? '\n' : '');
  writeFileSync(path, body);
}

/**
 * Run computeFn() at most once for a given key. If the key has been seen
 * before, return the cached result without invoking computeFn. Caller must
 * supply a stable key derived from the operation's intent.
 *
 * Intentionally async because the lock acquisition is async; computeFn may
 * be sync or async.
 *
 * @param {string} cwd
 * @param {string} key
 * @param {() => any | Promise<any>} computeFn
 * @returns {Promise<{ result: any, cached: boolean }>}
 */
export async function checkOrInsert(cwd, key, computeFn) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('idempotency: key must be a non-empty string');
  }

  const release = await acquireLock(cwd);
  try {
    const entries = readEntries(cwd);
    const hit = entries.find(e => e.key === key);
    if (hit) {
      return { result: hit.result, cached: true };
    }

    const result = await computeFn();
    entries.push({ key, result, ts: new Date().toISOString() });
    writeEntries(cwd, entries);
    return { result, cached: false };
  } finally {
    release();
  }
}

/**
 * Test/diagnostic helper: clear the cache. Not exposed via MCP.
 */
export function _resetIdempotency(cwd) {
  const path = cacheFile(cwd);
  if (existsSync(path)) rmSync(path);
  const lock = lockFile(cwd);
  if (existsSync(lock)) rmSync(lock, { recursive: true, force: true });
}

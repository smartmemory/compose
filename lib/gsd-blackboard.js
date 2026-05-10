// lib/gsd-blackboard.js
//
// COMP-GSD-2 T2: blackboard I/O for GSD post-execution capture.
//
// Exports:
//   read(code, opts?)                    → Record<taskId, TaskResult>  (returns {} if absent)
//   writeAll(code, taskResults, opts?)   → Promise<void>                (atomic batch write)
//   validate(taskResult)                 → { ok: boolean, errors: string[] }
//
// Lock pattern: mirrors lib/completion-writer.js:48-67 (mkdir-advisory-lock).
// Atomic write: temp-file + rename (mirrors lib/journal-writer.js).
// Schema validation: contracts/task-result.json compiled lazily under ajv.

import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '..');

const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 25;

// ---------- Path helpers ----------

function blackboardPath(cwd, code) {
  return join(cwd, '.compose', 'gsd', code, 'blackboard.json');
}

function lockPath(cwd, code) {
  return join(cwd, '.compose', 'data', 'locks', `gsd-${code}.lock`);
}

// ---------- Lock helpers (mirrors completion-writer.js:56) ----------

async function acquireLock(cwd, code) {
  const lp = lockPath(cwd, code);
  mkdirSync(dirname(lp), { recursive: true });

  const start = Date.now();
  while (true) {
    try {
      mkdirSync(lp);
      return () => {
        try { rmSync(lp, { recursive: true, force: true }); } catch { /* best-effort */ }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const st = statSync(lp);
        if (Date.now() - st.mtimeMs > LOCK_TIMEOUT_MS) {
          rmSync(lp, { recursive: true, force: true });
          continue;
        }
      } catch { /* stat raced; retry */ }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`gsd-blackboard: lock timeout after ${LOCK_TIMEOUT_MS}ms: ${lp}`);
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}

// ---------- Schema validation (lazy ajv) ----------

let _validator = null;

function getValidator() {
  if (_validator) return _validator;
  const Ajv = require('ajv');
  const schema = JSON.parse(
    readFileSync(join(PACKAGE_ROOT, 'contracts', 'task-result.json'), 'utf-8'),
  );
  const ajv = new Ajv({ strict: false, allErrors: true });
  _validator = ajv.compile(schema);
  return _validator;
}

// CommonJS require shim for ajv (this module is ESM)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export function validate(taskResult) {
  if (taskResult === null || typeof taskResult !== 'object' || Array.isArray(taskResult)) {
    return { ok: false, errors: ['expected TaskResult object'] };
  }
  const v = getValidator();
  const ok = v(taskResult);
  if (ok) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`),
  };
}

// ---------- Public I/O ----------

export function read(code, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const path = blackboardPath(cwd, code);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export async function writeAll(code, taskResults, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();

  // Validate every entry BEFORE acquiring the lock — fail fast, don't hold the lock for nothing.
  if (taskResults === null || typeof taskResults !== 'object' || Array.isArray(taskResults)) {
    throw new Error('gsd-blackboard.writeAll: invalid taskResults — expected object map');
  }
  for (const [taskId, result] of Object.entries(taskResults)) {
    const v = validate(result);
    if (!v.ok) {
      throw new Error(
        `gsd-blackboard.writeAll: invalid TaskResult for task "${taskId}": ${v.errors.join('; ')}`,
      );
    }
  }

  const release = await acquireLock(cwd, code);
  try {
    const path = blackboardPath(cwd, code);
    mkdirSync(dirname(path), { recursive: true });
    // One-shot batch finalization: replace whatever was there. The blackboard
    // is a post-execution artifact, not an append log. Concurrent writers
    // serialize on the lock — one wins, one waits — and the last writer's
    // map is the final state.
    const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmpPath, JSON.stringify(taskResults, null, 2) + '\n');
    renameSync(tmpPath, path);
  } finally {
    release();
  }
}

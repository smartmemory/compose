/**
 * lib/checkpoint/atomic.js — small fs helpers for the checkpoint stores.
 *
 * COMP-RESUME slice S2 (correction C6): existing stores copy-paste the
 * temp-file + rename atomic-write idiom (see server/vision-store.js:132-143)
 * and the JSONL append/idempotent-read idiom (see server/gate-log-store.js:46-102).
 * This module is the one shared helper the new JSONL checkpoint backend uses,
 * so we don't churn the existing stores.
 *
 * No external dependencies; Node built-ins only.
 */

import {
  mkdirSync,
  writeFileSync,
  renameSync,
  appendFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * Atomically write `str` to `file`: write to a unique temp sibling, then rename.
 * The rename is atomic on POSIX, so readers never observe a half-written file.
 * Creates the parent directory recursively.
 *
 * @param {string} file — absolute or relative target path
 * @param {string} str  — exact bytes to write (caller controls trailing newline)
 */
export function writeAtomic(file, str) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${Date.now()}`;
  writeFileSync(tmp, str, 'utf8');
  renameSync(tmp, file);
}

/**
 * Append one object as a single JSON line to `file` (creating parent dirs).
 *
 * @param {string} file
 * @param {object} obj
 */
export function appendJsonl(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

/**
 * Read all valid JSON objects from a JSONL `file`.
 * Returns `[]` if the file is absent. Blank and malformed lines are skipped
 * (tolerant read — a torn final line never poisons the whole log).
 *
 * @param {string} file
 * @returns {object[]}
 */
export function readJsonl(file) {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // malformed line — skip
    }
  }
  return out;
}

/**
 * Return the last valid JSON object in `file`, or `null` if there is none
 * (absent file, empty file, or only blank/malformed lines).
 *
 * @param {string} file
 * @returns {object|null}
 */
export function readLastJsonl(file) {
  const all = readJsonl(file);
  return all.length ? all[all.length - 1] : null;
}

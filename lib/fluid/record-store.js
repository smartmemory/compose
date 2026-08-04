/**
 * lib/fluid/record-store.js — durable, git-tracked persistence for the floor
 * provider.
 *
 * WHY THIS EXISTS (S3 entry-gate ruling, 2026-08-04)
 * --------------------------------------------------
 * S1 hosted records on vision-store items, in an additive `fluid_ext`
 * namespace. That was the right call for a seam pilot and the wrong one for
 * durability: `.compose/data/vision-state.json` is gitignored (`.gitignore:3`
 * matches `data/`), so wiring the CLI, the API and the UI onto the provider
 * would have moved idea canon from a tracked file to an untracked one on a
 * single machine — and committed a GENERATED `ideabox.md` with no source of
 * truth behind it on any other clone or in CI.
 *
 * The owner ruled: track the records, split them out of vision-state. That is
 * not merely a path change. It inverts which side is canon:
 *
 *     BEFORE  vision item = canon,   nothing tracked
 *     AFTER   record file = canon,   vision item = optional projection
 *
 * Vision-state could not simply be un-ignored: it is ~540KB of runtime state
 * (gates, connections, 465 items) rewritten on every save, so tracking it would
 * mean an unreadable diff and a merge conflict per parallel session. Records
 * need the opposite properties, so they get their own files.
 *
 * LAYOUT — mirrors `docs/judgment/`, deliberately
 * -----------------------------------------------
 * The judgment layer already solved "tool-owned canon plus a generated markdown
 * projection" and is the house convention; a third pattern here would be drift
 * for its own sake.
 *
 *     docs/judgment/records/joints/*.json   ↔   <root>/records/<HANDLE>.json
 *     docs/judgment/records/ledger.jsonl    ↔   <root>/events.jsonl
 *     docs/judgment/REGISTER.md (generated) ↔   docs/product/ideabox.md
 *
 * ONE FILE PER RECORD, not one array file. A whole-array rewrite makes every
 * `ideabox add` a diff against all records and a merge conflict between two
 * clones that each added an idea. Per-record files make an add a pure file
 * creation. The handle is the filename because it is unique, never reused
 * (retired handles stay retired — see the events log), and already constrained
 * to a filesystem-safe grammar by the contract.
 *
 * NO IN-MEMORY SNAPSHOT. Every read hits the directory. This is what retires
 * the S1 `_sync()` hazard rather than merely narrowing it: there is no cached
 * state for a second writer to invalidate, so the CLI and a running server
 * cannot erase each other's records by saving a stale view. Interleaving is
 * still unserialized — see the known gap at the foot of this file.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Tracked root, relative to the project. Under `docs/` on purpose: this is
 *  product canon that belongs in review and in git history, not runtime state.
 *  It sits beside its own projection (`docs/product/ideabox.md`). */
export const DEFAULT_RECORDS_ROOT = join('docs', 'product', 'fluid');

const RECORDS_DIR = 'records';
const EVENTS_FILE = 'events.jsonl';

/**
 * Filenames are handles, so the grammar is enforced on the way to disk as well
 * as at the seam. A handle is interpolated into a path; anything carrying a
 * separator or a traversal segment must never reach `join()`. The seam already
 * validates handles, but a store that writes wherever it is pointed is one
 * caller away from writing outside its root.
 */
const HANDLE_RE = /^[A-Z][A-Z0-9]*-[1-9][0-9]{0,8}$/;

function assertHandleSafe(handle) {
  if (typeof handle !== 'string' || !HANDLE_RE.test(handle)) {
    throw new Error(`fluid: unsafe record handle "${handle}" — refusing to build a path from it`);
  }
  return handle;
}

/**
 * Scans RAW log text for handle tokens, independent of JSON parseability.
 *
 * Carried over from S1 unchanged, and for the same reason: the watermark must
 * survive a corrupt or partially-written line. If the only tombstone for a
 * retired handle were lost to a parse failure, that handle would be reissued,
 * and handles are external citations — reuse silently repoints a citation in a
 * doc or a commit at a different idea. Tolerant history reading and durable
 * handle retirement are separate jobs, so they read the log differently.
 */
const HANDLE_TOKEN_RE = /"handle"\s*:\s*"([A-Z][A-Z0-9]*-[1-9][0-9]{0,8})"/g;

/**
 * Durable per-record storage plus the append-only lifecycle log.
 *
 * Deliberately dumb: no validation of record CONTENT (the provider validates
 * against `contracts/fluid-record.schema.json` before handing anything over),
 * no lifecycle rules, no handle allocation. It knows about paths, atomicity and
 * durability, and nothing else.
 */
export class FluidRecordStore {
  /**
   * @param {string} cwd project root
   * @param {object} [config]
   * @param {string} [config.recordsRoot] absolute or project-relative override
   *   (tests point this at a tmp dir)
   */
  constructor(cwd, config = {}) {
    this.cwd = cwd;
    const root = config.recordsRoot ?? DEFAULT_RECORDS_ROOT;
    this.root = join(cwd, root);
    this.recordsDir = join(this.root, RECORDS_DIR);
    this.eventsPath = join(this.root, EVENTS_FILE);
  }

  _pathFor(handle) {
    return join(this.recordsDir, `${assertHandleSafe(handle)}.json`);
  }

  // -------------------------------------------------------------------------
  // Records
  // -------------------------------------------------------------------------

  /**
   * Write a record atomically.
   *
   * tmp + rename, matching `VisionStore._save()`. A half-written record file is
   * worse here than in a single state file: it is not a corrupt blob you notice
   * on load, it is one idea that silently fails to parse while its 19 siblings
   * load fine. The rename makes the file appear whole or not at all.
   *
   * The tmp name carries a random suffix rather than a timestamp so two writers
   * in the same millisecond cannot land on the same tmp path and interleave
   * their bytes.
   */
  write(record) {
    const path = this._pathFor(record.handle);
    mkdirSync(this.recordsDir, { recursive: true });
    // Pretty-printed with a trailing newline: these files are reviewed as
    // diffs. Key order is deterministic because the provider builds every
    // record through one object literal and a re-read preserves that order —
    // NOT via a sorted replacer array, which would also filter nested objects
    // and silently drop `provenance` and every link field.
    const data = JSON.stringify(record, null, 2) + '\n';
    const tmp = `${path}.tmp.${randomUUID()}`;
    try {
      writeFileSync(tmp, data, 'utf8');
      renameSync(tmp, path);
    } catch (err) {
      // A leftover tmp file is invisible to read() (it does not end in .json
      // alone — see list()), but leaving litter in tracked canon would show up
      // in `git status` and in review.
      try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
      throw new Error(`fluid: failed to persist record ${record.handle} — ${err.message}`);
    }
    return record;
  }

  /** @returns {object|null} the record, or null when absent. */
  read(handle) {
    const path = this._pathFor(handle);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      // Loud, not null. Returning null for an unparseable file would make a
      // corrupt record indistinguishable from a deleted one, and the caller's
      // next move on "absent" is to allocate the handle again or report it
      // missing — both of which quietly destroy the damaged record.
      throw new Error(`fluid: record file for ${handle} is unreadable — ${err.message}`);
    }
  }

  /**
   * Every record on disk.
   *
   * Sorted by filename so the enumeration is deterministic regardless of
   * `readdirSync` order, which is filesystem-dependent. The provider re-sorts
   * for presentation; this only guarantees the input to that sort is stable, so
   * a regenerated projection does not churn on an unrelated machine.
   *
   * ONE CORRUPT FILE FAILS THE WHOLE LIST, deliberately. Skipping it would be
   * the friendlier-looking choice and the destructive one: this list is what
   * regenerates `ideabox.md`, so a silently omitted record becomes an idea
   * deleted from tracked markdown by a routine write. Refusing to list at all
   * is recoverable; a projection that quietly drops an idea is not.
   */
  list() {
    if (!existsSync(this.recordsDir)) return [];
    const names = readdirSync(this.recordsDir)
      .filter((n) => n.endsWith('.json') && HANDLE_RE.test(n.slice(0, -'.json'.length)))
      .sort();
    return names.map((n) => {
      const handle = n.slice(0, -'.json'.length);
      const record = this.read(handle);
      if (!record) {
        // Raced against a delete between readdir and read. Not an error; the
        // record is genuinely gone.
        return null;
      }
      return record;
    }).filter(Boolean);
  }

  /** Handles of live records only. Retired handles live in the log. */
  liveHandles() {
    if (!existsSync(this.recordsDir)) return new Set();
    const out = new Set();
    for (const n of readdirSync(this.recordsDir)) {
      if (!n.endsWith('.json')) continue;
      const handle = n.slice(0, -'.json'.length);
      if (HANDLE_RE.test(handle)) out.add(handle);
    }
    return out;
  }

  /** @returns {boolean} whether a file was removed. */
  remove(handle) {
    const path = this._pathFor(handle);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  }

  // -------------------------------------------------------------------------
  // Events — append-only
  // -------------------------------------------------------------------------

  _rawLog() {
    return existsSync(this.eventsPath) ? readFileSync(this.eventsPath, 'utf8') : '';
  }

  /**
   * Append one event.
   *
   * The log is the tombstone ledger: a `created` entry burns its handle
   * permanently, which is what stops a deleted record's handle being handed to
   * a different idea later. It is therefore tracked alongside the records
   * rather than left in the ignored runtime directory — losing it does not lose
   * history, it loses the guarantee.
   */
  appendEvent(event) {
    mkdirSync(this.root, { recursive: true });
    appendFileSync(this.eventsPath, JSON.stringify(event) + '\n', 'utf8');
    return { ok: true };
  }

  /**
   * Handles named anywhere in the raw log, including on lines that fail to
   * parse. See HANDLE_TOKEN_RE.
   */
  issuedHandlesFromLog() {
    const handles = new Set();
    const text = this._rawLog();
    HANDLE_TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = HANDLE_TOKEN_RE.exec(text)) !== null) handles.add(m[1]);
    return handles;
  }

  /** Parsed history, skipping unparseable lines. Handle retirement never
   *  depends on this path — see issuedHandlesFromLog. */
  readEvents() {
    const out = [];
    for (const line of this._rawLog().split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { out.push(JSON.parse(trimmed)); } catch { /* a corrupt line must not
        take the readable history with it */ }
    }
    return out;
  }
}

/*
 * KNOWN GAP, accepted for the floor (unchanged from S1, narrowed by this slice)
 * ----------------------------------------------------------------------------
 * There is still no lock. Two processes writing the SAME handle concurrently
 * can interleave read-modify-write, and last writer wins.
 *
 * What this slice did fix is the worse failure it used to sit behind: with a
 * shared state file and an in-memory snapshot, a stale writer saving unrelated
 * work erased records it had never read. Per-record files plus read-per-
 * operation mean a concurrent write can now only lose an update to the ONE
 * record being contended, never to its siblings.
 *
 * Handle allocation is the remaining sharp edge: two creates racing can compute
 * the same next handle. The pre-write tombstone narrows the window but does not
 * close it. Serializing that needs a lock, and `.compose/locks/` already exists
 * for exactly this — it is S3b's job, when the CLI, the API and the UI are all
 * actually writing.
 */

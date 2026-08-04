/**
 * lib/dir-lock.js — the one advisory lock, extracted.
 *
 * COMP-PLAN-IDEA-UNIFY S3b-1 (D17).
 *
 * `mkdir` is the primitive: it is atomic on every filesystem this runs on, and
 * it fails with EEXIST rather than clobbering. Everything below exists to make
 * that primitive survive the cases a bare `mkdirSync` does not.
 *
 * There were six independent copy-pasted versions of this in `lib/` when this
 * module was written, and they did NOT agree — the weakest set its stale
 * threshold equal to its acquire timeout, which makes ordinary contention
 * indistinguishable from a crashed holder, so a busy lock gets stolen from a
 * live owner. This is the hardened shape (from `lib/judgment-writer.js`),
 * lifted so there is one implementation to reason about instead of six.
 *
 * The four things that are not obvious:
 *
 *  1. **An owner token inside the dir.** Without it, release cannot tell "my
 *     lock" from "the lock that replaced mine after it was declared stale", so
 *     a slow holder deletes the new owner's lock on the way out. This is the
 *     ABA case and it is the reason release reads before it removes.
 *
 *  2. **A partial acquisition is undone.** If the dir is created but the token
 *     write fails, every later release declines to remove a lock it cannot
 *     prove is its own — stranding it until the stale window expires. So that
 *     window is closed by hand rather than waited out.
 *
 *  3. **A heartbeat, and why the threshold is high.** The holder touches the
 *     dir's mtime on a timer so a long-but-live operation is not mistaken for a
 *     dead one. The timer runs on the event loop, so a SYNCHRONOUS block longer
 *     than the stale threshold defeats it. 20s is set well above any sync
 *     section this codebase produces (small-file fs I/O; long work is async).
 *
 *  4. **Stale reclaim is by mtime, not by pid.** A pid check cannot see across
 *     containers or a reused pid, and this lock guards files that two clones
 *     can reach.
 *
 * The lock is advisory: it coordinates writers that agree to use it. Nothing
 * stops a writer that does not, which is why tool-owned canon also has the
 * guard layer.
 */

import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** A holder is presumed dead once its mtime is this old. See note 3. */
const LOCK_STALE_MS = 20000;
/** How long to keep trying before giving up on a live holder. */
const LOCK_ACQUIRE_TIMEOUT_MS = 30000;
/** Keeps a live holder from being declared stale. */
const LOCK_HEARTBEAT_MS = 1000;
/** Poll interval while waiting on a holder. */
const LOCK_RETRY_MS = 25;

/** The holder's token, or null if it cannot be read (racing, or never written). */
function readOwner(ownerFile) {
  try { return readFileSync(ownerFile, 'utf8'); } catch { return null; }
}

export class DirLockTimeout extends Error {
  constructor(path, ms) {
    super(`dir-lock: timed out after ${ms}ms waiting for ${path}`);
    this.name = 'DirLockTimeout';
    this.code = 'DIR_LOCK_TIMEOUT';
    this.path = path;
  }
}

/**
 * Acquire the lock at `path`, returning a release function.
 *
 * @param {string} path directory to create as the lock
 * @returns {Promise<() => void>} release — idempotent, and a no-op if the lock
 *   is no longer provably ours
 */
export async function acquireDirLock(path) {
  const ownerFile = join(path, 'owner');
  mkdirSync(dirname(path), { recursive: true });
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const start = Date.now();

  for (;;) {
    try {
      mkdirSync(path);
      try {
        writeFileSync(ownerFile, token);
      } catch (err) {
        // Note 2: undo our own partial acquisition rather than strand the lock.
        rmSync(path, { recursive: true, force: true });
        throw err;
      }
      const heartbeat = setInterval(() => {
        try {
          utimesSync(path, new Date(), new Date());
        } catch { /* stolen or gone — release will no-op */ }
      }, LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();

      let released = false;
      return () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        try {
          // Note 1: only remove a lock still provably ours.
          if (readFileSync(ownerFile, 'utf8') === token) {
            rmSync(path, { recursive: true, force: true });
          }
        } catch { /* not ours anymore — leave it */ }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const { mtimeMs } = statSync(path);
        if (Date.now() - mtimeMs > LOCK_STALE_MS) {
          // Reclaim is compare-and-delete, not blind delete. Two contenders can
          // both stat the same stale lock and both decide to remove it; if the
          // first then acquires a fresh one, a blind `rmSync` from the second
          // deletes the NEW owner's lock and both proceed into the critical
          // section. That is the ABA case on the acquire side — the release side
          // already guarded against it, and this side did not.
          //
          // Re-reading the owner token and removing only if it still matches
          // what we saw when we judged it stale closes the window: the winner
          // rewrote the token, so the loser's compare fails and it retries.
          const staleOwner = readOwner(ownerFile);
          const { mtimeMs: recheck } = statSync(path);
          if (recheck === mtimeMs && readOwner(ownerFile) === staleOwner) {
            rmSync(path, { recursive: true, force: true });
          }
          continue;
        }
      } catch { /* stat raced the holder's release; loop and retry */ }
      if (Date.now() - start > LOCK_ACQUIRE_TIMEOUT_MS) {
        throw new DirLockTimeout(path, LOCK_ACQUIRE_TIMEOUT_MS);
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}

/**
 * Run `fn` holding the lock at `path`. The lock is always released, including
 * when `fn` throws.
 *
 * Not reentrant: calling this for the same path from inside `fn` deadlocks
 * until the acquire timeout. Callers compose by locking once at the outermost
 * mutating boundary.
 *
 * @template T
 * @param {string} path
 * @param {() => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
export async function withDirLock(path, fn) {
  const release = await acquireDirLock(path);
  try {
    return await fn();
  } finally {
    release();
  }
}

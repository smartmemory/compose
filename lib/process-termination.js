/**
 * process-termination.js — graceful teardown for a spawned agent child process.
 *
 * Compose spawns the Claude Code CLI itself (see `lib/local-claude-connector.js`)
 * so that a cancelled run tears down the WHOLE process tree, not just the leader.
 * The child is spawned `detached: true`, which makes it a process-group leader;
 * signalling `-pid` reaches every descendant.
 *
 * Only what compose uses lives here. The teardown contract is:
 *   SIGTERM the group → wait up to the grace period → SIGKILL anything still
 *   alive → await leader close and group disappearance (bounded at 2 seconds).
 *
 * Grace period: `COMPOSE_CANCEL_GRACE_MS` (default 5000ms).
 *
 * D-TERM-1 (2026-09-07): `-pid` IS still signalled after the leader is reaped.
 * ------------------------------------------------------------------------
 * The open question was whether signalling the group after `close` aims at a
 * pgid the kernel may have recycled to a stranger. It does not, for the whole
 * window that matters:
 *
 *   POSIX 4.13 — "if there exists a process group whose process group ID is
 *   equal to that process ID, the process ID shall not be reused until the
 *   process group lifetime ends" — and a group's lifetime ends only when its
 *   LAST member leaves.
 *
 * So while our group has any living member, `-pid` provably names OUR group,
 * and a living member is exactly the condition teardown is waiting on.
 * Measured on Darwin 25.6.0 rather than taken on faith: with the leader reaped
 * and one grandchild left, 400,000 fork/exit cycles never got the pgid handed
 * back (the pid space is ~100k, so that is four wraps). Emptying the group
 * first, the same pid came back at iteration 98,102 — one full wrap.
 *
 * That measurement RETIRES the fear rather than confirming it: the recycled
 * pgid needs roughly 98,000 process creations between our group emptying and
 * our probe, inside a 2s reap deadline. It is not a millisecond race, and it
 * is the LEAST likely reading of a group-signal failure, not the diagnosis.
 * Keep signalling the group after close — "the group outlives the leader" is
 * correct and load-bearing.
 */

import { execFileSync } from 'node:child_process';

const DEFAULT_GRACE_MS = 5000;

/** Read the configured cancellation grace period. */
function graceMsFromEnv(env = process.env) {
  const raw = env.COMPOSE_CANCEL_GRACE_MS;
  if (raw === undefined || raw === '') return DEFAULT_GRACE_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('COMPOSE_CANCEL_GRACE_MS must be a nonnegative number');
  }
  return value;
}

/**
 * Own the teardown of a spawned child, separately from `child.kill()`, so SDK
 * cleanup cannot bypass the grace period.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {boolean} group — signal the whole process group (child was detached)
 * @param {number} [graceMs]
 * @returns {{ close: Promise<void>, terminate: () => Promise<void>, finish: () => Promise<void> }}
 */
/**
 * Every process currently in `pgid`, so a group-signal failure can be
 * attributed instead of argued about.
 *
 * `ps -g` is NOT portable — BSD reads it as a pgid list, procps as a
 * session/group list — so the whole table is read and filtered here.
 *
 * @returns {Array<object> | {error: string}} never throws: this runs on an
 *   error path, where a second failure would replace the first one.
 */
function groupMembers(pgid) {
  try {
    const table = execFileSync('ps', ['-eo', 'pid=,pgid=,ppid=,uid=,comm='], {
      encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return table.split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter((f) => f.length >= 5 && Number(f[1]) === pgid)
      // `comm` is last and may contain spaces (it is a path), so it takes the tail.
      .map((f) => ({ pid: Number(f[0]), ppid: Number(f[2]), uid: Number(f[3]), comm: f.slice(4).join(' ') }));
  } catch (e) {
    return { error: e?.code ?? e?.message ?? 'unknown' };
  }
}

/**
 * Why a group signal failed, stamped on the error itself.
 *
 * A non-ESRCH failure here is rethrown, relabelled `CANCELLATION_UNCONFIRMED`
 * by `terminate`, and reaches the caller carrying only Node's bare message —
 * `kill EPERM` and nothing else, which is unattributable after the fact: two
 * call sites send group signals.
 *
 * WHAT EPERM MEANS HERE. Measured on Darwin 25.6.0: `kill(-pgid, 0)` against a
 * group of processes we may not signal answers EPERM, not ESRCH. So EPERM says
 * exactly one thing — *a group with this pgid exists and every member refused
 * our signal*. Three sub-causes, deliberately unranked except for the last:
 *
 *   1. a member runs as another uid (a tool child that escalated), or
 *   2. a policy — MAC / sandbox — refused the signal for a member that shares
 *      our uid, so "same uid" does NOT rule this out, or
 *   3. our group is gone and a stranger holds a recycled pgid.
 *
 * (3) was the original hypothesis and is the LEAST likely of the three: per
 * D-TERM-1 above it needs ~98,000 process creations inside a 2s deadline.
 *
 * `killGroupMembers` is what actually separates them, and it is why this
 * function exists at all: uids other than ours point at (1) or (2), and
 * processes plainly unrelated to the run point at (3).
 *
 * `killLeader` is kept but is NOT the discriminator it shipped as. After
 * `close` the leader has been reaped, so it reads `gone` in every realistic
 * recurrence; `ours` / `not-ours` need the same implausible wrap as (3). Do not
 * read `not-ours` as "recycled pgid confirmed" — that inference was wrong.
 *
 * Diagnostic only: it changes no control flow and rethrows the same error.
 */
function describeGroupSignalFailure(error, { site, pid, signal }) {
  error.killSite = site;
  error.killTarget = -pid;
  error.killSignal = signal;
  error.killerPgid = typeof process.getpgrp === 'function' ? process.getpgrp() : null;
  try {
    // The LEADER as a plain pid, not the group. Probing must never throw out of
    // an error path, so every outcome is recorded rather than raised.
    process.kill(pid, 0);
    error.killLeader = 'ours';
  } catch (probe) {
    error.killLeader = probe.code === 'EPERM' ? 'not-ours' : (probe.code === 'ESRCH' ? 'gone' : probe.code);
  }
  error.killGroupMembers = groupMembers(pid);
  const members = Array.isArray(error.killGroupMembers)
    ? (error.killGroupMembers.length
      ? error.killGroupMembers.map((m) => `${m.pid}/uid ${m.uid} ${m.comm}`).join(', ')
      : 'none')
    : `unreadable (${error.killGroupMembers.error})`;
  error.message = `${error.message} (${site} ${String(signal)} → pgid ${pid}; `
    + `leader ${error.killLeader}; our pgid ${error.killerPgid}; our uid ${process.getuid?.() ?? '?'}; `
    + `group members: ${members})`;
  return error;
}

export function processTermination(child, group, graceMs = graceMsFromEnv(), reapTimeoutMs = 2000) {
  let closed = false;
  const close = new Promise((resolve) => child.once('close', () => { closed = true; resolve(); }));
  let teardown;

  const send = (signal) => {
    if (group && child.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') {
          throw describeGroupSignalFailure(error, { site: 'send', pid: child.pid, signal });
        }
      }
    } else if (!closed) {
      child.kill(signal);
    }
  };

  // The group outlives the leader: `close` firing does not mean the descendants
  // are gone, so liveness is probed with signal 0 against the group.
  const alive = () => {
    if (!group || !child.pid) return !closed;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw describeGroupSignalFailure(error, { site: 'alive', pid: child.pid, signal: 0 });
    }
  };

  const terminate = () => {
    teardown ??= (async () => {
      let timer;
      try {
        // INSIDE the try. Outside it, a refused opening SIGTERM escaped with
        // Node's bare `EPERM` as its code, so the one failure the caller is
        // told to expect from a group signal — CANCELLATION_UNCONFIRMED, per
        // `describeGroupSignalFailure` — was the one code it never got. Only
        // the later `alive()` and SIGKILL sites were ever labelled. Found by
        // the D-TERM-1 test below, which is the first test this path ever had.
        send('SIGTERM');
        await Promise.race([
          new Promise((resolve) => { timer = setTimeout(resolve, graceMs); }),
          // A leader that closed while its group lives must still wait out the
          // grace period, so that branch parks on a never-settling promise.
          close.then(() => (alive() ? new Promise(() => {}) : undefined)),
        ]);
        if (alive()) send('SIGKILL');
        await close;
        const deadline = Date.now() + reapTimeoutMs;
        while (group && alive()) {
          if (Date.now() >= deadline) throw Object.assign(new Error(`Process group still exists after ${reapTimeoutMs}ms reap deadline`), { code: 'CANCELLATION_TEARDOWN_TIMEOUT' });
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      } catch (error) {
        if (error.code !== 'CANCELLATION_TEARDOWN_TIMEOUT') error.code = 'CANCELLATION_UNCONFIRMED';
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    void teardown.catch(() => {});
    return teardown;
  };

  return { close, terminate, finish: () => teardown ?? Promise.resolve() };
}

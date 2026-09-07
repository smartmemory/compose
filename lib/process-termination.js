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
 */

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
 * Why a group signal failed, stamped on the error itself.
 *
 * A non-ESRCH failure here is rethrown, relabelled `CANCELLATION_UNCONFIRMED`
 * by `terminate`, and reaches the caller carrying only Node's bare message —
 * `kill EPERM` and nothing else. That is unattributable after the fact: two
 * call sites send group signals, and the question that actually decides what
 * went wrong is gone by the time anyone reads it. Namely, does `-pid` still
 * name OUR group, or one the kernel recycled after the leader was reaped? The
 * group is deliberately signalled after `close` (it outlives its leader), which
 * is exactly the window in which the pid becomes reusable.
 *
 * EPERM on the leader probe means "alive but not ours" — the canonical reading
 * in this repo (COMP-GSD-6 D-C, `gsd-state.js` `pidAlive`) — and a leader that
 * is alive-but-not-ours is the recycled-pgid case named outright.
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
  error.message = `${error.message} (${site} ${String(signal)} → pgid ${pid}; `
    + `leader ${error.killLeader}; our pgid ${error.killerPgid})`;
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
      send('SIGTERM');
      let timer;
      try {
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

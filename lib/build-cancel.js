/**
 * build-cancel.js — the build-level cancel handle and its in-process registry.
 *
 * Extracted from lib/build.js so the teardown handshake (§3.6) is unit-testable with
 * fakes and lib/build.js does not keep growing. `looksCancelled` (S05) and
 * `runCancelTeardown` (S06) land here in later slices; this file exists starting in S03
 * because S03 is the first slice that needs a symbol from it.
 */

/**
 * One handle, created once per `runBuild`, threaded through the build as `buildCancel`.
 *
 * TWO independent states (C27). `cancelled` is set by anyone — the signal handler, the
 * cross-process detector, or a same-process `abortBuild`. `teardownStarted` is set ONLY by
 * `runCancelTeardown`. Collapsing them would make the FIRST Ctrl-C after a detected
 * cross-process cancel take the second-signal branch and skip the teardown entirely.
 */
export function createBuildCancel() {
  const controller = new AbortController();
  const state = { cancelled: false, reason: null, at: null, teardownStarted: false };
  let resolveDrained;
  const drained = new Promise((resolve) => { resolveDrained = resolve; });
  return {
    signal: controller.signal, // -> runAndNormalize opts.buildSignal (C13)
    get cancelled() { return state.cancelled; },
    get reason() { return state.reason; },
    get at() { return state.at; },
    get teardownStarted() { return state.teardownStarted; },
    /** Idempotent. Returns true only for the FIRST caller. */
    cancel(reason) {
      if (state.cancelled) return false;
      state.cancelled = true;
      state.reason = reason;
      state.at = new Date().toISOString();
      controller.abort(new Error(`build cancelled: ${reason}`));
      return true;
    },
    /** Returns true only for the FIRST teardown, which is what forces a second signal to exit. */
    beginTeardown() {
      if (state.teardownStarted) return false;
      state.teardownStarted = true;
      return true;
    },
    // C37/§3.6. `teardown` is set synchronously by runCancelTeardown before its first await, so
    // the outer catch can see it and stand down. `drained` is resolved by the build's inner
    // finally once its resources are closed, so the teardown's writes cannot race
    // finalizeBuildAttempt. Both are plain promises; both waits on them are bounded.
    teardown: null,
    drained,
    resolveDrained,
  };
}

/** flowId -> BuildCancel, for builds running in THIS process. A same-process abort must
 *  cancel through the handle, never by signalling a pid: on the HTTP path that pid is the
 *  compose server itself (server/build-routes.js:134 and :151). Module-level and therefore
 *  per-process: a foreign build is unreachable through it by construction, and that absence
 *  is the signal that the pid path applies. */
const activeBuildCancels = new Map();

export function registerBuildCancel(flowId, handle) {
  if (flowId) activeBuildCancels.set(flowId, handle);
}

export function unregisterBuildCancel(flowId) {
  if (flowId) activeBuildCancels.delete(flowId);
}

export function lookupBuildCancel(flowId) {
  return (flowId && activeBuildCancels.get(flowId)) ?? null;
}

/** The teardown in flight for ANY build in this process, or null. The CLI awaits it before
 *  exiting; it is an accessor rather than an export of the handle so the CLI never needs to
 *  know which build it belongs to. */
export function pendingTeardown() {
  for (const handle of activeBuildCancels.values()) if (handle.teardown) return handle.teardown;
  return null;
}

/** The AUTHORITY on "was this run cancelled". stratum_audit succeeds on a cancelled run
 *  (stratum/ts/src/engine/engine.ts:1057-1061), unlike stepDone/gateResolve/resume, which
 *  refuse. Returns false on any audit failure: an unreachable engine is not evidence of a
 *  cancel, and treating it as one would abandon a live build. */
export async function isRunCancelled(stratum, flowId) {
  if (!stratum || !flowId) return false;
  try {
    const audit = await stratum.audit(flowId);
    return audit?.status === 'cancelled';
  } catch {
    return false;
  }
}

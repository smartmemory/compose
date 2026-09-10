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

/**
 * Resolve a promise, or reject at `ms`. The single bounded-wait primitive this file
 * uses; exported because `runBuild`'s outermost finally joins on the teardown with
 * the same bound.
 */
export function withDeadline(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`deadline exceeded after ${ms}ms`)), ms);
    }),
  ]);
}

/**
 * The two teardown deadlines and the join bound DERIVED from them (C46).
 *
 * `cancelMs` is `COMPOSE_CANCEL_TIMEOUT_MS`, the variable the client already reads
 * (lib/stratum-mcp-client.js:304) — one knob, not two. `joinMs` is never a chosen
 * constant: any smaller bound expires before the teardown's own worst case and hands
 * the exit back to the CLI mid-write.
 */
export function cancelBudgets(env = process.env) {
  const cancelMs = Number(env.COMPOSE_CANCEL_TIMEOUT_MS ?? 15000);
  const drainMs = Number(env.COMPOSE_TEARDOWN_DRAIN_MS ?? 10000);
  return { cancelMs, drainMs, joinMs: cancelMs + drainMs + 1000 };
}

/**
 * Bounded, idempotent teardown for SIGINT/SIGTERM (§9 S06-1). Every dependency is
 * injected, so the whole sequence runs under test with a fake client, a fake process
 * and injected deadlines. It NEVER awaits the build pump — it races it.
 *
 * Absent by design: `emitActuals` and `closeStream`. Both belong to the build's inner
 * `finally`; `finalizeBuildAttempt` (lib/build.js:2294-2301) is the single actuals
 * emitter and is already idempotent through `attemptFinalized` (C45).
 */
export async function runCancelTeardown({
  buildCancel, signal, flowId, flowCancel, timeoutMs, drainMs,
  killVision, writeTerminal, removeListeners, exit, log,
}) {
  // C27: key the force-exit on teardownStarted, NOT on cancelled. By the time a user
  // presses Ctrl-C the handle may ALREADY be cancelled — the cross-process detector
  // sets it — and keying on that would make the FIRST signal behave like a second
  // and skip the teardown entirely.
  if (!buildCancel.beginTeardown()) { exit(signal === 'SIGINT' ? 130 : 143); return; }
  buildCancel.cancel(`signal:${signal}`);   // idempotent; records the reason if it is first
  try {
    await withDeadline(flowCancel(flowId), timeoutMs);
  } catch (error) {
    // `already_cancelled` is success: abortBuild got here first. Anything else is
    // reported and does not stop the local teardown — the local record must not be
    // left `running`.
    if (error?.reason !== 'already_cancelled') {
      log(`flow cancel: ${error?.reason ?? error?.code ?? error?.message}`);
    }
  }
  // §3.6: wait for the build's own finally to close its resources and emit actuals, so
  // this teardown's writes cannot race finalizeBuildAttempt. Bounded, because a wedged
  // pump never reaches that finally and D-E forbids awaiting the pump.
  await withDeadline(buildCancel.drained, drainMs).catch(() => undefined);
  try { await killVision(); } catch { /* best-effort */ }
  try { writeTerminal(); } catch { /* best-effort */ }   // identity-claimed, §3.7
  removeListeners();
  exit(signal === 'SIGINT' ? 130 : 143);                 // the ONLY exit on this path
}

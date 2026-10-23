// Shared "wait for async delivery" helper for tests (COMP-TEST-WAIT-POLL-1).
//
// The class: a test waits for something the OS or another process delivers
// (fs.watch / FSEvents, an SSE or WebSocket frame, a child process finishing
// startup) and bounds the wait with a fixed sleep or a short loop. Those hold on an
// idle machine and fail under load (measured 2026-10-24: tmpdir fs.watch first-event
// latency 1.0-1.5 s with fseventsd at ~100% CPU, 1 of 5 never delivered). Poll the
// CONDITION, return the moment it holds, and give the deadline real headroom: a
// healthy run pays nothing for a long deadline, a stalled one still fails loudly.
//
// Not for negative assertions ("nothing arrives"): those need a fixed window by
// nature and stay as they are.

export const POLL_DEADLINE_MS = 30_000;

/**
 * Poll `check()` (sync or async) until it returns a truthy value, then return it.
 * A throw from `check` counts as "not yet" unless `rethrow(err)` returns true
 * (use it to abort early, e.g. when the child process under test already died).
 * Throws `Timed out after <ms>: <label>` at the deadline.
 */
export async function pollUntil(check, label, {
  timeoutMs = POLL_DEADLINE_MS, intervalMs = 25, rethrow = () => false,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      if (rethrow(err)) throw err;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

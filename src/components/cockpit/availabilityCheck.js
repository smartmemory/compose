/**
 * availabilityCheck.js — the one availability probe behind the Ops, Stratum, Cadence and Wiki
 * hooks (COMP-AUDIT-17, FORGE-PL L1). Pure async, no React.
 *
 * A transient failure is not "no". Only a definitive answer sets `no`: a 2xx or 4xx response whose
 * body says so. A network error or a 5xx keeps the state `unknown`, retries once after `retryMs`
 * and logs `[nav] <name> availability check failed: <reason>` once, so a stored view for a gated
 * tab never jumps to Home on a server restart.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} o
 * @param {string} o.name      short name for the warning ('ops', 'stratum', 'cadence', 'wiki')
 * @param {string} o.url
 * @param {(json: any) => 'yes'|'no'} o.decide   maps a response body to the definitive state
 * @param {() => boolean} [o.isLive]             false once the caller unmounted: stop quietly
 * @returns {Promise<{state: 'yes'|'no'|'unknown', json: any}>}
 */
export async function checkAvailability({
  name, url, decide, fetchFn = (...a) => fetch(...a), wait = sleep, warn = (...a) => console.warn(...a), retryMs = 3000, isLive = () => true,
}) {
  let warned = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let reason;
    try {
      const r = await fetchFn(url);
      if (r.ok) {
        const json = await r.json();
        return { state: decide(json), json };
      }
      if (r.status < 500) return { state: 'no', json: null };
      reason = `HTTP ${r.status}`;
    } catch (err) {
      reason = err?.message || String(err);
    }
    if (!isLive()) return { state: 'unknown', json: null };
    if (!warned) {
      warn(`[nav] ${name} availability check failed: ${reason}`);
      warned = true;
    }
    if (attempt === 0) {
      await wait(retryMs);
      if (!isLive()) return { state: 'unknown', json: null };
    }
  }
  return { state: 'unknown', json: null };
}

/**
 * COMP-SUBAPP-ATTENTION-FU-2 (F3): `checkAvailability` again every `recheckMs` while it stays `unknown`, until it settles
 * (`yes` or `no`, passed to `onSettled`) or `cancel()` is called. Only the first round logs its failure, plus one line saying
 * a recheck is scheduled, so a server that is down for an hour does not log every 30 s. Returns `cancel`.
 */
export function checkUntilSettled({ onSettled, recheckMs, warn = (...a) => console.warn(...a), setTimer = setTimeout, clearTimer = clearTimeout, ...opts }) {
  let live = true;
  let timer = null;
  let round = 0;
  const run = () => {
    if (!live) return; // a timer that fired after cancel()
    const first = round === 0;
    round += 1;
    checkAvailability({ ...opts, warn: first ? warn : () => {}, isLive: () => live }).then(({ state }) => {
      if (!live) return;
      if (state !== 'unknown') { onSettled(state); return; }
      if (first) warn(`[nav] ${opts.name} availability unknown; rechecking every ${Math.round(recheckMs / 1000)} s`);
      timer = setTimer(run, recheckMs);
    });
  };
  run();
  return () => { live = false; clearTimer(timer); };
}

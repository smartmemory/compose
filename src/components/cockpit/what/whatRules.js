/**
 * whatRules.js — COMP-COCKPIT-WHAT-LINE-1: the rule table behind Home's status line. Pure, no React, no network.
 *
 * Raw inputs: `{fleet, agent, index, now, lastVisitAt}`: `fleet` the GET /api/fleet body, `agent` the
 * `compose:agent-status` event detail, `index` the GET /api/units/index body, `now` epoch ms, `lastVisitAt` epoch ms
 * from `localStorage['compose:lastVisitAt']` (or null). The state word comes from the first row of `WHAT_RULES` that
 * matches. It is never produced by a model; the table is shown on hover so the sentence can be checked by reading it.
 * A count whose source is unknown is `null` (rendered "?"), never 0.
 */
import { readerUp, smPanel, runningNow } from '../fleetLogic.js';

export const MOVING_WINDOW_H = 2;
export const LAST_VISIT_KEY = 'compose:lastVisitAt';

const ms = (v) => { const t = Date.parse(v ?? ''); return Number.isFinite(t) ? t : null; };

/** Everything the rules and counts read, derived once from the raw inputs. null = that source is unknown. */
export function whatInputs({ fleet, agent, index, now = Date.now(), lastVisitAt = null } = {}) {
  const running = runningNow(fleet, agent);
  const units = Array.isArray(index?.units) ? index.units : null;
  const queue = smPanel(fleet, 'queue');
  const landed = units ? units.map((u) => ms(u?.landedAt)).filter((t) => t !== null) : null;
  const windowStart = now - MOVING_WINDOW_H * 3_600_000;
  const waitingIndex = units ? units.filter((u) => u?.waiting === 'review' || u?.waiting === 'owner').length : null;
  return {
    smUp: readerUp(fleet, 'sm_status'),
    units,
    running,
    isRunning: running.composeWorking || (running.busy ?? 0) > 0 || (running.jobs ?? 0) > 0,
    landedInWindow: landed ? landed.some((t) => t >= windowStart) : false,
    waitingAny: (waitingIndex ?? 0) + (Array.isArray(queue?.value) ? queue.value.length : 0) > 0,
    landed,
    queueRows: Array.isArray(queue?.value) ? queue.value.length : null,
    lastVisitAt: Number.isFinite(lastVisitAt) ? lastVisitAt : null,
  };
}

/** Ordered, first match wins. `when` is the plain-words rule shown on hover. */
export const WHAT_RULES = [
  { state: 'Unknown', when: 'the fleet status reader is down and the unit index has not loaded', test: (i) => !i.smUp && !i.units },
  { state: 'Moving', when: `a unit landed in the last ${MOVING_WINDOW_H} hours`, test: (i) => i.landedInWindow },
  { state: 'Working, nothing landed', when: `something is running (Compose's agent, a busy session or a live job) and nothing landed in the last ${MOVING_WINDOW_H} hours`, test: (i) => i.isRunning },
  { state: 'Stalled', when: 'nothing is running and at least one unit waits on a review or on you', test: (i) => i.waitingAny },
  { state: 'Idle', when: `nothing is running, nothing waits and nothing landed in the last ${MOVING_WINDOW_H} hours`, test: () => true },
];

/** The matching row of `WHAT_RULES` for raw inputs. */
export function whatRule(raw) {
  const i = whatInputs(raw);
  return WHAT_RULES.find((r) => r.test(i));
}

export function whatState(raw) {
  return whatRule(raw).state;
}

/** `{working, waitingReview, waitingYou, landedSinceVisit}`, each a number or null when its source is unknown. */
export function whatCounts(raw) {
  const i = whatInputs(raw);
  const { running } = i;
  return {
    working: running.fleetKnown ? running.busy + running.jobs + (running.composeWorking ? 1 : 0) : null,
    waitingReview: i.units ? i.units.filter((u) => u?.waiting === 'review').length : null,
    waitingYou: i.queueRows,
    landedSinceVisit: i.landed && i.lastVisitAt !== null ? i.landed.filter((t) => t > i.lastVisitAt).length : null,
  };
}

/** Read the stored last-visit time; null when absent or storage throws. */
export function readLastVisit(storage = globalThis.localStorage) {
  try {
    const n = Number(storage?.getItem(LAST_VISIT_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

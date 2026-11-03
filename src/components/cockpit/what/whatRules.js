/**
 * whatRules.js — COMP-COCKPIT-WHAT-LINE-1: the rule table behind Home's status line. Pure, no React, no network.
 *
 * Raw inputs: `{fleet, agent, index, now, lastVisitAt}`: `fleet` the GET /api/fleet body, `agent` the
 * `compose:agent-status` event detail, `index` the GET /api/units/index body, `now` epoch ms, `lastVisitAt` epoch ms
 * from `localStorage['compose:lastVisitAt']` (or null), `notifyState` Compose's notify list (`useNotifyState`, or null). The state word comes from the first row of `WHAT_RULES` that
 * matches. It is never produced by a model; the table is shown on hover so the sentence can be checked by reading it.
 * A count whose source is unknown is `null` (rendered "?"), never 0. The rule inputs `landedInWindow`, `waitingAny` and
 * `isRunning` are tri-state (true, false, null = unknown) for the same reason (COMP-COCKPIT-UNKNOWN-FU-1): a positive known
 * signal still wins, but "Idle" is only said when every input is known false.
 */
import { readerUp, smPanel, runningNow } from '../fleetLogic.js';
import { ownerAsks } from '../notify/notifyLogic.js';

export const MOVING_WINDOW_H = 2;
export const LAST_VISIT_KEY = 'compose:lastVisitAt';

const ms = (v) => { const t = Date.parse(v ?? ''); return Number.isFinite(t) ? t : null; };

/** Everything the rules and counts read, derived once from the raw inputs. null = that source is unknown. */
export function whatInputs({ fleet, agent, index, now = Date.now(), lastVisitAt = null, notifyState = null } = {}) {
  const running = runningNow(fleet, agent);
  const units = Array.isArray(index?.units) ? index.units : null;
  const owner = ownerAsks(smPanel(fleet, 'queue')?.value, notifyState, now); // COUNT-ONE-1: the chip's own count; NOTIFY-ACTIONS-1: same state as the chip
  const landed = units ? units.map((u) => ms(u?.landedAt)).filter((t) => t !== null) : null;
  const windowStart = now - MOVING_WINDOW_H * 3_600_000;
  const waitingIndex = units ? units.filter((u) => u?.waiting === 'review' || u?.waiting === 'owner').length : null;
  return {
    smUp: readerUp(fleet, 'sm_status'),
    units,
    running,
    isRunning: running.composeWorking || (running.busy ?? 0) > 0 || (running.jobs ?? 0) > 0 ? true : running.fleetKnown ? false : null,
    landedInWindow: landed ? landed.some((t) => t >= windowStart) : null,
    waitingAny: (waitingIndex ?? 0) + (owner?.n ?? 0) > 0 ? true : waitingIndex === null || owner === null ? null : false,
    landed,
    ownerCount: owner ? owner.n : null,
    lastVisitAt: Number.isFinite(lastVisitAt) ? lastVisitAt : null,
  };
}

/** What the inputs cannot say, in words ("the unit index is incomplete"), or null when every rule input is known. */
export function unknownWhat(i) {
  const parts = [];
  if (i.landedInWindow === null) parts.push('the unit index is incomplete or not loaded');
  if (i.waitingAny === null) parts.push(i.units ? 'the owner queue is unreadable' : 'the unit index or the owner queue is unreadable');
  if (i.isRunning === null) parts.push('the fleet is unreadable');
  return parts.length ? [...new Set(parts)].join('; ') : null;
}

// A positive known signal decides its state whatever else is unknown; only a verdict that needs an unknown input is Unknown.
const positive = (i) => i.landedInWindow === true || i.isRunning === true || i.waitingAny === true;

/** Ordered, first match wins. `when` is the plain-words rule shown on hover. */
export const WHAT_RULES = [
  { state: 'Unknown', when: 'no landing, running agent or open ask is known, and a source the answer needs is unknown (the fleet is unreadable, or the unit index is incomplete or not loaded)', test: (i) => !positive(i) && unknownWhat(i) !== null },
  { state: 'Moving', when: `a unit landed in the last ${MOVING_WINDOW_H} hours`, test: (i) => i.landedInWindow === true },
  { state: 'Working, nothing landed', when: `something is running (Compose's agent, a busy session or a live job) and nothing landed in the last ${MOVING_WINDOW_H} hours`, test: (i) => i.isRunning === true },
  { state: 'Stalled', when: 'nothing is running and at least one unit waits on a review or on you', test: (i) => i.waitingAny === true },
  { state: 'Idle', when: `nothing is running, nothing waits and nothing landed in the last ${MOVING_WINDOW_H} hours, all three known`, test: () => true },
];

/** The matching row of `WHAT_RULES` for raw inputs; the Unknown row also carries `reason`, what is unknown. */
export function whatRule(raw) {
  const i = whatInputs(raw);
  const row = WHAT_RULES.find((r) => r.test(i));
  return row.state === 'Unknown' ? { ...row, reason: unknownWhat(i) } : row;
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
    waitingYou: i.ownerCount,
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

/**
 * homeSectionsState.js — pure derivation of the Home sections (COMP-AUDIT-18).
 *
 * Everything comes from data the cockpit store already holds. Callers pass the
 * UNFILTERED items and gates (not the phase-filtered ones), so a sidebar phase
 * filter can never hide a pending gate from "Needs you".
 */
import { computeAttentionQueue, ATTENTION_PRIORITY } from './attentionQueueState.js';

export const HOME_RECENT_LIMIT = 5;
const ERROR_LIMIT = 3;
const DONE_STATUSES = ['complete', 'done'];

function isFeature(item) {
  return item?.type === 'feature';
}

function time(iso) {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/**
 * @returns {{
 *   needsYou: { gates: {gate: object, item: object|null}[], queue: object[], errors: object[] },
 *   running: { build: object|null, agents: object[] },
 *   inProgress: object[],
 *   recentlyChanged: object[],
 *   recentBuilds: object[],
 * }}
 */
export function deriveHomeSections({ items = [], gates = [], agentErrors = [], activeBuild = null, spawnedAgents = [], buildHistory = [] } = {}) {
  const itemById = new Map(items.map(i => [i.id, i]));

  // "Pending" is the gate badge's rule: status === 'pending'.
  const pendingGates = gates
    .filter(g => g.status === 'pending')
    .map(gate => ({ gate, item: itemById.get(gate.itemId) ?? null }));

  // Blocked items and open decisions; pending gates are listed as their own rows.
  const queue = computeAttentionQueue(items, gates)
    .filter(e => e.priority === ATTENTION_PRIORITY.BLOCKED || e.priority === ATTENTION_PRIORITY.DECISION);

  const errors = agentErrors.slice(-ERROR_LIMIT).reverse();

  const inProgress = items.filter(i => isFeature(i) && i.status === 'in_progress');

  // `updatedAt` is last-edit time, not completion time: the section says "last changed".
  const recentlyChanged = items
    .filter(i => isFeature(i) && DONE_STATUSES.includes(i.status))
    .sort((a, b) => time(b.updatedAt) - time(a.updatedAt))
    .slice(0, HOME_RECENT_LIMIT);

  return {
    needsYou: { gates: pendingGates, queue, errors },
    running: { build: activeBuild || null, agents: spawnedAgents.filter(a => a.status === 'running') },
    inProgress,
    recentlyChanged,
    recentBuilds: buildHistory.slice(0, HOME_RECENT_LIMIT),
  };
}

export function needsYouCount(needsYou) {
  return needsYou.gates.length + needsYou.queue.length + needsYou.errors.length;
}

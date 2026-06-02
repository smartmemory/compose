/**
 * budget-ledger.js — Cumulative iteration budget tracking across sessions.
 *
 * Ledger file: .compose/data/budget-ledger.json
 * Shape: { features: { [featureCode]: { totalIterations, totalActions, totalTimeMs, sessions[] } } }
 */

import fs from 'node:fs';
import path from 'node:path';

const LEDGER_FILE = 'budget-ledger.json';

function ledgerPath(composeDir) {
  return path.join(composeDir, 'data', LEDGER_FILE);
}

/**
 * Read the ledger file. Returns empty structure if missing.
 * @param {string} composeDir — path to .compose directory
 */
export function readLedger(composeDir) {
  const filePath = ledgerPath(composeDir);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { features: {} };
    }
    throw err;
  }
}

/**
 * Record an iteration completion event for a feature.
 * Creates the ledger file if it does not exist.
 *
 * @param {string} composeDir
 * @param {string} featureCode
 * @param {{ iterations: number, actions: number, timeMs: number }} entry
 */
export function recordIteration(composeDir, featureCode, { iterations = 1, actions = 0, timeMs = 0 } = {}) {
  const filePath = ledgerPath(composeDir);
  const ledger = readLedger(composeDir);

  if (!ledger.features[featureCode]) {
    ledger.features[featureCode] = { totalIterations: 0, totalActions: 0, totalTimeMs: 0, sessions: [] };
  }
  const feat = ledger.features[featureCode];
  feat.totalIterations += iterations;
  feat.totalActions += actions;
  feat.totalTimeMs += timeMs;
  feat.sessions.push({ recordedAt: new Date().toISOString(), iterations, actions, timeMs });

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(ledger, null, 2), 'utf-8');
  return feat;
}

/**
 * Check whether a feature has exceeded its cumulative budget.
 *
 * @param {string} composeDir
 * @param {string} featureCode
 * @param {{ maxTotalIterations?: number, maxTotalActions?: number }} limits
 * @returns {{ exceeded: boolean, reason: string|null, usage: object }}
 */
export function checkCumulativeBudget(composeDir, featureCode, limits = {}) {
  const ledger = readLedger(composeDir);
  const feat = ledger.features[featureCode] ?? { totalIterations: 0, totalActions: 0, totalTimeMs: 0, sessions: [] };

  const usage = {
    totalIterations: feat.totalIterations,
    totalActions: feat.totalActions,
    totalTimeMs: feat.totalTimeMs,
  };

  if (limits.maxTotalIterations != null && feat.totalIterations >= limits.maxTotalIterations) {
    return { exceeded: true, reason: `Cumulative iteration limit reached (${feat.totalIterations}/${limits.maxTotalIterations})`, usage };
  }
  if (limits.maxTotalActions != null && feat.totalActions >= limits.maxTotalActions) {
    return { exceeded: true, reason: `Cumulative action limit reached (${feat.totalActions}/${limits.maxTotalActions})`, usage };
  }

  return { exceeded: false, reason: null, usage };
}

// ===========================================================================
// COMP-GSD-4: cumulative gsd-run usage (tokens + cost). Shares the per-feature
// ledger entry with COMP-BUDGET's iteration tracking, adding two
// back-compatible fields (totalTokens/totalCostUsd; absent on legacy entries
// reads as 0). Wall-clock/dispatch are per-RUN windows enforced by the stratum
// flow budget — NOT cumulative-checked here (design Decision 3).
// ===========================================================================

/**
 * Record a gsd run's token/cost (and informational dispatch/time) usage,
 * sourced from the stratum terminal envelope's budget_state.consumed.
 *
 * @param {string} composeDir — path to .compose directory
 * @param {string} featureCode
 * @param {{ tokens?: number, costUsd?: number, dispatches?: number, timeMs?: number }} usage
 */
export function recordGsdUsage(composeDir, featureCode, { tokens = 0, costUsd = 0, dispatches = 0, timeMs = 0 } = {}) {
  const filePath = ledgerPath(composeDir);
  const ledger = readLedger(composeDir);

  if (!ledger.features[featureCode]) {
    ledger.features[featureCode] = { totalIterations: 0, totalActions: 0, totalTimeMs: 0, sessions: [] };
  }
  const feat = ledger.features[featureCode];
  feat.totalTokens = (feat.totalTokens ?? 0) + tokens;
  feat.totalCostUsd = (feat.totalCostUsd ?? 0) + costUsd;
  feat.totalTimeMs = (feat.totalTimeMs ?? 0) + timeMs;
  feat.sessions.push({ recordedAt: new Date().toISOString(), kind: 'gsd', tokens, costUsd, dispatches, timeMs });

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(ledger, null, 2), 'utf-8');
  return feat;
}

/**
 * Check whether a feature has exceeded its cumulative gsd token/cost ceiling.
 * Cumulative tokens/cost persist across sessions (a hard ceiling that blocks
 * resume); per-run wall-clock/dispatch reset each run, so they are not checked.
 *
 * @param {string} composeDir
 * @param {string} featureCode
 * @param {{ maxTotalTokens?: number, maxTotalCostUsd?: number }} limits
 * @returns {{ exceeded: boolean, reason: string|null, usage: object }}
 */
export function checkGsdCumulativeBudget(composeDir, featureCode, limits = {}) {
  const ledger = readLedger(composeDir);
  const feat = ledger.features[featureCode] ?? {};
  const usage = {
    totalTokens: feat.totalTokens ?? 0,
    totalCostUsd: feat.totalCostUsd ?? 0,
  };

  if (limits.maxTotalTokens != null && usage.totalTokens >= limits.maxTotalTokens) {
    return { exceeded: true, reason: `Cumulative token ceiling reached (${usage.totalTokens}/${limits.maxTotalTokens})`, usage };
  }
  if (limits.maxTotalCostUsd != null && usage.totalCostUsd >= limits.maxTotalCostUsd) {
    return { exceeded: true, reason: `Cumulative cost ceiling reached ($${usage.totalCostUsd.toFixed(4)}/$${Number(limits.maxTotalCostUsd).toFixed(4)})`, usage };
  }

  return { exceeded: false, reason: null, usage };
}

/**
 * Clear the cumulative gsd usage for a feature (the `--reset-budget` path).
 * Preserves COMP-BUDGET iteration fields; zeroes only the gsd token/cost
 * counters and drops gsd sessions. No-op when the feature has no ledger entry.
 *
 * @param {string} composeDir
 * @param {string} featureCode
 */
export function resetGsdUsage(composeDir, featureCode) {
  const filePath = ledgerPath(composeDir);
  const ledger = readLedger(composeDir);
  const feat = ledger.features[featureCode];
  if (!feat) return;
  feat.totalTokens = 0;
  feat.totalCostUsd = 0;
  if (Array.isArray(feat.sessions)) {
    feat.sessions = feat.sessions.filter((s) => s.kind !== 'gsd');
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(ledger, null, 2), 'utf-8');
}

/**
 * Read a snapshot budget response for a feature without throwing on quota.
 * Used by GET /api/lifecycle/budget.
 *
 * v1 limitation: the ledger aggregates all loop types together under
 * `totalIterations`; it doesn't track per-loopType iteration counts.
 * `per_loop_type[lt].usedIterations` therefore reflects the feature-wide
 * total rather than a per-loop-type breakdown.
 *
 * @param {string} composeDir
 * @param {string} featureCode
 * @param {object} [settings] — compose settings object (may be undefined)
 * @returns {{ featureCode, feature_total, per_loop_type, computed_at }}
 */
export function readBudget(composeDir, featureCode, settings) {
  const ledger = readLedger(composeDir);
  const feat = ledger.features[featureCode] ?? {
    totalIterations: 0,
    totalActions: 0,
    totalTimeMs: 0,
  };

  const feature_total = {
    usedIterations: feat.totalIterations,
    usedActions: feat.totalActions,
    totalTimeMs: feat.totalTimeMs,
  };

  const loopTypes = ['review', 'coverage'];
  const per_loop_type = {};
  for (const lt of loopTypes) {
    const maxTotal = settings?.iterations?.[lt]?.maxTotal ?? null;
    const usedIterations = feature_total.usedIterations; // v1: feature-wide proxy
    const remaining = maxTotal != null ? Math.max(0, maxTotal - usedIterations) : null;
    per_loop_type[lt] = { usedIterations, maxTotal, remaining };
  }

  return {
    featureCode,
    feature_total,
    per_loop_type,
    computed_at: new Date().toISOString(),
  };
}

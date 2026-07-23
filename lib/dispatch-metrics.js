/**
 * dispatch-metrics.js — read-only aggregation over the dispatch ledger.
 *
 * This module deliberately keeps the ledger's append-only observations intact:
 * settlements and terminal actuals are reduced at read time by their `_seq`.
 */

import { readEvents } from './dispatch-ledger.js';

const RETRY_NOTE = 'known undercount: child flows';
const GSD_NOTE = 'not instrumented';

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function upperMiddle(values) {
  const sorted = values.filter(isNumber).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function highestBy(rows, key) {
  const result = new Map();
  for (const row of rows) {
    const current = result.get(row[key]);
    if (!current || row._seq > current._seq) result.set(row[key], row);
  }
  return result;
}

function compareNullable(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return String(a).localeCompare(String(b));
}

function collectRowStats(dispatches, settlements, { gsd = false } = {}) {
  const tokenValues = dispatches.map((row) => row.tokens_total).filter(isNumber);
  const durationValues = dispatches.map((row) => row.duration_ms).filter(isNumber);
  const settled = dispatches
    .map((row) => settlements.get(row.dispatch_id))
    .filter(Boolean);
  const accepted = settled.filter((row) => row.accepted).length;
  const retryEligible = dispatches.filter((row) => isNumber(row.attempt));
  const retries = retryEligible.filter((row) => row.attempt > 1).length;

  return {
    token_sample_count: tokenValues.length,
    null_usage_count: dispatches.filter((row) => !isNumber(row.tokens_total)).length,
    median_tokens: upperMiddle(tokenValues),
    duration_sample_count: durationValues.length,
    median_duration_ms: upperMiddle(durationValues),
    completion: {
      ok: dispatches.filter((row) => row.outcome === 'ok').length,
      total: dispatches.length,
      rate: rate(dispatches.filter((row) => row.outcome === 'ok').length, dispatches.length),
    },
    acceptance: {
      accepted,
      settled: settled.length,
      rate: rate(accepted, settled.length),
      note: gsd ? GSD_NOTE : null,
    },
    retry: {
      retries,
      eligible: retryEligible.length,
      rate: rate(retries, retryEligible.length),
      note: RETRY_NOTE,
    },
    usd_total: dispatches.reduce((total, row) => total + (isNumber(row.usd) ? row.usd : 0), 0),
  };
}

function realizedLane(actual) {
  if (actual.escalations >= 1 || actual.review_iterations >= 3 || actual.files_changed_count >= 6) return 'complex';
  if (actual.files_changed_count <= 2 && actual.review_iterations <= 1 && actual.escalations === 0) return 'trivial';
  return 'standard';
}

function acrrSummary(rows) {
  const total = rows.length;
  const matched = rows.filter((row) => row.matched).length;
  return { matched, total, rate: rate(matched, total) };
}

/**
 * Aggregate dispatch, settlement, estimate, and terminal actual rows without
 * mutating the ledger.
 *
 * @param {string} projectCwd
 * @param {{ since?: string|number|Date, feature?: string }} [opts]
 * @returns {object}
 */
export function collectDispatchMetrics(projectCwd, { since, feature } = {}) {
  // Settlements have no feature code. Read one since-filtered population first,
  // then join them to the feature-filtered dispatches below.
  const allRows = readEvents(projectCwd, { since });
  const inFeature = (row) => !feature || row.feature_code === feature;
  const dispatches = allRows.filter((row) => row.kind === 'dispatch' && inFeature(row));
  const settlements = highestBy(allRows.filter((row) => row.kind === 'settlement'), 'dispatch_id');

  const modelBuckets = new Map();
  for (const row of dispatches) {
    const executed = row.effort_executed ?? null;
    const intendedWhenUnknown = executed === null ? (row.effort_intended ?? null) : null;
    const values = [row.model ?? null, executed, intendedWhenUnknown];
    const key = JSON.stringify(values);
    if (!modelBuckets.has(key)) modelBuckets.set(key, { values, rows: [] });
    modelBuckets.get(key).rows.push(row);
  }
  const model_effort = [...modelBuckets.values()]
    .sort((a, b) => compareNullable(a.values[0], b.values[0]) || compareNullable(a.values[1], b.values[1]) || compareNullable(a.values[2], b.values[2]))
    .map(({ values: [model, effort_executed, effort_intended_when_unknown], rows }) => {
      const stats = collectRowStats(rows, settlements, { gsd: rows.every((row) => row.site === 'gsd') });
      return {
        model, effort_executed, effort_intended_when_unknown, dispatch_count: rows.length,
        ...stats,
      };
    });

  const siteBuckets = new Map();
  for (const row of dispatches) {
    if (!siteBuckets.has(row.site)) siteBuckets.set(row.site, []);
    siteBuckets.get(row.site).push(row);
  }
  const sites = [...siteBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([site, rows]) => ({ site, dispatch_count: rows.length, ...collectRowStats(rows, settlements, { gsd: site === 'gsd' }) }));

  const estimates = allRows.filter((row) => row.kind === 'triage-estimate' && inFeature(row));
  const actualRows = allRows.filter((row) => row.kind === 'build-actuals' && inFeature(row));
  const actuals = highestBy(actualRows, 'build_id');
  const estimateBuildIds = new Set(estimates.map((row) => row.build_id));
  const acrrRows = estimates
    .map((estimate) => {
      const actual = actuals.get(estimate.build_id) ?? null;
      const eligible = actual?.terminal_status === 'complete';
      const lane = eligible ? realizedLane(actual) : null;
      return {
        build_id: estimate.build_id,
        feature_code: estimate.feature_code,
        estimate_source: estimate.estimate_source,
        confidence: estimate.confidence ?? null,
        estimated_lane: estimate.lane,
        terminal_status: actual?.terminal_status ?? null,
        realized_lane: lane,
        matched: eligible ? estimate.lane === lane : false,
        files_changed_count: actual?.files_changed_count ?? null,
        files_source: actual?.files_source ?? null,
        review_iterations: actual?.review_iterations ?? null,
        escalations: actual?.escalations ?? null,
      };
    })
    .sort((a, b) => a.build_id.localeCompare(b.build_id));
  const eligibleRows = acrrRows.filter((row) => row.terminal_status === 'complete' && row.estimate_source !== 'escalated');
  const escalatedRows = acrrRows.filter((row) => row.terminal_status === 'complete' && row.estimate_source === 'escalated');
  const failed_attempts = actualRows.filter((row) => row.terminal_status === 'failed').length;
  const aborted_attempts = actualRows.filter((row) => row.terminal_status === 'aborted').length;

  return {
    v: 1,
    filters: { since: since ?? null, feature: feature ?? null },
    coverage: {
      dispatch_count: dispatches.length,
      unattributed_count: dispatches.filter((row) => row.site === 'unattributed').length,
      null_usage_count: dispatches.filter((row) => !isNumber(row.tokens_total)).length,
    },
    model_effort,
    sites,
    acrr: {
      eligible: acrrSummary(eligibleRows),
      escalated: acrrSummary(escalatedRows),
      attrition_count: failed_attempts + aborted_attempts,
      failed_attempts,
      aborted_attempts,
      pending_count: acrrRows.filter((row) => row.terminal_status === null).length,
      unpaired_count: [...actuals.keys()].filter((buildId) => !estimateBuildIds.has(buildId)).length,
      rows: acrrRows,
    },
    known_limitations: { retry_rate: RETRY_NOTE, gsd_acceptance: GSD_NOTE },
  };
}

function formatRate(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatMedian(value) {
  return value === null ? 'n/a' : String(value);
}

function formatAcceptance(acceptance) {
  return acceptance.note === GSD_NOTE ? 'n/a (not instrumented)' : formatRate(acceptance.rate);
}

/** Render a compact, stable human report for `compose metrics`. */
export function renderDispatchMetrics(report) {
  const lines = [
    'Model × executed effort',
    'model | executed | intended when unknown | dispatches | median tokens | median ms | completion | acceptance | retry | usd',
  ];
  for (const row of report.model_effort) {
    lines.push([
      row.model === null ? '(model: unknown)' : row.model,
      row.effort_executed ?? 'unknown',
      row.effort_intended_when_unknown ?? '—',
      row.dispatch_count,
      formatMedian(row.median_tokens),
      formatMedian(row.median_duration_ms),
      formatRate(row.completion.rate),
      formatAcceptance(row.acceptance),
      formatRate(row.retry.rate),
      row.usd_total,
    ].join(' | '));
  }
  lines.push('', 'Sites', 'site | dispatches | median tokens | median ms | completion | acceptance | retry | usd');
  for (const row of report.sites) {
    lines.push([
      row.site, row.dispatch_count, formatMedian(row.median_tokens), formatMedian(row.median_duration_ms),
      formatRate(row.completion.rate), formatAcceptance(row.acceptance), formatRate(row.retry.rate), row.usd_total,
    ].join(' | '));
  }
  lines.push('', 'ACRR');
  lines.push(`eligible: ${report.acrr.eligible.matched}/${report.acrr.eligible.total} (${formatRate(report.acrr.eligible.rate)})`);
  lines.push(`escalated: ${report.acrr.escalated.matched}/${report.acrr.escalated.total} (${formatRate(report.acrr.escalated.rate)})`);
  lines.push(`attrition: ${report.acrr.attrition_count} (failed attempts: ${report.acrr.failed_attempts}, aborted attempts: ${report.acrr.aborted_attempts}, pending: ${report.acrr.pending_count}, unpaired: ${report.acrr.unpaired_count})`);
  lines.push('', 'Known limitations');
  lines.push(`retry rate: ${report.known_limitations.retry_rate}`);
  lines.push(`GSD acceptance: ${report.known_limitations.gsd_acceptance}`);
  return `${lines.join('\n')}\n`;
}

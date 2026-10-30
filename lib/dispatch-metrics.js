/**
 * dispatch-metrics.js — read-only aggregation over the dispatch ledger.
 *
 * This module deliberately keeps the ledger's append-only observations intact:
 * settlements and terminal actuals are reduced at read time by their `_seq`.
 */

import { readEvents } from './dispatch-ledger.js';
import { readBuildHistory } from './build-history.js';
import { normalizeSince } from './feature-events.js';

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
 * COMP-OBS-STATS-1: `to` is an exclusive upper bound on `ts` (the range is
 * [since, to)). `buckets: 'day'` adds a `usage` section (tiles, local-day
 * buckets, by-model rows, provenance) over the same dispatch population, so
 * `compose metrics` and the Usage page can never disagree. `historyDir` (the
 * .compose/data dir) joins build-history.jsonl for cache tokens and build
 * outcome. Without the new options the report is byte-identical to before.
 *
 * @param {string} projectCwd
 * @param {{ since?: string|number|Date, to?: string|number|Date, feature?: string, buckets?: 'day', historyDir?: string }} [opts]
 * @returns {object}
 */
export function collectDispatchMetrics(projectCwd, { since, to, feature, buckets, historyDir } = {}) {
  // Settlements have no feature code. Read one since-filtered population first,
  // then join them to the feature-filtered dispatches below.
  const toMs = normalizeSince(to);
  const allRows = readEvents(projectCwd, { since })
    .filter((row) => toMs === null || Date.parse(row.ts) < toMs);
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

  const report = {
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
  if (to !== undefined && to !== null) report.filters.to = to;
  if (buckets === 'day') {
    report.usage = collectUsage(dispatches, { fromMs: normalizeSince(since), toMs, historyDir });
  }
  return report;
}

// ---------------------------------------------------------------------------
// COMP-OBS-STATS-1: usage section (day buckets, tiles, by-model rows)
// ---------------------------------------------------------------------------

const UNHAPPY_BUILD_STATUSES = new Set(['failed', 'aborted', 'killed']);
// Ten years of local days. A wider span is a caller error, not a chart.
export const MAX_DAY_BUCKETS = 3660;
export const UNKNOWN_MODEL_KEY = 'unknown';

function sumOf(rows, field) {
  return rows.reduce((total, row) => total + (isNumber(row[field]) ? row[field] : 0), 0);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Local calendar day (the cockpit runs on the same machine as the server). */
export function localDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Every local day touched by [startMs, endMs), zero-dispatch days included. */
function localDaySpan(startMs, endMs) {
  const keys = [];
  const cursor = new Date(startMs);
  cursor.setHours(0, 0, 0, 0);
  while (cursor.getTime() < endMs) {
    keys.push(localDayKey(cursor.getTime()));
    if (keys.length > MAX_DAY_BUCKETS) {
      throw new RangeError(`range spans more than ${MAX_DAY_BUCKETS} days`);
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

function provenanceOf(row) {
  // usd_source null means "unknown" (dispatch-ledger.js USD_SOURCES note), same as absent.
  if (row.usd_source === 'reported') return 'reported';
  if (row.usd_source === 'estimated') return 'estimated';
  return 'absent';
}

function historyTime(record) {
  const ms = Date.parse(record?.completedAt ?? record?.startedAt ?? '');
  return Number.isNaN(ms) ? null : ms;
}

function collectUsage(dispatches, { fromMs, toMs, historyDir }) {
  // ── Day buckets ────────────────────────────────────────────────────────────
  let minTs = null;
  let maxTs = null;
  for (const row of dispatches) {
    const t = Date.parse(row.ts);
    if (minTs === null || t < minTs) minTs = t;
    if (maxTs === null || t > maxTs) maxTs = t;
  }
  const startMs = fromMs ?? minTs;
  const endMs = toMs ?? Math.max(Date.now(), maxTs === null ? 0 : maxTs + 1);
  const dayKeys = startMs === null ? [] : localDaySpan(startMs, endMs);
  const days = new Map(dayKeys.map((date) => [date, {
    date, dispatch_count: 0, usd: 0, tokens_total: 0, by_model: {}, by_site: {},
  }]));
  const addTo = (series, key, row) => {
    const cell = series[key] ?? (series[key] = { usd: 0, tokens_total: 0, dispatch_count: 0 });
    cell.usd += isNumber(row.usd) ? row.usd : 0;
    cell.tokens_total += isNumber(row.tokens_total) ? row.tokens_total : 0;
    cell.dispatch_count += 1;
  };
  for (const row of dispatches) {
    const day = days.get(localDayKey(Date.parse(row.ts)));
    if (!day) continue; // unreachable: every row's day is inside the span
    day.dispatch_count += 1;
    day.usd += isNumber(row.usd) ? row.usd : 0;
    day.tokens_total += isNumber(row.tokens_total) ? row.tokens_total : 0;
    addTo(day.by_model, row.model ?? UNKNOWN_MODEL_KEY, row);
    addTo(day.by_site, row.site, row);
  }

  // ── Provenance: three populations, never two ───────────────────────────────
  const provenance = {
    reported: { dispatch_count: 0, usd: 0 },
    estimated: { dispatch_count: 0, usd: 0 },
    absent: { dispatch_count: 0, usd: 0 },
  };
  for (const row of dispatches) {
    const bucket = provenance[provenanceOf(row)];
    bucket.dispatch_count += 1;
    bucket.usd += isNumber(row.usd) ? row.usd : 0;
  }

  // ── By-model rows; null model is one explicit Unknown row ──────────────────
  const totalUsd = sumOf(dispatches, 'usd');
  const modelRows = new Map();
  for (const row of dispatches) {
    const model = row.model ?? null;
    if (!modelRows.has(model)) modelRows.set(model, []);
    modelRows.get(model).push(row);
  }
  const models = [...modelRows.entries()]
    .map(([model, rows]) => {
      const usd = sumOf(rows, 'usd');
      return {
        model, unknown: model === null, dispatch_count: rows.length, usd,
        tokens_total: sumOf(rows, 'tokens_total'), tokens_out: sumOf(rows, 'tokens_out'),
        share: rate(usd, totalUsd),
        provenance_counts: {
          reported: rows.filter((r) => provenanceOf(r) === 'reported').length,
          estimated: rows.filter((r) => provenanceOf(r) === 'estimated').length,
          absent: rows.filter((r) => provenanceOf(r) === 'absent').length,
        },
      };
    })
    .sort((a, b) => (a.unknown - b.unknown) || (b.usd - a.usd) || String(a.model).localeCompare(String(b.model)));

  // ── Build-history join (cache tokens, build outcome) ───────────────────────
  const history = historyDir ? readBuildHistory(historyDir, { limit: Infinity }) : [];
  // readBuildHistory is most-recent-first: the first record per build id wins.
  const buildsById = new Map();
  for (const record of history) {
    const id = record.accumulator_build_id;
    if (typeof id === 'string' && !buildsById.has(id)) buildsById.set(id, record);
  }
  const inRange = (ms) => ms !== null && (fromMs === null || ms >= fromMs) && (toMs === null || ms < toMs);
  const rangeBuilds = history.filter((record) => inRange(historyTime(record)));
  const cacheBuilds = rangeBuilds.filter((r) => isNumber(r.cache_read_tokens) && isNumber(r.input_tokens));
  const cacheRead = sumOf(cacheBuilds, 'cache_read_tokens');
  const cacheInput = sumOf(cacheBuilds, 'input_tokens');
  const buildStatuses = {};
  for (const record of rangeBuilds) {
    const status = record.status ?? 'unknown';
    buildStatuses[status] = (buildStatuses[status] ?? 0) + 1;
  }

  let wastedUsd = 0;
  let wastedCount = 0;
  let joined = 0;
  let unjoined = 0;
  let noBuild = 0;
  for (const row of dispatches) {
    if (typeof row.build_id !== 'string') { noBuild += 1; continue; }
    const build = buildsById.get(row.build_id);
    if (!build) { unjoined += 1; continue; }
    joined += 1;
    if (UNHAPPY_BUILD_STATUSES.has(build.status)) {
      wastedCount += 1;
      wastedUsd += isNumber(row.usd) ? row.usd : 0;
    }
  }

  const retries = dispatches.filter((row) => isNumber(row.attempt) && row.attempt > 1);
  const usdUnknownCount = sumOf(rangeBuilds, 'usd_unknown_count');
  const missingUsd = dispatches.filter((row) => !isNumber(row.usd)).length;

  return {
    empty: dispatches.length === 0,
    tiles: {
      total_cost: { usd: totalUsd, provenance },
      total_tokens: { value: sumOf(dispatches, 'tokens_total'), missing_count: dispatches.filter((r) => !isNumber(r.tokens_total)).length },
      output_tokens: { value: sumOf(dispatches, 'tokens_out'), missing_count: dispatches.filter((r) => !isNumber(r.tokens_out)).length },
      dispatches: { value: dispatches.length },
      active_days: { value: [...days.values()].filter((day) => day.dispatch_count > 0).length },
      retry_cost: {
        usd: sumOf(retries, 'usd'), dispatch_count: retries.length,
        attempt_unknown_count: dispatches.filter((row) => !isNumber(row.attempt)).length,
      },
      wasted_spend: {
        usd: wastedUsd, dispatch_count: wastedCount, statuses: [...UNHAPPY_BUILD_STATUSES],
        joined_count: joined, unjoined_count: unjoined, no_build_count: noBuild,
      },
      cache_hit_rate: {
        // Build-level only: history has no model id, so this is never split by model.
        scope: 'build', by_model: false,
        rate: rate(cacheRead, cacheRead + cacheInput),
        cache_read_tokens: cacheRead, input_tokens: cacheInput,
        builds_counted: cacheBuilds.length,
        builds_excluded: rangeBuilds.length - cacheBuilds.length,
      },
    },
    incomplete: {
      marked: usdUnknownCount > 0 || missingUsd > 0,
      usd_unknown_count: usdUnknownCount,
      dispatches_missing_usd: missingUsd,
    },
    builds: { in_range: rangeBuilds.length, statuses: buildStatuses },
    models,
    days: [...days.values()],
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

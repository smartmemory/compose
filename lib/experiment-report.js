/**
 * experiment-report.js — Aggregation and Markdown rendering for COMP-MODEL-AB.
 *
 * Pure functions over run records — no LLM calls, no I/O.
 *
 * aggregate(runs, experimentId) → results (matches the contract's results.json shape)
 * render(results) → Markdown string (configs×metrics table, winner-per-metric, caveats)
 */

// ---------------------------------------------------------------------------
// Numeric utilities
// ---------------------------------------------------------------------------

/**
 * Compute median of a sorted (ascending) numeric array.
 * @param {number[]} sorted
 * @returns {number}
 */
function medianSorted(sorted) {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Compute spread stats (median, min, max) for a set of values.
 * Non-finite (null/undefined/NaN) values are dropped.
 *
 * @param {(number|null|undefined)[]} values
 * @returns {{ median: number, min: number, max: number, n: number } | null}
 *   null when there are no valid values.
 */
export function computeSpread(values) {
  const nums = values.filter(v => typeof v === 'number' && isFinite(v));
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  return {
    median: medianSorted(sorted),
    min:    sorted[0],
    max:    sorted[sorted.length - 1],
    n:      nums.length,
  };
}

// ---------------------------------------------------------------------------
// Metric path extraction (dotted paths into a run's metrics)
// ---------------------------------------------------------------------------

const METRIC_PATHS = [
  'cost.tokensIn',
  'cost.tokensOut',
  'cost.calls',
  'cost.wallMs',
  'cost.usd',
  'outcome.health',
  'outcome.testsPass',
  'outcome.testsTotal',
  'outcome.filesChanged',
  'outcome.linesChanged',
  'process.reviewIters',
  'process.gateFailures',
  'process.retries',
  'process.escalations',
];

const JUDGE_PATHS = [
  'judge.correctness',
  'judge.clarity',
  'judge.idiomaticity',
];

/**
 * Extract a dotted-path value from a run record.
 * @param {object} run
 * @param {string} path  e.g. 'cost.tokensIn', 'judge.correctness'
 * @returns {number|null}
 */
function extractValue(run, path) {
  const parts = path.split('.');
  let obj = run;
  for (const part of parts) {
    if (obj == null || typeof obj !== 'object') return null;
    obj = obj[part];
  }
  return typeof obj === 'number' && isFinite(obj) ? obj : null;
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

/**
 * Aggregate runs into a results object (the contract's results.json shape).
 *
 * Only completed runs contribute to metric aggregations (so a crash never
 * silently drags down the median with zeros). nCompleted/nTotal are always
 * reported.  Judge metrics include all runs where judge is non-null (judge
 * can succeed even when the build failed).
 *
 * @param {object[]} runs   Array of per-run records
 * @param {string}   experimentId
 * @returns {object}  The results object
 */
export function aggregate(runs, experimentId = 'experiment') {
  // Group by configLabel
  const byConfig = new Map();
  for (const run of runs) {
    const label = run.configLabel ?? 'unknown';
    if (!byConfig.has(label)) byConfig.set(label, []);
    byConfig.get(label).push(run);
  }

  const configResults = [];
  for (const [label, configRuns] of byConfig) {
    const nTotal     = configRuns.length;
    const completed  = configRuns.filter(r => r.metrics?.outcome?.completed);
    const nCompleted = completed.length;

    const metrics = {};

    // Build metrics from completed runs
    for (const path of METRIC_PATHS) {
      const vals = completed.map(r => extractValue(r, `metrics.${path}`));
      const spread = computeSpread(vals);
      if (spread) metrics[path] = { median: spread.median, min: spread.min, max: spread.max };
    }

    // Judge metrics from all runs where judge is non-null
    const judged = configRuns.filter(r => r.judge != null);
    for (const path of JUDGE_PATHS) {
      const vals = judged.map(r => extractValue(r, path));
      const spread = computeSpread(vals);
      if (spread) metrics[path] = { median: spread.median, min: spread.min, max: spread.max };
    }

    configResults.push({ label, nCompleted, nTotal, metrics });
  }

  return {
    experimentId,
    configs:     configResults,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

// Columns to include in the comparison table (ordered)
const TABLE_COLUMNS = [
  { key: 'nCompleted',           label: 'Completed',    fmt: (v) => String(v) },
  { key: 'cost.usd',             label: 'Cost $',       fmt: (v) => v != null ? `$${v.toFixed(3)}` : '-' },
  { key: 'cost.tokensIn',        label: 'Tokens In',    fmt: (v) => v != null ? String(Math.round(v)) : '-' },
  { key: 'cost.tokensOut',       label: 'Tokens Out',   fmt: (v) => v != null ? String(Math.round(v)) : '-' },
  { key: 'cost.wallMs',          label: 'Wall ms',      fmt: (v) => v != null ? String(Math.round(v)) : '-' },
  { key: 'outcome.health',       label: 'Health',       fmt: (v) => v != null ? v.toFixed(1) : '-' },
  { key: 'outcome.testsPass',    label: 'Tests Pass',   fmt: (v) => v != null ? String(Math.round(v)) : '-' },
  { key: 'outcome.filesChanged', label: 'Files',        fmt: (v) => v != null ? String(Math.round(v)) : '-' },
  { key: 'outcome.linesChanged', label: 'Lines',        fmt: (v) => v != null ? String(Math.round(v)) : '-' },
  { key: 'process.reviewIters',  label: 'Review Iters', fmt: (v) => v != null ? String(Math.round(v)) : '-' },
  { key: 'process.gateFailures', label: 'Gate Fails',   fmt: (v) => v != null ? String(Math.round(v)) : '-' },
  { key: 'judge.correctness',    label: 'Correctness',  fmt: (v) => v != null ? v.toFixed(1) : '-' },
  { key: 'judge.clarity',        label: 'Clarity',      fmt: (v) => v != null ? v.toFixed(1) : '-' },
  { key: 'judge.idiomaticity',   label: 'Idiom.',       fmt: (v) => v != null ? v.toFixed(1) : '-' },
];

// Higher is better for these metrics; lower is better for the rest
const HIGHER_IS_BETTER = new Set([
  'nCompleted',
  'outcome.health',
  'outcome.testsPass',
  'judge.correctness',
  'judge.clarity',
  'judge.idiomaticity',
]);

/**
 * Determine the winner config label for each column.
 * Returns a Map<columnKey, winnerLabel>.
 */
function computeWinners(configResults) {
  const winners = new Map();
  for (const col of TABLE_COLUMNS) {
    const key = col.key;
    let best = null;
    let bestVal = null;

    for (const cfg of configResults) {
      let val;
      if (key === 'nCompleted') {
        val = cfg.nCompleted;
      } else {
        val = cfg.metrics[key]?.median;
      }
      if (typeof val !== 'number' || !isFinite(val)) continue;

      const isBetter = bestVal == null || (HIGHER_IS_BETTER.has(key) ? val > bestVal : val < bestVal);
      if (isBetter) {
        best    = cfg.label;
        bestVal = val;
      }
    }

    if (best != null) winners.set(key, best);
  }
  return winners;
}

/**
 * Render a Markdown comparison report.
 *
 * @param {object} results  The aggregate results object
 * @returns {string}  Markdown
 */
export function render(results) {
  const { experimentId, configs, generatedAt } = results;
  const lines = [];

  lines.push(`# Experiment Report: ${experimentId}`);
  lines.push('');
  lines.push(`Generated: ${generatedAt}`);
  lines.push('');

  if (!configs || configs.length === 0) {
    lines.push('_No runs found._');
    return lines.join('\n');
  }

  // ---------- comparison table ----------

  lines.push('## Results');
  lines.push('');

  const winners = computeWinners(configs);

  // Table header
  const headers = ['Config', ...TABLE_COLUMNS.map(c => c.label)];
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);

  // Table rows
  for (const cfg of configs) {
    const cells = [cfg.label];
    for (const col of TABLE_COLUMNS) {
      let val;
      if (col.key === 'nCompleted') {
        val = `${cfg.nCompleted}/${cfg.nTotal}`;
      } else {
        const med = cfg.metrics[col.key]?.median;
        val = col.fmt(med ?? null);
      }
      const isWinner = winners.get(col.key) === cfg.label;
      cells.push(isWinner ? `**${val}**` : val);
    }
    lines.push(`| ${cells.join(' | ')} |`);
  }
  lines.push('');

  // ---------- winner summary ----------

  lines.push('## Winner per Metric');
  lines.push('');
  for (const col of TABLE_COLUMNS) {
    const winner = winners.get(col.key);
    if (winner) {
      lines.push(`- **${col.label}**: ${winner}`);
    }
  }
  lines.push('');

  // ---------- caveats ----------

  const totalRuns  = configs.reduce((s, c) => s + c.nTotal, 0);
  const completedRuns = configs.reduce((s, c) => s + c.nCompleted, 0);
  const hasJudge   = configs.some(c => c.metrics['judge.correctness'] != null);
  const maxVariance = (() => {
    let maxRel = 0;
    for (const cfg of configs) {
      for (const path of [...METRIC_PATHS, ...JUDGE_PATHS]) {
        const s = cfg.metrics[path];
        if (!s || s.median === 0) continue;
        const rel = (s.max - s.min) / s.median;
        if (rel > maxRel) maxRel = rel;
      }
    }
    return maxRel;
  })();
  const highVariance = maxVariance > 0.5;

  lines.push('## Caveats');
  lines.push('');
  lines.push(`- N = ${totalRuns} total runs (${completedRuns} completed). ` +
    (totalRuns < 5 ? 'Sample size is small; treat results as directional only.' : 'Medians are reported.'));
  if (highVariance) {
    lines.push(`- High variance observed (max relative spread ${(maxVariance * 100).toFixed(0)}%). ` +
      'Consider increasing reps for more stable estimates.');
  }
  if (hasJudge) {
    lines.push('- Judge scores may reflect judge-model bias. The same held-constant judge model rated all configs.');
  }
  lines.push('');

  return lines.join('\n');
}

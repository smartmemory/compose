/**
 * gsd-budget.js — COMP-GSD-4 budget-ceiling helpers for autonomous `compose gsd`.
 *
 * This module does NOT count tokens or enforce budgets — that is the stratum
 * flow budget (STRAT-WORKFLOW-BUDGET): a `budget:` block on the flow makes
 * stratum debit every server-dispatched agent and halt the run with a terminal
 * `budget_exhausted` status that carries `budget_state = {caps, consumed}`.
 *
 * GSD-4's job is purely compose-side glue:
 *   - readGsdBudgetConfig: read `.compose/compose.json` `gsd.budget.*` (no defaults).
 *   - buildBudgetBlock:     map that config → the stratum flow `budget` block
 *                           (+ a per-task task_timeout in seconds).
 *   - injectBudget:         inject the block into the gsd spec YAML — IDENTITY
 *                           when nothing is configured (byte-identical guarantee).
 *   - composeBudgetDiagnostic: render budget.json + budget.md from budget_state.
 *
 * Enforced axes (stratum): ms (wall-clock), max_agent_dispatches, max_tokens, usd.
 * See: docs/features/COMP-GSD-4/{design,blueprint}.md, stratum run_budget.py.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

/**
 * Read `.compose/compose.json` → `gsd.budget`. Returns {} when absent or
 * unparseable. NO defaults (gate decision 7): a gsd run is unbounded unless the
 * user sets a budget. Mirrors readGsdStuckConfig in gsd.js.
 */
export function readGsdBudgetConfig(cwd) {
  const configPath = join(cwd, '.compose', 'compose.json');
  if (!existsSync(configPath)) return {};
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    return cfg?.gsd?.budget ?? {};
  } catch {
    return {};
  }
}

/**
 * Map snake_case `gsd.budget.*` config → the stratum flow budget block and an
 * optional per-task timeout (seconds). Only keys the user set appear.
 *
 * Config keys:
 *   max_tokens, max_agent_dispatches, usd        → flow budget axes
 *   per_run_ms (alias: ms)                        → flow budget `ms` (wall-clock)
 *   per_task_ms                                   → execute step `task_timeout` (sec)
 *   cumulative: { max_total_tokens, max_total_cost_usd } → cross-session ceiling
 *
 * @returns {{ budget?: object, taskTimeoutSec?: number, cumulative?: object }}
 */
export function buildBudgetBlock(cfg = {}) {
  const out = {};

  const budget = {};
  if (cfg.max_tokens != null) budget.max_tokens = cfg.max_tokens;
  if (cfg.max_agent_dispatches != null) budget.max_agent_dispatches = cfg.max_agent_dispatches;
  if (cfg.usd != null) budget.usd = cfg.usd;
  const ms = cfg.per_run_ms ?? cfg.ms;
  if (ms != null) budget.ms = ms;
  if (Object.keys(budget).length > 0) out.budget = budget;

  if (cfg.per_task_ms != null) {
    // stratum parallel_dispatch per-task timeout is `task_timeout` in SECONDS
    // (spec.py:145, schema minimum 1). Convert from ms, floor at 1s.
    out.taskTimeoutSec = Math.max(1, Math.ceil(cfg.per_task_ms / 1000));
  }

  if (cfg.cumulative && typeof cfg.cumulative === 'object') {
    const cum = {};
    if (cfg.cumulative.max_total_tokens != null) cum.maxTotalTokens = cfg.cumulative.max_total_tokens;
    if (cfg.cumulative.max_total_cost_usd != null) cum.maxTotalCostUsd = cfg.cumulative.max_total_cost_usd;
    if (Object.keys(cum).length > 0) out.cumulative = cum;
  }

  return out;
}

/**
 * Inject the budget block into the gsd flow spec YAML.
 *
 * BYTE-IDENTICAL GUARANTEE: when nothing is configured (no flow budget AND no
 * per-task timeout), the original `specYaml` string is returned VERBATIM — no
 * YAML.parse/stringify round-trip (which would reorder/reformat). This keeps an
 * un-budgeted `compose gsd` (and plain `compose build`) bit-for-bit unchanged.
 *
 * @param {string} specYaml — the gsd.stratum.yaml contents
 * @param {object} cfg — raw gsd.budget config (from readGsdBudgetConfig)
 * @returns {string}
 */
export function injectBudget(specYaml, cfg = {}) {
  const built = buildBudgetBlock(cfg);
  if (!built.budget && built.taskTimeoutSec == null) {
    return specYaml; // identity — nothing to inject
  }

  const parsed = YAML.parse(specYaml);
  const flow = parsed?.flows?.gsd;
  if (!flow) {
    // Defensive: spec shape changed. Don't silently drop the budget — surface it.
    throw new Error('injectBudget: spec has no flows.gsd to attach a budget to');
  }

  if (built.budget) flow.budget = built.budget;

  if (built.taskTimeoutSec != null && Array.isArray(flow.steps)) {
    const execute = flow.steps.find((s) => s && s.id === 'execute');
    if (execute) execute.task_timeout = built.taskTimeoutSec;
  }

  return YAML.stringify(parsed);
}

// Maps a stratum budget axis → human label for diagnostics.
const AXIS_LABEL = {
  max_tokens: 'tokens',
  max_agent_dispatches: 'agent dispatches',
  ms: 'wall-clock',
  usd: 'cost (USD)',
};

/**
 * Identify which enforced axis tripped, comparing consumed vs caps.
 * Mirrors stratum run_budget.budget_exhausted() (consumed >= cap), in the same
 * precedence order. Returns null if nothing is over (shouldn't happen on a
 * budget_exhausted terminal, but the diagnostic stays honest).
 */
export function trippedAxis(budgetState) {
  const caps = budgetState?.caps ?? {};
  const consumed = budgetState?.consumed ?? {};
  if (caps.ms != null && (consumed.wall_s ?? 0) >= caps.ms / 1000) return 'ms';
  if (caps.max_agent_dispatches != null && (consumed.dispatches ?? 0) >= caps.max_agent_dispatches) return 'max_agent_dispatches';
  if (caps.max_tokens != null && (consumed.tokens ?? 0) >= caps.max_tokens) return 'max_tokens';
  if (caps.usd != null && (consumed.dollars ?? 0) >= caps.usd) return 'usd';
  return null;
}

/**
 * Build the budget.json + budget.md diagnostic from the stratum terminal
 * envelope's budget_state.
 *
 * @param {object} budgetState — {caps, consumed:{tokens,dispatches,wall_s,dollars}}
 * @param {{feature:string, decomposedTasks?:Array, completedTaskIds?:Array, cumulative?:object}} meta
 * @returns {{ json: object, md: string }}
 */
export function composeBudgetDiagnostic(budgetState, meta = {}) {
  const caps = budgetState?.caps ?? {};
  const consumed = budgetState?.consumed ?? {};
  const axis = meta.axis ?? trippedAxis(budgetState);
  const feature = meta.feature ?? '';

  const completed = new Set(meta.completedTaskIds ?? []);
  const remaining = (meta.decomposedTasks ?? [])
    .map((t) => t.id)
    .filter((id) => id && !completed.has(id));

  const json = {
    feature,
    kind: 'budget',
    axis,
    caps,
    consumed,
    remainingTaskIds: remaining,
    ts: new Date().toISOString(),
  };

  const rows = [];
  if (caps.max_tokens != null) rows.push(`| tokens | ${consumed.tokens ?? 0} | ${caps.max_tokens} |`);
  if (caps.max_agent_dispatches != null) rows.push(`| agent dispatches | ${consumed.dispatches ?? 0} | ${caps.max_agent_dispatches} |`);
  if (caps.ms != null) rows.push(`| wall-clock (s) | ${Math.round(consumed.wall_s ?? 0)} | ${Math.round(caps.ms / 1000)} |`);
  if (caps.usd != null) rows.push(`| cost (USD) | ${(consumed.dollars ?? 0).toFixed(4)} | ${Number(caps.usd).toFixed(4)} |`);

  const md = [
    `# GSD budget halt — ${feature}`,
    '',
    `**Tripped axis:** ${AXIS_LABEL[axis] ?? axis ?? 'cumulative'}`,
    `**When:** ${json.ts}`,
    '',
    '## Consumed vs cap',
    '',
    '| Axis | Consumed | Cap |',
    '|------|----------|-----|',
    ...rows,
    '',
    `## Remaining tasks (${remaining.length})`,
    '',
    remaining.length ? remaining.map((id) => `- ${id}`).join('\n') : '_none — all tasks completed before the halt._',
    '',
    '## Resume',
    '',
    'Raise the relevant `gsd.budget.*` cap in `.compose/compose.json` (or run with',
    '`--reset-budget` to clear the cumulative ledger), then:',
    '',
    '```',
    `compose gsd ${feature} --resume`,
    '```',
    '',
    'Completed task results are preserved in the blackboard; --resume re-dispatches',
    'only the remaining tasks.',
    '',
  ].join('\n');

  return { json, md };
}

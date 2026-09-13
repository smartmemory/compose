#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const usage = 'Usage: node scripts/cost-oracle.mjs [--flow <flowId>] [--all] [--json] [--tolerance 0.05]';
const coverageNote = 'Strict lower bound: source="main" transcripts cannot be joined by path; unjoined files have unknown cost.';

function parseArgs(args) {
  const options = { flow: null, all: false, json: false, tolerance: 0.05 };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--all') options.all = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--flow' || arg === '--tolerance') {
      const value = args[++i];
      if (!value?.trim() || value.startsWith('--')) throw new Error(`${arg} requires a value\n${usage}`);
      if (arg === '--flow') options.flow = value;
      else options.tolerance = Number(value);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage}`);
    }
  }
  if (options.flow && options.all) throw new Error(`Use either --flow or --all\n${usage}`);
  if (!Number.isFinite(options.tolerance) || options.tolerance < 0 || options.tolerance >= 1) {
    throw new Error('--tolerance must be a finite number in [0, 1)');
  }
  return options;
}

function readLedger() {
  const historyPath = resolve('.compose', 'data', 'build-history.jsonl');
  const flows = new Map();
  const accumulatorGroups = new Map();
  const legacyFlows = new Set();
  const lines = readFileSync(historyPath, 'utf8').split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`${historyPath}:${index + 1}: invalid JSON`);
    }
    if (typeof row?.flowId !== 'string' || !row.flowId.trim()
      || !Number.isFinite(row.cost_usd) || row.cost_usd < 0) {
      throw new Error(`${historyPath}:${index + 1}: expected flowId and non-negative numeric cost_usd`);
    }
    // Retain both legacy readings for diagnostics and the conservative fallback.
    const flow = flows.get(row.flowId)
      ?? { flowId: row.flowId, ledger_sum_usd: 0, ledger_last_usd: 0, ledger_usd: 0,
           ledger_rows: 0, _startedAt: null };
    flow.ledger_sum_usd += row.cost_usd;
    if (flow._startedAt === null || String(row.startedAt ?? '') >= flow._startedAt) {
      flow.ledger_last_usd = row.cost_usd;
      flow._startedAt = String(row.startedAt ?? '');
    }
    if (row.accumulator_build_id == null) {
      legacyFlows.add(row.flowId);
    } else {
      const groups = accumulatorGroups.get(row.flowId) ?? new Map();
      // Group rows by (flowId, accumulator_build_id), take the LAST row within a
      // group (JSONL append order), SUM across groups. A terminal auto-resume
      // rotation correctly starts a new accumulator lifetime and therefore group.
      groups.set(row.accumulator_build_id, row.cost_usd);
      accumulatorGroups.set(row.flowId, groups);
    }
    flow.ledger_rows += 1;
    flows.set(row.flowId, flow);
  }
  for (const flow of flows.values()) {
    if (!legacyFlows.has(flow.flowId)) {
      flow.ledger_usd = [...accumulatorGroups.get(flow.flowId).values()]
        .reduce((sum, cost) => sum + cost, 0);
      continue;
    }
    // If ANY row lacks an identity, neither reading is universally correct.
    // Keep the legacy max(sum, last) fallback: take the MOST GENEROUS and flag
    // UNDER only when even that falls short. Measured 2026-09-13: 44c575e7's SUM
    // ($11.6007) exceeds its own flow's total spend ($4.0447), which is
    // impossible, while 4122e695's LAST ($0.6974) is BELOW its earlier row
    // ($1.6045) and so cannot be a running total. Rows are cumulative only
    // within one accumulator lifetime; clearBuildAccumulator resets it.
    flow.ledger_usd = Math.max(flow.ledger_sum_usd, flow.ledger_last_usd);
  }
  return flows;
}

function selectFlows(flows, requested) {
  if (!requested) return [...flows.values()]; // No selector defaults to --all.
  if (flows.has(requested)) return [flows.get(requested)];
  const matches = [...flows.values()].filter((flow) => flow.flowId.startsWith(requested));
  if (matches.length !== 1) {
    throw new Error(matches.length ? `Ambiguous flow prefix: ${requested}` : `No ledger rows for flow: ${requested}`);
  }
  return matches;
}

function readOracle(cachePath) {
  let stdout;
  try {
    stdout = execFileSync('npx', ['-y', 'ccusage@latest', 'session', '--json'], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = String(error.stderr || error.message).trim();
    throw new Error(`ccusage command failed (exit ${error.status ?? 'unknown'}): ${detail}\nNo pricing fallback is available.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('ccusage emitted unparseable JSON. No pricing fallback is available.');
  }
  if (!Array.isArray(parsed?.session)) throw new Error('ccusage JSON is missing the session array');
  // Cache only this invocation's parsed response; never reuse a stale oracle run.
  writeFileSync(cachePath, JSON.stringify(parsed), { mode: 0o600 });
  const sessions = new Map();
  for (const session of parsed.session) {
    if (typeof session?.period !== 'string' || !session.period
      || !Number.isFinite(session.totalCost) || session.totalCost < 0) {
      throw new Error('ccusage session must have a period and non-negative numeric totalCost');
    }
    if (sessions.has(session.period)) throw new Error(`Duplicate ccusage period: ${session.period}`);
    sessions.set(session.period, session);
  }
  return sessions;
}

// stratum's own per-flow tally, a SECOND independent accounting path (different
// repo, different code). Absent on flows written before stratum recorded usd
// (e.g. 13fd190e, 2026-08-30), which is why it is optional rather than required.
function readFlowSpent(flowId) {
  const flowPath = join(homedir(), '.stratum', 'ts', 'flows', `${flowId}.json`);
  try {
    const usd = JSON.parse(readFileSync(flowPath, 'utf8'))?.flowSpent?.usd;
    return Number.isFinite(usd) && usd >= 0 ? usd : null;
  } catch {
    return null;
  }
}

function projectDirectories(projectsPath) {
  try {
    return readdirSync(projectsPath, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function compareFlow(flow, sessions, projectsPath, directories, tolerance) {
  const joined = new Set();
  let unjoined = 0;
  for (const directory of directories) {
    if (!directory.name.includes(flow.flowId)) continue;
    const files = readdirSync(join(projectsPath, directory.name), { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const sessionId = file.name.slice(0, -'.jsonl'.length);
      if (sessions.has(sessionId)) joined.add(sessionId);
      else unjoined += 1; // Count files whose cost is unknown, not zero-dollar sessions.
    }
  }
  // The same UUID in multiple directories is still one ccusage session.
  const oracle = [...joined].reduce((sum, id) => sum + sessions.get(id).totalCost, 0);
  // Best available lower bound: the transcript oracle misses main-source steps,
  // stratum's flowSpent misses nothing but is absent on older flows. Where both
  // exist they corroborate closely (44c575e7: $4.0316 vs $4.0447).
  const flowSpent = readFlowSpent(flow.flowId);
  const bound = Math.max(oracle, flowSpent ?? 0);
  const under = flow.ledger_usd < bound * (1 - tolerance);
  // flowSpent needs no transcripts at all, so when it is present coverage is
  // never thin — only a flow with neither flowSpent nor 3+ joined sessions is
  // genuinely unjudgeable.
  const thin = flowSpent === null && joined.size < 3;
  const verdict = under ? 'UNDER' : thin ? 'INSUFFICIENT-COVERAGE' : 'OK';
  return {
    ...flow,
    oracle_usd_lower_bound: oracle,
    oracle_is_strict_lower_bound: true,
    coverage_note: coverageNote,
    stratum_flow_spent_usd: flowSpent,
    bound_usd: bound,
    ledger_oracle_ratio: bound > 0 ? flow.ledger_usd / bound : null,
    sessions_joined: joined.size,
    unjoined,
    tolerance,
    verdict,
    finding: under,
  };
}

function printReport(reports, json) {
  if (json) {
    console.log(JSON.stringify({ flows: reports }, null, 2));
    return;
  }
  for (const report of reports) {
    const ratio = report.ledger_oracle_ratio === null ? 'N/A' : `${report.ledger_oracle_ratio.toFixed(2)}x`;
    const verdict = report.verdict === 'INSUFFICIENT-COVERAGE'
      ? 'INSUFFICIENT-COVERAGE (NOT a finding)' : report.verdict;
    console.log(`flow=${report.flowId} ledger=$${report.ledger_usd.toFixed(4)} `
      + `oracle=$${report.oracle_usd_lower_bound.toFixed(4)} (strict lower bound; main-source transcripts excluded) `
      + `stratum_flow_spent=$${report.stratum_flow_spent_usd === null ? 'n/a' : report.stratum_flow_spent_usd.toFixed(4)} `
      + `[sum=$${report.ledger_sum_usd.toFixed(4)} last=$${report.ledger_last_usd.toFixed(4)}] `
      + `ledger/bound=${ratio} ledger_rows=${report.ledger_rows} sessions_joined=${report.sessions_joined} `
      + `unjoined=${report.unjoined} (unknown cost) ${verdict}`);
  }
}

let cacheDirectory;
try {
  const options = parseArgs(process.argv.slice(2));
  const flows = selectFlows(readLedger(), options.flow);
  cacheDirectory = mkdtempSync(join(tmpdir(), 'compose-cost-oracle-'));
  const sessions = readOracle(join(cacheDirectory, 'ccusage-session.json'));
  const projectsPath = join(homedir(), '.claude', 'projects');
  const directories = projectDirectories(projectsPath);
  const reports = flows.map((flow) => compareFlow(flow, sessions, projectsPath, directories, options.tolerance));
  printReport(reports, options.json);
  process.exitCode = reports.some((report) => report.finding) ? 1 : 0;
} catch (error) {
  console.error(`cost-oracle: ${error.message}`);
  process.exitCode = 2;
} finally {
  if (cacheDirectory) rmSync(cacheDirectory, { recursive: true, force: true });
}

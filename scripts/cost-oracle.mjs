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
    const flow = flows.get(row.flowId) ?? { flowId: row.flowId, ledger_usd: 0, ledger_rows: 0 };
    flow.ledger_usd += row.cost_usd;
    flow.ledger_rows += 1;
    flows.set(row.flowId, flow);
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
  const under = flow.ledger_usd < oracle * (1 - tolerance);
  const verdict = under ? 'UNDER' : joined.size < 3 ? 'INSUFFICIENT-COVERAGE' : 'OK';
  return {
    ...flow,
    oracle_usd_lower_bound: oracle,
    oracle_is_strict_lower_bound: true,
    coverage_note: coverageNote,
    ledger_oracle_ratio: oracle > 0 ? flow.ledger_usd / oracle : null,
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
      + `ledger/oracle=${ratio} ledger_rows=${report.ledger_rows} sessions_joined=${report.sessions_joined} `
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

#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

const [runId, featureCode, projectArg] = process.argv.slice(2);
if (!runId || !featureCode) {
  console.error('Usage: node scripts/cost-census.mjs <runId> <featureCode> [projectCwd]');
  process.exitCode = 2;
} else {
  const projectCwd = resolve(projectArg ?? process.cwd());
  const flowPath = join(homedir(), '.stratum', 'ts', 'flows', `${runId}.json`);
  const accumulatorPath = join(
    projectCwd,
    '.compose',
    'data',
    'build-accumulator',
    `${featureCode}.json`,
  );
  const flow = JSON.parse(readFileSync(flowPath, 'utf8'));
  // The live accumulator is cleared when a build completes or aborts
  // (lib/build.js clearBuildAccumulator); after that the terminal totals live in
  // build-history.jsonl. Prefer the live file, fall back to the last history row.
  let accumulator;
  let accumulatorSource;
  if (existsSync(accumulatorPath)) {
    accumulator = JSON.parse(readFileSync(accumulatorPath, 'utf8'));
    accumulatorSource = 'build-accumulator (live)';
  } else {
    const historyPath = join(projectCwd, '.compose', 'data', 'build-history.jsonl');
    const rows = existsSync(historyPath)
      ? readFileSync(historyPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
    const last = rows.filter((row) => row?.feature_code === featureCode).at(-1);
    if (!last) {
      console.error(`no build accumulator or build-history row for ${featureCode} under ${projectCwd}`);
      process.exit(2);
    }
    accumulator = last;
    accumulatorSource = 'build-history.jsonl (terminal)';
  }
  console.log(`accumulator.source=${accumulatorSource}`);
  const receipts = Array.isArray(flow.receipts) ? flow.receipts : [];
  const costReceipts = receipts.filter((receipt) => receipt?.source !== 'engine');
  const clientReceipts = costReceipts.filter(
    (receipt) => !receipt?.dispatchId?.startsWith('legacy:') && receipt?.source !== 'server_dispatch',
  );
  const sumTokens = (rows) => rows.reduce(
    (sum, receipt) => sum + (Number(receipt?.amount?.tokens) || 0),
    0,
  );
  const sourceCounts = costReceipts.reduce((counts, receipt) => {
    const source = typeof receipt?.source === 'string' && receipt.source.length > 0
      ? receipt.source
      : 'unknown';
    counts[source] = (counts[source] ?? 0) + 1;
    return counts;
  }, {});
  const allHaveModel = receipts.every(
    (receipt) => typeof receipt?.telemetry?.model === 'string' && receipt.telemetry.model.length > 0,
  );

  console.log(`receipts.tokens.client_sources=${sumTokens(clientReceipts)}`);
  console.log(`receipts.tokens.all_sources=${sumTokens(costReceipts)}`);
  console.log(`flowSpent.tokens=${Number(flow?.flowSpent?.tokens) || 0}`);
  console.log(`accumulator.tokens_total=${Number(accumulator?.tokens_total) || 0}`);
  console.log(`receipts.counts_by_source=${JSON.stringify(sourceCounts)}`);
  console.log(`every_receipt_has_model=${allHaveModel}`);
}

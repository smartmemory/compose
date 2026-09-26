import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAndNormalize } from '../lib/result-normalizer.js';
import { reportUsageReceipts, toEngineUsage } from '../lib/build.js';
import { readFlowSpend } from '../lib/flow-state.js';

function fake(result, events = []) {
  let handler;
  return {
    onEvent(_flow, _step, fn) { handler = fn; return () => {}; },
    async agentRun() {
      for (const metadata of events) handler({ schema_version: '0.2.5', kind: 'step_usage', metadata });
      return { text: 'done', ...result };
    },
  };
}
const devin = { usage: { usd: 0, tokens: 11, ms: 7 }, usdSource: 'estimated',
  split: { input: 10, output: 1 }, telemetry: { model: 'swe-2-medium', effort: 'medium', durationMs: 7 } };
const rows = [
  ['Devin real result', 'devin', devin, [], 0, 'estimated'],
  ['Devin streamed', 'devin', devin, [{ input_tokens: 10, output_tokens: 1, cost_usd: 0, usd_source: 'estimated' }], 0, 'estimated'],
  ['Devin event-only stated zero', 'devin', { telemetry: devin.telemetry }, [{ input_tokens: 10, output_tokens: 1, cost_usd: 0, usd_source: 'estimated' }], 0, 'estimated'],
  ['Claude event-only stated zero', 'claude', { telemetry: { model: 'claude-opus-5-5', durationMs: 7 } }, [{ input_tokens: 10, output_tokens: 1, cost_usd: 0, usd_source: 'reported' }], 0, 'reported'],
  ['legacy unlabeled zero', 'devin', {}, [{ input_tokens: 10, output_tokens: 1, cost_usd: 0 }], undefined],
  ['partially unpriced', 'devin', devin, [{ input_tokens: 10, cost_usd: 0, usd_source: 'estimated' }, { output_tokens: 1 }], undefined],
  ['mixed unlabeled zero', 'devin', {}, [{ input_tokens: 10, cost_usd: 0, usd_source: 'estimated' }, { output_tokens: 1, cost_usd: 0 }], undefined],
  ['Claude stated zero', 'claude', { ...devin, usdSource: 'reported', telemetry: { model: 'claude-opus-5-5', durationMs: 7 } }, [], 0, 'reported'],
];
for (const [name, agent, result, events, cost, source] of rows) test(name + ' through normalization, receipts and spend verification', async t => {
  const out = await runAndNormalize(null, 'do work', { step_id: 'work', agent }, { stratum: fake(result, events), executionRuntime: 'stratum' });
  const record = out.usages[0];
  assert.equal(record.cost_usd, cost);
  if (source) assert.equal(record.usd_source, source);
  const receipts = [];
  await reportUsageReceipts({ receiptsMode: true, flowId: 'flow', stratum: {
    async usageReport(_flow, receipt) { receipts.push({ ...receipt, amount: receipt.usage }); return {}; },
  } }, out.usages);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].amount.usd, cost);
  if (source) assert.equal(receipts[0].usdSource, source);
  const root = mkdtempSync(join(tmpdir(), 'devin-spend-'));
  const old = process.env.STRATUM_STATE_ROOT;
  process.env.STRATUM_STATE_ROOT = root;
  t.after(() => { if (old === undefined) delete process.env.STRATUM_STATE_ROOT; else process.env.STRATUM_STATE_ROOT = old; rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, 'flow.json'), JSON.stringify({ id: 'flow', revisionDigest: 'rev', receipts }));
  if (cost === 0) assert.equal(readFlowSpend('flow', { revisionDigest: 'rev' }).spent, 0);
  else assert.throws(() => readFlowSpend('flow', { revisionDigest: 'rev' }), /Paid call cost missing/);
});

test('receipt conversion never invents zero or provenance', () => {
  assert.deepEqual(toEngineUsage({ tokens: 1, usd_source: 'estimated' }), { tokens: 1 });
  assert.deepEqual(toEngineUsage({ tokens: 1, usd: 0 }), { tokens: 1 });
  assert.deepEqual(toEngineUsage({ tokens: 1, usd: 0, usdSource: 'estimated' }), { tokens: 1, usd: 0 });
  assert.deepEqual(toEngineUsage({ tokens: 1, usd: 0, usd_source: 'estimated', usdUnknownSteps: 1 }), { tokens: 1 });
});

test('positive Claude and Codex records are byte-identical to HEAD 2106e32', async () => {
  const base = new URL('../lib/result-normalizer.js', import.meta.url);
  const source = execFileSync('git', ['show', '2106e32:lib/result-normalizer.js'], { encoding: 'utf8' })
    .replace(/from '(\.\.?\/[^']+)'/g, (_all, path) => `from '${new URL(path, base).href}'`);
  const baseline = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  for (const agent of ['claude', 'codex']) for (const streamed of [false, true]) {
    const result = { ...devin, usage: { ...devin.usage, usd: 0.25 }, usdSource: 'reported',
      telemetry: { model: agent === 'claude' ? 'claude-opus-5-5' : 'gpt-6-astra', effort: 'high', durationMs: 7 } };
    const events = streamed ? [{ input_tokens: 10, output_tokens: 1, cost_usd: 0.25, usd_source: 'reported' }] : [];
    const run = fn => fn(null, 'work', { step_id: 'work', agent }, { stratum: fake(result, events), executionRuntime: 'stratum' });
    const before = (await run(baseline.runAndNormalize)).usages;
    const after = (await run(runAndNormalize)).usages;
    // UUIDs identify separate invocations; every remaining record byte is pinned.
    for (const records of [before, after]) for (const entry of records) entry.dispatch_id = 'dispatch';
    assert.equal(JSON.stringify(after), JSON.stringify(before));
  }
});

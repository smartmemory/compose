import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { processTermination } from '../lib/process-termination.js';
import { runAndNormalize } from '../lib/result-normalizer.js';
import { reportUsageReceipts } from '../lib/build.js';

test('local termination waits for the group and rejects a surviving group', async t => {
  const child = Object.assign(new EventEmitter(), { pid: 123456 });
  t.mock.method(process, 'kill', () => true);
  const termination = processTermination(child, true, 0, 20);
  const result = termination.terminate();
  child.emit('close', 0);
  await assert.rejects(result, { code: 'CANCELLATION_TEARDOWN_TIMEOUT' });
});

for (const outcome of ['failure', 'late-timeout', 'interrupt', 'uncertain-teardown']) {
  test(`primary ${outcome} preserves provider price, split and identity in the actual receipt funnel`, async () => {
    const receipts = [];
    const progress = Object.assign(new EventEmitter(), { consumeAction: () => 'skip' });
    const stratum = {
      onEvent: () => () => {},
      async agentRun(_agent, _prompt, { signal }) {
        const result = { text: 'done', dispatchId: 'primary-fixture', usage: { tokens: 9, ms: 12, usd: 0.25 },
          split: { input: 7, output: 2, cacheRead: 4 }, usdSource: 'reported', telemetry: { model: 'gpt-fixture', durationMs: 12 } };
        if (outcome === 'interrupt') progress.emit('interrupt');
        if (outcome === 'late-timeout') {
          await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
          return result;
        }
        throw Object.assign(new Error('billable failure'), result,
          outcome === 'uncertain-teardown' ? { code: 'CANCELLATION_TEARDOWN_TIMEOUT' } : {});
      },
      async usageReport(_flow, receipt) { receipts.push(receipt); return {}; },
    };
    const error = await runAndNormalize(null, 'fixture', { step_id: 'work', agent: 'codex' }, {
      stratum, progress, maxDurationMs: outcome === 'late-timeout' ? 10 : 1000,
    }).catch(error => error);
    assert.ok(error instanceof Error);
    await reportUsageReceipts({ stratum, flowId: 'flow', receiptsMode: true }, error.usages ?? error.usage);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].dispatchId, 'primary-fixture');
    assert.deepEqual(receipts[0].usage, { tokens: 9, ms: 12, usd: 0.25 });
    assert.deepEqual(receipts[0].split, { input: 7, output: 2, cacheRead: 4 });
    assert.equal(receipts[0].usdSource, 'reported');
    assert.equal(receipts[0].telemetry.model, 'gpt-fixture');
  });
}

for (const timeout of [false, true]) {
  test(`review repair ${timeout ? 'late cancellation' : 'success'} preserves sibling USD provenance`, async () => {
    let calls = 0;
    const receipts = [];
    const stratum = {
      onEvent: () => () => {},
      async agentRun(_agent, _prompt, { signal }) {
        if (++calls === 1) return { text: 'review requires formatting', dispatchId: 'primary', usage: { tokens: 1, ms: 2 } };
        if (timeout) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        const value = { text: JSON.stringify({ summary: 'fixture', findings: [] }), dispatchId: 'repair', usage: { tokens: 9, ms: 12, usd: 0.25 },
          split: { input: 7, output: 2, cacheRead: 4 }, usdSource: 'reported', telemetry: { model: 'fixture', durationMs: 12 } };
        if (timeout) throw Object.assign(new Error('cancelled after late result'), value);
        return value;
      },
      async usageReport(_flow, receipt) { receipts.push(receipt); },
    };
    const result = await runAndNormalize(null, 'fixture', { step_id: 'review', agent: 'codex' }, {
      stratum, reviewMode: true, maxDurationMs: timeout ? 20 : 1000,
    }).catch(error => error);
    assert.equal(calls, 2);
    await reportUsageReceipts({ stratum, flowId: 'flow', receiptsMode: true }, result.usages);
    assert.equal(receipts.length, 2);
    assert.deepEqual(receipts[1].usage, { tokens: 9, ms: 12, usd: 0.25 });
    assert.deepEqual(receipts[1].split, { input: 7, output: 2, cacheRead: 4 });
    assert.equal(receipts[1].usdSource, 'reported');
  });
}

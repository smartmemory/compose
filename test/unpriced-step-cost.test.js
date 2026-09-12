/**
 * COMP-COST-OWNER S3 — the consumer never invents a cost.
 *
 * S1 made the accumulator the sole owner and S2 stopped the stream destroying provenance.
 * This is the same rule one layer earlier: `result-normalizer` used to price tokens itself
 * whenever a producer sent a `step_usage` with no `cost_usd`, which turned an UNKNOWN cost
 * into an estimate nobody asked for -- and, worse, into a run total that was SHORT by the
 * unknown step while still calling itself an estimate.
 *
 * Probes recorded in docs/features/COMP-COST-OWNER/evidence/s3-reachability-probes-2026-09-12.md
 * show that fallback could only ever return 0 on a real producer path (the only models it can
 * be asked about are exactly the ones stratum could not price either), so removing it changes
 * no amount. What it changes is the LABEL, and that is what these tests pin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { runAndNormalize } = await import(`${REPO_ROOT}/lib/result-normalizer.js`);

/**
 * Fake stratum client emitting v0.2.5 envelopes, mirroring test/cost-tracking.test.js.
 * `metadata` is passed through verbatim so a test can OMIT cost_usd -- the omission is
 * the signal under test and must not be filled in by the harness.
 */
function fakeStratum(usageEvents, runResult = {}) {
  const subs = new Map();
  return {
    onEvent(flowId, stepId, handler) {
      const key = `${flowId}::${stepId}`;
      let set = subs.get(key);
      if (!set) { set = new Set(); subs.set(key, set); }
      set.add(handler);
      return () => set.delete(handler);
    },
    async agentRun(_agentType, _prompt, opts) {
      const correlationId = opts?.correlationId;
      const set = subs.get(`${correlationId}::_agent_run`) ?? new Set();
      let seq = 0;
      for (const h of set) {
        h({
          schema_version: '0.2.5', flow_id: correlationId, step_id: '_agent_run',
          task_id: null, seq: seq++, ts: '', kind: 'agent_relay',
          metadata: { role: 'assistant', text: 'ok' },
        });
      }
      for (const metadata of usageEvents) {
        for (const h of set) {
          h({
            schema_version: '0.2.5', flow_id: correlationId, step_id: '_agent_run',
            task_id: null, seq: seq++, ts: '', kind: 'step_usage', metadata,
          });
        }
      }
      return { text: 'ok', correlation_id: correlationId, ...runResult };
    },
    async cancelAgentRun(correlationId) { return { status: 'cancelled', correlation_id: correlationId }; },
  };
}

const run = (stratum) =>
  runAndNormalize(null, 'prompt', { step_id: 's', output_fields: {} }, { stratum });

// ---------------------------------------------------------------------------
// 1. Tokens with no stated cost stay UNKNOWN -- no amount is invented.
// ---------------------------------------------------------------------------

test('a step with tokens and no stated cost yields a usage record with NO cost_usd', async () => {
  // A Claude model ID is used deliberately: it is the one case where compose's deleted
  // table COULD have produced a number, so this is the assertion that would have failed
  // before the fallback was removed.
  const { usages } = await run(fakeStratum([
    { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0, model: 'claude-sonnet-4-6' },
  ]));

  assert.equal(usages.length, 1, 'one primary usage record');
  assert.ok(!Object.hasOwn(usages[0], 'cost_usd'),
    `cost must be OMITTED when nobody stated it, got cost_usd=${usages[0].cost_usd}`);
  assert.equal(usages[0].input_tokens, 1000, 'tokens are still reported -- only the cost is unknown');
  assert.equal(usages[0].output_tokens, 500);
});

// ---------------------------------------------------------------------------
// 2. One unpriced step poisons the whole total. A short sum is worse than no sum.
// ---------------------------------------------------------------------------

test('a priced step plus an unpriced step refuses the partial total', async () => {
  const { usages } = await run(fakeStratum([
    { input_tokens: 100, output_tokens: 50, cost_usd: 0.25, usd_source: 'reported',
      model: 'claude-sonnet-4-6' },
    { input_tokens: 900, output_tokens: 400, model: 'claude-sonnet-4-6' },
  ]));

  assert.ok(!Object.hasOwn(usages[0], 'cost_usd'),
    `a total missing one step's spend must not be reported as the total, got ${usages[0].cost_usd}`);
  assert.equal(usages[0].input_tokens, 1000, 'token counts still aggregate across both steps');
});

// ---------------------------------------------------------------------------
// 3. A stated cost is still carried, with its stated provenance, unchanged.
// ---------------------------------------------------------------------------

test('a stated cost and its provenance survive untouched', async () => {
  const { usages } = await run(fakeStratum([
    { input_tokens: 216385, output_tokens: 5836, cache_read_input_tokens: 179200,
      cost_usd: 0.17813775, usd_source: 'estimated', model: 'gpt-5.3-codex-spark' },
  ]));

  assert.equal(usages[0].cost_usd, 0.17813775,
    'the producer stated the amount; the consumer must not re-derive it');
  assert.equal(usages[0].usd_source, 'estimated', 'stated provenance is preserved, never upgraded');
});

test('estimated is sticky across a run: a mixed total cannot honestly be called reported', async () => {
  const { usages } = await run(fakeStratum([
    { input_tokens: 100, output_tokens: 10, cost_usd: 0.5, usd_source: 'reported', model: 'gpt-6-astra' },
    { input_tokens: 100, output_tokens: 10, cost_usd: 0.25, usd_source: 'estimated', model: 'gpt-6-astra' },
  ]));

  assert.equal(usages[0].cost_usd, 0.75);
  assert.equal(usages[0].usd_source, 'estimated');
});

// ---------------------------------------------------------------------------
// 4. The connector result stays authoritative, INCLUDING over unknown steps.
//
// Before S3 this branch fired only when the event total was 0. With unknown steps no
// longer adding 0, a run whose events are partly unpriced must still adopt the
// connector's own figure rather than reporting unknown -- otherwise removing the
// fallback would LOSE a number the connector actually knew.
// ---------------------------------------------------------------------------

test('the connector result total is adopted when some steps were unpriced', async () => {
  const { usages } = await run(fakeStratum(
    [
      { input_tokens: 100, output_tokens: 50, cost_usd: 0.1, usd_source: 'reported', model: 'gpt-6-astra' },
      { input_tokens: 900, output_tokens: 400, model: 'gpt-6-astra' },
    ],
    { usage: { usd: 1.5, tokens: 1450 }, usdSource: 'reported' },
  ));

  assert.equal(usages[0].cost_usd, 1.5,
    "the connector's authoritative total supersedes an incomplete per-step sum");
  assert.equal(usages[0].usd_source, 'reported');
});

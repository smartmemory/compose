/**
 * Tests for lib/result-normalizer.js
 *
 * STRAT-DEDUP-AGENTRUN-V3 — runAndNormalize now dispatches via a
 * StratumMcpClient (`opts.stratum`) instead of accepting a JS connector.
 * These tests inject a fake stratum client with `agentRun`, `cancelAgentRun`,
 * and `onEvent` methods.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const {
  outputFieldsToJsonSchema,
  runAndNormalize,
  AgentError,
} = await import(`${REPO_ROOT}/lib/result-normalizer.js`);

// ---------------------------------------------------------------------------
// Fake stratum client
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake StratumMcpClient.
 *
 * @param {object} cfg
 * @param {string|((prompt: string) => string)} [cfg.text]      Text to return.
 * @param {Error}                              [cfg.error]      Throw from agentRun.
 * @param {object[]}                           [cfg.events]     BuildStreamEvent envelopes to fire on subscribers.
 */
function fakeStratum({ text = '', error = null, events = [] } = {}) {
  const subs = new Map();
  const recordedCalls = { agentRun: [], cancel: [] };
  return {
    onEvent(flowId, stepId, handler) {
      const key = `${flowId}::${stepId}`;
      let set = subs.get(key);
      if (!set) { set = new Set(); subs.set(key, set); }
      set.add(handler);
      return () => set.delete(handler);
    },
    async agentRun(agentType, prompt, opts) {
      recordedCalls.agentRun.push({ agentType, prompt, opts });
      const correlationId = opts?.correlationId;
      const key = `${correlationId}::_agent_run`;
      const set = subs.get(key) ?? new Set();
      for (const env of events) {
        for (const h of set) h({
          schema_version: '0.2.5',
          flow_id: correlationId,
          step_id: '_agent_run',
          ...env,
        });
      }
      if (error) throw error;
      const finalText = typeof text === 'function' ? text(prompt) : text;
      return { text: finalText, correlation_id: correlationId };
    },
    async cancelAgentRun(correlationId) {
      recordedCalls.cancel.push(correlationId);
      return { status: 'cancelled', correlation_id: correlationId };
    },
    _calls: recordedCalls,
  };
}

// ---------------------------------------------------------------------------
// outputFieldsToJsonSchema (pure)
// ---------------------------------------------------------------------------

test('outputFieldsToJsonSchema converts typed fields to JSON Schema', () => {
  const schema = outputFieldsToJsonSchema({ clean: 'boolean', findings: 'array' });
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['clean', 'findings']);
  assert.deepEqual(schema.properties.clean, { type: 'boolean' });
  assert.deepEqual(schema.properties.findings, { type: 'array' });
});

test('outputFieldsToJsonSchema maps "any" type to unconstrained {}', () => {
  const schema = outputFieldsToJsonSchema({ data: 'any', extra: 'unknown' });
  assert.deepEqual(schema.properties.data, {});
  assert.deepEqual(schema.properties.extra, {});
  assert.deepEqual(schema.required, ['data', 'extra']);
});

// ---------------------------------------------------------------------------
// runAndNormalize — JSON extraction strategies
// ---------------------------------------------------------------------------

test('normalizes clean JSON text to parsed result', async () => {
  const stratum = fakeStratum({ text: '{"clean": true}' });
  const { text, result } = await runAndNormalize(
    null,
    'check code',
    { step_id: 's', output_fields: { clean: 'boolean' } },
    { stratum },
  );
  assert.equal(text, '{"clean": true}');
  assert.deepEqual(result, { clean: true });
});

test('extracts JSON from fenced ```json block', async () => {
  const stratum = fakeStratum({
    text: 'Here is the result:\n```json\n{"clean": true, "findings": []}\n```\nDone.',
  });
  const { result } = await runAndNormalize(
    null,
    'check code',
    { step_id: 's', output_fields: { clean: 'boolean', findings: 'array' } },
    { stratum },
  );
  assert.deepEqual(result, { clean: true, findings: [] });
});

test('extracts JSON from text with surrounding prose', async () => {
  const stratum = fakeStratum({ text: 'Here is the result: {"clean": true} done' });
  const { result } = await runAndNormalize(
    null,
    'check code',
    { step_id: 's', output_fields: { clean: 'boolean' } },
    { stratum },
  );
  assert.deepEqual(result, { clean: true });
});

// ---------------------------------------------------------------------------
// runAndNormalize — fallback / no-schema / error
// ---------------------------------------------------------------------------

test('returns fallback result when schema expected but no JSON found', async () => {
  const stratum = fakeStratum({ text: 'I could not produce JSON' });
  const { text, result } = await runAndNormalize(
    null,
    'check code',
    { step_id: 's', output_fields: { clean: 'boolean' } },
    { stratum },
  );
  assert.equal(text, 'I could not produce JSON');
  assert.ok(result.summary, 'fallback result should have a summary');
});

test('returns { text, result: null } when no schema expected', async () => {
  const stratum = fakeStratum({ text: 'All good, no issues found.' });
  const { text, result } = await runAndNormalize(
    null,
    'check code',
    { step_id: 's', output_fields: {} },
    { stratum },
  );
  assert.equal(text, 'All good, no issues found.');
  assert.equal(result, null);
});

test('throws AgentError when agentRun rejects', async () => {
  const stratum = fakeStratum({ error: new Error('fail') });
  await assert.rejects(
    () => runAndNormalize(
      null,
      'check code',
      { step_id: 's', output_fields: { clean: 'boolean' } },
      { stratum },
    ),
    (err) => {
      assert.ok(err instanceof AgentError);
      assert.equal(err.message, 'fail');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// runAndNormalize — BuildStreamEvent envelope translation
// ---------------------------------------------------------------------------

test('forwards agent_relay envelope as assistant stream-writer event', async () => {
  const written = [];
  const stratum = fakeStratum({
    text: '',
    events: [
      { kind: 'agent_relay', metadata: { role: 'assistant', text: 'hello world' } },
    ],
  });
  const { text } = await runAndNormalize(
    null,
    'p',
    { step_id: 's', output_fields: {} },
    { stratum, streamWriter: { write: (ev) => written.push(ev) } },
  );
  assert.equal(text, 'hello world');
  assert.deepEqual(written, [{ type: 'assistant', content: 'hello world' }]);
});

test('aggregates step_usage envelopes into usage totals', async () => {
  const stratum = fakeStratum({
    text: 'ok',
    events: [
      { kind: 'step_usage', metadata: {
        input_tokens: 10, output_tokens: 5, model: 'claude-sonnet-4-6',
        cache_creation_input_tokens: 2, cache_read_input_tokens: 1, cost_usd: 0.001,
      } },
    ],
  });
  const { usage } = await runAndNormalize(
    null,
    'p',
    { step_id: 's', output_fields: {} },
    { stratum },
  );
  assert.equal(usage.input_tokens, 10);
  assert.equal(usage.output_tokens, 5);
  assert.equal(usage.model, 'claude-sonnet-4-6');
  assert.equal(usage.cost_usd, 0.001);
});

test('refuses to run without opts.stratum', async () => {
  await assert.rejects(
    () => runAndNormalize(null, 'p', { step_id: 's', output_fields: {} }, {}),
    (err) => err instanceof AgentError,
  );
});

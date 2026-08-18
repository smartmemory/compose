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

test('forwards a v0.2.6 agent_relay envelope (consumer accepts KNOWN_VERSIONS, not just 0.2.5)', async () => {
  // The producer (stratum_mcp/events.py) emits schema_version 0.2.6. The consumer
  // must not hard-pin 0.2.5 or it silently drops all live agent-run narration.
  const written = [];
  const stratum = fakeStratum({
    text: '',
    events: [
      { schema_version: '0.2.6', kind: 'agent_relay', metadata: { role: 'assistant', text: 'from 0.2.6' } },
    ],
  });
  const { text } = await runAndNormalize(
    null,
    'p',
    { step_id: 's', output_fields: {} },
    { stratum, streamWriter: { write: (ev) => written.push(ev) } },
  );
  assert.equal(text, 'from 0.2.6', 'v0.2.6 agent_relay must be forwarded, not dropped');
  assert.deepEqual(written, [{ type: 'assistant', content: 'from 0.2.6' }]);
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

// ---------------------------------------------------------------------------
// COMP-AGENT-LANES (S01b) — lane stamping on relayed stream writes
// ---------------------------------------------------------------------------

const LANE = {
  flowId: 'f1', stepId: 'execute_tasks/0', itemIndex: 0,
  generation: 1, attempt: 1, label: 'Run task 0', agent: 'claude',
};

test('lane opt stamps every engine-path stream write (assistant, tool_use, tool_use_summary, usage)', async () => {
  const written = [];
  const stratum = fakeStratum({
    text: 'ok',
    events: [
      { kind: 'agent_relay', metadata: { role: 'assistant', text: 'hi' } },
      { kind: 'tool_use_summary', metadata: { tool: 'Bash', input: { command: 'ls' }, summary: 'listed', output: 'a' } },
      { kind: 'step_usage', metadata: { input_tokens: 1, output_tokens: 1, model: 'm' } },
    ],
  });
  await runAndNormalize(
    null,
    'p',
    { step_id: 's', output_fields: {} },
    { stratum, lane: LANE, streamWriter: { write: (ev) => written.push(ev) } },
  );
  const byType = Object.groupBy(written, (ev) => ev.type);
  for (const type of ['assistant', 'tool_use', 'tool_use_summary', 'usage']) {
    assert.ok(byType[type]?.length, `expected a ${type} write`);
    for (const ev of byType[type]) {
      assert.deepEqual(ev.lane, LANE, `${type} write must carry the lane envelope`);
    }
  }
});

test('absent lane opt leaves stream writes byte-identical (no lane key)', async () => {
  const written = [];
  const stratum = fakeStratum({
    text: 'ok',
    events: [
      { kind: 'agent_relay', metadata: { role: 'assistant', text: 'hi' } },
      { kind: 'tool_use_summary', metadata: { tool: 'Bash', input: { command: 'ls' }, summary: 'listed', output: 'a' } },
      { kind: 'step_usage', metadata: { input_tokens: 1, output_tokens: 1, model: 'm' } },
    ],
  });
  await runAndNormalize(
    null,
    'p',
    { step_id: 's', output_fields: {} },
    { stratum, streamWriter: { write: (ev) => written.push(ev) } },
  );
  for (const ev of written) {
    assert.ok(!('lane' in ev), `write ${ev.type} must not grow a lane key without the opt`);
  }
  // Exact-shape snapshot for the relay write (the historical contract).
  assert.deepEqual(written[0], { type: 'assistant', content: 'hi' });
});

test('lane opt stamps the local-claude path tool_use write (C2)', async () => {
  const written = [];
  const localQuery = function () {
    return (async function* () {
      yield { type: 'system', subtype: 'init', model: 'claude-test' };
      yield {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x' } }] },
      };
      yield {
        type: 'result', subtype: 'success', result: 'done',
        total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 1,
      };
    })();
  };
  const stratum = fakeStratum({ text: 'unused' });
  await runAndNormalize(
    null,
    'p',
    { step_id: 's', agent: 'claude', output_fields: {} },
    {
      stratum, lane: LANE, localExecution: true, localQuery,
      streamWriter: { write: (ev) => written.push(ev) },
    },
  );
  const toolUse = written.find((ev) => ev.type === 'tool_use');
  assert.ok(toolUse, 'local path must emit a tool_use write');
  assert.deepEqual(toolUse.lane, LANE, 'local-path tool_use must carry the lane envelope');
});

test('local path relays assistant text with lane stamp; without lane it stays silent', async () => {
  const mkQuery = () => function () {
    return (async function* () {
      yield { type: 'system', subtype: 'init', model: 'claude-test' };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'live text' }] } };
      yield {
        type: 'result', subtype: 'success', result: 'done',
        total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 1,
      };
    })();
  };
  const run = async (withLane) => {
    const written = [];
    await runAndNormalize(
      null, 'p',
      { step_id: 's', agent: 'claude', output_fields: {} },
      {
        stratum: fakeStratum({ text: 'unused' }),
        localExecution: true, localQuery: mkQuery(),
        ...(withLane ? { lane: LANE } : {}),
        streamWriter: { write: (ev) => written.push(ev) },
      },
    );
    return written;
  };
  const withLane = await run(true);
  const assistant = withLane.find((ev) => ev.type === 'assistant');
  assert.ok(assistant, 'lane-carrying local run must relay assistant text');
  assert.equal(assistant.content, 'live text');
  assert.deepEqual(assistant.lane, LANE);
  const withoutLane = await run(false);
  assert.ok(
    !withoutLane.some((ev) => ev.type === 'assistant'),
    'lane-less local run keeps its historical shape (no assistant writes)',
  );
});

// ---------------------------------------------------------------------------
// sandboxMode routing — the engine's read-only sandbox binds CODEX ONLY.
//
// A read-only profile (Edit+Write disallowed) used to map to
// `sandboxMode: 'read-only'` for every provider. For a claude agent the engine's
// connector does not merely ignore it, it REJECTS the run:
//
//   "claude runs with sandboxMode=read-only are not supported: the Claude
//    connector cannot enforce read-only (D8). Omit sandboxMode or pass
//    workspace-write."
//
// `review_triage` is exactly that shape (`claude:orchestrator`, Edit+Write
// disallowed) in BOTH build.profiles.json and build-quick.profiles.json, so
// every headless build died on dispatch before it could reach `ship` — which is
// why build-history.jsonl contains no successful run. Found by running a real
// build, not by review.
//
// Nothing is lost by omitting it: the engine seam never enforced claude tool
// restrictions in the first place (see lib/local-claude-connector.js), and the
// read-only FANOUT keeps its real enforcement through the compose-local
// connector. Binding the restriction on plain claude steps is COMP-CLAUDE-READONLY-BIND.
// ---------------------------------------------------------------------------

test('read-only CODEX profile still requests the engine read-only sandbox', async () => {
  const stratum = fakeStratum({ text: '{}' });
  await runAndNormalize(
    null,
    'review it',
    { step_id: 'review_triage', agent: 'codex' },
    { stratum, profile: 'codex:read-only-reviewer' },
  );
  const call = stratum._calls.agentRun.at(-1);
  assert.equal(call.opts.sandboxMode, 'read-only',
    'codex is the one connector the engine sandbox actually binds');
});

test('read-only CLAUDE profile must NOT send sandboxMode (the connector rejects it)', async () => {
  const stratum = fakeStratum({ text: '{}' });
  await runAndNormalize(
    null,
    'triage lenses',
    { step_id: 'review_triage', agent: 'claude' },
    { stratum, profile: 'claude:orchestrator' },
  );
  const call = stratum._calls.agentRun.at(-1);
  assert.equal(call.opts.sandboxMode, undefined,
    'sending read-only for claude hard-fails the dispatch — omit it');
});

test('the WIRE request omits sandboxMode entirely when it is undefined', async () => {
  // The assertion above stops at compose's own boundary, where the key may be
  // present-and-undefined. What the engine validates is the request built here,
  // and `mcp-surface.json` rejects unknown keys — so pin the actual wire shape.
  const { buildAgentRunRequest } = await import(`${REPO_ROOT}/lib/stratum-mcp-client.js`);
  const req = buildAgentRunRequest('claude', 'triage lenses', { cwd: '/tmp', sandboxMode: undefined });
  assert.equal('sandboxMode' in req, false, 'no sandboxMode key reaches the engine');
  assert.deepEqual(Object.keys(req).sort(), ['agent', 'cwd', 'prompt']);

  const codexReq = buildAgentRunRequest('codex', 'review it', { cwd: '/tmp', sandboxMode: 'read-only' });
  assert.equal(codexReq.sandboxMode, 'read-only', 'codex still carries it');
});

test('a WRITE claude profile is unaffected (never had a sandbox to begin with)', async () => {
  const stratum = fakeStratum({ text: '{}' });
  await runAndNormalize(
    null,
    'implement it',
    { step_id: 'execute', agent: 'claude' },
    { stratum },
  );
  assert.equal(stratum._calls.agentRun.at(-1).opts.sandboxMode, undefined);
});

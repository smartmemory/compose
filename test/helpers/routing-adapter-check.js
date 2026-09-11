import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import YAML from 'yaml';
import { runConsumerIssuance, planWithRouting, reportUsageReceipts } from '../../lib/build.js';
import { recoverRoutingEvidence } from '../../lib/routing-runtime.js';
import { runtimeFixture, simpleSpec } from './routing-runtime-fixture.js';

// Capture only provider stimuli from the original adapter. Replaying these in
// an isolated participating run avoids reusing its mutable counters, UI, or sinks.
// No journal, binding, receipt, settlement or outcome is manufactured by replay.
function captureProvider(options, trace, envelopes) {
  let current;
  const begin = transport => {
    const call = { transport, started: Date.now(), messages: [], events: [] };
    trace.push(call); current = call; return call;
  };
  return new Proxy(options.stratum, { get(target, key) {
    if (key === '_localQuery' && target[key]) return args => (async function* () {
      const call = begin('local-sdk');
      try {
        for await (const message of target[key](args)) {
          call.messages.push({ after: Date.now() - call.started, value: structuredClone(message) });
          yield message;
        }
      } catch (error) { call.error = error; throw error; }
      finally { call.elapsed = Date.now() - call.started; call.aborted = args.options?.abortController?.signal.aborted; }
    })();
    if (key === 'agentRun') return async (...args) => {
      const call = begin('mcp');
      try { call.value = await target[key](...args); return call.value; }
      catch (error) { call.error = error; throw error; }
      finally { call.elapsed = Date.now() - call.started; call.aborted = args[2]?.signal?.aborted; }
    };
    if (key === 'stepDone') return async (...args) => { envelopes.push(structuredClone(args[2])); return target.stepDone(...args); };
    if (key === 'onEvent') return (flow, step, handler) => target.onEvent(flow, step, event => {
      current?.events.push({ after: Date.now() - current.started, value: structuredClone(event) }); handler(event);
    });
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function participatingAdapter(options, trace, originalError, envelopes) {
  const cleanup = [];
  const t = { after: fn => cleanup.push(fn) };
  const spec = simpleSpec(), flow = spec.flows.bug_fix;
  const step = options.descriptor.step;
  const contract = options.descriptor.contract;
  spec.contracts = structuredClone(contract?.contracts ?? options.localSpec.contracts ?? {});
  flow.input.items = 'object[]';
  flow.steps = [{ id: step, fanout: { over: '${input.items}', dispatch: 'consumer', isolation: options.descriptor.policy?.isolation ?? 'none',
    concurrency: 1, merge: 'sequential', require: 'all', steps: [{ agent: options.descriptor.agent, do: options.descriptor.do,
      ...(contract?.root ? { out: contract.root } : {}) }] } }];
  flow.output = { from: '${' + step + '.output[0]}', contract: contract.root };
  let index = 0, eventHandler, releaseOnCancel;
  const progress = Object.assign(new EventEmitter(), { stepStart() {}, stepDone() {}, info() {}, debug() {}, warn() {},
    toolUse() {}, toolSummary() {}, findings() {}, consumeAction: () => 'skip' });
  const consume = transport => {
    const call = trace[index++]; assert.ok(call, 'participation must not add a provider call');
    assert.equal(call.transport, transport, 'participation preserves the adapter transport');
    if (originalError?.name === 'UserInterruptError' && index === trace.length) {
      // Replay the operator input while the same provider stage is outstanding.
      setTimeout(() => progress.emit('interrupt'), 1);
    }
    return call;
  };
  try {
    const f = await runtimeFixture(t, { spec });
    const planned = await planWithRouting({ stratum: f.stratum, specYaml: YAML.stringify(spec), flowName: 'bug_fix',
      input: { task: 'adapter scenario', items: [options.descriptor.item ?? { id: 'item' }] }, cwd: f.cwd,
      featureCode: 'ADAPTER', options: { mode: 'shadow' }, artifactRoot: f.artifactRoot });
    const routing = planned.routing, artifacts = routing.artifacts;
    const descriptor = planned.response.ready.find(d => d.step === step);
    assert.ok(descriptor, 'real engine must issue the consumer descriptor');
    f.connector._localQuery = ({ options: sdkOptions }) => (async function* () {
      const call = consume('local-sdk'); let elapsed = 0;
      for (const message of call.messages) {
        if (call.aborted && message.value.type === 'result' && !sdkOptions.abortController.signal.aborted) {
          await new Promise(resolve => sdkOptions.abortController.signal.addEventListener('abort', resolve, { once: true }));
        }
        await delay(Math.max(0, message.after - elapsed)); elapsed = message.after;
        yield structuredClone(message.value);
      }
      if (call.error) throw call.error;
    })();
    f.connector._testClient = { callTool: async ({ name }, _schema, request) => {
      if (name === 'stratum_cancel_agent_run') { releaseOnCancel?.(); return { content: [{ type: 'text', text: '{"status":"cancelled"}' }] }; }
      assert.equal(name, 'stratum_agent_run');
      const call = consume('mcp');
      for (const event of call.events) eventHandler?.(structuredClone(event.value));
      if (call.aborted) await new Promise(resolve => { releaseOnCancel = resolve; });
      else await delay(call.elapsed);
      if (call.error) {
        // Returned agent errors remain protocol errors at the real boundary.
        // A bare transport failure remains a bare failure (no fake termination).
        if (call.error.usage) throw new McpError(ErrorCode.InternalError, call.error.message, {
          usage: call.error.usage, telemetry: call.error.telemetry, split: call.error.split, usdSource: call.error.usdSource,
        });
        throw call.error;
      }
      return { content: [{ type: 'text', text: JSON.stringify(call.value) }] };
    } };
    const onEvent = f.connector.onEvent.bind(f.connector);
    f.connector.onEvent = (flow, step, handler) => { eventHandler = handler; return onEvent(flow, step, handler); };
    const context = { ...options.context, cwd: f.cwd, projectCwd: f.cwd, stratum: f.stratum, flowId: f.flowId,
      routing, artifacts, receiptsMode: true,
      onUsage: (usage, meta) => reportUsageReceipts(context, usage, meta) };
    let error;
    try {
      await runConsumerIssuance({ ...options, descriptor, flowId: f.flowId, stratum: f.stratum, artifacts, localSpec: spec,
        context, progress, streamWriter: { write() {} },
        // Keep the original deadline scenario, allowing journal I/O before the
        // controlled provider stage waits for the actual timeout/interrupt.
        perItemTimeoutMs: options.perItemTimeoutMs ? Math.max(2000, options.perItemTimeoutMs) : null, audit: await f.engine.audit(f.flowId) });
    } catch (caught) { error = caught; }
    if (originalError) assert.equal(error?.name, originalError.name, 'participation preserves the original control exit');
    else if (error) throw error;
    await recoverRoutingEvidence(context);
    assert.equal(index, trace.length, 'the same primary and repair calls must run with a real journal');
    const rows = f.rows(), parent = rows.find(r => r.issuance?.scopedStep === step);
    assert.ok(parent, 'the adapter must materialize a participating issuance');
    assert.equal(parent.calls.length, trace.length, 'all participating provider calls belong to the original item');
    assert.ok(parent.calls.every(c => c.resolution), 'real connector resolutions must be durable');
    const paid = artifacts.journal.pendingUsageReceipts.filter(p => p.receipt.detail?.routing?.kind === 'paid-call');
    assert.equal(paid.length, trace.length, 'each returned provider call must retain its canonical receipt');
    assert.equal(f.reports.length, envelopes.length, 'participation preserves whether the adapter reports a result');
    for (const [n, envelope] of envelopes.entries()) {
      const actual = f.reports[n][2];
      assert.equal(Boolean(actual.failure), Boolean(envelope.failure), 'participation preserves failure vs success');
      if (!envelope.failure) assert.deepEqual(actual.output, envelope.output, 'participation preserves normalized adapter output');
      assert.equal(Object.hasOwn(actual, 'usage'), false, 'participating spend belongs to the original receipt spool');
    }
    if (originalError) assert.equal(f.reports.length, 0, 'interrupted or stuck work must not settle');
  } finally {
    for (const dispose of cleanup.reverse()) await dispose();
  }
}

let replayQueue = Promise.resolve();

/** Every literal adapter runs all three populations. The off run supplies only
 * the provider responses/operator events for the isolated real-journal replay. */
export async function checkedConsumerAdapter(options) {
  let launches = 0;
  const stratum = new Proxy(options.stratum, { get(target, key, receiver) {
    if (['agentRun', 'runAgentText', '_localQuery'].includes(key)) return () => { launches++; throw Error('Model reached with missing routing journal'); };
    return Reflect.get(target, key, receiver);
  } });
  await assert.rejects(runConsumerIssuance({ ...options, stratum,
    context: { ...options.context, routing: {} },
  }), { code: 'ROUTING_BINDING_MISSING' });
  assert.equal(launches, 0);
  const trace = [], envelopes = []; let result, error;
  try { result = await runConsumerIssuance({ ...options, stratum: captureProvider(options, trace, envelopes) }); }
  catch (caught) { error = caught; }
  assert.ok(trace.length, 'the original adapter scenario must reach a provider');
  const replay = replayQueue.then(() => participatingAdapter(options, trace, error, envelopes));
  replayQueue = replay.catch(() => {});
  await replay;
  if (error) throw error;
  return result;
}

import crypto from 'node:crypto';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';
import { runLocalClaudeAgent } from '../lib/local-claude-connector.js';
import { runAndNormalize } from '../lib/result-normalizer.js';
import { callsForRouting, recoverRoutingEvidence } from '../lib/routing-runtime.js';
import { materializeRoutingLedger } from '../lib/routing-ledger.js';
import { fixture, consumerWave } from './helpers/routing-s1b-fixture.js';
process.env.NODE_ENV = 'test';
const wire = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
function connector(f, responder) {
  const client = new StratumMcpClient();
  client._testClient = { callTool: async ({ name, arguments: args }) => {
    if (name === 'stratum_usage_report') return wire({ status: 'ok', receipt: { seq: 1 } });
    return wire(await responder(args));
  } };
  f.context.stratum = client;
  return client;
}
const result = (text = 'done', usd = 3) => ({ text, usage: { tokens: 20, ms: 50, usd }, usdSource: 'reported', telemetry: { model: 'gpt-5.4', effort: 'high' } });
const calls = f => Object.values(f.reopen().exportRoutingJournal().records).filter(r => r.type === 'call-intent');
const resolutions = f => Object.values(f.reopen().exportRoutingJournal().records).filter(r => r.type === 'call-resolution');
test('real MCP boundary owns one invocation and strips observer from the transport', async t => {
  const f = fixture(t); const i = f.issue(); f.launch(i);
  let original;
  const client = connector(f, args => { original = calls(f)[0]; assert.ok(original); assert.equal(args.routingCalls, undefined); return result(); });
  const value = await client.agentRun('codex', 'original prompt', { routingCalls: callsForRouting(f.context, i), modelID: 'gpt-5.4', effort: 'high' });
  assert.equal(calls(f).length, 1); assert.equal(value.dispatchId, original.callId);
  assert.equal(resolutions(f)[0].usageEvidence.usd, 3);
  const receipt = f.reopen().journal.pendingUsageReceipts.find(p => p.dispatchId === value.dispatchId);
  assert.equal(receipt.receipt.detail.routing.issuanceId, i.id); assert.equal(receipt.state, 'acknowledged');
});
test('pre-dispatch MCP abort records minted identity and proves no execution', async t => {
  const f = fixture(t); const i = f.issue(); let launches = 0;
  const client = connector(f, () => { launches++; return result(); });
  await assert.rejects(client.agentRun('codex', 'p', { signal: AbortSignal.abort(), routingCalls: callsForRouting(f.context, i) }));
  assert.equal(launches, 0); assert.equal(calls(f).length, 1);
  assert.equal(resolutions(f)[0].launchOutcome, 'not-executed'); assert.ok(resolutions(f)[0].callId);
});
for (const failed of [false, true]) test(`local SDK raw presence and null effort, failed=${failed}`, async t => {
  const f = fixture(t); const i = f.issue();
  f.context.stratum = { usageReport: async () => ({ status: 'ok' }) };
  async function* query({ options }) {
    assert.equal(options.routingCalls, undefined); assert.equal(calls(f).length, 1);
    yield { type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' };
    yield { type: 'result', subtype: failed ? 'error_max_turns' : 'success', result: 'done', total_cost_usd: 0.2, duration_ms: 17, usage: { input_tokens: 3, output_tokens: 7 } };
  }
  const p = runLocalClaudeAgent('p', { query, effort: 'high', routingCalls: callsForRouting(f.context, i) });
  if (failed) await assert.rejects(p); else await p;
  const r = resolutions(f)[0]; assert.equal(r.usageEvidence.tokens, 10); assert.equal(r.usageEvidence.usd, 0.2);
  assert.equal(r.reportedEffort, null); assert.equal(r.outcome, failed ? 'errored' : 'resolved');
});
test('missing SDK usage never becomes zero-valued raw evidence', async t => {
  const f = fixture(t); const i = f.issue();
  await runLocalClaudeAgent('p', { query: async function* () { yield { type: 'result', subtype: 'success', result: 'done' }; }, routingCalls: callsForRouting(f.context, i) });
  const r = resolutions(f)[0]; assert.equal(r.usageEvidence.tokens, null); assert.equal(r.usageEvidence.usd, null); assert.equal(r.reportedModel, null);
});
for (const failure of ['intent', 'resolution']) test(`full normalizer repair ${failure} persistence failure escapes without silent rerun`, async t => {
  let armed = false;
  const f = fixture(t, { hooks: { beforeRoutingWrite(journal) {
    if (!armed) return;
    const all = Object.values(journal.routing.records);
    const child = all.find(r => r.type === 'call-intent' && r.purpose === 'normalization-repair');
    if (child && (failure === 'intent' || all.some(r => r.type === 'call-resolution' && r.intentId === child.id))) throw new Error('injected routing write failure');
  } } });
  const i = f.issue(); f.launch(i); let launched = 0;
  const client = connector(f, () => { launched++; armed = true; return result(launched === 1 ? 'not JSON: review inconclusive' : '{"clean":true,"findings":[],"summary":"done"}'); });
  await assert.rejects(runAndNormalize(null, 'review', { step_id: 'review', agent: 'codex' }, {
    stratum: client, reviewMode: true, routingCalls: callsForRouting(f.context, i),
  }), { code: 'ROUTING_PERSISTENCE_FAILED' });
  assert.equal(launched, failure === 'intent' ? 1 : 2);
  assert.equal(calls(f).length, failure === 'intent' ? 1 : 2);
});
test('A/B same-profile primary and repair orders retain original descriptors through reload and late delivery', async t => {
  const f = fixture(t, { consumer: true });
  const tasks = ['A', 'B'].map(id => ({ id, description: id, depends_on: [] }));
  const wave = await consumerWave(f, tasks);
  const names = ['A', 'B', 'A-repair', 'B-repair'];
  const ids = Object.fromEntries(names.map((name, n) => [name, `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`]));
  const original = new Map(names.map(name => [ids[name], name])), releases = new Map(); let deliver = false;
  const client = connector(f, async args => {
    const owner = args.prompt.includes('PRIMARY-A') ? 'A' : args.prompt.includes('PRIMARY-B') ? 'B' : args.prompt.includes('TEXT-A') ? 'A-repair' : 'B-repair';
    await new Promise(resolve => releases.set(owner, resolve));
    return result(owner.includes('repair') ? 'still not JSON' : `TEXT-${owner}`, { A: 1, B: 2, 'A-repair': 3, 'B-repair': 4 }[owner]);
  });
  // Prescribe connector entropy independently of the journal and arrival order.
  // The real agentRun/dispatch boundary still mints and records each identity.
  const runAgent = client.agentRun.bind(client), randomUUID = crypto.randomUUID;
  client.agentRun = (provider, prompt, opts) => {
    const owner = prompt.includes('PRIMARY-A') ? 'A' : prompt.includes('PRIMARY-B') ? 'B' : prompt.includes('TEXT-A') ? 'A-repair' : 'B-repair';
    let first = true;
    crypto.randomUUID = () => { if (first) { first = false; return ids[owner]; } return randomUUID(); };
    syncBuiltinESMExports();
    opts.correlationId ??= `correlation-${owner}`;
    try { return runAgent(provider, prompt, opts); }
    finally { crypto.randomUUID = randomUUID; syncBuiltinESMExports(); }
  };
  f.context.stratum = { usageReport: async () => { if (!deliver) throw Error('delivery offline'); return { status: 'ok' }; } };
  const run = index => runAndNormalize(null, `PRIMARY-${tasks[index].id}`, { step_id: 'review', agent: 'codex' }, { stratum: client, reviewMode: true,
    routingCalls: callsForRouting(f.context, wave.issuances[index], null, wave.descriptors[index]) });
  const a = run(0), b = run(1);
  const until = async key => { for (let n = 0; n < 100 && !releases.has(key); n++) await new Promise(r => setTimeout(r, 5)); assert.ok(releases.has(key), key); };
  await until('B'); releases.get('B')(); await until('B-repair');
  releases.get('A')(); await until('A-repair'); releases.get('A-repair')(); releases.get('B-repair')(); await Promise.all([a, b]);
  assert.equal(original.size, 4); assert.equal(calls(f).length, 4);
  const pin = f.reopen().exportRoutingJournal();
  for (const call of calls(f)) {
    const name = original.get(call.callId); const expected = wave.issuances[name.startsWith('A') ? 0 : 1];
    assert.equal(call.issuanceId ?? call.parentRecordId, expected.id);
    if (name.includes('repair')) assert.equal(call.issuanceId, null);
  }
  deliver = true; f.context.routing.artifacts = f.reopen(); f.context.artifacts = f.context.routing.artifacts;
  await recoverRoutingEvidence(f.context);
  const rows = materializeRoutingLedger({ cwd: f.cwd, artifacts: f.context.artifacts });
  for (const [index, usd] of [4, 6].entries()) assert.equal(rows.find(r => r.recordId === wave.issuances[index].id).cost.usd, usd);
  assert.equal(Object.values(pin.records).filter(r => r.type === 'unsupported-observation').length, 2);
});

for (const repair of ['success', 'error', 'uncredited']) test(`local primary passes its one parent binding into the MCP-only ${repair} repair`, async t => {
  const f = fixture(t); const issuance = f.issue(); f.launch(issuance);
  let repairs = 0;
  const client = connector(f, () => {
    repairs++;
    if (repair === 'error') throw new McpError(ErrorCode.InternalError, 'repair failed', { code: 'AGENT_FAILED', usage: { tokens: 3, ms: 4, usd: 0.4 }, usdSource: 'reported' });
    return result(repair === 'success' ? '{"clean":true,"findings":[],"summary":"fixed"}' : 'still malformed', 0.4);
  });
  client._localQuery = async function* () { yield { type: 'result', subtype: 'success', result: 'malformed review', total_cost_usd: 0.2, duration_ms: 5, usage: { input_tokens: 2, output_tokens: 3 } }; };
  await runAndNormalize(null, 'Review implementation', { step_id: 'review', agent: 'claude' }, {
    stratum: client, localExecution: true, reviewMode: true, routingCalls: callsForRouting(f.context, issuance),
  });
  const intents = calls(f); assert.equal(intents.length, 2); assert.equal(repairs, 1);
  const primary = intents.find(i => i.purpose === 'primary'), child = intents.find(i => i.purpose === 'normalization-repair');
  assert.equal(primary.transport, 'local-sdk'); assert.equal(child.transport, 'mcp');
  assert.equal(child.issuanceId, null); assert.equal(child.parentRecordId, issuance.id);
  assert.equal(f.reopen().exportRoutingJournal().records[child.observationId].parentIntentId, primary.id);
  assert.equal(resolutions(f).find(r => r.intentId === primary.id).reportedEffort, null);
  assert.ok(Math.abs(materializeRoutingLedger({ cwd: f.cwd, artifacts: f.reopen() }).find(r => r.recordId === issuance.id).cost.usd - 0.6) < 1e-9);
});

for (const producer of ['gate-qa', 'codex-preflight', 'escalation-1', 'escalation-2']) test(`real ${producer} producer owns one unsupported connector observation`, async t => {
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs'); const { join } = await import('node:path');
  const f = fixture(t);
  execFileSync('git', ['-c', 'user.name=Routing Test', '-c', 'user.email=routing@example.test', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: f.cwd });
  const client = connector(f, args => {
    if (producer === 'codex-preflight') writeFileSync(join(args.cwd, args.prompt.match(/file named (\S+)/)[1]), 'COMPOSE_CODEX_PROBE_OK\n');
    return result('{"clean":true,"findings":[],"summary":"done"}', 0.3);
  });
  const context = { ...f.context, cwd: f.cwd, mode: 'bug', bug_code: 'AUX', step_id: 'work', flowId: f.binding.runId };
  if (producer === 'gate-qa') {
    const { makeAskAgent } = await import('../lib/build.js'); await makeAskAgent(client, context, { step_id: 'approval' })('Explain the change');
  } else if (producer === 'codex-preflight') {
    const { preflightCodexWorktreeProbe } = await import('../lib/codex-preflight.js');
    const value = await preflightCodexWorktreeProbe({ cwd: f.cwd, projectCwd: f.cwd, dataDir: join(f.root, 'probe'), ts: f.binding.runId, stratum: client, routingContext: context, force: true });
    assert.equal(value.ok, true);
  } else {
    const { tier1CodexReview, tier2FreshAgent } = await import('../lib/bug-escalation.js');
    if (producer === 'escalation-1') await tier1CodexReview(client, context, 'bug', 'repro', 'diff', []);
    else await tier2FreshAgent(client, context, { clean: false, summary: 'new hypothesis', findings: [{ finding: 'new hypothesis', severity: 'must-fix', confidence: 9 }] }, [], null);
  }
  assert.equal(calls(f).length, 1); assert.equal(calls(f)[0].issuanceId, null);
  const observed = Object.values(f.reopen().exportRoutingJournal().records).filter(r => r.type === 'unsupported-observation');
  assert.equal(observed.length, 1); assert.equal(observed[0].unsupportedReason, producer.startsWith('escalation') ? 'bug-escalation' : producer);
  assert.equal(resolutions(f)[0].usageEvidence.usd, 0.3);
});

test('runAgentText passes the connector binding and propagates a participating usage integrity refusal', async t => {
  const f = fixture(t); const issuance = f.issue(); const client = connector(f, () => result());
  const { reportUsageReceipts } = await import('../lib/build.js');
  await assert.rejects(client.runAgentText('codex', 'p', { routingCalls: callsForRouting(f.context, issuance),
    onUsage(usage) { return reportUsageReceipts(f.context, usage.map(r => ({ ...r, cost_usd: 99 }))); },
  }), { code: 'ROUTING_CALL_EVIDENCE_CONFLICT' });
  assert.equal(calls(f).length, 1); assert.equal(resolutions(f).length, 1);
});

test('real late MCP return improves the same uncertain invocation without a new model call', async t => {
  const f = fixture(t); const issuance = f.issue(); f.launch(issuance);
  const client = new StratumMcpClient(); let release, launched = 0;
  client._testClient = { callTool: async ({ name }) => {
    if (name === 'stratum_cancel_agent_run') return wire({ status: 'cancelled' });
    launched++; await new Promise(resolve => { release = resolve; }); return wire(result('late completion', 0.8));
  } };
  f.context.stratum = { usageReport: async () => ({ status: 'ok' }) };
  const controller = new AbortController();
  const running = client.agentRun('codex', 'original', { signal: controller.signal, cancellationTimeoutMs: 5, routingCalls: callsForRouting(f.context, issuance) });
  controller.abort(); await assert.rejects(running, { code: 'CANCELLATION_TEARDOWN_TIMEOUT' });
  assert.equal(resolutions(f).at(-1).outcome, 'unresolved');
  release();
  for (let n = 0; n < 100 && !resolutions(f).some(r => r.outcome === 'resolved'); n++) await new Promise(resolve => setTimeout(resolve, 5));
  await recoverRoutingEvidence(f.context);
  assert.equal(launched, 1); assert.equal(calls(f).length, 1);
  assert.equal(resolutions(f).at(-1).usageEvidence.usd, 0.8);
  assert.equal(f.reopen().journal.pendingUsageReceipts.filter(p => p.receipt.detail?.routing?.kind === 'paid-call').length, 1);
});

test('an unconfirmed repair transport failure escapes the full normalizer instead of settling synthetic fallback output', async t => {
  const f = fixture(t); const issuance = f.issue(); f.launch(issuance); let launched = 0;
  const client = connector(f, () => { if (++launched === 1) return result('malformed review'); throw Error('repair transport disconnected'); });
  await assert.rejects(runAndNormalize(null, 'Review work', { step_id: 'review', agent: 'codex' }, {
    stratum: client, reviewMode: true, routingCalls: callsForRouting(f.context, issuance),
  }), /repair transport disconnected/);
  assert.equal(launched, 2); assert.equal(calls(f).length, 2);
  assert.equal(resolutions(f).find(r => r.outcome === 'unresolved').terminationEvidence.kind, 'uncertain');
});

for (const producer of ['normalizer', 'runAgentText']) test(`${producer} fallback UUID cannot become paid evidence after connector id loss`, async t => {
  const { reportUsageReceipts } = await import('../lib/build.js');
  const f = fixture(t); const issuance = f.issue(); f.launch(issuance);
  const client = connector(f, () => result('done', 0.3));
  const observer = callsForRouting(f.context, issuance);
  let connectorId, forwarded;
  // Simulate metadata loss at the returned connector boundary, after the real
  // connector has recorded its own call. The downstream producer mints the UUID.
  const losingObserver = { ...observer, async finish(intent, outcome) {
    const resolved = await observer.finish(intent, outcome);
    connectorId = outcome.value.dispatchId;
    delete outcome.value.dispatchId;
    return resolved;
  } };
  if (producer === 'normalizer') {
    forwarded = (await runAndNormalize(null, 'work', { step_id: 'work', agent: 'codex' }, {
      stratum: client, routingCalls: losingObserver,
    })).usages;
  } else {
    await client.runAgentText('codex', 'work', { routingCalls: losingObserver, onUsage: records => { forwarded = records; } });
  }
  assert.equal(forwarded.length, 1);
  const fallbackId = forwarded[0].dispatch_id;
  assert.match(fallbackId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/); assert.notEqual(fallbackId, connectorId);
  await reportUsageReceipts(f.context, forwarded);
  // A reserved engine id is also offered as completion evidence for this same
  // supported issuance, through the production forwarding entry.
  await reportUsageReceipts(f.context, [{ ...forwarded[0], dispatch_id: 'legacy:17' }]);
  const paid = f.reopen().journal.pendingUsageReceipts.filter(p => p.receipt.detail?.routing?.kind === 'paid-call');
  assert.deepEqual(paid.map(p => p.dispatchId), [connectorId]);
  assert.equal(f.reopen().journal.pendingUsageReceipts.some(p => [fallbackId, 'legacy:17'].includes(p.dispatchId)), false);
  assert.equal(calls(f).length, 1); assert.equal(calls(f)[0].issuanceId, issuance.id);
  const row = materializeRoutingLedger({ cwd: f.cwd, artifacts: f.reopen() }).find(r => r.recordId === issuance.id);
  assert.equal(row.calls.length, 1); assert.equal(row.cost.usd, 0.3);
  assert.equal(row.calls[0].intent.callId, connectorId);
});

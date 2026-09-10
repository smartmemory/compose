import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as cancel from '../lib/build-cancel.js';
import * as build from '../lib/build.js';
import * as fanout from '../lib/consumer-fanout.js';
import { runAndNormalize } from '../lib/result-normalizer.js';
import { FLOW, SPEC, fixture, fakeClient, mergeFixture } from './helpers/build-cancel-s05.js';

const swept = code => Object.assign(new Error('codex exited with code 143'), code ? { code } : {});
for (const code of ['PERSIST_ON_CANCELLED_RUN', 'flow_cancelled', 'flow_not_running', 'FLOW_NOT_RUNNING']) {
  test(`looksCancelled triggers on ${code}`, () => assert.equal(cancel.looksCancelled({ code }), true));
}
test('looksCancelled handles uncoded engine errors and ordinary failures', () => {
  assert.equal(cancel.looksCancelled(new Error('run x is cancelled; cannot persist')), true);
  assert.equal(cancel.looksCancelled(swept()), false);
  assert.equal(cancel.looksCancelled(null), false);
});
for (const status of ['cancelled', 'running', 'unreachable']) {
  for (const code of [undefined, 'agent_run_failed']) {
    test(`shared boundary: tagged ${code ?? 'uncoded'} failure, audit ${status}`, async () => {
      const handle = cancel.createBuildCancel();
      let audits = 0;
      const stratum = { audit: async () => { audits++; if (status === 'unreachable') throw new Error('transport'); return { status }; } };
      const ctx = { stratum, flowId: FLOW, buildCancel: handle, tagged: true };
      assert.equal(await cancel.confirmCancellation(swept(code), ctx), status === 'cancelled');
      assert.equal(audits, 1);
      assert.equal(handle.cancelled, status === 'cancelled');
      if (handle.cancelled) {
        assert.equal(handle.reason, 'flow_cancelled');
        await cancel.confirmCancellation(swept(), ctx);
        assert.equal(audits, 1, 'no second RPC after confirmation');
      }
    });
  }
}
test('untagged ordinary failures do not audit', async () => {
  const stratum = { audit: () => assert.fail('unexpected audit') };
  assert.equal(await cancel.confirmCancellation(swept(), { stratum, flowId: FLOW, buildCancel: cancel.createBuildCancel() }), false);
});
for (const site of ['ordinary', 'step-fixer', 'gate-fixer', 'consumer']) {
  test(`runAndNormalize detects ${site} cancellation before AgentError conversion`, async () => {
    const handle = cancel.createBuildCancel();
    const client = fakeClient({ agentRun: async () => { throw swept(); }, audit: async () => ({ status: 'cancelled' }) });
    await assert.rejects(runAndNormalize(null, 'work', { step_id: site, agent: 'claude', output_fields: {} }, {
      stratum: client, flow: { runId: FLOW, stepId: site }, flowId: FLOW, buildCancel: handle, buildSignal: handle.signal,
    }));
    assert.equal(handle.cancelled, true);
    assert.equal(client.calls.filter(c => c.name === 'agentRun').length, 1);
    assert.equal(client.calls.filter(c => c.name === 'audit').length, 1);
  });
}
test('review-format repair cannot swallow a confirmed cancellation', async () => {
  const handle = cancel.createBuildCancel();
  let runs = 0;
  const client = fakeClient({ agentRun: async () => { if (++runs === 1) return { text: 'not json' }; throw swept(); }, audit: async () => ({ status: 'cancelled' }) });
  await assert.rejects(runAndNormalize(null, 'review', { step_id: 'review', agent: 'claude', output_fields: {} }, {
    stratum: client, reviewMode: true, flow: { runId: FLOW }, flowId: FLOW, buildCancel: handle, buildSignal: handle.signal,
  }));
  assert.equal(runs, 2);
  assert.equal(handle.cancelled, true);
});
test('gate Q&A confirms an uncoded swept agent through context.buildCancel', async () => {
  const handle = cancel.createBuildCancel();
  const client = fakeClient({ runAgentText: async () => { throw swept(); }, audit: async () => ({ status: 'cancelled' }) });
  const ask = build.makeAskAgent(client, { cwd: process.cwd(), flowId: FLOW, featureCode: 'S05', stepHistory: [], buildCancel: handle }, { step_id: 'merge' });
  await assert.rejects(ask('why?'));
  assert.equal(handle.cancelled, true);
});
for (const site of ['ordinary', 'step-fixer', 'gate-fixer', 'stepDone', 'clean-terminal']) {
  test(`driver ${site} cancellation ends aborted/killed with no receipt flush or retry`, async t => {
    const spec = site === 'gate-fixer' ? SPEC.replace('id: merge', 'id: review_gate') : SPEC;
    const f = fixture(t, spec);
    const client = fakeClient({
      plan: async () => site === 'gate-fixer' ? { runId: FLOW, status: 'running' } : { runId: FLOW, status: 'ready', ready: [{ id: site === 'step-fixer' ? 'nested/work' : 'work', do: 'work', agent: 'claude', dispatchToken: 'tok', ...(site === 'step-fixer' ? { previousFailure: { reason: 'ensure' } } : {}) }] },
      audit: async () => ({ status: 'cancelled', steps: site === 'gate-fixer' ? { review_gate: { status: 'waiting_gate', gateToken: 'gate' } } : {} }),
      agentRun: async () => {
        if (['stepDone', 'clean-terminal'].includes(site)) return { text: '{"value":"ok"}' };
        throw Object.assign(swept('agent_run_failed'), { usage: { tokens: 3, usd: 0.01, ms: 1 }, dispatchId: 'failed' });
      },
      stepDone: async () => {
        if (site === 'clean-terminal') return { runId: FLOW, status: 'cancelled' };
        throw new Error(`run ${FLOW} is cancelled; cannot persist`);
      },
    });
    if (site === 'clean-terminal') await f.run(client);
    else await assert.rejects(f.run(client));
    assert.equal(f.read('active-build.json').status, 'aborted');
    assert.equal(f.read('vision-state.json').items[0].status, 'killed');
    assert.equal(client.calls.filter(c => c.name === 'usageReport').length, 0);
    assert.ok(client.calls.filter(c => c.name === 'agentRun').length <= 1);
    const history = readFileSync(join(f.dataDir, 'build-history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(history.at(-1).status, 'aborted');
  });
}
test('cancel terminalizer preserves a replacement active build and its vision', async t => {
  const f = fixture(t);
  const client = fakeClient({ audit: async () => ({ status: 'cancelled' }), agentRun: async () => {
    writeFileSync(join(f.dataDir, 'active-build.json'), JSON.stringify({ ...f.read('active-build.json'), flowId: 'replacement', status: 'running' }));
    throw swept();
  } });
  await assert.rejects(f.run(client));
  assert.equal(f.read('active-build.json').flowId, 'replacement');
  assert.equal(f.read('active-build.json').status, 'running');
  assert.equal(f.read('vision-state.json').items[0].status, 'in_progress');
});
test('receipt loop stops after cancellation and does not flush already-cancelled usage', async () => {
  const handle = cancel.createBuildCancel();
  let reports = 0;
  const context = { receiptsMode: true, flowId: FLOW, buildCancel: handle, stratum: { usageReport: async () => { reports++; handle.cancel('flow_cancelled'); } } };
  const usage = [{ input_tokens: 1 }, { input_tokens: 2 }];
  await build.reportUsageReceipts(context, usage);
  await build.reportUsageReceipts(context, usage);
  assert.equal(reports, 1);
});
for (const inProcess of [false, true]) {
  test(`audited cancelled resume refuses without fresh plan (in-process owner=${inProcess})`, async t => {
    const f = fixture(t);
    const active = { featureCode: 'S05', flowId: FLOW, status: 'running', pid: process.pid, startedAt: 'start' };
    writeFileSync(join(f.dataDir, 'active-build.json'), JSON.stringify(active));
    const handle = cancel.createBuildCancel();
    if (inProcess) { cancel.registerBuildCancel(FLOW, handle); t.after(() => cancel.unregisterBuildCancel(FLOW)); }
    const client = fakeClient({ audit: async () => ({ status: 'cancelled' }) });
    await assert.rejects(f.run(client, { resume: true }), error => {
      assert.equal(error.code, 'FLOW_CANCELLED');
      assert.match(error.message, /cancelled.*cannot be resumed/);
      return true;
    });
    assert.equal(client.calls.some(c => ['plan', 'resume'].includes(c.name)), false);
    if (inProcess) { assert.equal(handle.cancelled, true); assert.deepEqual(f.read('active-build.json'), active); }
    else { assert.equal(f.read('active-build.json').status, 'aborted'); assert.equal(f.read('active-build.json').failureReason, 'flow_cancelled'); }
  });
}
test('cancelled is a terminal flow', () => assert.equal(build.isTerminalFlow('cancelled'), true));
test('pre-apply fence keeps captured diff as unmerged evidence and never enters applyMerge', async t => {
  const f = mergeFixture(t);
  const prepare = fanout.ConsumerFanoutArtifacts.prototype.prepareMerge;
  t.mock.method(fanout.ConsumerFanoutArtifacts.prototype, 'prepareMerge', function(...args) {
    const tx = prepare.apply(this, args);
    cancel.lookupBuildCancel(FLOW).cancel('flow_cancelled');
    return tx;
  });
  const spy = t.mock.method(fanout.ConsumerFanoutArtifacts.prototype, 'applyMerge', async () => assert.fail('applyMerge entered after cancellation'));
  await assert.rejects(f.run(f.client), error => {
    assert.equal(error.code, 'MERGE_AFTER_CANCEL');
    assert.ok(error instanceof fanout.MergeAfterCancelError);
    return true;
  });
  assert.equal(spy.mock.callCount(), 0);
  assert.ok(f.journal().issuances[0].diff.includes('captured evidence'));
  assert.equal(f.journal().issuances[0].state, 'accepted');
  assert.equal(existsSync(join(f.cwd, 'landed.txt')), false);
  assert.equal(f.client.calls.some(c => c.name === 'gateResolve'), false);
});
test('failed restore journals rollback_failed in a separate mutation and surfaces an indeterminate tree', async t => {
  const f = mergeFixture(t);
  const apply = fanout.ConsumerFanoutArtifacts.prototype.applyMerge;
  t.mock.method(fanout.ConsumerFanoutArtifacts.prototype, 'applyMerge', async function(tx) {
    const result = await apply.call(this, tx);
    // Force the REAL restore callback to throw, before #mutate can journal it.
    const journal = f.journal();
    journal.mergeTransactions[0].baselineTree = 'missing-tree';
    writeFileSync(this.journalPath, JSON.stringify(journal));
    cancel.lookupBuildCancel(FLOW).cancel('flow_cancelled');
    return result;
  });
  await assert.rejects(f.run(f.client), error => {
    assert.equal(error.code, 'MERGE_AFTER_CANCEL');
    assert.match(error.message, /reversal FAILED.*indeterminate/);
    return true;
  });
  const tx = f.journal().mergeTransactions[0];
  assert.equal(tx.state, 'rollback_failed');
  assert.equal(tx.failureCode, 'merge_revert_failed');
  assert.ok(tx.failure.includes('missing-tree'));
  assert.equal(f.client.calls.some(c => c.name === 'gateResolve'), false);
});

for (const status of ['cancelled', 'running']) {
  test(`scripted consumer agent_run_failed with audit ${status} ${status === 'cancelled' ? 'aborts without retry' : 'retains item failure envelope'}`, async t => {
    const f = fixture(t);
    const descriptor = { id: 'fan/0', flow: 'main', step: 'fan', itemIndex: 0, stage: 0, generation: 1, attempt: 1, dispatchToken: 'item-token', revisionDigest: 'revision', contractDigest: 'contract', agent: 'claude', do: 'work', item: 'alpha', contract: { root: 'Result', contracts: { Result: { value: 'string' } } }, policy: { isolation: 'worktree', concurrency: 1, merge: 'sequential' } };
    let failed = false;
    const client = fakeClient({
      plan: async () => ({ runId: FLOW, status: 'ready', revisionDigest: 'revision', ready: [descriptor] }),
      audit: async () => ({ status: failed ? status : 'running', steps: { fan: { fanout: { items: [{ status: 'running', generation: 1, dispatchToken: 'item-token' }] } } } }),
      agentRun: async () => { failed = true; throw swept('agent_run_failed'); },
      stepDone: async () => ({ runId: FLOW, status: 'failed' }),
    });
    if (status === 'cancelled') await assert.rejects(f.run(client));
    else await f.run(client);
    assert.equal(client.calls.filter(c => c.name === 'agentRun').length, 1);
    const reports = client.calls.filter(c => c.name === 'stepDone');
    assert.equal(reports.length, status === 'cancelled' ? 0 : 1);
    if (reports.length) assert.match(reports[0].args[2].failure, /codex exited with code 143/);
    assert.equal(f.read('active-build.json').status, status === 'cancelled' ? 'aborted' : 'failed');
  });
}

test('gateResolve uncoded cancellation is confirmed and terminalized', async t => {
  const f = mergeFixture(t);
  let failed = false;
  f.client.gateResolve = async () => { failed = true; throw new Error(`run ${FLOW} is cancelled`); };
  f.client.audit = async () => ({ ...f.audit, status: failed ? 'cancelled' : 'running' });
  await assert.rejects(f.run(f.client));
  assert.equal(failed, true);
  assert.equal(f.read('active-build.json').status, 'aborted');
  assert.equal(f.read('vision-state.json').items[0].status, 'killed');
});

test('interactive gate Q&A cancellation unwinds the driver without another answer', async t => {
  const { PassThrough } = await import('node:stream');
  const f = fixture(t, SPEC.replace('id: merge', 'id: approval'));
  writeFileSync(join(f.dataDir, 'settings.json'), JSON.stringify({ policies: { approval: 'gate' } }));
  const input = new PassThrough();
  const output = new PassThrough();
  t.after(() => { input.destroy(); output.destroy(); });
  let asked = false;
  output.on('data', chunk => {
    if (!asked && chunk.toString().includes('> ')) { asked = true; queueMicrotask(() => input.write('why?\n')); }
  });
  let failed = false;
  const client = fakeClient({
    plan: async () => ({ runId: FLOW, status: 'running' }),
    audit: async () => ({ status: failed ? 'cancelled' : 'running', steps: { approval: { status: 'waiting_gate', gateToken: 'gate' } } }),
    runAgentText: async () => { failed = true; throw swept(); },
  });
  // Bound the test independently of readline: the pre-fix prompt swallows the
  // rejection and waits forever for another user answer.
  const running = f.run(client, { gateOpts: { input, output } });
  const watchdog = setTimeout(() => input.end(), 1500);
  t.after(() => clearTimeout(watchdog));
  await assert.rejects(Promise.race([running, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Q&A cancellation did not unwind')), 1800);
    running.finally(() => clearTimeout(timer)).catch(() => {});
  })]), error => { assert.notEqual(error.message, 'Q&A cancellation did not unwind'); return true; });
  assert.equal(failed, true);
  assert.equal(f.read('active-build.json').status, 'aborted');
  assert.equal(f.read('vision-state.json').items[0].status, 'killed');
  assert.equal(client.calls.some(c => c.name === 'gateResolve'), false);
});

for (const known of [false, true]) {
  test(`consumer capture survives cancellation before report (handle already cancelled=${known})`, async t => {
    const f = fixture(t);
    const descriptor = { id: 'fan/0', flow: 'main', step: 'fan', itemIndex: 0, stage: 0, generation: 1, attempt: 1, dispatchToken: 'item-token', revisionDigest: 'revision', contractDigest: 'contract', agent: 'claude', do: 'work', item: 'alpha', contract: { root: 'Result', contracts: { Result: { value: 'string' } } }, policy: { isolation: 'worktree', concurrency: 1, merge: 'sequential' } };
    const pending = { ...descriptor, id: 'fan/1', itemIndex: 1, dispatchToken: 'pending-token' };
    let captured = false;
    const client = fakeClient({
      plan: async () => ({ runId: FLOW, status: 'ready', revisionDigest: 'revision', ready: [descriptor, pending] }),
      audit: async () => ({ status: captured ? 'cancelled' : 'running', steps: { fan: { fanout: { items: [descriptor, pending].map(d => ({ status: 'running', generation: 1, dispatchToken: d.dispatchToken })) } } } }),
      agentRun: async (_agent, _prompt, opts) => { writeFileSync(join(opts.cwd, 'evidence.txt'), 'finished after external cancel\n'); return { text: '{"value":"ok"}' }; },
      stepDone: async () => { throw new Error(`run ${FLOW} is cancelled`); },
    });
    await assert.rejects(f.run(client, { consumerCrashHooks: { afterPreparedBeforeReport() {
      captured = true;
      if (known) cancel.lookupBuildCancel(FLOW).cancel('flow_cancelled');
    } } }));
    const artifacts = new fanout.ConsumerFanoutArtifacts({ runId: FLOW, targetCwd: f.cwd, artifactRoot: f.artifactRoot });
    assert.ok(artifacts.journal.issuances[0].diff.includes('finished after external cancel'));
    assert.notEqual(artifacts.journal.issuances[0].state, 'merged');
    assert.equal(existsSync(join(f.cwd, 'evidence.txt')), false);
    assert.equal(client.calls.filter(c => c.name === 'agentRun').length, 1, 'queued sibling/retry never starts');
    assert.equal(client.calls.filter(c => c.name === 'stepDone').length, known ? 0 : 1);
    assert.equal(f.read('active-build.json').status, 'aborted');
  });
}

test('gate input cancellation closes the prompt and releases its abort listener', async () => {
  const { PassThrough } = await import('node:stream');
  const { getEventListeners } = await import('node:events');
  const { promptGate } = await import('../lib/gate-prompt.js');
  const handle = cancel.createBuildCancel();
  const input = new PassThrough();
  const output = new PassThrough();
  try {
    const waiting = promptGate({ step_id: 'approval' }, { input, output, signal: handle.signal });
    handle.cancel('flow_cancelled');
    await assert.rejects(waiting, /build cancelled/);
    assert.equal(getEventListeners(handle.signal, 'abort').length, 0);
  } finally { input.destroy(); output.destroy(); }
});

for (const options of [{}, { resumeFlowId: FLOW }]) {
  test(`cancelled recovery refuses even with a live pid (${options.resumeFlowId ? 'explicit flow' : 'automatic'})`, async t => {
    const f = fixture(t);
    writeFileSync(join(f.dataDir, 'active-build.json'), JSON.stringify({ featureCode: 'S05', flowId: FLOW, status: 'running', pid: process.ppid, startedAt: 'old' }));
    const client = fakeClient({ audit: async () => ({ status: 'cancelled' }) });
    await assert.rejects(f.run(client, options), { code: 'FLOW_CANCELLED' });
    assert.equal(client.calls.some(c => ['plan', 'resume'].includes(c.name)), false);
    assert.equal(f.read('active-build.json').status, 'aborted');
  });
}

test('cancelled resume identity claim preserves a replacement installed during audit', async t => {
  const f = fixture(t);
  const activePath = join(f.dataDir, 'active-build.json');
  writeFileSync(activePath, JSON.stringify({ featureCode: 'S05', flowId: FLOW, status: 'running', pid: process.pid, startedAt: 'old' }));
  const replacement = { featureCode: 'S05', flowId: 'replacement', status: 'running', pid: process.pid, startedAt: 'new' };
  const client = fakeClient({ audit: async () => { writeFileSync(activePath, JSON.stringify(replacement)); return { status: 'cancelled' }; } });
  await assert.rejects(f.run(client, { resume: true }), { code: 'FLOW_CANCELLED' });
  assert.deepEqual(f.read('active-build.json'), replacement);
  assert.equal(client.calls.some(c => ['plan', 'resume'].includes(c.name)), false);
});

test('--fresh explicitly permits a new plan after a cancelled build', async t => {
  const f = fixture(t);
  writeFileSync(join(f.dataDir, 'active-build.json'), JSON.stringify({ featureCode: 'S05', flowId: 'old-flow', status: 'aborted', pid: process.pid, startedAt: 'old' }));
  const client = fakeClient();
  await f.run(client, { fresh: true });
  assert.equal(client.calls.filter(c => c.name === 'plan').length, 1);
  assert.equal(client.calls.some(c => c.name === 'resume'), false);
  assert.equal(f.read('active-build.json').flowId, FLOW);
});

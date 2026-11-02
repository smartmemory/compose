/** Run with --test-timeout=900000. No model services, GUI, or installed-package mutation.
 *  Split from build-wave-golden.test.js (COMP-TEST-BWG-SPLIT-1) so no one file nears the suite per-file timeout. */
import { tier } from '../helpers/model-catalog.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { preflightPipelineProfiles } from '../../lib/pipeline-profiles.js';
import { StratumMcpClient } from '../../lib/stratum-mcp-client.js';
import { TS_MCP_BIN } from '../helpers/stratum-test-bin.js';
import { git } from '../helpers/consumer-wave-fixture.js';
import { runWaveGolden, readGoldenJournal, readGoldenTrace, paidWaveGolden, frozenRoutingBaseline, normalizedGoldenCalls, WAVE_GOLDEN_SPEC, PROFILES, CORE, BROKEN, FIXED, REPAIR, FINDING, fixtureFor, workers, recordedReceipts, assertShip, GOLDEN_MODELS } from '../helpers/build-wave-golden-fixture.js';

test('fixture: sidecar preflight and fake executable model, prerequisite, wiring and escape controls', async t => {
  assert.equal(preflightPipelineProfiles(PROFILES, WAVE_GOLDEN_SPEC).ok, true);
  const f = await fixtureFor(t, 'repair');
  const invoke = (id, model = GOLDEN_MODELS[id], flag = '--model') => spawnSync(f.codexPath, ['exec', flag, model, '-'], {
    cwd: f.workspace, env: f.env, input: `## Intent\nD3_WORK ${JSON.stringify({ id })}\n\n## Inputs\n`, encoding: 'utf8', timeout: 10000,
  });
  const missing = invoke('REPAIR');
  assert.equal(missing.status, 23);
  assert.match(missing.stderr, /FAKE_CODEX_PREREQUISITE_OR_WRITE_FAILED/);
  assert.equal(existsSync(join(f.workspace, 'adapter.cjs')), false, 'failed prerequisite writes nothing');
  assert.equal(invoke('CORE', GOLDEN_MODELS.CORE, '-m').status, 0, 'connector uses the short -m spelling');
  await writeFile(join(f.workspace, 'core.cjs'), 'wrong content\n');
  assert.equal(invoke('REPAIR').status, 23, 'presence alone does not satisfy prerequisite');
  await writeFile(join(f.workspace, 'core.cjs'), CORE);
  assert.equal(invoke('BROKEN').status, 0);
  const unit = spawnSync(process.execPath, ['--test', 'unit.test.cjs'], { cwd: f.workspace, encoding: 'utf8' });
  assert.equal(unit.status, 0, unit.stderr);
  const review = () => {
    const r = spawnSync(f.codexPath, ['exec', '-m', tier('codex', 'critical').model, '-'], {
      cwd: f.workspace, env: f.env, input: '## Intent\nD3_REVIEW\n\n', encoding: 'utf8', timeout: 10000,
    });
    assert.equal(r.status, 0, r.stderr);
    const message = r.stdout.trim().split('\n').map(JSON.parse).find(e => e.type === 'item.completed');
    return JSON.parse(message.item.text);
  };
  assert.deepEqual(review(), { blocking: true, findings: [FINDING] });
  assert.equal(invoke('REPAIR').status, 0);
  assert.deepEqual(review(), { blocking: false, findings: [] });
  assert.equal(invoke('ESCAPE', tier('codex', 'critical').model).status, 0);
  assert.equal(await readFile(join(f.workspace, 'untouched.txt'), 'utf8'), 'forbidden\n');
  const calls = await f.readAgentPids();
  for (const call of calls) assert.equal(call.model, GOLDEN_MODELS[call.lane] ?? tier('codex', 'critical').model);
});

test('real connector: model argv and telemetry independently of wave admission', { timeout: 90000 }, async t => {
  const f = await fixtureFor(t, 'repair');
  const client = new StratumMcpClient();
  try {
    await client.connect({ command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
      args: [TS_MCP_BIN], cwd: f.workspace, env: f.env });
    for (const id of ['CORE', 'BROKEN', 'FAST']) {
      const result = await client.agentRun('codex', `## Intent\nD3_WORK ${JSON.stringify({ id })}\n\n`, {
        cwd: f.workspace, modelID: GOLDEN_MODELS[id], sandboxMode: 'workspace-write',
      });
      assert.equal(result.telemetry.model, GOLDEN_MODELS[id]);
    }
    assert.deepEqual((await f.readAgentPids()).map(c => [c.lane, c.model]),
      ['CORE', 'BROKEN', 'FAST'].map(id => [id, GOLDEN_MODELS[id]]));
  } finally { await client.close(); }
});

test('real engine + connector: two carried waves repair only affected work, preserve model receipts and squash ship', { timeout: 240000 }, async t => {
  const f = await fixtureFor(t, 'repair');
  const { audit, flowId } = await runWaveGolden(f);
  assert.equal(audit.status, 'completed');
  const journal = await readGoldenJournal(f);
  const calls = await f.readAgentPids();
  assert.deepEqual(workers(calls).map(c => c.lane).sort(), ['BROKEN', 'CORE', 'DEFAULT', 'FAST', 'REPAIR']);
  assert.equal(calls.filter(c => c.lane === 'review').length, 2);
  const trace = await readGoldenTrace(f);
  assert.equal(trace.filter(c => c.kind === 'claude' && c.step === 'plan').length, 1, 'plan remains outside reset closure');
  assert.deepEqual(trace.filter(c => c.kind === 'claude' && c.step === 'verify').map(c => c.output.tests_pass), [true, true]);
  const reviews = trace.filter(c => c.kind === 'step_done' && c.step === 'review').map(c => c.envelope.output);
  assert.deepEqual(reviews, [{ blocking: true, findings: [FINDING] }, { blocking: false, findings: [] }]);
  const assessments = trace.filter(c => c.kind === 'claude' && c.step === 'assess').map(c => c.output);
  assert.deepEqual(assessments.map(c => c.action), ['repair', 'complete']);
  assert.deepEqual(assessments[0].tasks, [REPAIR]);
  assert.deepEqual(audit.carry.wave.value, [REPAIR]);
  assert.equal(audit.carry.wave.provenance.kind, 'revise');
  const [first, second] = journal.wave.checkpoints;
  assert.equal(journal.wave.checkpoints.length, 2);
  assert.equal(second.parentCommit, first.commit);
  assert.equal(journal.waveAdmissions[1].baseCommit, first.commit);
  assert.equal(git(f.workspace, ['show', `${first.commit}:adapter.cjs`]), BROKEN.trim());
  assert.equal(git(f.workspace, ['show', `${second.commit}:adapter.cjs`]), FIXED.trim());
  assert.equal(git(f.workspace, ['diff', '--name-only', first.commit, second.commit]), 'adapter.cjs', 'unaffected paths not merged again');
  assert.equal(first.orderedDispatchTokens.length, 4);
  assert.equal(second.orderedDispatchTokens.length, 1);
  assert.ok(second.orderedDispatchTokens.every(token => !first.orderedDispatchTokens.includes(token)));
  for (const checkpoint of [first, second]) {
    assert.equal(checkpoint.state, 'published');
    assert.ok(checkpoint.evidenceReceiptId);
  }
  const repairCall = calls.find(c => c.lane === 'REPAIR');
  assert.ok(repairCall, 'repair could succeed only after checking exact wave-1 core content');
  assert.equal(await readFile(join(f.workspace, 'core.cjs'), 'utf8'), CORE);
  // Stratum's receipt spine is persisted; its public audit projects usage_debit events.
  const receipts = await recordedReceipts(f, flowId);
  const proposed = receipts.filter(r => r.source === 'compose:item_model' && r.dispatchId.endsWith(':proposed'));
  assert.equal(proposed.length, 5);
  for (const receipt of proposed) {
    const id = receipt.detail.itemBinding.item.id;
    const expected = GOLDEN_MODELS[id];
    assert.ok(expected, `known task receipt ${id}`);
    assert.equal(receipt.detail.intended.modelID, expected);
    const acknowledgement = journal.pendingUsageReceipts.find(r => r.dispatchId === receipt.dispatchId);
    assert.equal(acknowledgement.state, 'acknowledged');
    assert.equal(acknowledgement.seq, receipt.seq, 'client acknowledgement identifies the persisted model receipt');
    assert.equal(calls.find(c => c.lane === id).model, expected, 'model reaches actual executable argv');
    const observed = receipts.find(r => r.dispatchId === receipt.dispatchId.replace(/:proposed$/, ':observed'));
    // Codex usage records carry `<model>/<effort>` (the connector's identity string);
    // the model half must match the tier and the effort half the tier's default.
    const [observedModel, observedEffort] = String(observed.detail.observed.normalizedUsageModel).split('/');
    assert.equal(observedModel, expected);
    assert.equal(observedEffort, receipt.detail.intended.effort, 'effort follows the resolved tier');
    assert.equal(observed.detail.observed.connectorIdentityVerified, false, 'intended model is not live service verification');
  }
  const paidWorkers = receipts.filter(r => r.source === 'fanout');
  assert.equal(paidWorkers.length, 5);
  // Paid receipts carry compose's normalized `<model>/<effort>` identity.
  assert.deepEqual(paidWorkers.map(r => String(r.telemetry.model).split('/')[0]).sort(), Object.values(GOLDEN_MODELS).sort());
  for (const receipt of paidWorkers) {
    assert.ok(receipt.amount.tokens > 0 && receipt.amount.usd > 0, 'real connector fake telemetry persisted');
    assert.equal(audit.events.find(e => e.type === 'usage_debit' && e.detail.dispatchId === receipt.dispatchId)?.detail.model,
      receipt.telemetry.model, 'actual connector telemetry is also visible in audit');
  }
  assertShip(f, journal);
});

test('real engine: unknown tier in pending sixth item rejects wave with zero fake processes', { timeout: 180000 }, async t => {
  const f = await fixtureFor(t, 'unknown');
  const { audit, flowId } = await runWaveGolden(f);
  assert.equal(audit.status, 'failed');
  assert.deepEqual(await f.readAgentPids(), []);
  const failures = (await readGoldenTrace(f)).filter(c => c.kind === 'step_done' && c.step.startsWith('execute/'));
  assert.ok(failures.length > 0);
  for (const failure of failures) assert.match(failure.envelope.failure, /^WAVE_TIER_INVALID:/);
  assert.ok((await recordedReceipts(f, flowId)).some(r => r.source === 'compose:wave_admission'
    && r.detail.findings.some(finding => finding.code === 'WAVE_TIER_INVALID' && finding.itemIndex === 5)));
  assert.equal(git(f.workspace, ['rev-parse', 'HEAD']), f.base);
});

test('real engine + connector: outside files_owned replaces worker success with FILES_OWNED_VIOLATION', { timeout: 180000 }, async t => {
  const f = await fixtureFor(t, 'ownership');
  const index = await readFile(join(f.workspace, '.git/index'));
  const { audit, flowId } = await runWaveGolden(f);
  assert.equal(audit.status, 'failed');
  assert.equal(await readFile(join(f.workspace, 'untouched.txt'), 'utf8'), 'parent sentinel\n');
  assert.equal(existsSync(join(f.workspace, 'owned.txt')), false);
  assert.equal(git(f.workspace, ['rev-parse', 'HEAD']), f.base);
  assert.equal(git(f.workspace, ['diff', '--name-only', 'HEAD']), '', 'tracked parent tree untouched');
  assert.deepEqual(await readFile(join(f.workspace, '.git/index')), index);
  // The engine's default contract-failure policy allows two attempts.
  assert.deepEqual(workers(await f.readAgentPids()).map(c => c.lane), ['ESCAPE', 'ESCAPE']);
  const reports = (await readGoldenTrace(f)).filter(c => c.kind === 'step_done' && c.step.startsWith('execute/'));
  assert.equal(reports.length, 2);
  // Deliberately exact: a different production code is an owning-dispatch defect.
  for (const report of reports) {
    assert.match(report.envelope.failure, /^FILES_OWNED_VIOLATION:/);
    assert.equal(report.envelope.output, undefined);
  }
  assert.ok((await recordedReceipts(f, flowId)).some(r => r.source === 'compose:ownership'
    && r.detail.findings.some(finding => finding.files.includes('untouched.txt'))));
});

test('full-call oracle tolerates concurrent arrivals only; prompt/options and step/wave order remain pinned', () => {
  const frozen = frozenRoutingBaseline('carry');
  const expected = normalizedGoldenCalls(frozen.events);
  const swap = structuredClone(frozen.events);
  [swap[2], swap[3]] = [swap[3], swap[2]];
  assert.deepEqual(normalizedGoldenCalls(swap), expected);
  for (const mutate of [
    events => { events[1].prompt += 'changed'; },
    events => { events[2].opts.sandboxMode = 'read-only'; },
    events => { events[2].opts.newOption = true; },
    events => { events[2].opts.modelID = 'different-model'; },
    events => { events[2].opts.effort = 'different-effort'; },
    events => { const i = events.findIndex(e => e.opts?.flow?.stepId === 'review'); [events[i], events[i - 1]] = [events[i - 1], events[i]]; },
    events => { const i = events.findLastIndex(e => e.opts?.telemetry?.step_id === 'execute/0'); [events[2], events[i]] = [events[i], events[2]]; },
  ]) {
    const changed = structuredClone(frozen.events); mutate(changed);
    assert.notDeepEqual(normalizedGoldenCalls(changed), expected);
  }
});

for (const scenario of ['unknown', 'failed-primary']) test(`d3 paid carry ${scenario} keeps incomplete and failed spend`, { timeout: 180000 }, async t => {
  const f = await paidWaveGolden(t, { unknown: scenario === 'unknown', failPrimary: scenario === 'failed-primary' });
  await f.run();
  const rows = f.rows(); assert.ok(rows.length > 0);
  const name = scenario === 'unknown' ? 'B1' : 'B0';
  const call = rows.flatMap(r => r.calls).find(c => c.intent.callId === f.ids[name]);
  assert.ok(call);
  const receipt = f.snapshot().receipts.find(r => r.dispatchId === f.ids[name]);
  assert.ok(receipt);
  if (scenario === 'unknown') {
    assert.equal(call.resolution.usageEvidence.usd, null);
    assert.equal(receipt.amount.usd, undefined);
    const row = rows.find(r => r.issuance?.logicalTaskId === 'B' && r.issuance.epoch === 1);
    assert.equal(row.cost.usd, null); assert.equal(row.completeness.state, 'incomplete');
    assert.ok(row.completeness.reasons.includes('missing-usd'));
  } else {
    assert.equal(call.resolution.outcome, 'errored'); assert.equal(receipt.amount.usd, 2);
    const row = rows.find(r => r.issuance?.logicalTaskId === 'B');
    assert.equal(row.cost.usd, 2); assert.equal(row.outcome.label, 'failed-or-cancelled');
    assert.equal(row.outcome.binary, 'negative');
  }
});

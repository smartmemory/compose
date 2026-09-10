/** Run with --test-timeout=900000. No model services, GUI, or installed-package mutation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWaveGoldenProject, runWaveGolden, readGoldenJournal, readGoldenTrace,
  WAVE_GOLDEN_SPEC, PROFILES, CORE, BROKEN, FIXED, REPAIR, FINDING } from '../helpers/build-wave-golden-fixture.js';
import { preflightPipelineProfiles } from '../../lib/pipeline-profiles.js';
import { StratumMcpClient } from '../../lib/stratum-mcp-client.js';
import { readFlowSnapshot } from '../../lib/flow-state.js';
import { TS_MCP_BIN } from '../helpers/stratum-test-bin.js';
import { git } from '../helpers/consumer-wave-fixture.js';

const DRIVER = fileURLToPath(new URL('../helpers/build-wave-golden-fixture.js', import.meta.url));
const MODELS = { CORE: 'gpt-6-astra', BROKEN: 'gpt-5.6-terra', FAST: 'gpt-5.3-codex-spark',
  DEFAULT: 'gpt-6-astra', REPAIR: 'gpt-6-astra' };
async function fixtureFor(t, scenario) {
  const fixture = await makeWaveGoldenProject(scenario);
  t.after(() => fixture.cleanup());
  return fixture;
}
const workers = calls => calls.filter(c => c.lane !== 'review');
async function recordedReceipts(f, flowId) {
  const journal = await readGoldenJournal(f);
  const previousRoot = process.env.STRATUM_STATE_ROOT;
  process.env.STRATUM_STATE_ROOT = f.stateRoot;
  try {
    return readFlowSnapshot(flowId, { revisionDigest: journal.revisionDigest }).receipts;
  } finally {
    if (previousRoot === undefined) delete process.env.STRATUM_STATE_ROOT;
    else process.env.STRATUM_STATE_ROOT = previousRoot;
  }
}
function assertShip(f, journal) {
  const head = git(f.workspace, ['rev-parse', 'HEAD']);
  assert.equal(git(f.workspace, ['rev-parse', 'HEAD^']), f.base, 'ship parent is pinned base');
  assert.equal(git(f.workspace, ['rev-list', '--count', `${f.base}..HEAD`]), '1', 'one ship commit');
  const ancestry = git(f.workspace, ['rev-list', 'HEAD']).split('\n');
  for (const cp of journal.wave.checkpoints) assert.ok(!ancestry.includes(cp.commit), 'no wave commits in ship ancestry');
  assert.equal(git(f.workspace, ['rev-parse', `${head}^{tree}`]), journal.wave.checkpoints.at(-1).tree);
}

test('fixture: sidecar preflight and fake executable model, prerequisite, wiring and escape controls', async t => {
  assert.equal(preflightPipelineProfiles(PROFILES, WAVE_GOLDEN_SPEC).ok, true);
  const f = await fixtureFor(t, 'repair');
  const invoke = (id, model = MODELS[id], flag = '--model') => spawnSync(f.codexPath, ['exec', flag, model, '-'], {
    cwd: f.workspace, env: f.env, input: `## Intent\nD3_WORK ${JSON.stringify({ id })}\n\n## Inputs\n`, encoding: 'utf8', timeout: 10000,
  });
  const missing = invoke('REPAIR');
  assert.equal(missing.status, 23);
  assert.match(missing.stderr, /FAKE_CODEX_PREREQUISITE_OR_WRITE_FAILED/);
  assert.equal(existsSync(join(f.workspace, 'adapter.cjs')), false, 'failed prerequisite writes nothing');
  assert.equal(invoke('CORE', MODELS.CORE, '-m').status, 0, 'connector uses the short -m spelling');
  await writeFile(join(f.workspace, 'core.cjs'), 'wrong content\n');
  assert.equal(invoke('REPAIR').status, 23, 'presence alone does not satisfy prerequisite');
  await writeFile(join(f.workspace, 'core.cjs'), CORE);
  assert.equal(invoke('BROKEN').status, 0);
  const unit = spawnSync(process.execPath, ['--test', 'unit.test.cjs'], { cwd: f.workspace, encoding: 'utf8' });
  assert.equal(unit.status, 0, unit.stderr);
  const review = () => {
    const r = spawnSync(f.codexPath, ['exec', '-m', 'gpt-6-astra', '-'], {
      cwd: f.workspace, env: f.env, input: '## Intent\nD3_REVIEW\n\n', encoding: 'utf8', timeout: 10000,
    });
    assert.equal(r.status, 0, r.stderr);
    const message = r.stdout.trim().split('\n').map(JSON.parse).find(e => e.type === 'item.completed');
    return JSON.parse(message.item.text);
  };
  assert.deepEqual(review(), { blocking: true, findings: [FINDING] });
  assert.equal(invoke('REPAIR').status, 0);
  assert.deepEqual(review(), { blocking: false, findings: [] });
  assert.equal(invoke('ESCAPE', 'gpt-6-astra').status, 0);
  assert.equal(await readFile(join(f.workspace, 'untouched.txt'), 'utf8'), 'forbidden\n');
  const calls = await f.readAgentPids();
  for (const call of calls) assert.equal(call.model, MODELS[call.lane] ?? 'gpt-6-astra');
});

test('real connector: model argv and telemetry independently of wave admission', { timeout: 90000 }, async t => {
  const f = await fixtureFor(t, 'repair');
  const client = new StratumMcpClient();
  try {
    await client.connect({ command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
      args: [TS_MCP_BIN], cwd: f.workspace, env: f.env });
    for (const id of ['CORE', 'BROKEN', 'FAST']) {
      const result = await client.agentRun('codex', `## Intent\nD3_WORK ${JSON.stringify({ id })}\n\n`, {
        cwd: f.workspace, modelID: MODELS[id], sandboxMode: 'workspace-write',
      });
      assert.equal(result.telemetry.model, MODELS[id]);
    }
    assert.deepEqual((await f.readAgentPids()).map(c => [c.lane, c.model]),
      ['CORE', 'BROKEN', 'FAST'].map(id => [id, MODELS[id]]));
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
    const expected = MODELS[id];
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
  assert.deepEqual(paidWorkers.map(r => String(r.telemetry.model).split('/')[0]).sort(), Object.values(MODELS).sort());
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

async function childAttempt(t, f, options) {
  const configPath = join(f.stateRoot, options.crash ? 'crash-config.json' : 'resume-config.json');
  // Serialize paths/config, never methods or inherited environment secrets.
  const { workspace, stateRoot, artifactRoot, tracePath, resultPath, crashPath, scenario, tasks } = f;
  await writeFile(configPath, JSON.stringify({ fixture: { workspace, stateRoot, artifactRoot, tracePath, resultPath,
    crashPath, scenario, tasks, env: { PATH: f.env.PATH, STRATUM_STATE_ROOT: stateRoot,
      STRATUM_AGENT_FG_ROOT: f.fgRoot, COMPOSE_FAKE_CODEX_PIDS: f.pidsFile,
      COMPOSE_FAKE_CODEX_BEHAVIOR: f.env.COMPOSE_FAKE_CODEX_BEHAVIOR } }, options }));
  const child = spawn(process.execPath, [DRIVER, '--driver', configPath], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-30000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-30000); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  try {
    // 'exit', not 'close': a killed driver can leave the real server holding its pipe briefly.
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.stdout.destroy(); child.stderr.destroy();
    return { ...result, output };
  } finally { clearTimeout(timer); }
}

test('real engine + connector: SIGKILL after ref CAS before journal acknowledgement resumes one checkpoint and one ship', { timeout: 360000 }, async t => {
  const f = await fixtureFor(t, 'crash');
  const index = await readFile(join(f.workspace, '.git/index'));
  const crashed = await childAttempt(t, f, { crash: true });
  assert.equal(crashed.signal, 'SIGKILL', crashed.output);
  assert.ok(existsSync(f.crashPath), `must reach publication boundary, not timeout\n${crashed.output}`);
  const receipt = JSON.parse(await readFile(f.crashPath, 'utf8'));
  const prepared = await readGoldenJournal(f);
  assert.equal(prepared.wave.checkpoints.length, 1);
  assert.equal(prepared.wave.checkpoints[0].state, 'prepared');
  assert.equal(prepared.wave.checkpoints[0].evidenceReceiptId, undefined);
  assert.equal(git(f.workspace, ['rev-parse', receipt.ref]), receipt.checkpoint.commit);
  assert.equal(git(f.workspace, ['rev-parse', 'HEAD']), f.base);
  assert.deepEqual(await readFile(join(f.workspace, '.git/index')), index);
  assert.equal(await readFile(join(f.workspace, 'core.cjs'), 'utf8'), CORE);
  const resumed = await childAttempt(t, f, { resumeFlowId: receipt.flowId });
  assert.equal(resumed.code, 0, resumed.output);
  const { audit } = JSON.parse(await readFile(f.resultPath, 'utf8'));
  assert.equal(audit.status, 'completed');
  const journal = await readGoldenJournal(f);
  assert.equal(journal.wave.checkpoints.length, 1);
  const checkpoint = journal.wave.checkpoints[0];
  assert.equal(checkpoint.commit, receipt.checkpoint.commit);
  assert.equal(checkpoint.state, 'published');
  assert.ok(checkpoint.evidenceReceiptId);
  assert.equal(git(f.workspace, ['rev-list', '--count', `${f.base}..${receipt.ref}`]), '1');
  assert.deepEqual(workers(await f.readAgentPids()).map(c => c.lane), ['CORE'], 'worker not replayed');
  assert.equal(checkpoint.orderedDispatchTokens.length, 1);
  assert.equal((await recordedReceipts(f, receipt.flowId)).filter(r => r.source === 'compose:checkpoint').length, 1);
  assert.equal(await readFile(join(f.workspace, 'core.cjs'), 'utf8'), CORE, 'accepted diff not applied twice');
  assertShip(f, journal);
});

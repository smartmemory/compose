/** Run with --test-timeout=900000. No model services, GUI, or installed-package mutation.
 *  Split from build-wave-golden.test.js (COMP-TEST-BWG-SPLIT-1) so no one file nears the suite per-file timeout. */
import { symbolicProfilesDigest } from '../helpers/model-route-projection.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflightPipelineProfiles } from '../../lib/pipeline-profiles.js';
import { git } from '../helpers/consumer-wave-fixture.js';
import { makeWaveGoldenProject, runWaveGolden, readGoldenJournal, frozenRoutingBaseline, normalizedGoldenCalls, readRoutingEvidence, assertRoutingGolden, assertShadowGoldenInput, WAVE_GOLDEN_SPEC, PROFILES, CORE, BROKEN, REPAIR, fixtureFor, workers, recordedReceipts, assertShip } from '../helpers/build-wave-golden-fixture.js';

const DRIVER = fileURLToPath(new URL('../helpers/build-wave-golden-fixture.js', import.meta.url));

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

for (const route_mode of ['off', 'shadow']) test(`real engine + connector ${route_mode}: SIGKILL after ref CAS before journal acknowledgement resumes one checkpoint and one ship`, { timeout: 360000 }, async t => {
  const f = await fixtureFor(t, 'crash', { routingInputs: route_mode === 'shadow' });
  const index = await readFile(join(f.workspace, '.git/index'));
  const crashed = await childAttempt(t, f, { crash: true, route_mode });
  assert.equal(crashed.signal, 'SIGKILL', crashed.output);
  assert.ok(existsSync(f.crashPath), `must reach publication boundary, not timeout\n${crashed.output}`);
  const receipt = JSON.parse(await readFile(f.crashPath, 'utf8'));
  const prepared = await readGoldenJournal(f);
  const routingBefore = route_mode === 'shadow' ? readRoutingEvidence(f, receipt.flowId) : null;
  assert.equal(prepared.wave.checkpoints.length, 1);
  assert.equal(prepared.wave.checkpoints[0].state, 'prepared');
  assert.equal(prepared.wave.checkpoints[0].evidenceReceiptId, undefined);
  assert.equal(git(f.workspace, ['rev-parse', receipt.ref]), receipt.checkpoint.commit);
  assert.equal(git(f.workspace, ['rev-parse', 'HEAD']), f.base);
  assert.deepEqual(await readFile(join(f.workspace, '.git/index')), index);
  assert.equal(await readFile(join(f.workspace, 'core.cjs'), 'utf8'), CORE);
  const resumed = await childAttempt(t, f, { resumeFlowId: receipt.flowId, route_mode: 'off' });
  assert.equal(resumed.code, 0, resumed.output);
  const { audit } = JSON.parse(await readFile(f.resultPath, 'utf8'));
  assert.equal(audit.status, 'completed');
  const journal = await readGoldenJournal(f);
  assert.equal(journal.wave.checkpoints.length, 1);
  if (routingBefore) {
    const after = readRoutingEvidence(f, receipt.flowId);
    assert.equal(after.rootBytes, routingBefore.rootBytes);
    assert.deepEqual(after.input, routingBefore.input);
    for (const [id, record] of Object.entries(routingBefore.journal.routing.records)) assert.deepEqual(after.journal.routing.records[id], record);
    assertRoutingGolden(after, 5);
  }
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

test('routing carry off oracle: frozen digest/input/full calls and no routing writes', { timeout: 480000 }, async t => {
  const frozen = frozenRoutingBaseline('carry');
  const off = await fixtureFor(t, 'repair');
  const beforeExclude = await readFile(join(off.workspace, '.git/info/exclude'), 'utf8');
  const beforeIgnore = await readFile(join(off.workspace, '.gitignore'), 'utf8');
  const a = await runWaveGolden(off, { route_mode: 'off' });
  assert.equal(a.audit.status, 'completed');
  assert.equal(symbolicProfilesDigest(preflightPipelineProfiles(PROFILES, WAVE_GOLDEN_SPEC)), frozen.profileDigest);
  assert.deepEqual(a.events[0].input, frozen.events[0].input);
  assert.equal(a.events[0].flow, frozen.events[0].flow);
  assert.deepEqual(a.events[0].opts, { ...frozen.events[0].opts, workspaceRoot: off.workspace });
  assert.deepEqual(normalizedGoldenCalls(a.events), normalizedGoldenCalls(frozen.events));
  assert.equal((await readGoldenJournal(off)).routing, undefined);
  assert.equal(existsSync(join(off.workspace, '.compose/routing')), false);
  assert.equal(await readFile(join(off.workspace, '.git/info/exclude'), 'utf8'), beforeExclude);
  assert.equal(await readFile(join(off.workspace, '.gitignore'), 'utf8'), beforeIgnore);

});

test('routing carry shadow oracle: immutable two-wave and ordinary epochs with identical full calls', { timeout: 240000 }, async t => {
  const frozen = frozenRoutingBaseline('carry');
  const shadow = await makeWaveGoldenProject('repair', { routingInputs: true });
  t.after(() => shadow.cleanup());
  let b;
  await assert.doesNotReject(async () => {
    b = await runWaveGolden(shadow, { route_mode: 'shadow', traceRouting: true });
  }, 'concurrent shadow carry must finish both waves without re-admitting a settled token');
  assert.equal(b.audit.status, 'completed');
  assert.deepEqual(normalizedGoldenCalls(b.events), normalizedGoldenCalls(frozen.events));
  assertShadowGoldenInput(b.events[0].input, frozen.events[0].input);
  const final = readRoutingEvidence(shadow, b.flowId);
  const records = assertRoutingGolden(final, 12);
  const sealed = JSON.parse(final.rootBytes);
  const checked = preflightPipelineProfiles(sealed.mergedProfiles, sealed.spec.effective);
  assert.equal(sealed.profilesDigest, checked.profilesDigest);
  assert.equal(symbolicProfilesDigest(checked), frozen.profileDigest);
  assert.equal(new Set(b.routingSnapshots.map(r => r.rootBytes)).size, 1);
  for (const earlier of b.routingSnapshots) for (const [id, record] of Object.entries(earlier.journal.routing.records)) {
    assert.deepEqual(final.journal.routing.records[id], record, 'later waves never rewrite earlier records');
  }
  const ordinary = records.filter(r => r.type === 'admission' && r.stage === null);
  for (const step of ['verify', 'review', 'assess']) {
    assert.deepEqual(ordinary.filter(r => r.scopedStep === step).map(r => r.epoch), [0, 1]);
  }
  assert.equal(ordinary.filter(r => r.scopedStep === 'plan').length, 1);
  assert.deepEqual(records.filter(r => r.type === 'admission' && r.stage === 0).map(r => r.logicalTaskId).sort(),
    ['BROKEN', 'CORE', 'DEFAULT', 'FAST', 'REPAIR']);
  assertShip(shadow, final.journal);
});

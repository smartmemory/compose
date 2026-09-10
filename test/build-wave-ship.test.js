import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildWaveFixture, waveSpec } from './helpers/build-wave-fixture.js';
import { git } from './helpers/consumer-wave-fixture.js';
import { ConsumerFanoutArtifacts } from '../lib/consumer-fanout.js';
import { prepareWaveShip } from '../lib/build.js';
process.env.NODE_ENV = 'test';
test('ship acknowledgement loss replays the same result and receipt without staging or committing', async t => {
  const f = buildWaveFixture(t, { spec: waveSpec({ ship: true }) });
  const sections = join(f.cwd, 'docs/bugs', f.code, 'sections');
  mkdirSync(sections, { recursive: true });
  writeFileSync(join(sections, 'section-01-file.md'), '# File\n\n## Files\n\n- `f1.txt`\n');
  writeFileSync(join(f.cwd, 'package.json'), JSON.stringify({ scripts: {
    test: "node -e \"console.log('# tests 1\\n# pass 1\\n# fail 0')\"",
  } }));
  const ready = () => ({ status: 'ready', runId: f.runId, revisionDigest: 'revision',
    ready: [{ id: 'ship', agent: 'claude', do: 'ship', dispatchToken: 'ship-token', attempt: 1 }] });
  const gateResolve = f.stratum.gateResolve;
  f.stratum.gateResolve = async (...args) => {
    await gateResolve(...args); f.state.status = 'running'; f.persist(); return ready();
  };
  const stepDone = f.stratum.stepDone;
  const reports = [];
  f.stratum.stepDone = async (...args) => {
    if (args[1] !== 'ship') return stepDone(...args);
    reports.push(structuredClone(args[2]));
    if (reports.length === 1) throw new Error('lost ship step_done');
    f.state.status = 'completed'; f.persist();
    return { status: 'completed', runId: f.runId };
  };
  f.stratum.resume = async () => ready();
  await assert.rejects(f.run(), /lost ship step_done/);
  const head = git(f.cwd, ['rev-parse', 'HEAD']);
  const index = readFileSync(join(f.cwd, '.git/index'));
  const dirty = git(f.cwd, ['diff', '--name-only']);
  assert.match(dirty, /section-01-file\.md/);
  const receipt = structuredClone(f.journal().pendingUsageReceipts.find(p => p.receipt.source === 'compose:wave_ship'));
  assert.ok(receipt);
  const receiptCalls = f.stratum.calls.filter(c => c.type === 'usageReport' && c.receipt.source === 'compose:wave_ship').length;
  await f.run({ resume: true });
  assert.equal(reports.length, 2);
  assert.deepEqual(reports[1], reports[0]);
  assert.equal(reports[1].output.outcome, 'complete');
  assert.equal(git(f.cwd, ['rev-parse', 'HEAD']), head);
  assert.equal(git(f.cwd, ['rev-parse', 'HEAD^']), f.base);
  assert.equal(git(f.cwd, ['rev-list', '--count', `${f.base}..HEAD`]), '1');
  assert.deepEqual(readFileSync(join(f.cwd, '.git/index')), index);
  assert.equal(git(f.cwd, ['diff', '--name-only']), dirty);
  assert.deepEqual(f.journal().pendingUsageReceipts.find(p => p.dispatchId === receipt.dispatchId), receipt);
  assert.equal(f.stratum.calls.filter(c => c.type === 'usageReport' && c.receipt.source === 'compose:wave_ship').length, receiptCalls);
});
test('public build publishes the approved witness and ship preparation preserves HEAD/index', async t => {
  const f = buildWaveFixture(t);
  const index = git(f.cwd, ['write-tree']);
  await f.run();
  const journal = f.journal();
  const checkpoint = journal.wave.checkpoints[0];
  assert.equal(checkpoint.state, 'published'); assert.ok(checkpoint.evidenceReceiptId);
  assert.equal(git(f.cwd, ['rev-parse', journal.wave.ref]), checkpoint.commit);
  assert.equal(git(f.cwd, ['rev-parse', 'HEAD']), f.base);
  assert.equal(git(f.cwd, ['write-tree']), index);
  assert.equal(readFileSync(join(f.cwd, 'f1.txt'), 'utf8'), 'wave 0\n');
  const context = { artifacts: new ConsumerFanoutArtifacts({ runId: f.runId, targetCwd: f.cwd, artifactRoot: f.artifactRoot }) };
  assert.equal(prepareWaveShip(context), checkpoint.tree);
  assert.deepEqual(context.filesChanged, ['f1.txt']);
  assert.equal(git(f.cwd, ['write-tree']), index);
});

test('second wave inherits first checkpoint and pins one base for the wave', async t => {
  const { writeFileSync } = await import('node:fs');
  const f = buildWaveFixture(t, { mutate(cwd, index) {
    if (index === 1) assert.equal(readFileSync(join(cwd, 'f1.txt'), 'utf8'), 'wave 0\n');
    writeFileSync(join(cwd, `f${index + 1}.txt`), `wave ${index}\n`);
  } });
  const gateResolve = f.stratum.gateResolve; const stepDone = f.stratum.stepDone;
  let wave = 0;
  f.stratum.gateResolve = async (...args) => {
    const next = await gateResolve(...args);
    if (++wave === 2) return next;
    const d = f.descriptors[0];
    Object.assign(d, { generation: 10, epoch: 1, dispatchToken: 'wave2-token', do: 'write 1', item: { ...d.item, id: 'T2', files_owned: ['f2.txt'] } });
    f.state.status = 'running';
    f.state.steps.plan = { status: 'succeeded', epoch: 1, output: { tasks: [d.item] }, acceptedDispatchToken: 'plan2' };
    f.state.steps.execute = { status: 'running', epoch: 1, fanout: { items: [{ status: 'running', generation: 10, dispatchToken: d.dispatchToken }] } };
    f.persist();
    return { status: 'ready', runId: f.runId, revisionDigest: 'revision', ready: [structuredClone(d)] };
  };
  f.stratum.stepDone = async (...args) => {
    const next = await stepDone(...args);
    if (wave === 1) { f.state.steps.execute_merge.gateToken = 'merge2-token'; f.state.steps.execute_merge.epoch = 1; f.persist(); }
    return next;
  };
  await f.run();
  const journal = f.journal();
  assert.equal(journal.wave.checkpoints.length, 2);
  assert.equal(journal.waveAdmissions[1].baseCommit, journal.wave.checkpoints[0].commit);
  assert.equal(journal.wave.checkpoints[1].parentCommit, journal.wave.checkpoints[0].commit);
  assert.equal(git(f.cwd, ['rev-parse', 'HEAD']), f.base);
});

test('acknowledgement loss after approval publishes one checkpoint without a second gate call', async t => {
  const f = buildWaveFixture(t);
  const original = f.stratum.gateResolve;
  f.stratum.gateResolve = async (...args) => { await original(...args); throw new Error('lost gate ack'); };
  f.stratum.resume = async () => ({ status: f.state.status, runId: f.runId, revisionDigest: 'revision' });
  await f.run();
  assert.equal(f.journal().wave.checkpoints.length, 1);
  assert.equal(f.stratum.calls.filter(c => c.type === 'gateResolve').length, 1);
});

test('ship entry produces one base-parent commit and resume preparation recognizes its receipt', async t => {
  const { writeFileSync } = await import('node:fs');
  const { executeShipStep } = await import('../lib/build.js');
  const f = buildWaveFixture(t);
  await f.run();
  // The ship test runs only this disposable project's deterministic test command.
  writeFileSync(join(f.cwd, 'package.json'), JSON.stringify({ scripts: { test: "node -e \"console.log('# tests 1\\n# pass 1\\n# fail 0')\"" } }));
  const context = { cwd: f.cwd, featureCode: f.code, mode: 'bug', flowId: f.runId, stratum: f.stratum,
    artifacts: new ConsumerFanoutArtifacts({ runId: f.runId, targetCwd: f.cwd, artifactRoot: f.artifactRoot }) };
  const result = await executeShipStep(f.code, f.cwd, f.cwd, context, '', null);
  assert.equal(result.outcome, 'complete', result.summary);
  assert.equal(git(f.cwd, ['rev-parse', 'HEAD^']), f.base);
  assert.equal(git(f.cwd, ['rev-list', '--count', `${f.base}..HEAD`]), '1');
  assert.equal(git(f.cwd, ['show', 'HEAD:f1.txt']), 'wave 0');
  assert.doesNotThrow(() => prepareWaveShip(context));
});

test('explicit fresh deletes only the previous flow ref with expected-old CAS', async t => {
  const f = buildWaveFixture(t);
  await f.run();
  const ref = f.journal().wave.ref;
  const other = 'refs/heads/compose/wave/another-flow';
  git(f.cwd, ['update-ref', other, f.base]);
  f.stratum.plan = async () => ({ status: 'completed', runId: 'fresh-flow', revisionDigest: 'revision' });
  await f.run({ fresh: true });
  assert.throws(() => git(f.cwd, ['show-ref', '--verify', ref]));
  assert.equal(git(f.cwd, ['rev-parse', other]), f.base);
  assert.equal(git(f.cwd, ['rev-parse', 'HEAD']), f.base);
});

test('cancellation after confirmed approval preserves checkpoint and unreplicated evidence', async t => {
  const f = buildWaveFixture(t);
  const gateResolve = f.stratum.gateResolve; const usageReport = f.stratum.usageReport;
  f.stratum.gateResolve = async (...args) => {
    await gateResolve(...args); f.state.status = 'cancelled'; f.persist();
    return { status: 'cancelled', runId: f.runId };
  };
  f.stratum.usageReport = async (...args) => {
    if (f.state.status === 'cancelled') throw Object.assign(new Error('no receipts on cancelled run'), { code: 'PERSIST_ON_CANCELLED_RUN' });
    return usageReport(...args);
  };
  await assert.rejects(f.run(), /retained locally|cancel/i);
  const journal = f.journal();
  assert.equal(journal.wave.checkpoints[0].state, 'published');
  assert.equal(git(f.cwd, ['rev-parse', journal.wave.ref]), journal.wave.checkpoints[0].commit);
  assert.equal(git(f.cwd, ['rev-parse', 'HEAD']), f.base);
  assert.equal(readFileSync(join(f.cwd, 'f1.txt'), 'utf8'), 'wave 0\n');
  assert.ok(journal.pendingUsageReceipts.some(r => r.state === 'pending' && r.receipt.source === 'compose:checkpoint'));
});

test('checkpoint-only policy derives ship paths from the captured net tree without requiring ownership', async t => {
  const { decisionProfiles } = await import('./helpers/build-wave-fixture.js');
  const f = buildWaveFixture(t, { tasks: [{ id: 'T1', description: 'work' }], profiles: {
    ...decisionProfiles, execute: 'codex:implementer:standard', _consumer: { execute: { checkpoint_gate: 'execute_merge' } },
  } });
  await f.run();
  const context = { artifacts: new ConsumerFanoutArtifacts({ runId: f.runId, targetCwd: f.cwd, artifactRoot: f.artifactRoot }) };
  prepareWaveShip(context);
  assert.deepEqual(context.filesChanged, ['f1.txt']);
});

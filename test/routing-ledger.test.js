/** Routing start/plan/continuation persistence over disposable Git repositories. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRoutingStart, readRoutingStart, recordRoutingPlanIntent, recordRoutingPlanRequested, bindRoutingRun,
  recoverRoutingPlan, validateRoutingRun, createContinuationIntent, ensureRoutingStorage, validateRoutingRecord } from '../lib/routing-ledger.js';
import { routingDigest, canonicalRoutingJson, routingRecordId } from '../lib/model-router.js';
import { preflightPipelineProfiles } from '../lib/pipeline-profiles.js';
import YAML from 'yaml';
import { validateSpec } from '@smartmemory/stratum/dist/ir/validate.js';
import { resolvePlanSpecValues } from '../lib/stratum-mcp-client.js';
import { ConsumerFanoutArtifacts } from '../lib/consumer-fanout.js';
import { readRoutingSnapshot, findRoutingPlanRuns, routingStepEpoch } from '../lib/flow-state.js';
const transport = { route_mode: 'string?', routing_start: 'string?', routing_root: 'string?', routing_plan_intent: 'string?', routing_continuation: 'string?' };
const spec = { version: 1, contracts: { Result: { value: 'string' } }, flows: { entry: 'main', main: { input: { task: 'string', ...transport }, steps: [{ id: 'work', agent: 'codex', out: 'Result' }] } } };
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'routing-ledger-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(['init', '-q']); git(['config', 'user.email', 'test@example.test']); git(['config', 'user.name', 'Routing test']);
  writeFileSync(join(cwd, 'tracked'), 'base'); git(['add', '.']); git(['commit', '-qm', 'base']);
  const preflight = preflightPipelineProfiles({}, spec);
  const args = { cwd, spec, inputs: { task: 'work' }, originalProfiles: {}, runtimeOverrides: {}, preflight, mode: 'shadow', presetId: 'test' };
  return { cwd, git, args, preflight };
}
function planned(t) {
  const f = fixture(t); const start = createRoutingStart(f.args);
  const input = { ...f.args.inputs, route_mode: 'shadow', routing_start: canonicalRoutingJson(start), routing_root: start.rootDigest, routing_plan_intent: 'plan1' };
  const intent = recordRoutingPlanIntent({ cwd: f.cwd, start, input, specDigest: routingDigest(spec), featureCode: 'FEATURE' });
  const snapshot = { id: 'run1', revisionDigest: routingDigest(spec), spec, input, workspaceRoot: f.cwd, steps: { work: { status: 'pending' } } };
  return { ...f, start, input, intent, snapshot };
}
test('start is sealed before plan, canonical immutable replay and closed schemas detect corruption', t => {
  const f = planned(t);
  assert.equal(f.start.seed, routingDigest({ startId: f.start.startId, policyVersion: f.start.policyVersion }));
  assert.deepEqual(readRoutingStart({ cwd: f.cwd, ...f.start }), f.start);
  assert.equal(f.start.table.contents.length, 0); assert.equal(f.start.calibration_feedback, false);
  assert.ok(Object.keys(f.start.staticResolutions).includes('main/work'));
  const path = join(f.cwd, '.compose/routing/starts', f.start.startId, 'routing-start.json');
  const bytes = readFileSync(path, 'utf8');
  assert.deepEqual(recordRoutingPlanIntent({ cwd: f.cwd, start: f.start, input: f.input, specDigest: routingDigest(spec), featureCode: 'FEATURE' }), f.intent);
  assert.equal(readFileSync(path, 'utf8'), bytes);
  for (const patch of [{ unknown: true }, { seed: 'bad' }, { table: { ...f.start.table, contents: [1] } }]) {
    writeFileSync(path, JSON.stringify({ ...f.start, ...patch }));
    assert.throws(() => readRoutingStart({ cwd: f.cwd, ...f.start }));
  }
  writeFileSync(path, bytes);
  assert.throws(() => readRoutingStart({ cwd: f.cwd, startId: '../escape', rootDigest: f.start.rootDigest }));
  assert.throws(() => createRoutingStart({ ...f.args, mode: 'active' }), { code: 'ROUTING_SLICE_UNAVAILABLE' });
  assert.throws(() => createRoutingStart({ ...f.args, spec: { flows: { main: { input: {}, steps: [] } } } }), { code: 'ROUTING_INPUT_UNDECLARED' });
});
test('storage excludes routing data from dirty checks, snapshot staging, cleanup and ship; linked worktrees resolve local exclude', t => {
  const f = fixture(t); const exclude = join(f.cwd, '.git/info/exclude');
  const before = readFileSync(exclude, 'utf8'); ensureRoutingStorage(f);
  assert.ok(readFileSync(exclude, 'utf8').startsWith(before));
  const path = join(f.cwd, '.compose/routing/control'); writeFileSync(path, 'retained');
  assert.equal(f.git(['status', '--porcelain']), ''); f.git(['add', '-A']); assert.equal(f.git(['diff', '--cached', '--name-only']), '');
  f.git(['clean', '-fd']); assert.equal(readFileSync(path, 'utf8'), 'retained');
  f.git(['commit', '--allow-empty', '-qm', 'ship']); assert.doesNotMatch(f.git(['ls-tree', '-r', '--name-only', 'HEAD']), /routing/);
  const linked = join(f.cwd, 'linked'); f.git(['worktree', 'add', '-q', '-b', 'linked', linked]);
  ensureRoutingStorage({ cwd: linked }); assert.equal(execFileSync('git', ['check-ignore', '.compose/routing/probe'], { cwd: linked, encoding: 'utf8' }).trim(), '.compose/routing/probe');
});
test('tracked reserved subtree, symlink escape and concurrent live writer refuse', t => {
  const f = fixture(t); mkdirSync(join(f.cwd, '.compose/routing'), { recursive: true }); writeFileSync(join(f.cwd, '.compose/routing/tracked'), 'bad');
  f.git(['add', '-f', '.compose/routing/tracked']); assert.throws(() => ensureRoutingStorage(f), { code: 'ROUTING_STORAGE_UNSAFE' });
  const g = fixture(t); mkdirSync(join(g.cwd, '.compose')); symlinkSync(tmpdir(), join(g.cwd, '.compose/routing'));
  assert.throws(() => ensureRoutingStorage(g), { code: 'ROUTING_STORAGE_UNSAFE' });
  const p = planned(t); const lock = join(p.cwd, '.compose/routing/starts', p.start.startId, '.lock');
  mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  assert.throws(() => recordRoutingPlanRequested({ cwd: p.cwd, start: p.start, intent: p.intent }), { code: 'ROUTING_STORAGE_LOCKED' });
});
test('requested plan recovery binds exactly one recorded run; zero, duplicate and unreadable candidates refuse', t => {
  const f = planned(t); recordRoutingPlanRequested({ cwd: f.cwd, start: f.start, intent: f.intent });
  const stateRoot = join(f.cwd, 'flows'); mkdirSync(stateRoot);
  const recover = () => recoverRoutingPlan({ cwd: f.cwd, intent: f.intent, stateRoot });
  assert.throws(recover, { code: 'ROUTING_PLAN_UNCERTAIN' });
  writeFileSync(join(stateRoot, 'run1.json'), JSON.stringify(f.snapshot));
  const binding = recover(); assert.equal(binding.runId, 'run1'); assert.equal(binding.previousRunId, null);
  assert.deepEqual(bindRoutingRun({ cwd: f.cwd, start: f.start, intent: f.intent, snapshot: f.snapshot }), binding);
  const journal = { routing: { version: 1, startId: f.start.startId, rootDigest: f.start.rootDigest, runBinding: binding, records: {}, tokenIndex: {}, eventTips: {} } };
  assert.deepEqual(validateRoutingRun({ cwd: f.cwd, snapshot: f.snapshot, journal, currentSpec: spec, currentMappings: f.start.mappings }), { start: f.start, binding });
  assert.throws(() => validateRoutingRun({ cwd: f.cwd, snapshot: f.snapshot, journal, currentSpec: spec, currentMappings: {} }), { code: 'ROUTING_ROOT_DRIFT' });
  writeFileSync(join(stateRoot, 'run2.json'), JSON.stringify({ ...f.snapshot, id: 'run2' })); assert.throws(recover, { code: 'ROUTING_PLAN_UNCERTAIN' });
  rmSync(join(stateRoot, 'run2.json')); writeFileSync(join(stateRoot, 'unknown.json'), '{'); assert.throws(recover, { code: 'ROUTING_PLAN_UNCERTAIN' });
});
test('strict routing snapshots verify transport/spec/workspace and epoch zero requires an existing step', t => {
  const f = planned(t); const stateRoot = join(f.cwd, 'flows'); mkdirSync(stateRoot); writeFileSync(join(stateRoot, 'run1.json'), JSON.stringify(f.snapshot));
  assert.equal(readRoutingSnapshot('run1', { stateRoot, revisionDigest: f.snapshot.revisionDigest, rootDigest: f.start.rootDigest, planIntentId: f.intent.id }).id, 'run1');
  assert.equal(routingStepEpoch(f.snapshot, 'work'), 0); assert.throws(() => routingStepEpoch(f.snapshot, 'missing'), { code: 'ROUTING_STATE_UNVERIFIED' });
  assert.equal(findRoutingPlanRuns({ stateRoot, workspaceRoot: f.cwd, planIntentId: f.intent.id, rootDigest: f.start.rootDigest }).length, 1);
  assert.throws(() => readRoutingSnapshot('../run1', { stateRoot }), { code: 'ROUTING_STATE_UNVERIFIED' });
});
test('plan boundaries replay durably after injected publication failure; conflicting payload is never overwritten', t => {
  const f = planned(t);
  assert.throws(() => recordRoutingPlanRequested({ cwd: f.cwd, start: f.start, intent: f.intent, hooks: { afterPublish() { throw Error('crash'); } } }), /crash/);
  const requested = recordRoutingPlanRequested({ cwd: f.cwd, start: f.start, intent: f.intent }); assert.equal(requested.phase, 'requested');
  assert.throws(() => bindRoutingRun({ cwd: f.cwd, start: f.start, intent: f.intent, snapshot: f.snapshot, hooks: { afterPublish() { throw Error('crash'); } } }), /crash/);
  assert.equal(bindRoutingRun({ cwd: f.cwd, start: f.start, intent: f.intent, snapshot: f.snapshot }).runId, 'run1');
  assert.throws(() => recordRoutingPlanIntent({ cwd: f.cwd, start: f.start, input: { ...f.input, task: 'changed' }, specDigest: routingDigest(spec), featureCode: 'FEATURE' }));
});
test('off start does no storage work', t => {
  const f = fixture(t); const before = readFileSync(join(f.cwd, '.git/info/exclude'), 'utf8');
  assert.equal(createRoutingStart({ ...f.args, mode: 'off' }), null); assert.equal(existsSync(join(f.cwd, '.compose')), false);
  assert.equal(readFileSync(join(f.cwd, '.git/info/exclude'), 'utf8'), before);
});

test('three-run continuation preserves C allocation through 2→1→0, cumulative completion chain and source epoch independence', t => {
  const f = planned(t); recordRoutingPlanRequested({ cwd: f.cwd, start: f.start, intent: f.intent });
  const oldBinding = bindRoutingRun({ cwd: f.cwd, start: f.start, intent: f.intent, snapshot: f.snapshot });
  const graph = { tasks: ['A', 'B', 'C'].map((id, i) => ({ id, description: id, depends_on: i ? ['A'] : [] })) };
  const route = { resolution: f.preflight.resolved.work, provenance: f.preflight.staticProvenance.work };
  const base = (type, id) => ({ schemaVersion: 1, startId: f.start.startId, rootDigest: f.start.rootDigest, type, id });
  const artifactRoot = mkdtempSync(join(tmpdir(), 'continuation-artifacts-'));
  t.after(() => rmSync(artifactRoot, { recursive: true, force: true }));
  const open = (binding, routingAncestry, hooks = {}) => new ConsumerFanoutArtifacts({ runId: binding.runId, targetCwd: f.cwd,
    artifactRoot, revisionDigest: binding.revisionDigest, routingBinding: binding, routingAncestry, hooks });
  let artifacts = open(oldBinding);
  const put = record => artifacts.recordRoutingRecord(record);
  const journal = () => ({ routing: artifacts.exportRoutingJournal() });
  for (const [index, task] of graph.tasks.entries()) {
    const logical = { scopedStep: 'execute', stage: 0, logicalWaveId: 'wave', logicalEpoch: 4, logicalTaskId: task.id };
    put({ ...base('admission', `admission-${task.id}`), ...logical, allocationId: `allocation-${task.id}`, runId: 'run1', epoch: 1,
      itemIndex: index, generation: 1, inputDigest: routingDigest(graph), inputProvenance: { source: 'decompose' }, candidate: route, baseline: route,
      proposal: route, admitted: route, refusal: null, would: route, repairContext: { state: 'not-evaluated-s1a' } });
    const issuance = { ...base('issuance', 'pending'), ...logical, key: 'shared', admissionId: `admission-${task.id}`, runId: 'run1', revisionDigest: oldBinding.revisionDigest,
      epoch: 1, itemIndex: index, generation: 1, issuanceToken: `token-${task.id}`, priorRecordId: null, selected: route, would: route };
    issuance.id = routingRecordId(issuance); put(issuance);
    put({ ...base('issuance-event', `launch-${task.id}`), event: 'launch-intent', sequence: 0, issuanceId: issuance.id, issuanceToken: issuance.issuanceToken });
    put({ ...base('issuance-event', `settled-${task.id}`), event: 'settled', sequence: 1, issuanceId: issuance.id, issuanceToken: issuance.issuanceToken,
      evidence: { runId: 'run1', revisionDigest: oldBinding.revisionDigest, scopedStep: 'execute', epoch: 1, itemIndex: index, generation: 1,
        issuanceToken: issuance.issuanceToken, acceptedDispatchToken: issuance.issuanceToken, status: 'succeeded' } });
  }
  const sourceBinding = { runId: 'run1', scopedStep: 'decompose', epoch: 0, acceptedDispatchToken: 'source-token', output: graph, outputDigest: routingDigest(graph) };
  const epoch = put({ ...base('epoch-binding', 'epoch1'), scopedStep: 'execute', stage: 0, logicalWaveId: 'wave', logicalEpoch: 4, logicalTaskId: null,
    runId: 'run1', epoch: 1, priorEpochBindingId: null, admissionIds: graph.tasks.map(t => `admission-${t.id}`), issuanceIds: Object.values(artifacts.exportRoutingJournal().tokenIndex), sourceBinding, graph, graphDigest: routingDigest(graph) });

  const snapshot = { ...f.snapshot, steps: { ...f.snapshot.steps, execute: { status: 'succeeded', epoch: 1 }, decompose: { status: 'succeeded', acceptedDispatchToken: 'source-token', output: graph } } };
  const filtered = { tasks: graph.tasks.slice(1).map(t => ({ ...t, depends_on: [] })) };
  const details = { previousRunId: 'run1', originalGraph: graph, graph: filtered, completedTaskIds: ['A'], verifiedCompletedTaskIds: ['A'] };
  const first = createContinuationIntent({ start: f.start, oldBinding, resumeDetails: details, priorJournal: journal(), snapshot });
  assert.deepEqual(first.indexMap, [{ taskId: 'A', oldIndex: 0, newIndex: null }, { taskId: 'B', oldIndex: 1, newIndex: 0 }, { taskId: 'C', oldIndex: 2, newIndex: 1 }]);
  assert.deepEqual(first.removedDependencies, [{ taskId: 'B', dependency: 'A' }, { taskId: 'C', dependency: 'A' }]);
  assert.equal(first.bindings[1].allocationId, 'allocation-C'); assert.equal(first.bindings[1].logicalEpoch, 4);
  for (const change of [{ completedTaskIds: ['X'] }, { graph: { tasks: filtered.tasks.map(t => ({ ...t, description: 'changed' })) } }, { originalGraph: { tasks: [graph.tasks[0], graph.tasks[0]] } }]) {
    assert.throws(() => createContinuationIntent({ start: f.start, oldBinding, resumeDetails: { ...details, ...change }, priorJournal: journal(), snapshot }), { code: 'ROUTING_CONTINUATION_AMBIGUOUS' });
  }
  const drift = structuredClone(snapshot); drift.steps.decompose.acceptedDispatchToken = 'changed';
  assert.throws(() => createContinuationIntent({ start: f.start, oldBinding, resumeDetails: details, priorJournal: journal(), snapshot: drift }), { code: 'ROUTING_CONTINUATION_AMBIGUOUS' });
  put(first);
  const input2 = { ...f.input, routing_plan_intent: 'plan2', routing_continuation: first.id };
  const intent2 = recordRoutingPlanIntent({ cwd: f.cwd, start: f.start, input: input2, specDigest: routingDigest(spec), featureCode: 'FEATURE', previousRunId: 'run1', continuation: first });
  recordRoutingPlanRequested({ cwd: f.cwd, start: f.start, intent: intent2 });
  const snapshot2 = { ...snapshot, id: 'run2', input: input2, steps: { execute: { status: 'succeeded', epoch: 0 }, decompose: { status: 'succeeded', acceptedDispatchToken: 'source2', output: filtered } } };
  const binding2 = bindRoutingRun({ cwd: f.cwd, start: f.start, intent: intent2, snapshot: snapshot2 });
  const ancestry = artifacts.exportRoutingJournal();
  const withoutContinuation = Object.fromEntries(Object.entries(ancestry.records).filter(([id]) => id !== first.id));
  assert.throws(() => open(binding2, { ...ancestry, records: withoutContinuation }), { code: 'ROUTING_BINDING_MISSING' });
  const withoutAdmission = Object.fromEntries(Object.entries(ancestry.records).filter(([id]) => id !== 'admission-C'));
  assert.throws(() => open(binding2, { ...ancestry, records: withoutAdmission }), { code: 'ROUTING_BINDING_MISSING' });
  assert.throws(() => open(binding2), { code: 'ROUTING_BINDING_MISSING' });
  for (const boundary of ['beforeRoutingWrite', 'afterRoutingWrite']) {
    assert.throws(() => open(binding2, ancestry, { [boundary]() { throw Error('first journal crash'); } }), /first journal crash/);
    if (boundary === 'beforeRoutingWrite') {
      assert.throws(() => open(binding2), { code: 'ROUTING_BINDING_MISSING' });
    }
  }
  artifacts = open(binding2);
  assert.deepEqual(artifacts.exportRoutingJournal().tokenIndex, ancestry.tokenIndex);
  assert.deepEqual(artifacts.exportRoutingJournal().eventTips, ancestry.eventTips);
  const nextIssuanceIds = [];
  for (const [index, task] of filtered.tasks.entries()) {
    const old = artifacts.readRoutingRecord(ancestry.tokenIndex[`token-${task.id}`]);
    const issued = { ...old, runId: 'run2', epoch: 0, itemIndex: index, generation: 2, issuanceToken: `second-${task.id}`, priorRecordId: old.id };
    issued.id = routingRecordId(issued); put(issued); nextIssuanceIds.push(issued.id);
    put({ ...artifacts.readRoutingRecord(`launch-${task.id}`), id: `launch2-${task.id}`, issuanceId: issued.id, issuanceToken: issued.issuanceToken });
    const settled = artifacts.readRoutingRecord(`settled-${task.id}`); settled.id = `settled2-${task.id}`; settled.issuanceId = issued.id; settled.issuanceToken = issued.issuanceToken;
    Object.assign(settled.evidence, { runId: 'run2', epoch: 0, itemIndex: index, generation: 2, issuanceToken: issued.issuanceToken, acceptedDispatchToken: issued.issuanceToken }); put(settled);
  }
  const epoch2 = put({ ...epoch, id: 'epoch2', runId: 'run2', epoch: 0, priorEpochBindingId: epoch.id, admissionIds: ['admission-B', 'admission-C'], issuanceIds: nextIssuanceIds,
    sourceBinding: { ...sourceBinding, runId: 'run2', acceptedDispatchToken: 'source2', output: filtered, outputDigest: routingDigest(filtered) }, graph: filtered, graphDigest: routingDigest(filtered) });
  const secondDetails = { previousRunId: 'run2', originalGraph: filtered, graph: { tasks: [filtered.tasks[1]] }, completedTaskIds: ['A', 'B'], verifiedCompletedTaskIds: ['B'] };
  // Review probe: B is locally valid, but cumulative history may not drop A.
  assert.throws(() => createContinuationIntent({ start: f.start, oldBinding: binding2, resumeDetails: { ...secondDetails, completedTaskIds: ['B'] },
    priorJournal: journal(), snapshot: snapshot2 }), { code: 'ROUTING_CONTINUATION_HISTORY_DRIFT' });
  // Review probe: even matching new epoch/source evidence cannot explain a changed C description.
  const changedGraph = { tasks: filtered.tasks.map(task => task.id === 'C' ? { ...task, description: 'unexplained change' } : task) };
  const changedEpoch = { ...epoch2, id: 'changed-epoch', graph: changedGraph, graphDigest: routingDigest(changedGraph),
    sourceBinding: { ...epoch2.sourceBinding, output: changedGraph, outputDigest: routingDigest(changedGraph) } };
  assert.throws(() => put(changedEpoch), { code: 'ROUTING_CONTINUATION_GRAPH_DRIFT' });
  const changedSnapshot = structuredClone(snapshot2); changedSnapshot.steps.decompose.output = changedGraph;
  assert.throws(() => createContinuationIntent({ start: f.start, oldBinding: binding2,
    resumeDetails: { ...secondDetails, originalGraph: changedGraph, graph: { tasks: [changedGraph.tasks[1]] } },
    priorJournal: journal(), snapshot: changedSnapshot }), { code: 'ROUTING_CONTINUATION_GRAPH_DRIFT' });
  const second = createContinuationIntent({ start: f.start, oldBinding: binding2, resumeDetails: { previousRunId: 'run2', originalGraph: filtered, graph: { tasks: [filtered.tasks[1]] }, completedTaskIds: ['A', 'B'], verifiedCompletedTaskIds: ['B'] }, priorJournal: journal(), snapshot: snapshot2 });
  assert.deepEqual(second.removedTaskIds, ['B']); assert.deepEqual(second.completionChain, [first.id]);
  assert.deepEqual(second.indexMap, [{ taskId: 'B', oldIndex: 0, newIndex: null }, { taskId: 'C', oldIndex: 1, newIndex: 0 }]);
  assert.equal(second.bindings[0].admissionId, 'admission-C'); assert.equal(second.bindings[0].allocationId, 'allocation-C');
  put(second);
  const input3 = { ...f.input, routing_plan_intent: 'plan3', routing_continuation: second.id };
  const intent3 = recordRoutingPlanIntent({ cwd: f.cwd, start: f.start, input: input3, specDigest: routingDigest(spec), featureCode: 'FEATURE', previousRunId: 'run2', continuation: second });
  recordRoutingPlanRequested({ cwd: f.cwd, start: f.start, intent: intent3 });
  const graph3 = second.filteredGraph;
  const snapshot3 = { ...snapshot2, id: 'run3', input: input3, steps: { execute: { status: 'pending', epoch: 0 }, decompose: { status: 'succeeded', acceptedDispatchToken: 'source3', output: graph3 } } };
  const binding3 = bindRoutingRun({ cwd: f.cwd, start: f.start, intent: intent3, snapshot: snapshot3 });
  artifacts = open(binding3, artifacts.exportRoutingJournal());
  const previousC = artifacts.readRoutingRecord(second.bindings[0].priorRecordId);
  const thirdC = { ...previousC, runId: 'run3', itemIndex: 0, generation: 3, issuanceToken: 'third-C', priorRecordId: previousC.id };
  thirdC.id = routingRecordId(thirdC); put(thirdC);
  put({ ...epoch2, id: 'epoch3', runId: 'run3', priorEpochBindingId: epoch2.id, admissionIds: ['admission-C'], issuanceIds: [thirdC.id],
    sourceBinding: { ...sourceBinding, runId: 'run3', acceptedDispatchToken: 'source3', output: graph3, outputDigest: routingDigest(graph3) }, graph: graph3, graphDigest: routingDigest(graph3) });
  artifacts = open(binding3);
  assert.equal(artifacts.readRoutingRecord(thirdC.id).itemIndex, 0);
  assert.deepEqual(artifacts.readRoutingRecord('epoch3').graph, second.filteredGraph);
  assert.equal(artifacts.readRoutingRecord(thirdC.id).admissionId, 'admission-C');
  assert.equal(artifacts.readRoutingRecord(second.id).completionChain[0], first.id);
  assert.deepEqual(artifacts.readRoutingRecord('admission-C').inputProvenance, { source: 'decompose' });
});

test('nested path symlinks refuse and a verifiably dead per-start writer can be reclaimed', t => {
  const f = planned(t);
  const startPath = join(f.cwd, '.compose/routing/starts', f.start.startId);
  const saved = join(f.cwd, 'saved-start'); execFileSync('mv', [startPath, saved]); symlinkSync(saved, startPath);
  assert.throws(() => readRoutingStart({ cwd: f.cwd, ...f.start }), { code: 'ROUTING_STORAGE_UNSAFE' });
  rmSync(startPath); execFileSync('mv', [saved, startPath]);
  const deadPid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }));
  const lock = join(startPath, '.lock'); mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: deadPid }));
  assert.equal(recordRoutingPlanRequested({ cwd: f.cwd, start: f.start, intent: f.intent }).phase, 'requested');
  assert.equal(existsSync(lock), false);
});
test('prepared-plan publication boundaries retain the same pre-plan seed and never overwrite conflicts', t => {
  for (const boundary of ['beforePublish', 'afterPublish']) {
    const f = fixture(t); const start = createRoutingStart(f.args);
    const input = { ...f.args.inputs, route_mode: 'shadow', routing_start: canonicalRoutingJson(start), routing_root: start.rootDigest, routing_plan_intent: 'boundary-plan' };
    const args = { cwd: f.cwd, start, input, specDigest: routingDigest(spec), featureCode: 'BOUNDARY' };
    assert.throws(() => recordRoutingPlanIntent({ ...args, hooks: { [boundary]() { throw Error('crash'); } } }), /crash/);
    const intent = recordRoutingPlanIntent(args); assert.equal(intent.input.routing_start, canonicalRoutingJson(start));
    assert.deepEqual(readRoutingStart({ cwd: f.cwd, ...start }), start);
  }
});
test('start pins original and effective spec identities, input roles and scoped resolutions', t => {
  const f = fixture(t);
  const authored = structuredClone(spec); authored.flows.main.input.role = 'string'; authored.flows.main.steps[0].agent = '$.input.role';
  const effective = structuredClone(authored); effective.flows.main.steps[0].agent = 'codex';
  const runtime = { work: 'codex::fast' };
  const preflight = preflightPipelineProfiles({}, effective, runtime, { runtimeOrigins: { work: { supplied: false, origin: 'recorded-role', recordedRole: 'codex::fast' } } });
  const start = createRoutingStart({ ...f.args, spec: authored, inputs: { task: 'work', role: 'codex::fast' }, preflight });
  assert.deepEqual(start.spec.original, authored); assert.deepEqual(start.spec.effective, effective);
  assert.notEqual(start.spec.originalDigest, start.spec.effectiveDigest);
  assert.equal(start.staticResolutions['main/work'].manualFallback.supplied, false);
  assert.equal(start.staticResolutions['main/work'].manualFallback.recordedRole, 'codex::fast');
  assert.equal(start.staticResolutions['main/work'].source, 'default');
  assert.deepEqual(start.runtimeOverrides, {});
  const input = { ...start.originalInput, route_mode: 'shadow', routing_start: canonicalRoutingJson(start), routing_root: start.rootDigest, routing_plan_intent: 'role-plan' };
  const intent = recordRoutingPlanIntent({ cwd: f.cwd, start, input, specDigest: start.spec.effectiveDigest, featureCode: 'ROLE' });
  recordRoutingPlanRequested({ cwd: f.cwd, start, intent });
  assert.equal(bindRoutingRun({ cwd: f.cwd, start, intent, snapshot: { id: 'role-run', revisionDigest: start.spec.effectiveDigest, input, spec: effective, workspaceRoot: f.cwd, steps: { work: { status: 'pending' } } } }).runId, 'role-run');
});
test('start pins unseen item-tier mappings and separate same-named scoped defaults', t => {
  const f = fixture(t);
  const authored = structuredClone(spec); authored.flows.other = { steps: [{ id: 'work', agent: 'claude', out: 'Result' }] };
  const preflight = preflightPipelineProfiles({}, authored);
  const start = createRoutingStart({ ...f.args, spec: authored, preflight });
  assert.equal(start.staticResolutions['main/work'].winner.provider, 'codex');
  assert.equal(start.staticResolutions['other/work'].winner.provider, 'claude');
  assert.equal(start.mappings['candidate/codex/standard'].modelID, 'gpt-6-sol');
  assert.equal(start.mappings['candidate/claude/coordinator'].modelID, 'claude-fable-5-1');
});
test('requested and run-binding before/after publication faults recover the original intent exactly', t => {
  for (const boundary of ['beforePublish', 'afterPublish']) {
    for (const stage of ['requested', 'binding']) {
      const f = planned(t);
      if (stage === 'binding') recordRoutingPlanRequested({ cwd: f.cwd, start: f.start, intent: f.intent });
      const apply = hooks => stage === 'requested'
        ? recordRoutingPlanRequested({ cwd: f.cwd, start: f.start, intent: f.intent, hooks })
        : bindRoutingRun({ cwd: f.cwd, start: f.start, intent: f.intent, snapshot: f.snapshot, hooks });
      assert.throws(() => apply({ [boundary]() { throw Error('crash'); } }), /crash/);
      const saved = apply({}); assert.deepEqual(apply({}), saved);
      assert.equal(saved.planIntentId, f.intent.id);
    }
  }
});
test('published contracts carry feature metadata and refuse outcome extensions in v1 records', t => {
  const f = planned(t);
  for (const name of ['routing-start', 'routing-record', 'routing-join', 'routing-outcome']) {
    const schema = JSON.parse(readFileSync(`contracts/${name}.schema.json`, 'utf8'));
    assert.equal(schema._source, 'docs/features/COMP-MODEL-ROUTE/design.md'); assert.equal(schema._roadmap, 'COMP-MODEL-ROUTE');
    assert.equal(schema.$id, `${name}.schema.json`); assert.ok(schema.$schema);
    for (const shape of schema.oneOf ?? [schema]) {
      if (shape.$ref) assert.ok(['routing-join.schema.json', 'routing-outcome.schema.json'].includes(shape.$ref));
      else assert.equal(shape.additionalProperties, false);
    }
  }
  for (const field of ['acceptance', 'cost', 'paidCall', 'usageReport']) assert.throws(() => validateRoutingRecord({ ...f.intent, [field]: true }), { code: 'ROUTING_SCHEMA_INVALID' });
});

test('Stratum-valid custom flow with omitted step out reaches routing start', t => {
  const f = fixture(t);
  const authored = {
    version: 1,
    contracts: { Result: { value: 'string' } },
    flows: { entry: 'main', main: {
      input: { task: 'string', ...transport },
      steps: [
        { id: 'work', agent: 'codex', do: 'Read the task' },
        { id: 'finish', after: ['work'], agent: 'codex', do: 'Return the result', out: 'Result' },
      ],
      output: { from: '${finish.output}', contract: 'Result' },
    } },
  };
  const validation = validateSpec(authored);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  const inputs = { task: 'Contract closure probe' };
  const roles = {};
  const effective = resolvePlanSpecValues(authored, inputs, roles);
  const originalProfiles = {};
  const preflight = preflightPipelineProfiles(originalProfiles, effective, roles, { mode: 'shadow' });
  assert.equal(preflight.ok, true);
  const start = createRoutingStart({ ...f.args, spec: authored, inputs, originalProfiles, preflight });
  assert.equal(start.contracts['main/work'].root, null);
  assert.deepEqual(start.contracts['main/work'].contracts, {});
  assert.equal(start.contracts['main/finish'].root, 'Result');
  assert.deepEqual(start.contracts['main/finish'].contracts, authored.contracts);
  assert.deepEqual(start.spec.effective, effective);
  assert.deepEqual(readRoutingStart({ cwd: f.cwd, ...start }), start);
});

for (const path of ['presets/team-fable-astra.stratum.yaml', 'pipelines/gsd.stratum.yaml']) {
  test(`actual bundled output closure reaches routing start: ${path}`, t => {
    const f = fixture(t);
    const authored = YAML.parse(readFileSync(path, 'utf8'));
    Object.assign(authored.flows[authored.flows.entry].input, transport);
    const inputs = { featureCode: 'ROUTE-TEST', description: 'Contract closure probe', gateCommands: [], pre_merge_gate: [] };
    const roles = {};
    const effective = resolvePlanSpecValues(authored, inputs, roles);
    const sidecar = path.replace('.stratum.yaml', '.profiles.json');
    const originalProfiles = existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, 'utf8')) : {};
    const preflight = preflightPipelineProfiles(originalProfiles, effective, roles, { mode: 'shadow' });
    assert.equal(preflight.ok, true);
    const start = createRoutingStart({ ...f.args, spec: authored, inputs, originalProfiles, preflight, presetId: path });
    assert.ok(Object.keys(start.contracts).length > 0);
    assert.deepEqual(readRoutingStart({ cwd: f.cwd, ...start }), start);
    assert.ok(Object.values(start.contracts).some(c => Object.keys(c.contracts).length > 0));
    assert.deepEqual(start.spec.effective, effective);
  });
}

test('multi-stage starts use fanout-level provenance for sidecar profiles and stage provenance otherwise', t => {
  const f = fixture(t);
  const multi = structuredClone(spec);
  multi.flows.main.steps = [{ id: 'wave', fanout: { dispatch: 'consumer', steps: [{ agent: 'claude' }, { agent: 'claude' }] } }];
  for (const profiles of [{}, { wave: { default: 'claude', tier_from: 'item.tier' } }]) {
    const preflight = preflightPipelineProfiles(profiles, multi);
    const start = createRoutingStart({ ...f.args, spec: multi, originalProfiles: profiles, preflight });
    for (const stage of [0, 1]) assert.deepEqual(start.staticResolutions[`main/wave/stage-${stage}`],
      preflight.staticProvenance[profiles.wave ? 'wave' : `wave/${stage}`]);
  }
});

import { acquireRoutingLock } from '../lib/routing-ledger.js';
test('project and owner lock reclamation requires a verified dead process; live or unknown owners refuse', t => {
  const f = fixture(t); const lock = join(realpathSync(f.cwd), '.test-routing-lock');
  const release = acquireRoutingLock(lock);
  assert.throws(() => acquireRoutingLock(lock, { timeoutMs: 0 }), { code: 'ROUTING_STORAGE_LOCKED' });
  release();
  // The child uses the production lock acquisition and exits without release.
  execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {acquireRoutingLock} from ${JSON.stringify(new URL('../lib/routing-ledger.js', import.meta.url).href)}; acquireRoutingLock(process.argv[1]);`, lock], { cwd: process.cwd() });
  acquireRoutingLock(lock)();
  mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: null }));
  assert.throws(() => acquireRoutingLock(lock, { timeoutMs: 0 }), { code: 'ROUTING_STORAGE_LOCKED' });
});

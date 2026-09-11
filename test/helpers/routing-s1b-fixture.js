/** S1b has no runtime hooks in D1. Drive shipped start/admission/issuance producers. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { preflightPipelineProfiles } from '../../lib/pipeline-profiles.js';
import { createRoutingStart, recordRoutingPlanIntent, recordRoutingPlanRequested, bindRoutingRun, bindRoutingCalls,
  routingReceiptDetail, routingUsageEvidence, routingGateRequest } from '../../lib/routing-ledger.js';
import { canonicalRoutingJson, routingDigest } from '../../lib/model-router.js';
import { ConsumerFanoutArtifacts } from '../../lib/consumer-fanout.js';
import { admitOrdinaryRoute, prepareRoutingIssuance, routingEvent } from '../../lib/build.js';

export function fixture(t, { cwd: suppliedCwd, start: suppliedStart, hooks = {}, off = false, observation = true, consumer = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'routing-s1b-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = suppliedCwd ?? join(root, 'project'); mkdirSync(cwd, { recursive: true });
  if (!suppliedCwd) execFileSync('git', ['init', '-q'], { cwd });
  const stateRoot = process.env.STRATUM_STATE_ROOT ?? join(root, 'flows'); mkdirSync(stateRoot, { recursive: true });
  const previousStateRoot = process.env.STRATUM_STATE_ROOT; process.env.STRATUM_STATE_ROOT = stateRoot;
  t.after(() => { if (previousStateRoot === undefined) delete process.env.STRATUM_STATE_ROOT; else process.env.STRATUM_STATE_ROOT = previousStateRoot; });
  const spec = { version: 1, contracts: { Result: { value: 'string' } }, flows: { entry: 'main', main: {
    input: { task: 'string', ...Object.fromEntries(['route_mode', 'routing_start', 'routing_root', 'routing_plan_intent', 'routing_continuation'].map(k => [k, 'string?'])) },
    steps: [{ id: 'work', agent: 'codex', out: 'Result' }] } } };
  if (consumer) {
    spec.contracts.Task = { id: 'string', description: 'string', depends_on: 'string[]' };
    spec.contracts.Graph = { tasks: 'Task[]' };
    spec.flows.main.steps[0].out = 'Graph';
    spec.flows.main.steps.push({ id: 'execute', fanout: { over: '${work.output.tasks}', dispatch: 'consumer', steps: [{ id: 'implement', agent: 'codex', out: 'Result' }] } });
  }
  const profiles = { ...(consumer ? { execute: 'codex::standard' } : {}), work: 'codex::standard' };
  const preflight = preflightPipelineProfiles(profiles, spec);
  const start = suppliedStart ?? createRoutingStart({ cwd, spec, inputs: { task: 'original work' }, originalProfiles: profiles, preflight, mode: off ? 'off' : 'shadow', presetId: 's1b-unit' });
  if (off) return { root, cwd, start };
  const input = { ...start.originalInput, route_mode: 'shadow', routing_start: canonicalRoutingJson(start), routing_root: start.rootDigest, routing_plan_intent: randomUUID() };
  const plan = recordRoutingPlanIntent({ cwd, start, input, specDigest: start.spec.effectiveDigest, featureCode: 'S1B' });
  recordRoutingPlanRequested({ cwd, start, intent: plan });
  const runId = randomUUID();
  const snapshot = { id: runId, revisionDigest: routingDigest(spec), spec, input, workspaceRoot: cwd, steps: { work: { status: 'running', epoch: 0, dispatchToken: randomUUID() } } };
  const saveSnapshot = () => writeFileSync(join(stateRoot, `${runId}.json`), JSON.stringify(snapshot)); saveSnapshot();
  const binding = bindRoutingRun({ cwd, start, intent: plan, snapshot });
  const opts = { runId, targetCwd: cwd, artifactRoot: join(root, 'artifacts'), routingObservation: observation, routingBinding: binding, revisionDigest: binding.revisionDigest, hooks };
  const reopen = () => new ConsumerFanoutArtifacts(opts);
  const artifacts = reopen();
  const context = { routing: { cwd, start, binding, artifacts, resolvedRoutes: new Map() }, artifacts };
  const capturedInputs = new Map();
  const workInput = epoch => ({ input: structuredClone(snapshot.input), scopedInput: null, stepInputs: { revision: epoch }, intent: 'produce a result' });
  const issue = ({ epoch = 0, token = randomUUID(), metadata = true } = {}) => {
    snapshot.steps.work = { status: 'running', epoch, dispatchToken: token }; saveSnapshot();
    const descriptor = { id: 'work', step: 'work', agent: 'codex', dispatchToken: token, epoch, inputs: workInput(epoch).stepInputs, do: 'produce a result' };
    const admission = admitOrdinaryRoute({ descriptor, snapshot, localSpec: spec, context });
    const issuance = prepareRoutingIssuance({ descriptor, admission, context });
    if (metadata) artifacts.prepareRoutingMetadata(issuance.id);
    capturedInputs.set(issuance.id, workInput(epoch));
    return issuance;
  };
  const launch = issuance => routingEvent(context, issuance, 'launch-intent');
  const settle = (issuance, status = 'succeeded') => {
    routingEvent(context, issuance, 'settled', { evidence: Object.fromEntries([...['runId', 'revisionDigest', 'scopedStep', 'epoch', 'itemIndex', 'generation', 'issuanceToken'].map(k => [k, issuance[k]]), ['acceptedDispatchToken', issuance.issuanceToken], ['status', status]]) });
  };
  const observer = issuance => bindRoutingCalls({ artifacts, issuanceId: issuance.id });
  return { root, cwd, spec, start, binding, artifacts, context, snapshot, saveSnapshot, workInput, capturedInputs, issue, launch, settle, observer, reopen, opts,
    bytes: () => readFileSync(artifacts.journalPath, 'utf8') };
}
export function beginCall(f, issuance, { callId = randomUUID(), transport = 'mcp', observer = f.observer(issuance), callSite = 'primary' } = {}) {
  const resolution = issuance.selected.resolution;
  const intent = observer.intent({ callSite, callId, transport, profileIntent: { provider: resolution.provider, model: resolution.modelID, effort: resolution.effort } });
  return { observer, intent };
}
export function finishCall(f, call, { usd = 0.12, tokens = 23, durationMs = 17, unresolved = false, errored = false, receipt = true } = {}) {
  const { observer, intent } = call;
  const raw = unresolved ? {} : { tokens, durationMs, usd, model: intent.profileIntent.model, effort: intent.transport === 'local-sdk' ? null : intent.profileIntent.effort };
  const usage = routingUsageEvidence(raw, { provenance: unresolved ? null : 'reported' });
  const routing = f.artifacts.exportRoutingJournal(); const owner = routing.records[intent.issuanceId ?? intent.observationId];
  const payload = receipt && !unresolved && intent.callId ? { dispatchId: intent.callId, stepId: owner.scopedStep, source: 'agent', usage: { tokens, ms: durationMs, usd }, usdSource: 'reported', detail: { routing: routingReceiptDetail(routing, owner, intent) } } : null;
  const evidence = { outcome: unresolved ? 'unresolved' : errored ? 'errored' : 'resolved', launchOutcome: unresolved ? 'uncertain' : 'executed', usage,
    terminationEvidence: { kind: unresolved ? 'uncertain' : 'return', intentId: intent.id, callId: intent.callId, evidence: unresolved ? null : { returned: true } } };
  return observer.resolve(intent.id, evidence, payload);
}
export function acknowledgeAll(f) {
  for (const pending of f.artifacts.pendingRoutingReceipts()) f.artifacts.acknowledgeUsageReceipt({ dispatchId: pending.dispatchId, payloadDigest: routingDigest(pending.receipt) });
}
export function evidenceRecord(f, type, fields) {
  const record = { schemaVersion: 1, startId: f.start.startId, rootDigest: f.start.rootDigest, type, ...fields };
  return { ...record, id: routingDigest(record) };
}
// Explicit protocol inputs for primitives with no D1 runtime producer. Every
// admission, issuance, epoch binding and route comes from the S1a producer above.
export function gateEvidence(f, issuances, { relation = 'retained', proposals = [], defective = relation === 'repaired', reconciliation = 'token-response', partitionCheck = 'valid', priorSnapshotIds = [], gateOrdinal = 0, gateToken = randomUUID() } = {}) {
  const routing = f.artifacts.exportRoutingJournal();
  const snapshot = evidenceRecord(f, 'wave-snapshot', { runId: f.binding.runId, revisionDigest: f.binding.revisionDigest, gateStepId: 'assess_gate', gateToken,
    capturedAt: '2026-09-11T00:00:00.000Z', resetTarget: 'work', resetClosure: ['work'], sourceRefs: [], waves: [], priorSnapshotIds,
    ordinaryIssuances: issuances.map(issuance => ({ runId: issuance.runId, scopedStep: issuance.scopedStep, epoch: issuance.epoch,
      epochBindingId: Object.values(routing.records).find(r => r.type === 'epoch-binding' && r.admissionIds.includes(issuance.admissionId)).id,
      logicalTaskId: null, fullItem: f.capturedInputs.get(issuance.id),
      itemDigest: routingDigest(f.capturedInputs.get(issuance.id)), itemIndex: null, generation: null, stage: null,
      status: 'succeeded', admissionId: issuance.admissionId, issuanceId: issuance.id, issuanceToken: issuance.issuanceToken,
      acceptedDispatchToken: issuance.issuanceToken, chosenTier: issuance.selected.resolution.tier,
      executedTier: { value: null, source: 'not-captured', evidenceRefs: [] }, priorSnapshotId: null })) });
  f.artifacts.recordRoutingRecord(snapshot);
  const decision = { decision: relation === 'retained' ? 'approve' : 'revise', rationale: 'retained protocol evidence', resolver: 'test-authority' };
  const dispositionId = randomUUID();
  const disposition = { ...evidenceRecord(f, 'gate-disposition', { snapshotId: snapshot.id, runId: f.binding.runId, gateStepId: snapshot.gateStepId, gateToken,
    gateOrdinal, requestedDecision: decision, finalProposedDecision: decision, findingsRef: null,
    dispositions: issuances.map(i => ({ issuanceId: i.id, relation, defective })), partitionCheck, ownershipCheck: 'valid', lineage: proposals.map(p => ({
      dispositionId, relation: p.relation ?? relation, fromSnapshotId: p.from ? snapshot.id : null,
      fromAdmissionId: p.from?.admissionId ?? null, fromIssuanceId: p.from?.id ?? null, proposedTaskDigest: routingDigest(p.fullItem),
      toSnapshotId: null, toAdmissionId: null, toIssuanceId: null,
    })) }), id: dispositionId };
  f.artifacts.recordRoutingRecord(disposition);
  const request = routingGateRequest(f.artifacts.exportRoutingJournal(), disposition);
  const ack = evidenceRecord(f, 'gate-acknowledgement', { dispositionId: disposition.id, requestDigest: routingDigest(request), reconciliation,
    witness: reconciliation.startsWith('token-') ? { request, response: { status: 'acknowledged', result: { advanced: true } }, engineEvidence: reconciliation === 'token-engine-witness' ? (() => { const { gateToken, ...rest } = request; return { ...rest, consumedGateToken: gateToken }; })() : null } : null,
    acknowledgedAt: '2026-09-11T00:00:01.000Z' });
  f.artifacts.recordRoutingRecord(ack);
  return { snapshot, disposition, ack };
}
export function linkRepair(f, previous, next, fromGate, toGate, relation = 'repaired') {
  const target = toGate.snapshot.ordinaryIssuances.find(i => i.issuanceId === next.id);
  const link = evidenceRecord(f, 'lineage-link', { dispositionId: fromGate.disposition.id, relation, fromSnapshotId: fromGate.snapshot.id,
    fromAdmissionId: previous.admissionId, fromIssuanceId: previous.id, proposedTaskDigest: target.itemDigest,
    toSnapshotId: toGate.snapshot.id, toAdmissionId: next.admissionId, toIssuanceId: next.id });
  return f.artifacts.recordRoutingRecord(link);
}

export async function consumerWave(f, tasks, epoch = 0) {
  const { admitConsumerWave, sealRoutingEpochs } = await import('../../lib/build.js');
  const graph = { tasks };
  f.snapshot.steps.work = { status: 'succeeded', epoch, acceptedDispatchToken: `source-result-${epoch}`, output: graph };
  const descriptors = tasks.map((item, itemIndex) => ({ id: `execute/${itemIndex}`, step: 'execute', item, itemIndex, stage: 0, generation: 0, epoch, policy: { isolation: 'none' }, dispatchToken: randomUUID() }));
  f.snapshot.steps.execute = { status: 'running', epoch, fanout: { items: descriptors.map(d => ({ index: d.itemIndex, stage: 0, epoch, generation: 0, status: 'running', dispatchToken: d.dispatchToken })) } };
  f.saveSnapshot();
  await admitConsumerWave({ descriptor: descriptors[0], descriptors, audit: f.snapshot, localSpec: f.spec, profiles: f.start.mergedProfiles,
    artifacts: f.artifacts, flowId: f.binding.runId, routing: f.context.routing });
  const issuances = descriptors.map(d => f.artifacts.readRoutingRecord(f.artifacts.exportRoutingJournal().tokenIndex[d.dispatchToken]));
  return { graph, descriptors, issuances, seal() { sealRoutingEpochs(f.context.routing); } };
}
export async function continueRoutingFixture(f, wave) {
  const { createContinuationIntent } = await import('../../lib/routing-ledger.js');
  wave.seal();
  const prior = f.artifacts.exportRoutingJournal();
  const continuation = createContinuationIntent({ start: f.start, oldBinding: f.binding,
    resumeDetails: { previousRunId: f.binding.runId, originalGraph: wave.graph, graph: wave.graph, completedTaskIds: [], verifiedCompletedTaskIds: [] },
    priorJournal: { routing: prior }, snapshot: f.snapshot });
  f.artifacts.recordRoutingRecord(continuation);
  const input = { ...f.snapshot.input, routing_plan_intent: randomUUID(), routing_continuation: continuation.id };
  const plan = recordRoutingPlanIntent({ cwd: f.cwd, start: f.start, input, specDigest: f.start.spec.effectiveDigest, featureCode: 'S1B', previousRunId: f.binding.runId, continuation });
  recordRoutingPlanRequested({ cwd: f.cwd, start: f.start, intent: plan });
  const snapshot = { ...f.snapshot, id: randomUUID(), input };
  const binding = bindRoutingRun({ cwd: f.cwd, start: f.start, intent: plan, snapshot });
  const opts = { ...f.opts, runId: binding.runId, routingBinding: binding, routingAncestry: f.artifacts.exportRoutingJournal() };
  return { binding, artifacts: new ConsumerFanoutArtifacts(opts), opts };
}

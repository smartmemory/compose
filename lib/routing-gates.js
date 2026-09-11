/** Pre-reset capture adapters shared by Build and GSD. */
import { routingArtifactsFor, routingRecord, recoverRoutingEvidence } from './routing-runtime.js';
import { routingDigest, routingRefuse } from './model-router.js';
import { routingExecutedTier, latestRoutingCall, routingGateRequest } from './routing-ledger.js';
import { readRoutingSnapshot } from './flow-state.js';
import { observeRoutingDecision } from './output-gate.js';
import { normalizeOwnedPath } from './pipeline-profiles.js';
const all = artifacts => Object.values(artifacts.exportRoutingJournal().records);
const itemsOf = snapshot => [...snapshot.ordinaryIssuances, ...snapshot.waves.flatMap(w => w.items)];
function dependencies(step) {
  const result = new Set(step.after ?? []);
  const walk = value => {
    if (typeof value === 'string') for (const match of value.matchAll(/\$\{([\w-]+)\.(?:output|failure|status)(?:[.}])/g)) result.add(match[1]);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(step); return [...result];
}
export function routingResetClosure(steps, gate) {
  const target = gate?.gate?.on_revise ?? null;
  const closure = new Set(target ? [target] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) if (!closure.has(step.id) && (dependencies(step).some(id => closure.has(id))
      || steps.some(r => closure.has(r.id) && [r.on_fail, r.gate?.on_approve, r.gate?.on_kill].includes(step.id)))) { closure.add(step.id); changed = true; }
  }
  const selected = new Set(closure);
  if (!target) {
    const visit = id => { if (selected.has(id)) return; selected.add(id); const step = steps.find(s => s.id === id); if (step) dependencies(step).forEach(visit); };
    dependencies(gate ?? {}).forEach(visit);
  }
  return { target, closure: [...closure], selected };
}
export async function captureRoutingGate(context, { gateStepId, gateToken, localSpec }) {
  const artifacts = routingArtifactsFor(context); if (!artifacts) return null;
  await recoverRoutingEvidence(context);
  const pin = artifacts.exportRoutingJournal();
  const snapshot = readRoutingSnapshot(artifacts.runId, { revisionDigest: pin.runBinding.revisionDigest, rootDigest: pin.rootDigest });
  const expanded = { ...snapshot.steps };
  const visit = (steps, prefix = '') => { for (const [id, state] of Object.entries(steps)) { expanded[`${prefix}${id}`] = state; if (state.sub?.steps) visit(state.sub.steps, `${prefix}${id}/`); } };
  visit(snapshot.steps); snapshot.steps = expanded;
  const state = snapshot.steps[gateStepId];
  if (state?.gateToken !== gateToken || state.status !== 'waiting_gate') routingRefuse('ROUTING_BINDING_DRIFT', 'Pre-reset gate token differs');
  const existing = all(artifacts).find(r => r.type === 'wave-snapshot' && r.runId === artifacts.runId && r.gateToken === gateToken && r.gateStepId === gateStepId);
  if (existing) return existing;
  const spec = context.routing.start.spec.effective;
  const steps = spec.flows[spec.flows.entry].steps;
  const gate = steps.find(s => s.id === gateStepId);
  const selection = routingResetClosure(steps, gate);
  const retained = all(artifacts);
  const prior = retained.filter(r => r.type === 'wave-snapshot' && r.gateStepId === gateStepId);
  const admissions = retained.filter(r => r.type === 'admission' && selection.selected.has(r.scopedStep.split('/')[0]));
  const waves = [], ordinaryIssuances = [];
  const groups = new Map();
  for (const admission of admissions) {
    const key = JSON.stringify([admission.runId, admission.scopedStep, admission.stage, admission.epoch]);
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(admission);
  }
  for (const group of groups.values()) {
    const first = group[0];
    const historical = first.runId !== artifacts.runId || (snapshot.steps[first.scopedStep]?.epoch ?? 0) !== first.epoch;
    if (historical) continue; // Retained below from immutable snapshots, never reconstructed from a new index.
    const issued = retained.filter(r => r.type === 'issuance' && r.runId === artifacts.runId && r.scopedStep === first.scopedStep && r.epoch === first.epoch);
    let epoch = retained.find(r => r.type === 'epoch-binding' && r.runId === artifacts.runId && r.scopedStep === first.scopedStep && r.stage === first.stage && r.epoch === first.epoch);
    if (!epoch) {
      // Capture identity is explicitly distinct from the safety seal. A partial
      // wave does not become continuation-safe merely because it was observed.
      const fields = { runId: first.runId, scopedStep: first.scopedStep, stage: first.stage, epoch: first.epoch,
        logicalWaveId: first.logicalWaveId, logicalEpoch: first.logicalEpoch, logicalTaskId: null, priorEpochBindingId: null,
        admissionIds: group.map(a => a.id).sort(), issuanceIds: issued.map(i => i.id).sort(),
        sourceBinding: first.inputProvenance.routingSource ?? null, graph: first.inputProvenance.routingGraph ?? null,
        graphDigest: first.inputProvenance.routingGraph ? routingDigest(first.inputProvenance.routingGraph) : null };
      epoch = artifacts.recordRoutingRecord({ schemaVersion: 1, startId: pin.startId, rootDigest: pin.rootDigest, type: 'epoch-binding',
        id: `capture_${routingDigest({ gateToken, ...fields })}`, ...fields });
    }
    const items = group.map(admission => {
      const current = snapshot.steps[admission.scopedStep];
      const state = admission.stage === null ? current : current?.fanout?.items?.[admission.itemIndex];
      const candidates = issued.filter(i => i.admissionId === admission.id);
      const issuance = candidates.find(i => i.issuanceToken === state?.acceptedDispatchToken || i.issuanceToken === state?.dispatchToken)
        ?? candidates.find(i => !candidates.some(next => next.priorRecordId === i.id));
      const binding = issuance ? artifacts.journal.dispatchBindings?.[issuance.issuanceToken]?.itemBinding : null;
      const fullItem = admission.stage === null ? admission.inputProvenance.fullInput
        : binding?.item ?? admission.inputProvenance.routingItems?.[admission.itemIndex] ?? admission.inputProvenance.routingGraph?.tasks?.[admission.itemIndex];
      if (fullItem === undefined) routingRefuse('ROUTING_BINDING_MISSING', 'Pre-reset full admitted input unavailable');
      const intent = retained.find(r => r.type === 'call-intent' && r.issuanceId === issuance?.id && r.purpose === 'primary');
      const executedTier = intent ? routingExecutedTier(context.routing.start, intent, latestRoutingCall(artifacts.exportRoutingJournal(), intent.id).resolution)
        : { value: null, source: 'missing-primary-execution', evidenceRefs: [] };
      const item = { logicalTaskId: admission.logicalTaskId, fullItem, itemDigest: routingDigest(fullItem), itemIndex: issuance?.itemIndex ?? admission.itemIndex,
        generation: issuance?.generation ?? admission.generation, stage: admission.stage, status: state?.status ?? 'unknown', admissionId: admission.id,
        issuanceId: issuance?.id ?? null, issuanceToken: issuance?.issuanceToken ?? null, acceptedDispatchToken: state?.acceptedDispatchToken ?? null,
        chosenTier: issuance?.selected.resolution.tier ?? null, executedTier, priorSnapshotId: null };
      return admission.stage === null ? { ...item, runId: first.runId, scopedStep: first.scopedStep, epoch: first.epoch, epochBindingId: epoch.id } : item;
    });
    if (first.stage === null) ordinaryIssuances.push(...items);
    else waves.push({ runId: first.runId, scopedStep: first.scopedStep, stage: first.stage, epoch: first.epoch, logicalWaveId: first.logicalWaveId,
      logicalEpoch: first.logicalEpoch, epochBindingId: epoch.id, sourceRef: group[0].id, items });
  }
  // Keep old tasks absent from today's wave. Their original issuance is the key.
  const seen = new Set([...ordinaryIssuances, ...waves.flatMap(w => w.items)].map(i => i.issuanceId).filter(Boolean));
  for (const old of [...prior].reverse()) {
    for (const item of old.ordinaryIssuances) if (!seen.has(item.issuanceId)) { ordinaryIssuances.push({ ...item, priorSnapshotId: old.id }); seen.add(item.issuanceId); }
    for (const wave of old.waves) {
      const items = wave.items.filter(i => i.issuanceId && !seen.has(i.issuanceId)).map(i => { seen.add(i.issuanceId); return { ...i, priorSnapshotId: old.id }; });
      if (items.length) waves.push({ ...wave, items });
    }
  }
  const captured = routingRecord(artifacts, 'wave-snapshot', { runId: artifacts.runId, revisionDigest: snapshot.revisionDigest, gateStepId, gateToken,
    capturedAt: new Date().toISOString(), resetTarget: selection.target, resetClosure: selection.closure, sourceRefs: admissions.map(a => a.id),
    waves, ordinaryIssuances, priorSnapshotIds: prior.map(p => p.id) }, { runId: artifacts.runId, gateStepId, gateToken });
  // A later immutable capture can complete a previously retained proposal.
  for (const disposition of retained.filter(r => r.type === 'gate-disposition')) for (const link of disposition.lineage) {
    if (link.toIssuanceId || retained.some(r => r.type === 'lineage-link' && r.toIssuanceId
      && r.dispositionId === link.dispositionId && r.fromIssuanceId === link.fromIssuanceId
      && r.proposedTaskDigest === link.proposedTaskDigest)) continue;
    const from = retained.find(r => r.id === link.fromIssuanceId);
    const targets = itemsOf(captured).filter(i => i.itemDigest === link.proposedTaskDigest && i.issuanceId
      && i.issuanceId !== link.fromIssuanceId && !i.priorSnapshotId
      && (!from || retained.find(r => r.id === i.issuanceId)?.scopedStep === from.scopedStep));
    if (targets.length === 1) routingRecord(artifacts, 'lineage-link', { ...link, toSnapshotId: captured.id, toAdmissionId: targets[0].admissionId, toIssuanceId: targets[0].issuanceId });
  }
  return captured;
}
export function prepareRoutingGate(context, captured, { requestedDecision, finalProposedDecision, audit, mergeEvidence = null, mergeGate = false }) {
  if (!captured) return null;
  const artifacts = routingArtifactsFor(context);
  const config = context.pipelineProfiles?.[captured.gateStepId];
  const source = config?.decide_from?.step;
  const decision = source ? audit.steps?.[source]?.output : null;
  const reviewStep = config?.validators?.[0]?.review_step;
  const review = reviewStep ? audit.steps?.[reviewStep]?.output : null;
  // A merge checkpoint proves artifact integration, not downstream review.
  // Capture it (including flips) without granting acceptance on a plain merge.
  // Retire only files actually assumed by a completed, acknowledged successor.
  // B0 {b,c} -> B1 {b} leaves B0 owning c, while another repair of b follows B1.
  // This is an observation-only projection; immutable snapshots keep full tasks.
  const retained = all(artifacts);
  const items = itemsOf(captured);
  const retiredFiles = new Map();
  for (const link of retained.filter(r => r.type === 'lineage-link' && r.fromIssuanceId && r.toIssuanceId
    && ['repaired', 're-implemented'].includes(r.relation)
    && retained.some(d => d.id === r.dispositionId && d.partitionCheck === 'valid' && d.ownershipCheck === 'valid')
    && retained.some(ack => ack.type === 'gate-acknowledgement' && ack.dispositionId === r.dispositionId
      && ack.reconciliation.startsWith('token-')))) {
    const target = items.find(i => i.issuanceId === link.toIssuanceId);
    let files;
    try { files = (target?.fullItem?.files_owned ?? []).map(normalizeOwnedPath); }
    catch { continue; } // Invalid ownership cannot retire evidence; the observer refuses it.
    const retired = retiredFiles.get(link.fromIssuanceId) ?? new Set();
    files.forEach(file => retired.add(file));
    retiredFiles.set(link.fromIssuanceId, retired);
  }
  const activeItems = items.flatMap(item => {
    const retired = retiredFiles.get(item.issuanceId);
    const owned = item.fullItem?.files_owned;
    if (!retired?.size || !Array.isArray(owned) || !owned.length) return [item];
    let remaining;
    try { remaining = owned.filter(file => !retired.has(normalizeOwnedPath(file))); }
    catch { return [item]; }
    return remaining.length ? [{ ...item, fullItem: { ...item.fullItem, files_owned: remaining } }] : [];
  });
  const observation = mergeGate && !decision && finalProposedDecision.decision === 'approve'
    ? { partitionCheck: 'valid', ownershipCheck: 'valid', dispositions: [], proposals: [] }
    : observeRoutingDecision({ decision, review, items: activeItems, finalDecision: finalProposedDecision.decision });
  const gateOrdinal = (audit.events ?? []).filter(e => e.type === 'gate_resolved' && e.stepId === captured.gateStepId).length;
  const id = routingDigest({ type: 'gate-disposition', snapshotId: captured.id, requestedDecision, finalProposedDecision });
  // Retain the full decision/review as part of the final request's observational
  // evidence. The RPC itself still receives only decision/rationale/resolver.
  const lineage = observation.proposals.map(p => ({ dispositionId: id, relation: p.relation, fromSnapshotId: p.from ? captured.id : null,
    fromAdmissionId: p.from?.admissionId ?? null, fromIssuanceId: p.from?.issuanceId ?? null, proposedTaskDigest: routingDigest(p.task),
    toSnapshotId: null, toAdmissionId: null, toIssuanceId: null }));
  const merge = mergeEvidence ? { gateToken: mergeEvidence.gateToken ?? null, state: mergeEvidence.state ?? null,
    baselineTree: mergeEvidence.baselineTree ?? null, failureCode: mergeEvidence.failureCode ?? null, failure: mergeEvidence.failure ?? null } : null;
  const graph = { decision: decision ?? null, review: review ?? null, mergeEvidence: merge, rounds: audit.rounds ?? 0,
    source: source ? { step: source, state: audit.steps?.[source] ?? null } : null,
    reviewSource: reviewStep ? { step: reviewStep, state: audit.steps?.[reviewStep] ?? null } : null };
  const findings = routingRecord(artifacts, 'epoch-binding', { runId: captured.runId, scopedStep: captured.gateStepId, stage: null,
    epoch: audit.steps?.[captured.gateStepId]?.epoch ?? 0, logicalWaveId: routingDigest({ gateStepId: captured.gateStepId, runId: captured.runId }),
    logicalEpoch: audit.steps?.[captured.gateStepId]?.epoch ?? 0, logicalTaskId: null, priorEpochBindingId: null,
    admissionIds: [], issuanceIds: [], sourceBinding: null, graph, graphDigest: routingDigest(graph) }, { dispositionId: id, evidence: graph });
  const fields = { snapshotId: captured.id, runId: captured.runId, gateStepId: captured.gateStepId, gateToken: captured.gateToken,
    gateOrdinal, requestedDecision, finalProposedDecision, findingsRef: findings.id, dispositions: observation.dispositions,
    partitionCheck: observation.partitionCheck, ownershipCheck: observation.ownershipCheck, lineage };
  return artifacts.recordRoutingRecord({ schemaVersion: 1, startId: captured.startId, rootDigest: captured.rootDigest, type: 'gate-disposition', id, ...fields });
}
export function acknowledgeRoutingGate(context, disposition, response, audit = null) {
  if (!disposition) return;
  const artifacts = routingArtifactsFor(context), pin = artifacts.exportRoutingJournal();
  const request = routingGateRequest(pin, disposition);
  const event = audit?.events?.filter(e => e.type === 'gate_resolved' && e.stepId === disposition.gateStepId)[disposition.gateOrdinal];
  if (event && event.detail?.decision !== disposition.finalProposedDecision.decision) routingRefuse('ROUTING_BINDING_DRIFT', 'Recovered gate decision conflicts with prepared request');
  let engineEvidence = null, engineWitness = null;
  const captured = pin.records[disposition.snapshotId];
  const findingEvidence = pin.records[disposition.findingsRef]?.graph;
  if (!response && event && disposition.finalProposedDecision.decision === 'revise') {
    // Read the persisted authority; an ordinal event or prepared transaction alone
    // cannot supply the consumed token. Carry provenance can, when its round and
    // reset transition agree with the retained pre-reset source.
    const state = readRoutingSnapshot(disposition.runId, { revisionDigest: captured.revisionDigest, rootDigest: pin.rootDigest });
    const carries = Object.values(state.carry ?? {}).filter(c => c.provenance?.kind === 'revise'
      && c.provenance.gate === disposition.gateStepId && c.provenance.gateToken === disposition.gateToken
      && c.provenance.round === (findingEvidence?.rounds ?? -1) + 1);
    const expectedEpochs = new Map();
    for (const x of [...captured.waves, ...captured.ordinaryIssuances].filter(x => x.runId === captured.runId)) {
      expectedEpochs.set(x.scopedStep, Math.max(expectedEpochs.get(x.scopedStep) ?? 0, x.epoch));
    }
    const resets = (state.events ?? []).filter(e => e.type === 'step_reset' && e.stepId === captured.resetTarget);
    const reset = resets.find(e => captured.resetClosure.every(id => e.detail?.reset?.some(r => r.stepId === id
      && r.toEpoch === r.fromEpoch + 1 && (!expectedEpochs.has(id) || expectedEpochs.get(id) === r.fromEpoch))));
    if (carries.length && reset && findingEvidence?.decision && carries.some(c => routingDigest(c.value) === routingDigest(findingEvidence.decision.tasks))) {
      const { gateToken, ...rest } = request;
      engineEvidence = { ...rest, consumedGateToken: gateToken };
      engineWitness = { kind: 'persisted-engine-witness', gateEvent: event, resetEvent: reset, carry: carries, runId: state.id, revisionDigest: state.revisionDigest };
    }
  }
  const reconciliation = response ? 'token-response' : engineEvidence ? 'token-engine-witness' : event ? 'ordinal' : 'unconfirmed';
  const existing = all(artifacts).find(r => r.type === 'gate-acknowledgement' && r.dispositionId === disposition.id && r.reconciliation === reconciliation);
  if (existing) return existing;
  const witness = response || engineEvidence ? { request, response: response ? { status: 'acknowledged', result: response } : engineWitness, engineEvidence } : null;
  return routingRecord(artifacts, 'gate-acknowledgement', { dispositionId: disposition.id, requestDigest: routingDigest(request), witness, reconciliation,
    acknowledgedAt: new Date().toISOString() }, { dispositionId: disposition.id, reconciliation });
}

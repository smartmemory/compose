/** Runtime adapters for S1b. Connectors alone own call intent and resolution. */
import { bindRoutingCalls, routingUsageEvidence, routingReceiptDetail, flushRoutingReceipts,
  readRoutingOwners, materializeRoutingLedger, latestRoutingCall, routingIssuanceState } from './routing-ledger.js';
import { routingDigest, routingRefuse } from './model-router.js';
import { readRoutingSnapshot } from './flow-state.js';

export const routingIntegrityError = error => Boolean((typeof error?.code === 'string' && error.code.startsWith('ROUTING_')) || error?.code === 'CONSUMER_EVIDENCE_MISMATCH');
const copy = value => structuredClone(value);
// Late returns may arrive after an uncertain teardown has already reached its caller.
// Recovery joins only writes that have actually begun, never a still-running model.
const lateWrites = new Map();
const records = artifacts => Object.values(artifacts.exportRoutingJournal().records);
export function routingArtifactsFor(context) {
  const participating = context?.routing || context?.routingCalls || context?.artifacts?.journal?.routing
    || context?.input?.routing_root || context?.inputs?.routing_root;
  if (!participating) return null;
  const artifacts = context.routing?.artifacts ?? context.artifacts;
  if (!artifacts?.exportRoutingJournal || !artifacts.journal?.routing) routingRefuse('ROUTING_BINDING_MISSING', 'Participating runtime requires its original journal');
  if (context.artifacts && !context.artifacts.journal?.routing) routingRefuse('ROUTING_BINDING_MISSING', 'Participating adapter requires the original journal');
  if (context.artifacts?.journalPath && context.artifacts.journalPath !== artifacts.journalPath) routingRefuse('ROUTING_BINDING_DRIFT', 'Adapter journal differs from routing owner');
  artifacts.exportRoutingJournal();
  return artifacts;
}
export async function deliverRoutingReceipt(context, runId, receipt) {
  if (typeof context.stratum?.usageReport !== 'function') throw new Error('Receipt delivery unavailable');
  let ack;
  try { ack = await context.stratum.usageReport(runId, receipt); } catch (error) {
    if (routingIntegrityError(error)) throw error;
    // JSON-RPC errors have numeric codes; the D1 delivery callback takes a transport Error.
    throw new Error(error.message, { cause: error });
  }
  return { status: ['ok', 'accepted', 'recorded'].includes(ack?.status) ? 'recorded'
    : ['duplicate', 'already_recorded', 'already-recorded'].includes(ack?.status) ? 'already_recorded' : ack?.status,
  ...(ack?.receipt?.seq !== undefined || ack?.seq !== undefined ? { seq: ack.receipt?.seq ?? ack.seq } : {}) };
}
export async function flushObservedReceipts(context, requiredDispatchId = null, artifacts = routingArtifactsFor(context)) {
  if (!artifacts) return;
  await flushRoutingReceipts({ artifacts, requiredDispatchId, deliver: (runId, receipt) => deliverRoutingReceipt(context, runId, receipt) });
}
function guardedWrite(fn) {
  try { return fn(); } catch (error) {
    if (!routingIntegrityError(error)) error.code = 'ROUTING_PERSISTENCE_FAILED';
    throw error;
  }
}
function rawUsage(value, localCapture) {
  if (localCapture) {
    const c = localCapture;
    return routingUsageEvidence({ tokens: c.inputTokens !== null && c.outputTokens !== null ? c.inputTokens + c.outputTokens : null,
      durationMs: c.durationMs, usd: c.costUsd, model: c.model, effort: null }, { provenance: c.costUsd === null ? null : 'reported' });
  }
  const u = value?.usage ?? {}, t = value?.telemetry ?? {};
  const provenance = value?.usdSource ?? u.usd_source ?? u.usdSource;
  return routingUsageEvidence({ tokens: u.tokens ?? (u.input_tokens != null && u.output_tokens != null ? u.input_tokens + u.output_tokens : null),
    durationMs: u.ms ?? u.duration_ms ?? t.durationMs ?? null, usd: u.usd ?? u.cost_usd ?? null,
    model: t.model ?? u.model ?? null, effort: t.effort ?? u.effort ?? null },
  { provenance: ['reported', 'estimated'].includes(provenance) ? provenance : null });
}
function paidReceipt(artifacts, intent, usage, split) {
  if (!intent.callId) return null;
  const routing = artifacts.exportRoutingJournal();
  const owner = routing.records[intent.issuanceId ?? intent.observationId];
  const amount = {};
  for (const [key, field] of [['tokens', 'tokens'], ['ms', 'durationMs'], ['usd', 'usd']]) {
    if (usage[field] !== null) amount[key] = usage[field];
  }
  const telemetry = {};
  if (usage.model !== null) telemetry.model = usage.model;
  if (usage.effort !== null) telemetry.effort = usage.effort;
  if (usage.durationMs !== null) telemetry.durationMs = usage.durationMs;
  return { dispatchId: intent.callId, ...(owner.scopedStep ? { stepId: owner.scopedStep } : {}), source: 'agent', usage: amount,
    ...(usage.model !== null && usage.durationMs !== null ? { telemetry } : {}), ...(Object.hasOwn(amount, 'usd') && usage.provenance ? { usdSource: usage.provenance } : {}),
    ...(split ? { split: copy(split) } : {}), detail: { routing: routingReceiptDetail(routing, owner, intent) } };
}
function runtimeObserver(context, observer, callSite, purpose) {
  const artifacts = routingArtifactsFor(context);
  let lastIntent = null;
  return Object.freeze({ binding: observer.binding,
    begin({ callId, transport, provider, model, effort }) {
      lastIntent = guardedWrite(() => observer.intent({ callSite, purpose, callId, transport,
        profileIntent: { provider, model: model ?? null, effort: effort ?? null } }));
      return lastIntent;
    },
    async finish(intent, { value, failed = false, launched = true, returned = true, termination = null, localCapture }) {
      const usage = rawUsage(value, localCapture);
      const uncertain = !returned && !termination;
      const hasEvidence = ['tokens', 'durationMs', 'usd', 'model', 'effort'].some(k => usage.presence[k]);
      const launchOutcome = !launched ? 'not-executed' : !failed || hasEvidence ? 'executed' : 'uncertain';
      const split = localCapture && localCapture.inputTokens !== null && localCapture.outputTokens !== null
        ? { input: localCapture.inputTokens, output: localCapture.outputTokens } : value?.split;
      const receipt = launchOutcome === 'not-executed' || uncertain && !hasEvidence ? null : paidReceipt(artifacts, intent, usage, split);
      const result = guardedWrite(() => observer.resolve(intent.id, {
        outcome: uncertain ? 'unresolved' : failed ? 'errored' : 'resolved', launchOutcome, usage,
        terminationEvidence: { kind: uncertain ? 'uncertain' : termination ? 'acknowledged-termination' : 'return',
          intentId: intent.id, callId: intent.callId, evidence: uncertain ? null : termination ?? { returned: true, failed } },
        incompleteReasons: uncertain ? ['transport-termination-unconfirmed'] : [],
      }, receipt));
      await flushObservedReceipts(context, null, artifacts);
      return result;
    },
    observeLate(intent, outcome, returned) {
      outcome.then(settled => {
        if (!returned() || ['CANCELLATION_UNCONFIRMED', 'CANCELLATION_TEARDOWN_TIMEOUT'].includes(settled.error?.code)) return; // A dead transport is not a model return.
        const state = lateWrites.get(artifacts.journalPath) ?? { pending: new Set(), error: null };
        lateWrites.set(artifacts.journalPath, state);
        const write = this.finish(intent, { value: settled.error ?? settled.value, failed: Boolean(settled.error), returned: true })
          .catch(error => { state.error ??= error; }).finally(() => state.pending.delete(write));
        state.pending.add(write);
      });
    },
    terminated() { return routingCallsTerminated(context, { id: observer.binding.recordId }); },
    child(unsupportedReason = 'normalization-repair') {
      if (!lastIntent) routingRefuse('ROUTING_BINDING_MISSING', 'Child dispatch has no connector-owned parent intent');
      const child = guardedWrite(() => observer.child({ parentIntentId: lastIntent.id, unsupportedReason, callSite: `${callSite}/${unsupportedReason}` }));
      return runtimeObserver(context, child, `${callSite}/${unsupportedReason}`, unsupportedReason === 'normalization-repair' ? 'normalization-repair' : 'auxiliary');
    },
  });
}
export function callsForRouting(context, issuance = null, unsupportedReason = null, descriptor = {}) {
  const artifacts = routingArtifactsFor(context);
  if (!artifacts) return null;
  let callSite = `${descriptor.id ?? issuance?.scopedStep ?? 'run'}/${descriptor.stage ?? 'ordinary'}/${unsupportedReason ?? 'primary'}`;
  if (unsupportedReason || !issuance) {
    const prior = records(artifacts).filter(r => r.type === 'unsupported-observation' && r.evidenceSource === 'connector'
      && r.unsupportedReason === (unsupportedReason ?? 'multi-stage-consumer') && r.parentRecordId === (issuance?.id ?? null)
      && r.scopedStep === (descriptor.step ?? descriptor.id ?? issuance?.scopedStep ?? null)
      && r.stage === (descriptor.stage ?? issuance?.stage ?? null) && r.epoch === (descriptor.epoch ?? issuance?.epoch ?? null)
      && r.itemIndex === (descriptor.itemIndex ?? null) && r.generation === (descriptor.generation ?? null)
      && r.observedDispatchToken === (descriptor.dispatchToken ?? null));
    const pin = artifacts.exportRoutingJournal();
    if (Object.values(pin.records).some(r => r.type === 'call-intent' && prior.some(o => o.id === r.observationId)
      && (!latestRoutingCall(pin, r.id).resolution || latestRoutingCall(pin, r.id).resolution.outcome === 'unresolved'))) {
      routingRefuse('ROUTING_ISSUANCE_UNCERTAIN', 'Prior auxiliary invocation has no confirmed completion');
    }
    const slot = prior.length;
    callSite += `/${slot}`;
  }
  if (unsupportedReason || !issuance) {
    const observation = guardedWrite(() => artifacts.recordRoutingObservation({ unsupportedReason: unsupportedReason ?? 'multi-stage-consumer', callSite,
      parentRecordId: issuance?.id ?? null, context: { ...issuance, scopedStep: descriptor.step ?? descriptor.id ?? issuance?.scopedStep ?? null,
        stage: descriptor.stage ?? issuance?.stage ?? null, epoch: descriptor.epoch ?? issuance?.epoch ?? null,
        itemIndex: descriptor.itemIndex ?? null, generation: descriptor.generation ?? null, issuanceToken: descriptor.dispatchToken ?? null } }));
    return runtimeObserver(context, bindRoutingCalls({ artifacts, observationId: observation.id }), callSite, 'auxiliary');
  }
  return runtimeObserver(context, bindRoutingCalls({ artifacts, issuanceId: issuance.id }), callSite, 'primary');
}
export function routingParentForToken(context, token) {
  const artifacts = routingArtifactsFor(context);
  if (!artifacts || !token) return null;
  const journal = artifacts.exportRoutingJournal();
  return journal.records[journal.tokenIndex[token]] ?? null;
}
export function installRoutingCalls(context) {
  if (!routingArtifactsFor(context)) return;
  context.routingCalls = Object.freeze({ forIssuance: (issuance, descriptor) => callsForRouting(context, issuance, null, descriptor),
    unsupported: (reason, descriptor, parent) => callsForRouting(context, parent, reason, descriptor) });
}
// Codex usage events carry model/effort; its result telemetry separates them.
// Compare both facts, including the suffix when an explicit effort is present.
// Other providers' model identifiers are opaque (a slash need not mean effort).
function forwardedModelFacts(value, provider) {
  const slash = provider === 'codex' && typeof value.model === 'string' ? value.model.indexOf('/') : -1;
  return { model: slash < 0 ? value.model : value.model.slice(0, slash),
    effort: value.effort, embeddedEffort: slash < 0 ? null : value.model.slice(slash + 1) || null };
}
/** Forwarding is a delivery trigger; raw connector resolutions own the one canonical payload. */
export async function reportObservedUsage(context, usage, meta = {}) {
  const artifacts = routingArtifactsFor(context);
  if (!artifacts) return null;
  const entries = Array.isArray(usage) ? usage : Array.isArray(usage?.usages) ? usage.usages : usage ? [usage] : [];
  for (const entry of entries) {
    if (entry?.detail?.routing) {
      guardedWrite(() => artifacts.recordPendingUsageReceipt({ dispatchId: entry.dispatchId, receipt: entry }));
      continue;
    }
    if (!entry?.dispatch_id) continue; // Aggregate/fallback identity is never raw evidence.
    const intent = records(artifacts).find(r => r.type === 'call-intent' && r.callId === entry.dispatch_id);
    if (!intent) continue;
    const resolution = latestRoutingCall(artifacts.exportRoutingJournal(), intent.id).resolution;
    if (!resolution) continue;
    const tokens = entry.tokens ?? (entry.input_tokens != null && entry.output_tokens != null ? entry.input_tokens + entry.output_tokens : null);
    const original = resolution.usageEvidence;
    const paid = artifacts.journal.pendingUsageReceipts?.find(p => p.dispatchId === intent.callId)?.receipt;
    const actualModel = forwardedModelFacts(entry, intent.profileIntent.provider);
    const expectedModel = forwardedModelFacts(original, intent.profileIntent.provider);
    const expectedEffort = expectedModel.effort ?? expectedModel.embeddedEffort;
    const forwarded = [
      ['usd', entry.cost_usd ?? entry.usd, original.usd], ['tokens', tokens, original.tokens],
      ['durationMs', entry.duration_ms ?? entry.ms, original.durationMs],
      ['model', actualModel.model, expectedModel.model], ['effort', actualModel.effort, expectedEffort],
      ['embedded effort', actualModel.embeddedEffort, expectedEffort],
      ['model/effort', actualModel.embeddedEffort, actualModel.effort],
      ['provenance', entry.usd_source ?? entry.usdSource, original.provenance],
      ...[['input', 'input_tokens'], ['output', 'output_tokens'], ['cacheRead', 'cache_read'], ['cacheCreation', 'cache_creation']]
        .map(([raw, normalized]) => [raw, entry[normalized], paid?.split?.[raw]]),
    ];
    for (const [key, value, expected] of forwarded) {
      if (value != null && expected != null && value !== expected) {
        routingRefuse('ROUTING_CALL_EVIDENCE_CONFLICT', `Forwarded ${key} differs from original connector evidence`);
      }
    }
  }
  if (meta.routingReceipt) guardedWrite(() => artifacts.recordPendingUsageReceipt({ dispatchId: meta.routingReceipt.dispatchId, receipt: meta.routingReceipt }));
  await flushObservedReceipts(context, null, artifacts);
  return [];
}
export function routingRecord(artifacts, type, fields, identity = fields) {
  const pin = artifacts.exportRoutingJournal();
  return guardedWrite(() => artifacts.recordRoutingRecord({ schemaVersion: 1, startId: pin.startId, rootDigest: pin.rootDigest,
    type, id: routingDigest({ type, ...identity }), ...fields }));
}
function settleCancellation(artifacts, snapshot) {
  if (snapshot.status !== 'cancelled') return;
  for (const issuance of records(artifacts).filter(r => r.type === 'issuance' && r.runId === artifacts.runId)) {
    const pin = artifacts.exportRoutingJournal();
    const state = routingIssuanceState(pin, issuance.id).state;
    if (['prepared', 'settled'].includes(state)) continue;
    const owned = new Set([issuance.id]);
    let grew = true;
    while (grew) { grew = false; for (const r of Object.values(pin.records)) if (r.type === 'unsupported-observation' && owned.has(r.parentRecordId) && !owned.has(r.id)) { owned.add(r.id); grew = true; } }
    const calls = Object.values(pin.records).filter(r => r.type === 'call-intent' && owned.has(r.recordId));
    const resolutions = calls.map(i => latestRoutingCall(pin, i.id).resolution);
    if (!calls.length || resolutions.some(r => !r || r.terminationEvidence.kind === 'uncertain')) continue;
    const evidence = { ...Object.fromEntries(['runId', 'revisionDigest', 'scopedStep', 'epoch', 'itemIndex', 'generation', 'issuanceToken'].map(k => [k, issuance[k]])),
      acceptedDispatchToken: null, status: 'cancelled', proofKind: 'cancellation-audit',
      audit: { runId: snapshot.id, revisionDigest: snapshot.revisionDigest, status: 'cancelled', evidence: copy(snapshot) }, terminationRefs: resolutions.map(r => r.id) };
    routingRecord(artifacts, 'issuance-event', { issuanceId: issuance.id, issuanceToken: issuance.issuanceToken, event: 'settled', sequence: pin.eventTips[issuance.id].count, evidence }, { issuanceId: issuance.id, event: 'settled' });
  }
}
export async function recoverRoutingEvidence(context, { deliver = true } = {}) {
  const artifacts = routingArtifactsFor(context);
  if (!artifacts) return [];
  // Reload original owners, including late predecessor completions. No model calls.
  const owners = records(artifacts).filter(r => r.type === 'receipt-owner');
  const stores = new Map([[artifacts.runId, artifacts]]);
  for (const owner of owners) if (!stores.has(owner.ownerRunId)) stores.set(owner.ownerRunId, artifacts.openRoutingOwner(owner));
  for (const store of stores.values()) {
    const late = lateWrites.get(store.journalPath);
    if (late) {
      if (deliver) await Promise.all(late.pending);
      if (late.error) throw late.error;
      if (!late.pending.size) lateWrites.delete(store.journalPath);
    }
    const pin = store.exportRoutingJournal();
    for (const intent of Object.values(pin.records).filter(r => r.type === 'call-intent' && r.ownerRunId === store.runId)) {
      if (latestRoutingCall(pin, intent.id).resolution) continue;
      const observer = bindRoutingCalls({ artifacts: store, issuanceId: intent.issuanceId, observationId: intent.observationId });
      observer.resolve(intent.id, { outcome: 'unresolved', launchOutcome: 'uncertain',
        terminationEvidence: { kind: 'uncertain', intentId: intent.id, callId: intent.callId, evidence: null }, incompleteReasons: ['completion-unavailable'] });
    }
    const snapshot = readRoutingSnapshot(store.runId, { revisionDigest: pin.runBinding.revisionDigest, rootDigest: pin.rootDigest });
    for (const receipt of snapshot.receipts ?? []) {
      if (receipt.dispatchId?.startsWith('compose:') || receipt.dispatchId?.startsWith('engine:step_reset:')) continue;
      const pending = store.journal.pendingUsageReceipts?.find(p => p.dispatchId === receipt.dispatchId);
      if (pending) {
        const expected = pending.receipt;
        if (expected.detail?.routing && (routingDigest(receipt.amount) !== routingDigest(expected.usage)
          || routingDigest(receipt.detail?.routing ?? null) !== routingDigest(expected.detail.routing))) {
          routingRefuse('ROUTING_CALL_EVIDENCE_CONFLICT', 'Engine receipt differs from the original Compose spool');
        }
        continue; // Only delivery of the canonical pending bytes may acknowledge them.
      }
      const declaration = Object.values(snapshot.spec.flows).flatMap(flow => flow?.steps ?? []).find(step => step.id === receipt.stepId?.split('/').at(-1));
      const unsupportedReason = declaration?.ensure?.some?.(entry => typeof entry === 'object' && entry.judged) ? 'engine-judged' : 'engine-fanout';
      store.recordRoutingEngineReceipt({ receipt, sequence: receipt.seq, unsupportedReason,
        context: { scopedStep: receipt.stepId ?? null, epoch: receipt.detail?.epoch ?? null,
          stage: receipt.detail?.item?.stage ?? null, itemIndex: receipt.detail?.item?.itemIndex ?? null,
          generation: receipt.detail?.item?.generation ?? null } });
    }
    for (const [stepId, state] of Object.entries(snapshot.steps)) {
      const step = Object.values(snapshot.spec.flows).flatMap(f => f?.steps ?? []).find(s => s.id === stepId);
      if (step?.fanout && step.fanout.dispatch !== 'consumer' || step?.ensure?.some?.(e => typeof e === 'object' && e.judged)) {
        store.recordRoutingObservation({ unsupportedReason: 'engine-evidence-unavailable', evidenceSource: 'engine-audit',
          callSite: `${stepId}/${state.epoch ?? 0}/engine-coverage`, context: { scopedStep: stepId, epoch: state.epoch ?? 0 } });
      }
    }
    const dispositions = records(store).filter(r => r.type === 'gate-disposition' && r.runId === store.runId);
    if (dispositions.length) {
      const { acknowledgeRoutingGate } = await import('./routing-gates.js');
      for (const disposition of dispositions) {
        if (!records(store).some(r => r.type === 'gate-acknowledgement' && r.dispositionId === disposition.id && r.reconciliation.startsWith('token-'))) {
          acknowledgeRoutingGate({ ...context, artifacts: store, routing: { ...context.routing, artifacts: store } }, disposition, null, snapshot);
        }
      }
    }
    settleCancellation(store, snapshot);
    if (deliver && snapshot.status !== 'cancelled') await flushObservedReceipts(context, null, store);
  }
  readRoutingOwners({ artifacts });
  return materializeRoutingLedger({ cwd: context.routing?.cwd ?? context.routing?.start?.workspaceRoot ?? artifacts.targetCwd, artifacts });
}

/** The successful RPC return binds the exact original attempt; current audit alone cannot. */
export function acknowledgeRoutingFailure(context, issuance, envelope, response) {
  if (!issuance) return false;
  const artifacts = routingArtifactsFor(context);
  const snapshot = readRoutingSnapshot(issuance.runId, { revisionDigest: issuance.revisionDigest, rootDigest: issuance.rootDigest });
  const step = scopedRoutingState(snapshot, issuance.scopedStep);
  const state = issuance.stage === null ? step : step?.fanout?.items?.[issuance.itemIndex];
  if (snapshot.status === 'cancelled' || state?.acceptedDispatchToken === issuance.issuanceToken) return false;
  if ((step?.epoch ?? 0) !== issuance.epoch || issuance.stage !== null && state?.generation !== issuance.generation) return false;
  if (!state?.failure || state.dispatchToken === issuance.issuanceToken) return false;
  const request = { ...Object.fromEntries(['runId', 'revisionDigest', 'scopedStep', 'epoch', 'itemIndex', 'generation'].map(k => [k, issuance[k]])),
    dispatchToken: issuance.issuanceToken, envelope: copy(envelope) };
  const evidence = { ...Object.fromEntries(['runId', 'revisionDigest', 'scopedStep', 'epoch', 'itemIndex', 'generation', 'issuanceToken'].map(k => [k, issuance[k]])),
    acceptedDispatchToken: null, status: 'failed', proofKind: 'failure-acknowledgement', request, requestDigest: routingDigest(request),
    response: { acknowledged: true, status: 'failed', result: { response: copy(response), audit: copy(snapshot) } } };
  const pin = artifacts.exportRoutingJournal();
  routingRecord(artifacts, 'issuance-event', { issuanceId: issuance.id, issuanceToken: issuance.issuanceToken, event: 'settled', sequence: pin.eventTips[issuance.id].count, evidence }, { issuanceId: issuance.id, event: 'settled' });
  return true;
}
function scopedRoutingState(snapshot, scopedStep) {
  if (snapshot.steps[scopedStep]) return snapshot.steps[scopedStep];
  let state = { sub: snapshot };
  for (const id of scopedStep.split('/')) state = state?.sub?.steps?.[id];
  return state;
}
export function routingCallsTerminated(context, issuance) {
  const artifacts = routingArtifactsFor(context); if (!artifacts || !issuance) return false;
  const pin = artifacts.exportRoutingJournal();
  const owned = new Set([issuance.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of Object.values(pin.records)) if (r.type === 'unsupported-observation' && owned.has(r.parentRecordId) && !owned.has(r.id)) { owned.add(r.id); changed = true; }
  }
  const calls = Object.values(pin.records).filter(r => r.type === 'call-intent' && owned.has(r.recordId));
  return calls.length > 0 && calls.every(i => { const r = latestRoutingCall(pin, i.id).resolution; return r && r.terminationEvidence.kind !== 'uncertain'; });
}

/** Internal bindings are non-enumerable: option traces and provider projections
 * retain their historical serialized bytes, while the next boundary can read it. */
export function routingCallOptions(options) {
  if (!options.routingCalls) return options;
  const observer = options.routingCalls;
  delete options.routingCalls;
  Object.defineProperty(options, 'routingCalls', { value: observer, enumerable: false });
  return options;
}

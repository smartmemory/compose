/** Pure output-gate decision. Callers supply current recorded step states. */
import { canonicalRoutingJson } from './model-router.js';
import { ownField, normalizeOwnedPath, validateGateConfig, validateWaveAdmission, profilesDigest } from './pipeline-profiles.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(v => typeof v === 'string');
function validateDecision(decision, review, validator, { executeProfile, executeProvider }) {
  const findings = [];
  const add = (code, message) => findings.push({ code, message });
  const tasks = ownField(decision, validator.tasks_field ?? 'tasks');
  const findingShape = f => object(f) && typeof f.severity === 'string' && strings(f.files)
    && typeof f.claim === 'string' && typeof f.evidence === 'string';
  const taskShape = t => object(t) && typeof t.id === 'string' && t.id.length > 0
    && typeof t.description === 'string' && strings(t.files_owned) && strings(t.files_read)
    && strings(t.depends_on) && (t.tier_rationale === undefined || typeof t.tier_rationale === 'string');
  if (!object(decision) || !['repair', 'implement', 'complete', 'blocked'].includes(decision.action)
    || typeof decision.rationale !== 'string' || typeof decision.blocking !== 'boolean'
    || !Number.isInteger(decision.open_count) || decision.open_count < 0
    || !Array.isArray(decision.open_findings) || !decision.open_findings.every(findingShape)
    || !Array.isArray(decision.addressed_findings) || !decision.addressed_findings.every(findingShape)
    || !Array.isArray(tasks) || !tasks.every(taskShape)) {
    add('WAVE_DECISION_SHAPE', 'Invalid WaveDecision/task/finding shape');
    return findings;
  }
  if (decision.open_count !== decision.open_findings.length) add('WAVE_OPEN_COUNT_MISMATCH', 'open_count differs from open_findings length');
  if (typeof review?.blocking !== 'boolean' || review.blocking !== decision.blocking) add('WAVE_BLOCKING_MISMATCH', 'blocking differs from recorded review');
  if (decision.action === 'complete' && (decision.open_count !== 0 || decision.blocking)) add('WAVE_COMPLETE_WITH_OPEN_FINDINGS', 'Complete requires no open findings and no blocking');
  if (decision.action === 'blocked' && decision.open_count === 0) add('WAVE_BLOCKED_WITHOUT_FINDINGS', 'Blocked requires open findings');
  if (['repair', 'implement'].includes(decision.action)) {
    if (tasks.length < 1 || tasks.length > 6) add('WAVE_REPAIR_EMPTY', 'Implementation/repair requires 1–6 tasks');
    findings.push(...validateWaveAdmission(executeProfile, tasks,
      { provider: executeProvider, ownership: true, independent: true }).findings);
  }
  if (decision.action === 'repair') {
    try {
      const files = new Set(decision.open_findings.flatMap(f => f.files.map(normalizeOwnedPath)));
      for (const task of tasks) if (!task.files_owned.some(file => files.has(normalizeOwnedPath(file)))) {
        add('WAVE_REPAIR_UNOWNED_FINDING', `Repair task ${task.id} owns no open finding file`);
      }
    } catch (error) { add('WAVE_DECISION_SHAPE', error.message); }
  }
  return findings;
}
/**
 * Resolve only from current recorded source, waiting gate and configured review states.
 * executeProfile (the configured execute entry) and executeProvider are required.
 * reviewOutput is ignored; validators always use the configured review step's recorded output.
 */
export function decideGateFromOutput(config, stepOutputs, { gateStepId, gateToken, reviewOutput, ceiling, executeProfile, executeProvider } = {}) {
  const hold = (reason, extra = {}) => ({ outcome: null, reason, ...extra });
  try { validateGateConfig(config); }
  catch (error) { return hold('GATE_CONFIG_INVALID', { findings: [{ code: 'GATE_CONFIG_INVALID', message: error.message }] }); }
  if (!executeProfile || typeof executeProvider !== 'string' || !executeProvider.trim()) return hold('GATE_CONFIG_INVALID');
  if (ceiling !== undefined) {
    if (!Number.isFinite(ceiling.spent) || ceiling.spent < 0 || !Number.isFinite(ceiling.ceiling) || ceiling.ceiling <= 0) return hold('COST_CEILING_INVALID');
    if (ceiling.spent > ceiling.ceiling) return hold('COST_CEILING_BREACHED', { breach: { spent: ceiling.spent, ceiling: ceiling.ceiling } });
  }
  const sourceState = stepOutputs?.[config.decide_from.step];
  if (!object(sourceState) || sourceState.status !== 'succeeded' || !object(sourceState.output)) return hold('GATE_SOURCE_MISSING');
  const gate = stepOutputs?.[gateStepId];
  if (!object(gate) || gate.status !== 'waiting_gate' || typeof gateToken !== 'string' || !gateToken
    || gate.gateToken !== gateToken || !Number.isInteger(gate.epoch) || gate.epoch < 0
    || sourceState.epoch !== gate.epoch) return hold('GATE_SOURCE_STALE');
  const output = sourceState.output;
  const action = ownField(output, config.decide_from.field);
  const outcome = ['approve', 'revise', 'kill'].find(key => config.decide_from[key].includes(action));
  if (!outcome) return hold('GATE_ACTION_UNKNOWN');
  const findings = [];
  for (const validator of config.validators ?? []) {
    const reviewState = stepOutputs?.[validator.review_step];
    const review = reviewState?.status === 'succeeded' ? reviewState.output : undefined;
    if (reviewState && reviewState.epoch !== gate.epoch) return hold('GATE_SOURCE_STALE');
    findings.push(...validateDecision(output, review, validator, { executeProfile, executeProvider }));
  }
  if (findings.length) return hold('GATE_VALIDATION_FAILED', { findings });
  return {
    outcome, rationale: output.rationale ?? `Mapped ${String(action)} to ${outcome}`,
    source: { step: config.decide_from.step, field: config.decide_from.field, action, gateStepId, gateToken,
      epoch: sourceState.epoch, acceptedDispatchToken: sourceState.acceptedDispatchToken,
      outputDigest: profilesDigest(output), output: structuredClone(output) },
  };
}

/** Observation only: original finding multiplicities and historical ownership.
 * This does not participate in gate admission or compare model tiers. */
export function observeRoutingDecision({ decision, review, items, finalDecision }) {
  const canonical = canonicalRoutingJson;
  const bag = values => values.map(canonical).sort();
  const findings = decision && Array.isArray(review?.findings) && Array.isArray(decision.open_findings) && Array.isArray(decision.addressed_findings);
  const partitionCheck = decision ? findings && JSON.stringify(bag(review.findings)) === JSON.stringify(bag([...decision.open_findings, ...decision.addressed_findings])) ? 'valid' : 'ambiguous' : 'valid';
  let ownershipCheck = 'valid';
  const dispositions = [], proposals = [];
  const tasks = decision?.tasks ?? [];
  const owned = item => Array.isArray(item?.files_owned) ? item.files_owned.map(normalizeOwnedPath) : [];
  let taskFiles, oldFiles, openFiles;
  try {
    taskFiles = tasks.map(owned); oldFiles = items.map(i => owned(i.fullItem));
    openFiles = (decision?.open_findings ?? []).flatMap(f => (f.files ?? []).map(normalizeOwnedPath));
  } catch { ownershipCheck = 'ambiguous'; taskFiles = tasks.map(() => []); oldFiles = items.map(() => []); openFiles = []; }
  for (let index = 0; index < items.length; index++) {
    const item = items[index]; if (!item.issuanceId) continue;
    let relation = 'retained', defective = false;
    const matches = taskFiles.map((files, n) => files.some(f => oldFiles[index].includes(f)) ? n : -1).filter(n => n >= 0);
    const affected = oldFiles[index].some(f => openFiles.includes(f));
    if (finalDecision !== 'approve' && (!decision || decision.action === 'blocked')) relation = 'unknown';
    if (decision?.action === 'repair' && affected) {
      if (matches.length !== 1) { relation = 'unknown'; ownershipCheck = 'ambiguous'; }
      else { relation = 'repaired'; defective = true; }
    } else if (matches.length) {
      // Repetition of a name/index does not link work. Only uniquely owned files
      // in the retained snapshot establish this proposed replacement.
      if (matches.length !== 1 || decision?.action !== 'implement') { relation = 'unknown'; ownershipCheck = 'ambiguous'; }
      else relation = 're-implemented';
    }
    if (relation === 'repaired' || relation === 're-implemented') {
      const target = matches[0];
      if (oldFiles.filter(files => files.some(f => taskFiles[target].includes(f))).length !== 1) { relation = 'unknown'; defective = false; ownershipCheck = 'ambiguous'; }
      else proposals.push({ relation, from: item, task: tasks[target] });
    }
    if (relation === 'unknown') { ownershipCheck = 'ambiguous'; relation = 'retained'; defective = null; }
    dispositions.push({ issuanceId: item.issuanceId, relation, defective });
  }
  for (let n = 0; n < tasks.length; n++) if (!oldFiles.some(files => files.some(f => taskFiles[n].includes(f)))) proposals.push({ relation: 'added', from: null, task: tasks[n] });
  return { partitionCheck, ownershipCheck, dispositions, proposals };
}

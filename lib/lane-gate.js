// lib/lane-gate.js
//
// COMP-TRIAGE-5 — E3 (Estimate → Execute → Expand) front-of-pipeline scope
// estimation + verification-gated escalation. Two entry points, extracted from
// build.js runBuild/executeShipStep so they are unit-testable in isolation:
//
//   applyFrontTriage()  — E3 "Estimate": derive the lane from the RAW REQUEST
//                         before any design/plan/blueprint doc is read, and
//                         persist validated feature fields (closing the
//                         complexity: String(tier) bypass at build.js:997/1006).
//
//   maybeEscalateLane() — E3 "Expand": on a failed ship-time test gate, escalate
//                         the lane so the NEXT build runs wider — persist the
//                         escalated lane + a widened profile + a bounded counter
//                         and drop a resume checkpoint. STOP → human handoff.
//                         Re-entry is via re-invocation reading the escalated
//                         lane, NOT inline runBuild surgery.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { estimateScope, tierToComplexity } from './triage.js';
import { validateFeatureFields } from './feature-writer.js';
import { escalate } from './escalation.js';

// A widened profile — nothing skipped. Persisted on escalation so the next build
// runs every phase.
const FULL_PROFILE = {
  needs_prd: true,
  needs_architecture: true,
  needs_verification: true,
  needs_report: true,
};

/**
 * E3 Estimate. Runs before spec load. Derives {tier, profile, lane} from the raw
 * request (doc-free) and persists validated fields through the shared validator
 * (so the tier can no longer be stringified into `complexity`). Returns the
 * values runBuild needs to toggle skip_if.
 *
 * @param {object} a
 * @param {string} a.featureCode
 * @param {string} [a.request]        raw task text (opts.description); falls back to the code
 * @param {object} a.provider         build provider (getFeature/createFeature/putFeature)
 * @param {object|null} a.cachedFeature  already-fetched feature.json, or null
 * @returns {Promise<{buildProfile:object, tier:number, lane:string, tierLabel:string, rationale:string, cachedFeature:object}>}
 */
export async function applyFrontTriage({ featureCode, request, provider, cachedFeature }) {
  const req = request ?? featureCode;
  const front = estimateScope(req);
  const tier = front.tier;
  const buildProfile = front.profile;
  const lane = front.lane;

  const fields = {
    complexity: tierToComplexity(tier),
    triageTier: tier,
    lane,
    estimateSource: 'front',
    profile: buildProfile,
    triageTimestamp: new Date().toISOString(),
  };
  // Throws on any invalid field — this is the guard the raw provider write bypassed.
  validateFeatureFields(fields);

  let updated;
  if (!cachedFeature) {
    updated = await provider.createFeature(featureCode, {
      code: featureCode,
      description: req,
      status: 'PLANNED',
      ...fields,
    });
  } else {
    updated = await provider.putFeature(featureCode, { ...cachedFeature, ...fields });
  }

  return {
    buildProfile,
    tier,
    lane,
    tierLabel: fields.complexity,
    rationale: front.rationale,
    cachedFeature: updated,
  };
}

/**
 * E3 Expand. On a failed ship-time test gate, escalate the lane so the next build
 * runs wider. Bounded via escalationCount; on STOP or exhausted ladder, writes a
 * checkpoint and hands off to a human. Best-effort — the caller never blocks ship
 * on this. Only acts on features that went through front triage (have a `lane`).
 *
 * @param {object} a
 * @param {string} a.featureCode
 * @param {object} a.provider        build provider
 * @param {string} [a.featureDir]    dir to write the escalation checkpoint into
 * @param {string|null} [a.currentPhase]  optional live phase (unused for reEntry today; see escalation.js)
 * @returns {Promise<{action:'none'|'escalate'|'stop', [from]:string, [to]:string, [reEntryPhase]:string, [escalationCount]:number}>}
 */
export async function maybeEscalateLane({ featureCode, provider, featureDir, currentPhase = null }) {
  const feature = await provider.getFeature(featureCode);
  // Only features that went through the front seam carry a lane — never escalate
  // a feature that never opted into lane-based execution.
  if (!feature?.lane) return { action: 'none' };

  const lane = feature.lane;
  const escalationCount = feature.escalationCount ?? 0;
  const decision = escalate({ gate: 'test', passed: false }, lane, escalationCount, currentPhase);

  if (decision === 'STOP') {
    writeCheckpoint(featureDir, { featureCode, lane, decision: 'STOP', reEntryPhase: null, escalationCount });
    return { action: 'stop', lane, escalationCount };
  }
  if (!decision) return { action: 'none' };

  // Persist the escalated lane + a widened profile so the next build runs wide.
  validateFeatureFields({ lane: decision.nextLane, estimateSource: 'escalated' });
  await provider.putFeature(featureCode, {
    ...feature,
    lane: decision.nextLane,
    estimateSource: 'escalated',
    escalationCount: escalationCount + 1,
    profile: FULL_PROFILE,
    triageTimestamp: new Date().toISOString(),
  });
  writeCheckpoint(featureDir, {
    featureCode,
    lane: decision.nextLane,
    decision: 'escalate',
    reEntryPhase: decision.reEntryPhase,
    escalationCount: escalationCount + 1,
  });
  return {
    action: 'escalate',
    from: lane,
    to: decision.nextLane,
    reEntryPhase: decision.reEntryPhase,
    escalationCount: escalationCount + 1,
  };
}

function writeCheckpoint(featureDir, { featureCode, lane, decision, reEntryPhase, escalationCount }) {
  if (!featureDir) return;
  try {
    mkdirSync(featureDir, { recursive: true });
    const lines = [
      `# COMP-TRIAGE-5 Escalation Checkpoint — ${featureCode}`,
      '',
      `- Decision: ${decision}`,
      `- Lane: ${lane}`,
      reEntryPhase ? `- Re-enter at phase: ${reEntryPhase}` : '- Re-enter: n/a (STOP — human handoff)',
      `- Escalation count: ${escalationCount}`,
      '- Trigger: ship-time test gate failed (E3 Expand)',
      '',
      decision === 'STOP'
        ? 'Escalation bound reached. A human should investigate before re-running.'
        : `Re-run \`compose build ${featureCode}\` — it reads the escalated lane and runs the heavier phases.`,
      '',
    ];
    writeFileSync(join(featureDir, 'escalation-checkpoint.md'), lines.join('\n'), 'utf-8');
  } catch {
    /* best-effort — a checkpoint failure must never break the build */
  }
}

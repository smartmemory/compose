/**
 * pipeline-steps.js — Shared build-pipeline step definitions and logic.
 *
 * Extracted from src/components/vision/constants.js (PIPELINE_STEPS) and
 * src/components/vision/PipelineView.jsx (merge block) so both desktop and
 * mobile can use the same logic without duplication.
 *
 * COMP-MOBILE-1 S01
 */

export const PIPELINE_STEPS = [
  { id: 'explore_design',      name: 'Explore Design',  agent: 'claude', phase: 'design',         hasGate: false },
  { id: 'design_review',       name: 'Design Review',   agent: 'codex',  phase: 'design',         hasGate: false },
  { id: 'design_gate',         name: 'Design Gate',     agent: 'human',  phase: 'design',         hasGate: true  },
  { id: 'prd',                 name: 'PRD',             agent: 'claude', phase: 'design',         hasGate: false },
  { id: 'prd_review',          name: 'PRD Review',      agent: 'codex',  phase: 'design',         hasGate: false },
  { id: 'prd_gate',            name: 'PRD Gate',        agent: 'human',  phase: 'design',         hasGate: true  },
  { id: 'architecture',        name: 'Architecture',    agent: 'claude', phase: 'design',         hasGate: false },
  { id: 'architecture_review', name: 'Arch Review',     agent: 'codex',  phase: 'design',         hasGate: false },
  { id: 'architecture_gate',   name: 'Arch Gate',       agent: 'human',  phase: 'design',         hasGate: true  },
  { id: 'blueprint',           name: 'Blueprint',       agent: 'claude', phase: 'blueprint',      hasGate: false },
  { id: 'verification',        name: 'Verification',    agent: 'claude', phase: 'blueprint',      hasGate: false },
  { id: 'blueprint_review',    name: 'BP Review',       agent: 'codex',  phase: 'blueprint',      hasGate: false },
  { id: 'plan',                name: 'Plan',            agent: 'claude', phase: 'implementation', hasGate: false },
  { id: 'plan_review',         name: 'Plan Review',     agent: 'codex',  phase: 'implementation', hasGate: false },
  { id: 'plan_gate',           name: 'Plan Gate',       agent: 'human',  phase: 'implementation', hasGate: true  },
  { id: 'execute',             name: 'Execute',         agent: 'claude', phase: 'implementation', hasGate: false },
  { id: 'review',              name: 'Review Loop',     agent: 'codex',  phase: 'implementation', hasGate: false },
  { id: 'coverage',            name: 'Coverage Sweep',  agent: 'claude', phase: 'implementation', hasGate: false },
  { id: 'report',              name: 'Report',          agent: 'claude', phase: 'ship',           hasGate: false },
  { id: 'report_review',       name: 'Report Review',   agent: 'codex',  phase: 'ship',           hasGate: false },
  { id: 'report_gate',         name: 'Report Gate',     agent: 'human',  phase: 'ship',           hasGate: true  },
  { id: 'docs',                name: 'Docs',            agent: 'claude', phase: 'ship',           hasGate: false },
  { id: 'ship',                name: 'Ship',            agent: 'claude', phase: 'ship',           hasGate: false },
  { id: 'ship_gate',           name: 'Ship Gate',       agent: 'human',  phase: 'ship',           hasGate: true  },
];

// Terminal build statuses: covers both 'complete' (active-build.json writer)
// and 'completed' (mobile BuildsTab legacy). Both must be treated as terminal.
const TERMINAL_STATUSES = new Set(['complete', 'completed', 'aborted', 'failed', 'killed', 'done']);

/**
 * Returns true if `status` represents a terminal (non-running) build state.
 * Covers both 'complete' (active-build.json writer) and 'completed' (mobile
 * BuildsTab legacy spelling) — see blueprint correction #6.
 *
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function isTerminalBuildStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Merge template PIPELINE_STEPS with live build step data.
 *
 * Port of PipelineView.jsx:178-199 as a pure function so desktop and mobile
 * share identical merge logic. Returns the merged Step[] array directly.
 *
 * Rules:
 * - Live data right-spreads over template defaults (live status wins)
 * - The currentStepId step gets status:'active' ONLY when it has no terminal
 *   live status (the currently running step is not yet in steps[])
 * - Dynamic steps (not in template) are appended at the end
 *
 * @param {Array} template            Full step template (e.g. PIPELINE_STEPS)
 * @param {Array|null} liveSteps      activeBuild.steps[] (completed history; may be empty/null)
 * @param {string|null} currentStepId activeBuild.currentStepId (currently running step)
 * @returns {Array} Merged step objects
 */
export function mergePipelineSteps(template, liveSteps, currentStepId) {
  // Build lookup maps from live steps
  const liveStatusMap = Array.isArray(liveSteps)
    ? Object.fromEntries(liveSteps.map(s => [s.id, s.status]))
    : {};
  const liveStepMap = Array.isArray(liveSteps)
    ? Object.fromEntries(liveSteps.map(s => [s.id, s]))
    : {};

  // Merge: live data right-spreads over template defaults
  const merged = template.map(t => {
    const live = liveStepMap[t.id];
    const step = live ? { ...t, ...live } : { ...t };

    // Apply active marker: currentStepId step gets status 'active' ONLY if
    // it has no live status (running step is not yet in steps[], so has no
    // terminal live status to preserve)
    if (step.id === currentStepId && !liveStatusMap[step.id]) {
      step.status = 'active';
    }

    return step;
  });

  // Append any dynamic steps that are not in the template (custom Stratum steps)
  if (Array.isArray(liveSteps)) {
    for (const s of liveSteps) {
      if (!template.find(t => t.id === s.id)) {
        merged.push({
          id: s.id,
          name: s.id.replace(/_/g, ' '),
          agent: 'claude',
          phase: 'implementation',
          ...s,
        });
      }
    }
  }

  return merged;
}

/**
 * Returns true when the active build is in a "gate pending" state:
 * - status is 'running'
 * - currentStepId ends with '_gate'
 * - there is at least one unresolved gate whose itemId matches the feature's item
 *
 * Ported from graphOpsOverlays.js:70-79 (computeBuildStateMap gate-pending derivation).
 *
 * @param {object|null} activeBuild  active build object {featureCode, status, currentStepId}
 * @param {Array} gates              pending gates array
 * @param {Array} items              vision items array (for featureCode → itemId lookup)
 * @returns {boolean}
 */
export function isGatePending(activeBuild, gates, items) {
  if (!activeBuild) return false;
  const { featureCode, status, currentStepId } = activeBuild;
  if (status !== 'running') return false;
  if (!currentStepId || !currentStepId.endsWith('_gate')) return false;

  // Find the item for this feature code (mirrors findItemByFeatureCode in graphOpsOverlays.js)
  const safeItems = Array.isArray(items) ? items : [];
  const featureItem = safeItems.find(i => i.featureCode === featureCode)
    || safeItems.find(i => i.title === featureCode)
    || safeItems.find(i => i.title && i.title.startsWith(featureCode + ':'));
  if (!featureItem) return false;

  // Check for an unresolved gate matching this item
  return (Array.isArray(gates) ? gates : []).some(
    g => g.itemId === featureItem.id && !g.resolvedAt
  );
}

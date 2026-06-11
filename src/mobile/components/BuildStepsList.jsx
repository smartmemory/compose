/**
 * BuildStepsList — vertical merged-step list grouped by phase.
 *
 * Props:
 *   active — active build object from useActiveBuild (may be null)
 *
 * Uses mergePipelineSteps() to overlay completed history (active.steps[])
 * and the currently-running step (active.currentStepId) on the template.
 * The active step comes ONLY from currentStepId — see blueprint active-step
 * caveat: steps[] holds completed history only.
 *
 * Consecutive runs of 3+ done steps collapse into a single "N done ✓" row
 * that expands on tap.
 *
 * COMP-MOBILE-1 S02
 */

import React, { useState } from 'react';
import { PIPELINE_STEPS, mergePipelineSteps } from '../../lib/pipeline-steps.js';

const PHASE_LABELS = {
  design: 'Design',
  blueprint: 'Blueprint',
  implementation: 'Implementation',
  ship: 'Ship',
};

const PHASE_ORDER = ['design', 'blueprint', 'implementation', 'ship'];

function statusGlyph(status) {
  if (status === 'active') return '◉';
  if (status === 'done' || status === 'complete' || status === 'completed') return '●';
  if (status === 'failed' || status === 'error') return '✕';
  // pending / undefined / anything else
  return '○';
}

function isDone(status) {
  return status === 'done' || status === 'complete' || status === 'completed';
}

function isFailed(status) {
  return status === 'failed' || status === 'error';
}

function agentLabel(agent) {
  if (!agent) return null;
  return agent;
}

/**
 * Collapse consecutive runs of done steps into segments.
 * A run of N>=3 consecutive done steps is eligible for collapsing.
 * Returns an array of segments:
 *   { type: 'step',      step }
 *   { type: 'collapsed', steps, count }
 */
function segmentSteps(steps) {
  const result = [];
  let i = 0;
  while (i < steps.length) {
    const step = steps[i];
    if (!isDone(step.status)) {
      result.push({ type: 'step', step });
      i++;
      continue;
    }
    // Count the consecutive done run starting here
    let runEnd = i;
    while (runEnd < steps.length && isDone(steps[runEnd].status)) {
      runEnd++;
    }
    const runLen = runEnd - i;
    if (runLen >= 3) {
      result.push({ type: 'collapsed', steps: steps.slice(i, runEnd), count: runLen });
    } else {
      for (let j = i; j < runEnd; j++) {
        result.push({ type: 'step', step: steps[j] });
      }
    }
    i = runEnd;
  }
  return result;
}

function StepRow({ step }) {
  const glyph = statusGlyph(step.status);
  const failed = isFailed(step.status);
  const active = step.status === 'active';
  return (
    <div
      className={[
        'm-step-row',
        active ? 'm-step-row--active' : '',
        failed ? 'm-step-row--failed' : '',
      ].filter(Boolean).join(' ')}
      data-testid={`mobile-build-step-${step.id}`}
      data-status={step.status || 'pending'}
    >
      <span className={`m-step-glyph${active ? ' m-step-glyph--pulse' : ''}`} aria-hidden="true">
        {glyph}
      </span>
      <span className="m-step-name">{step.name || step.id}</span>
      {agentLabel(step.agent) && (
        <span className="m-step-agent-chip">{step.agent}</span>
      )}
      {failed && step.summary && (
        <div className="m-step-summary">{step.summary}</div>
      )}
    </div>
  );
}

function CollapsedRow({ segment, expandedKey, onToggle }) {
  const expanded = expandedKey === segment.steps[0].id;
  return (
    <div
      className="m-step-collapsed-row"
      data-testid="mobile-build-steps-collapsed"
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={() => onToggle(segment.steps[0].id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggle(segment.steps[0].id); }}
    >
      {expanded ? (
        segment.steps.map(s => <StepRow key={s.id} step={s} />)
      ) : (
        <span className="m-step-collapsed-label">{segment.count} done ✓</span>
      )}
    </div>
  );
}

export default function BuildStepsList({ active }) {
  const [expandedKey, setExpandedKey] = useState(null);

  const merged = mergePipelineSteps(
    PIPELINE_STEPS,
    active?.steps ?? null,
    active?.currentStepId ?? null,
  );

  // Group by phase, preserving PHASE_ORDER
  const phaseMap = {};
  for (const step of merged) {
    const phase = step.phase || 'implementation';
    if (!phaseMap[phase]) phaseMap[phase] = [];
    phaseMap[phase].push(step);
  }

  const phases = PHASE_ORDER.filter(p => phaseMap[p]?.length > 0);

  function handleToggle(key) {
    setExpandedKey(prev => (prev === key ? null : key));
  }

  return (
    <div className="m-build-steps-list" data-testid="mobile-build-steps">
      {phases.map(phase => {
        const stepsInPhase = phaseMap[phase];
        const segments = segmentSteps(stepsInPhase);
        return (
          <div key={phase} className="m-build-steps-phase">
            <div className="m-build-steps-phase-header">
              {PHASE_LABELS[phase] || phase}
            </div>
            <div className="m-build-steps-phase-rows">
              {segments.map((seg, idx) =>
                seg.type === 'collapsed' ? (
                  <CollapsedRow
                    key={`collapsed-${idx}`}
                    segment={seg}
                    expandedKey={expandedKey}
                    onToggle={handleToggle}
                  />
                ) : (
                  <StepRow key={seg.step.id} step={seg.step} />
                )
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

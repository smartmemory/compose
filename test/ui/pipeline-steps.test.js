import { describe, it, expect } from 'vitest';
import {
  PIPELINE_STEPS,
  mergePipelineSteps,
  isGatePending,
  isTerminalBuildStatus,
} from '../../src/lib/pipeline-steps.js';

describe('PIPELINE_STEPS', () => {
  it('has exactly 24 steps', () => {
    expect(PIPELINE_STEPS).toHaveLength(24);
  });

  it('every step has id, name, agent, phase, hasGate', () => {
    for (const s of PIPELINE_STEPS) {
      expect(typeof s.id).toBe('string');
      expect(typeof s.name).toBe('string');
      expect(typeof s.agent).toBe('string');
      expect(typeof s.phase).toBe('string');
      expect(typeof s.hasGate).toBe('boolean');
    }
  });

  it('first step is explore_design', () => {
    expect(PIPELINE_STEPS[0].id).toBe('explore_design');
  });

  it('last step is ship_gate', () => {
    expect(PIPELINE_STEPS[23].id).toBe('ship_gate');
  });
});

describe('mergePipelineSteps', () => {
  it('template-only: returns template steps with no status when liveSteps is empty', () => {
    const merged = mergePipelineSteps(PIPELINE_STEPS, [], null);
    expect(merged).toHaveLength(24);
    expect(merged[0].id).toBe('explore_design');
    expect(merged[0].status).toBeUndefined();
  });

  it('live status wins over template: done steps get their live status', () => {
    const liveSteps = [
      { id: 'explore_design', status: 'done', startedAt: 'ts1' },
      { id: 'design_review', status: 'done' },
    ];
    const merged = mergePipelineSteps(PIPELINE_STEPS, liveSteps, null);
    expect(merged[0].status).toBe('done');
    expect(merged[1].status).toBe('done');
    // Non-live steps remain without status
    expect(merged[2].status).toBeUndefined();
  });

  it('currentStepId marks the step active when it has no terminal live status', () => {
    const liveSteps = [
      { id: 'explore_design', status: 'done' },
    ];
    const merged = mergePipelineSteps(PIPELINE_STEPS, liveSteps, 'design_review');
    const active = merged.find(s => s.id === 'design_review');
    expect(active.status).toBe('active');
  });

  it('currentStepId does NOT override a terminal live status with active', () => {
    const liveSteps = [
      { id: 'design_review', status: 'failed' },
    ];
    const merged = mergePipelineSteps(PIPELINE_STEPS, liveSteps, 'design_review');
    const step = merged.find(s => s.id === 'design_review');
    // failed is terminal — should NOT be replaced by 'active'
    expect(step.status).toBe('failed');
  });

  it('currentStepId does NOT mark active when live status is complete', () => {
    const liveSteps = [
      { id: 'design_review', status: 'complete' },
    ];
    const merged = mergePipelineSteps(PIPELINE_STEPS, liveSteps, 'design_review');
    const step = merged.find(s => s.id === 'design_review');
    expect(step.status).toBe('complete');
    expect(step.status).not.toBe('active');
  });

  it('currentStepId does NOT mark active when live status is completed', () => {
    const liveSteps = [
      { id: 'design_review', status: 'completed' },
    ];
    const merged = mergePipelineSteps(PIPELINE_STEPS, liveSteps, 'design_review');
    const step = merged.find(s => s.id === 'design_review');
    expect(step.status).toBe('completed');
  });

  it('dynamic step not in template is appended at the end', () => {
    const liveSteps = [
      { id: 'custom_extra_step', status: 'done', phase: 'implementation' },
    ];
    const merged = mergePipelineSteps(PIPELINE_STEPS, liveSteps, null);
    expect(merged.length).toBe(25);
    const extra = merged[24];
    expect(extra.id).toBe('custom_extra_step');
    expect(extra.status).toBe('done');
  });

  it('handles null liveSteps gracefully', () => {
    const merged = mergePipelineSteps(PIPELINE_STEPS, null, null);
    expect(merged).toHaveLength(24);
  });
});

describe('isTerminalBuildStatus', () => {
  it('returns true for complete', () => {
    expect(isTerminalBuildStatus('complete')).toBe(true);
  });

  it('returns true for completed', () => {
    expect(isTerminalBuildStatus('completed')).toBe(true);
  });

  it('returns true for aborted, failed, killed, done', () => {
    expect(isTerminalBuildStatus('aborted')).toBe(true);
    expect(isTerminalBuildStatus('failed')).toBe(true);
    expect(isTerminalBuildStatus('killed')).toBe(true);
    expect(isTerminalBuildStatus('done')).toBe(true);
  });

  it('returns false for running, in_progress, null, undefined', () => {
    expect(isTerminalBuildStatus('running')).toBe(false);
    expect(isTerminalBuildStatus('in_progress')).toBe(false);
    expect(isTerminalBuildStatus(null)).toBe(false);
    expect(isTerminalBuildStatus(undefined)).toBe(false);
  });
});

describe('isGatePending', () => {
  const items = [
    { id: 'item-1', featureCode: 'COMP-A', title: 'COMP-A: Alpha' },
    { id: 'item-2', featureCode: 'COMP-B', title: 'COMP-B: Beta' },
  ];

  const gates = [
    { id: 'gate-1', itemId: 'item-1', resolvedAt: null },
  ];

  it('returns true when status=running, currentStepId ends with _gate, feature has unresolved gate', () => {
    const activeBuild = { featureCode: 'COMP-A', status: 'running', currentStepId: 'plan_gate' };
    expect(isGatePending(activeBuild, gates, items)).toBe(true);
  });

  it('returns false when status is not running', () => {
    const activeBuild = { featureCode: 'COMP-A', status: 'complete', currentStepId: 'plan_gate' };
    expect(isGatePending(activeBuild, gates, items)).toBe(false);
  });

  it('returns false when currentStepId does not end with _gate', () => {
    const activeBuild = { featureCode: 'COMP-A', status: 'running', currentStepId: 'execute' };
    expect(isGatePending(activeBuild, gates, items)).toBe(false);
  });

  it('returns false when gate is already resolved (resolvedAt set)', () => {
    const resolvedGates = [{ id: 'gate-1', itemId: 'item-1', resolvedAt: '2026-01-01T00:00:00Z' }];
    const activeBuild = { featureCode: 'COMP-A', status: 'running', currentStepId: 'plan_gate' };
    expect(isGatePending(activeBuild, resolvedGates, items)).toBe(false);
  });

  it('returns false when activeBuild is null', () => {
    expect(isGatePending(null, gates, items)).toBe(false);
  });

  it('returns false when no item found for featureCode', () => {
    const activeBuild = { featureCode: 'COMP-UNKNOWN', status: 'running', currentStepId: 'plan_gate' };
    expect(isGatePending(activeBuild, gates, items)).toBe(false);
  });

  it('returns false when gate belongs to a different item', () => {
    const activeBuild = { featureCode: 'COMP-B', status: 'running', currentStepId: 'plan_gate' };
    // gate-1 is for item-1 (COMP-A), not item-2 (COMP-B)
    expect(isGatePending(activeBuild, gates, items)).toBe(false);
  });
});

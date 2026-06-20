/**
 * pipeline-step-inspector.test.jsx — COMP-PIPE-EDIT-2 / T5.
 *
 * StepInspector renders the selected step's fields, routes field edits through
 * updateStep, routes an id edit through renameStep, surfaces inline validation
 * errors from editorErrors, and disables editing for a read-only (v0.1) spec.
 *
 * The store is mocked (a selector-shaped fake) so the inspector is tested in
 * isolation from the singleton store and its WebSocket boot.
 *
 * Run: npm run test:ui
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// ── Mock store ────────────────────────────────────────────────────────────────
const actions = {
  updateStep: vi.fn(),
  renameStep: vi.fn(),
};

let _state;

vi.mock('../../src/components/vision/useVisionStore.js', () => ({
  useVisionStore: (selector) => (typeof selector === 'function' ? selector(_state) : _state),
}));

const { default: StepInspector } = await import('../../src/components/vision/StepInspector.jsx');

function baseModel() {
  return {
    version: '0.3',
    contracts: { Plan: {}, Report: {} },
    _doc: {},
    flows: [
      {
        name: 'build',
        steps: [
          { id: 'design', agent: 'claude:design:opus', intent: 'Design it', inputs: {}, ensure: [], depends_on: [], _extra: {} },
          { id: 'implement', agent: 'claude:impl:sonnet', intent: 'Build it', inputs: {}, ensure: [], depends_on: ['design'], _extra: {} },
        ],
      },
    ],
  };
}

function setState(overrides = {}) {
  _state = {
    editorModel: baseModel(),
    editorSelectedFlow: 'build',
    editorSelectedStep: 'design',
    editorErrors: { errors: [], warningsByStepId: {} },
    editorReadOnly: false,
    ...actions,
    ...overrides,
  };
}

describe('StepInspector (COMP-PIPE-EDIT-2)', () => {
  beforeEach(() => {
    actions.updateStep.mockReset();
    actions.renameStep.mockReset();
    setState();
  });

  it('populates fields from the selected step', () => {
    render(<StepInspector />);
    expect(screen.getByDisplayValue('design')).toBeTruthy();        // id
    expect(screen.getByDisplayValue('claude:design:opus')).toBeTruthy(); // agent
    expect(screen.getByDisplayValue('Design it')).toBeTruthy();     // intent
  });

  it('output_contract dropdown lists the spec contracts + TaskGraph + (none)', () => {
    render(<StepInspector />);
    const options = Array.from(document.querySelectorAll('option')).map(o => o.value);
    expect(options).toContain('Plan');
    expect(options).toContain('Report');
    expect(options).toContain('TaskGraph');
    expect(options).toContain('(none)');
  });

  it('dedups TaskGraph when the spec already defines it', () => {
    const m = baseModel();
    m.contracts.TaskGraph = { tasks: { type: 'array' } };
    setState({ editorModel: m });
    render(<StepInspector />);
    const tgOptions = Array.from(document.querySelectorAll('option')).filter(o => o.value === 'TaskGraph');
    expect(tgOptions).toHaveLength(1);
  });

  it('editing the intent calls updateStep', () => {
    render(<StepInspector />);
    fireEvent.change(screen.getByDisplayValue('Design it'), { target: { value: 'New intent' } });
    expect(actions.updateStep).toHaveBeenCalledWith('design', { intent: 'New intent' });
  });

  it('committing a changed id calls renameStep', () => {
    render(<StepInspector />);
    const idInput = screen.getByDisplayValue('design');
    fireEvent.change(idInput, { target: { value: 'design_v2' } });
    fireEvent.blur(idInput);
    expect(actions.renameStep).toHaveBeenCalledWith('design', 'design_v2');
  });

  it('shows inline validation errors for the selected step', () => {
    setState({
      editorErrors: { errors: ['bad'], warningsByStepId: { design: ['Step "design" output_contract "X" is not a known contract'] } },
    });
    render(<StepInspector />);
    expect(screen.getByText(/is not a known contract/)).toBeTruthy();
  });

  it('disables editing when the spec is read-only', () => {
    setState({ editorReadOnly: true });
    render(<StepInspector />);
    const idInput = screen.getByDisplayValue('design');
    expect(idInput.disabled).toBe(true);
    fireEvent.change(screen.getByDisplayValue('Design it'), { target: { value: 'nope' } });
    // updateStep is still callable but the inputs are disabled; assert the agent
    // input is disabled (no edits possible through the UI).
    expect(screen.getByDisplayValue('claude:design:opus').disabled).toBe(true);
  });
});

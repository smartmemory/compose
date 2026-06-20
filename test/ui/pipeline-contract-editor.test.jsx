/**
 * pipeline-contract-editor.test.jsx — COMP-PIPE-EDIT-4 / Wave 1.
 *
 * ContractEditor renders the spec's user contracts (EXCLUDING the reserved
 * built-in TaskGraph, which is shown locked), routes add/rename/field edits
 * through the store contract actions, and never offers TaskGraph as editable.
 *
 * The store is mocked (a selector-shaped fake) so the editor is tested in
 * isolation from the singleton store and its WebSocket boot.
 *
 * Run: npm run test:ui
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const actions = {
  addContract: vi.fn(() => true),
  renameContract: vi.fn(() => true),
  deleteContract: vi.fn(() => true),
  setContractField: vi.fn(() => true),
  removeContractField: vi.fn(() => true),
  renameContractField: vi.fn(() => true),
};

let _state;

vi.mock('../../src/components/vision/useVisionStore.js', () => ({
  useVisionStore: (selector) => (typeof selector === 'function' ? selector(_state) : _state),
}));

const { default: ContractEditor } = await import('../../src/components/vision/ContractEditor.jsx');

function baseModel(extra = {}) {
  return {
    version: '0.3',
    contracts: {
      Plan: { summary: { type: 'string' }, risk: { type: 'string', optional: true } },
      ...extra,
    },
    _doc: {},
    flows: [],
  };
}

function setState(overrides = {}) {
  _state = {
    editorModel: baseModel(),
    editorReadOnly: false,
    ...actions,
    ...overrides,
  };
}

describe('ContractEditor (COMP-PIPE-EDIT-4)', () => {
  beforeEach(() => {
    Object.values(actions).forEach(fn => fn.mockReset?.() ?? fn.mockClear?.());
    actions.addContract.mockReturnValue(true);
    setState();
  });

  it('renders user contracts and their fields', () => {
    render(<ContractEditor />);
    expect(screen.getByDisplayValue('Plan')).toBeTruthy();      // contract name
    expect(screen.getByDisplayValue('summary')).toBeTruthy();   // field name
    expect(screen.getByDisplayValue('risk')).toBeTruthy();
  });

  it('adding a contract calls addContract with the typed name', () => {
    render(<ContractEditor />);
    const input = screen.getByTestId('new-contract-name');
    fireEvent.change(input, { target: { value: 'Report' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(actions.addContract).toHaveBeenCalledWith('Report');
  });

  it('renaming a contract calls renameContract on commit', () => {
    render(<ContractEditor />);
    const nameInput = screen.getByDisplayValue('Plan');
    fireEvent.change(nameInput, { target: { value: 'PlanV2' } });
    fireEvent.blur(nameInput);
    expect(actions.renameContract).toHaveBeenCalledWith('Plan', 'PlanV2');
  });

  it('editing a field type calls setContractField', () => {
    render(<ContractEditor />);
    const row = screen.getByTestId('contract-field-Plan-summary');
    const select = row.querySelector('select');
    fireEvent.change(select, { target: { value: 'number' } });
    expect(actions.setContractField).toHaveBeenCalledWith('Plan', 'summary', { type: 'number' });
  });

  it('deleting a contract calls deleteContract', () => {
    render(<ContractEditor />);
    const block = screen.getByTestId('contract-Plan');
    const delBtn = block.querySelector('button[title="Delete contract"]');
    fireEvent.click(delBtn);
    expect(actions.deleteContract).toHaveBeenCalledWith('Plan');
  });

  it('TaskGraph is shown locked and never editable', () => {
    setState({ editorModel: baseModel({ TaskGraph: { tasks: { type: 'array' } } }) });
    render(<ContractEditor />);
    // The locked indicator is present.
    expect(screen.getByTestId('contract-taskgraph-locked')).toBeTruthy();
    // TaskGraph is NOT rendered as an editable contract block.
    expect(screen.queryByTestId('contract-TaskGraph')).toBeNull();
    // No editable input carries the TaskGraph name.
    expect(screen.queryByDisplayValue('TaskGraph')).toBeNull();
  });

  it('disables editing when the spec is read-only', () => {
    setState({ editorReadOnly: true });
    render(<ContractEditor />);
    // No add-contract input in read-only mode.
    expect(screen.queryByTestId('new-contract-name')).toBeNull();
    // Contract name input is disabled.
    expect(screen.getByDisplayValue('Plan').disabled).toBe(true);
  });

  it('surfaces editorErrors (e.g. a blocked delete reason) in the panel', () => {
    setState({ editorErrors: { errors: ['Cannot delete contract "Plan": still referenced by step.output_contract'], warningsByStepId: {} } });
    render(<ContractEditor />);
    const banner = screen.getByTestId('contract-errors');
    expect(banner.textContent).toMatch(/Cannot delete contract "Plan"/);
  });
});

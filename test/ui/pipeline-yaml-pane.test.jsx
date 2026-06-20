/**
 * pipeline-yaml-pane.test.jsx — COMP-PIPE-EDIT-6 / Wave 2.
 *
 * YamlPane renders the model as YAML text (a comment-stripped projection via
 * modelToYamlObject), routes edits through setYamlBuffer + a debounced flushYaml,
 * and shows the store's editorYamlError inline. The store is mocked (a selector-
 * shaped fake) so the pane is tested in isolation from the singleton store boot.
 * The real pipeline-model lib is used for serialization.
 *
 * Run: npm run test:ui
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { specToModel } from '../../src/lib/pipeline-model.js';

const actions = {
  setYamlBuffer: vi.fn(),
  flushYaml: vi.fn(() => true),
};

let _state;

vi.mock('../../src/components/vision/useVisionStore.js', () => ({
  useVisionStore: (selector) => (typeof selector === 'function' ? selector(_state) : _state),
}));

const { default: YamlPane } = await import('../../src/components/vision/YamlPane.jsx');

function baseModel() {
  return specToModel({
    version: '0.3',
    contracts: { Plan: { fields: { summary: 'string' } } },
    flows: {
      build: { steps: [{ id: 'design', agent: 'claude:design:opus', intent: 'Design it', output_contract: 'Plan' }] },
    },
  });
}

function setState(overrides = {}) {
  _state = {
    editorModel: baseModel(),
    editorReadOnly: false,
    editorYamlError: null,
    editorYamlBuffer: null,
    ...actions,
    ...overrides,
  };
}

describe('YamlPane (COMP-PIPE-EDIT-6)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    actions.setYamlBuffer.mockClear();
    actions.flushYaml.mockClear();
    actions.flushYaml.mockReturnValue(true);
    setState();
  });

  afterEach(() => { vi.useRealTimers(); });

  it('renders the model serialized as YAML', () => {
    render(<YamlPane />);
    const ta = screen.getByTestId('yaml-pane-textarea');
    // The serialized projection contains the flow + step from the model.
    expect(ta.value).toMatch(/build:/);
    expect(ta.value).toMatch(/design/);
    expect(ta.value).toMatch(/claude:design:opus/);
  });

  it('an edit stores the buffer and flushes after the debounce', () => {
    render(<YamlPane />);
    const ta = screen.getByTestId('yaml-pane-textarea');
    fireEvent.change(ta, { target: { value: 'version: "0.3"\nflows: {}\n' } });
    // Buffer set immediately; flush deferred to the debounce.
    expect(actions.setYamlBuffer).toHaveBeenCalledWith('version: "0.3"\nflows: {}\n');
    expect(actions.flushYaml).not.toHaveBeenCalled();
    vi.advanceTimersByTime(350);
    expect(actions.flushYaml).toHaveBeenCalledTimes(1);
  });

  it('shows the store parse error inline', () => {
    setState({ editorYamlError: 'YAML parse error: bad token' });
    render(<YamlPane />);
    expect(screen.getByTestId('yaml-pane-error').textContent).toMatch(/parse error/i);
  });

  it('is read-only for v0.1 specs (edits do not call the store)', () => {
    setState({ editorReadOnly: true });
    render(<YamlPane />);
    const ta = screen.getByTestId('yaml-pane-textarea');
    expect(ta.readOnly).toBe(true);
    fireEvent.change(ta, { target: { value: 'mutated' } });
    expect(actions.setYamlBuffer).not.toHaveBeenCalled();
  });

  // FINDING 1a: a buffer that survived a previous unmount must be restored into
  // the textarea on remount, not silently hidden behind the serialized model.
  it('restores a still-pending store buffer into the textarea on mount', () => {
    setState({ editorYamlBuffer: 'version: "0.3"\nflows:\n  edited: {}\n' });
    render(<YamlPane />);
    const ta = screen.getByTestId('yaml-pane-textarea');
    expect(ta.value).toBe('version: "0.3"\nflows:\n  edited: {}\n');
    // It must NOT show the serialized model.
    expect(ta.value).not.toMatch(/claude:design:opus/);
  });

  // FINDING 1b: on unmount the pane flushes synchronously so a pending buffer is
  // applied/surfaced, never stranded (where it keeps blocking saveSpec).
  it('flushes synchronously on unmount (no stranded buffer)', () => {
    setState({ editorYamlBuffer: 'version: "0.3"\nflows: {}\n' });
    const { unmount } = render(<YamlPane />);
    actions.flushYaml.mockClear();
    unmount();
    expect(actions.flushYaml).toHaveBeenCalledTimes(1);
  });

  it('unmount calls flush even with no pending buffer (store-side no-op)', () => {
    setState({ editorYamlBuffer: null });
    const { unmount } = render(<YamlPane />);
    actions.flushYaml.mockClear();
    unmount();
    // The pane always flushes on unmount; flushYaml itself no-ops when the store
    // has no buffer, so this is safe.
    expect(actions.flushYaml).toHaveBeenCalledTimes(1);
  });
});

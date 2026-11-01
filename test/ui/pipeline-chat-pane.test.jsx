/**
 * pipeline-chat-pane.test.jsx — COMP-PIPE-EDIT-CHAT-PANE-1.
 *
 * (1) the pure pane rules, (2) PipelineEditor's right pane: chat by default, the inspector on a
 * selection, the tab strip, the toolbar toggles and the phone bottom sheet, (3) PipelineChatPane:
 * a proposal renders as a diff and Apply is off with a reason when it cannot run.
 * The store is a selector-shaped fake and the heavy children are stubbed, so only the pane
 * wiring is under test.
 *
 * Run: npm run test:ui
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { specToModel } from '../../src/lib/pipeline-model.js';
import {
  resolvePane, paneOnSelect, paneToggle, applyBlockReason, hashText, serializeSpec, STALE_MESSAGE,
} from '../../src/components/vision/pipeline-pane-state.js';

let _state;
const actions = {
  loadSpecList: vi.fn(), loadSpecForEdit: vi.fn(), selectFlow: vi.fn(), addStep: vi.fn(), saveSpec: vi.fn(),
  saveAsTemplate: vi.fn(), resolveConflict: vi.fn(), collapseSelectedToSubflow: vi.fn(),
  loadChat: vi.fn(), sendChat: vi.fn(), cancelChat: vi.fn(), clearChat: vi.fn(),
  applyChatProposal: vi.fn(async () => ({ ok: true })), revertChatProposal: vi.fn(() => ({ ok: true })),
};

vi.mock('../../src/components/vision/useVisionStore.js', () => {
  const hook = (selector) => (typeof selector === 'function' ? selector(_state) : _state);
  hook.getState = () => _state;
  return { useVisionStore: hook };
});
vi.mock('../../src/components/vision/PipelineEditorCanvas.jsx', () => ({ default: React.forwardRef(() => <div data-testid="canvas" />) }));
vi.mock('../../src/components/vision/StepInspector.jsx', () => ({ default: () => <div data-testid="inspector" /> }));
vi.mock('../../src/components/vision/ContractEditor.jsx', () => ({ default: () => <div data-testid="contracts" /> }));
vi.mock('../../src/components/vision/YamlPane.jsx', () => ({ default: () => <div data-testid="yaml" /> }));

const { default: PipelineEditor } = await import('../../src/components/vision/PipelineEditor.jsx');
const { default: PipelineChatPane } = await import('../../src/components/vision/PipelineChatPane.jsx');

const model = () => specToModel({
  version: '0.3',
  flows: { build: { steps: [{ id: 'design', agent: 'claude:design:opus', intent: 'Design it' }] } },
});

function setState(over = {}) {
  _state = {
    editorSpecs: [], editorSpecFile: 'demo.stratum.yaml', editorModel: model(), editorSelectedFlow: 'build',
    editorSelectedStep: null, editorDirty: false, editorErrors: { errors: [], warningsByStepId: {} },
    editorReadOnly: false, editorConflict: null, editorYamlBuffer: null, editorYamlError: null,
    chatByFile: {}, chatUndo: null, ...actions, ...over,
  };
}
const shownPane = () => ['inspector', 'chat-pane', 'contracts', 'yaml'].find((id) => screen.queryByTestId(id));
const setWidth = (w) => { Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w }); };

beforeEach(() => { vi.clearAllMocks(); setWidth(1280); setState(); });
afterEach(() => cleanup());

describe('pane rules (pure)', () => {
  it('resolvePane: auto follows the selection, the rest pin', () => {
    const rows = [
      ['auto', null, 'chat'], ['auto', 'a', 'inspector'],
      ['chat', 'a', 'chat'], ['contracts', null, 'contracts'], ['yaml', 'a', 'yaml'],
    ];
    for (const [pane, step, want] of rows) expect(resolvePane(pane, step), `${pane}/${step}`).toBe(want);
  });
  it('paneOnSelect: only a new non-null step resets to auto; toggles return to auto', () => {
    expect(paneOnSelect('yaml', null, 'a')).toBe('auto');
    expect(paneOnSelect('chat', 'a', 'b')).toBe('auto');
    expect(paneOnSelect('yaml', 'a', 'a')).toBe('yaml');
    expect(paneOnSelect('yaml', 'a', null)).toBe('yaml');
    expect(paneToggle('yaml', 'yaml')).toBe('auto');
    expect(paneToggle('auto', 'yaml')).toBe('yaml');
  });
  it('applyBlockReason: read-only, invalid, pending buffer, stale, then clear', () => {
    const ok = { yaml: 'y', baseHash: 'h', valid: true };
    expect(applyBlockReason({ proposal: ok, currentHash: 'h', readOnly: true })).toMatch(/read-only/);
    expect(applyBlockReason({ proposal: { ...ok, valid: false, error: 'bad ref' }, currentHash: 'h' })).toBe('bad ref');
    expect(applyBlockReason({ proposal: ok, currentHash: 'h', bufferPending: true })).toMatch(/YAML pane/);
    expect(applyBlockReason({ proposal: ok, currentHash: 'other' })).toBe(STALE_MESSAGE);
    expect(applyBlockReason({ proposal: ok, currentHash: 'h' })).toBeNull();
  });
});

describe('PipelineEditor right pane', () => {
  it('shows chat with no step, the inspector on select, chat again on deselect', () => {
    const { rerender } = render(<PipelineEditor />);
    expect(shownPane()).toBe('chat-pane');
    setState({ editorSelectedStep: 'design' }); rerender(<PipelineEditor />);
    expect(shownPane()).toBe('inspector');
    setState({ editorSelectedStep: null }); rerender(<PipelineEditor />);
    expect(shownPane()).toBe('chat-pane');
  });

  it('tabs reach Chat, Contracts and YAML; Step is off with no selection', () => {
    render(<PipelineEditor />);
    expect(screen.getByTestId('pane-tab-inspector').disabled).toBe(true);
    fireEvent.click(screen.getByTestId('pane-tab-contracts')); expect(shownPane()).toBe('contracts');
    fireEvent.click(screen.getByTestId('pane-tab-yaml')); expect(shownPane()).toBe('yaml');
    fireEvent.click(screen.getByTestId('pane-tab-chat')); expect(shownPane()).toBe('chat-pane');
  });

  it('Chat stays pinned while a step is selected; selecting a step from YAML shows the inspector', () => {
    setState({ editorSelectedStep: 'design' });
    const { rerender } = render(<PipelineEditor />);
    fireEvent.click(screen.getByTestId('pane-tab-chat'));
    expect(shownPane()).toBe('chat-pane');
    fireEvent.click(screen.getByTestId('pane-tab-inspector'));
    expect(shownPane()).toBe('inspector');

    setState({ editorSelectedStep: null }); rerender(<PipelineEditor />);
    fireEvent.click(screen.getByTestId('pane-tab-yaml')); expect(shownPane()).toBe('yaml');
    setState({ editorSelectedStep: 'design' }); rerender(<PipelineEditor />);
    expect(shownPane()).toBe('inspector');
  });

  it('the toolbar Contracts and YAML toggles still work and toggling off returns to auto', () => {
    render(<PipelineEditor />);
    fireEvent.click(screen.getByTestId('contracts-toggle')); expect(shownPane()).toBe('contracts');
    fireEvent.click(screen.getByTestId('contracts-toggle')); expect(shownPane()).toBe('chat-pane');
    fireEvent.click(screen.getByTestId('yaml-toggle')); expect(shownPane()).toBe('yaml');
    fireEvent.click(screen.getByTestId('yaml-toggle')); expect(shownPane()).toBe('chat-pane');
  });

  it('below 768px the pane is a bottom sheet with the same tabs; at 1280 it is the side column', () => {
    setWidth(390);
    const { unmount } = render(<PipelineEditor />);
    expect(screen.getByTestId('editor-body').dataset.phone).toBe('1');
    expect(screen.getByTestId('editor-body').className).toMatch(/flex-col/);
    expect(screen.getByTestId('side-pane').className).toMatch(/max-h-\[45vh\]/);
    expect(screen.getByTestId('side-pane').className).toMatch(/(^| )h-\[45vh\]/); // definite, or the chat input clips
    for (const t of ['chat', 'inspector', 'contracts', 'yaml']) expect(screen.getByTestId(`pane-tab-${t}`)).toBeTruthy();
    unmount();
    setWidth(1280); render(<PipelineEditor />);
    expect(screen.getByTestId('editor-body').dataset.phone).toBe('0');
    expect(screen.getByTestId('side-pane').className).toMatch(/w-80/);
  });
});

describe('PipelineChatPane', () => {
  const withProposal = async (over = {}, state = {}) => {
    const m = model();
    const yaml = serializeSpec(m);
    const proposal = { yaml: yaml.replace('Design it', 'Design it better'), baseHash: await hashText(yaml), valid: true, error: null, ...over };
    setState({
      editorModel: m,
      chatByFile: { 'demo.stratum.yaml': { messages: [{ role: 'user', text: 'tighten' }, { role: 'assistant', text: 'done', proposal, applied: false }], busy: false, error: null } },
      ...state,
    });
  };

  it('loads history for the open spec and shows the empty state', () => {
    render(<PipelineChatPane />);
    expect(actions.loadChat).toHaveBeenCalledWith('demo.stratum.yaml');
    expect(screen.getByTestId('chat-empty')).toBeTruthy();
  });

  it('a proposal renders as a diff against the current yaml and Apply calls the store', async () => {
    await withProposal();
    render(<PipelineChatPane />);
    expect(screen.getByText(/Show changes \(\+1 -1\)/)).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('chat-apply-1').disabled).toBe(false));
    await act(async () => { fireEvent.click(screen.getByTestId('chat-apply-1')); });
    expect(actions.applyChatProposal).toHaveBeenCalledWith(1);
  });

  it('Apply is off with the reason for a stale, invalid, read-only or pending-buffer proposal', async () => {
    const rows = [
      ['stale', { baseHash: 'not-the-current-hash' }, {}, /Spec changed, ask again/],
      ['invalid', { valid: false, error: 'Spec validation failed: bad ref' }, {}, /bad ref/],
      ['read-only', {}, { editorReadOnly: true }, /read-only/],
      ['pending buffer', {}, { editorYamlBuffer: 'half typed' }, /YAML pane/],
    ];
    for (const [name, over, state, expected] of rows) {
      cleanup();
      await withProposal(over, state);
      render(<PipelineChatPane />);
      await waitFor(() => expect(screen.getByTestId('chat-apply-1').disabled, name).toBe(true));
      expect(screen.getByTestId('chat-apply-1').title, name).toMatch(expected);
    }
  });

  it('an applied proposal shows Applied and Revert only while its undo is held', async () => {
    await withProposal();
    _state.chatByFile['demo.stratum.yaml'].messages[1].applied = true;
    setState({ ..._state, chatUndo: { file: 'demo.stratum.yaml', index: 1, yaml: 'y', appliedYaml: serializeSpec(_state.editorModel), dirty: false, scope: 'flow' } });
    render(<PipelineChatPane />);
    expect(screen.getByTestId('chat-applied-1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('chat-revert-1'));
    expect(actions.revertChatProposal).toHaveBeenCalled();
    cleanup();
    setState({ ..._state, chatUndo: null });
    render(<PipelineChatPane />);
    expect(screen.queryByTestId('chat-revert-1')).toBeNull();
  });

  it('after an edit past Apply, Revert is hidden and a one-line reason says why', async () => {
    await withProposal();
    _state.chatByFile['demo.stratum.yaml'].messages[1].applied = true;
    setState({ ..._state, chatUndo: { file: 'demo.stratum.yaml', index: 1, yaml: 'y', appliedYaml: 'not the current spec', dirty: false, scope: 'flow' } });
    render(<PipelineChatPane />);
    expect(screen.queryByTestId('chat-revert-1')).toBeNull();
    expect((await screen.findByTestId('chat-revert-reason-1', {}, { timeout: 5000 })).textContent).toMatch(/edited the spec after Apply/);
  });
});

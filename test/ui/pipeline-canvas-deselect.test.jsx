/**
 * pipeline-canvas-deselect.test.jsx — COMP-PIPE-EDIT-CHAT-PANE-1 F3.
 *
 * A tap on the empty canvas clears the selected step, so the right pane resolves back to chat.
 * The decision is the pure `backgroundTapAction`; the pane it leads to is `resolvePane`.
 * The cytoscape `tap` wiring itself is checked live on 5195, not here (no cytoscape in jsdom).
 *
 * Run: npm run test:ui
 */
import { describe, it, expect } from 'vitest';
import { backgroundTapAction } from '../../src/components/vision/PipelineEditorCanvas.jsx';
import { resolvePane } from '../../src/components/vision/pipeline-pane-state.js';

// Mirrors the store: selectStep(id) sets the selection, the handler calls selectStep(null) on 'clear'.
const afterTap = (selected, tap) => {
  if (tap.kind === 'node') return tap.id;
  return backgroundTapAction(tap) === 'clear' ? null : selected;
};

const ROWS = [
  // name,                          tap,                                    selected, expectSel, expectPane
  ['background tap clears',         { kind: 'bg' },                         'design', null,     'chat'],
  ['node tap still selects',        { kind: 'node', id: 'ship' },           'design', 'ship',   'inspector'],
  ['background in connect mode',    { kind: 'bg', connectMode: true },      'design', 'design', 'inspector'],
  ['shift background is unchanged', { kind: 'bg', shift: true },            'design', 'design', 'inspector'],
  ['background with none selected', { kind: 'bg' },                         null,     null,     'chat'],
];

describe('canvas background tap', () => {
  it.each(ROWS)('%s', (_name, tap, selected, expectSel, expectPane) => {
    const next = afterTap(selected, tap);
    expect(next).toBe(expectSel);
    expect(resolvePane('auto', next)).toBe(expectPane);
  });
});

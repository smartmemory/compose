/**
 * COMP-AUDIT-17 slice 2: the Focus button in the right panel's item header (props only, store mocked).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', () => ({ wsFetch: vi.fn(async () => ({ ok: true, json: async () => ({ enabled: false }) })) }));
vi.mock('../../src/contexts/WorkspaceContext.jsx', () => ({ useWorkspace: () => ({ workspace: { id: 'w' } }) }));

let _state;
vi.mock('../../src/components/vision/useVisionStore.js', () => ({
  useVisionStore: (selector) => (typeof selector === 'function' ? selector(_state) : _state),
}));
vi.mock('../../src/components/vision/ItemDetailPanel.jsx', () => ({ default: () => <div data-testid="detail-stub" /> }));

import ContextItemDetail from '../../src/components/cockpit/ContextItemDetail.jsx';

const ITEMS = [
  { id: 'a', featureCode: 'FEAT-A' },
  { id: 'b', lifecycle: { featureCode: 'FEAT-B' } },
  { id: 'c', feature_code: 'FEAT-C' },
  { id: 'n', type: 'idea', title: 'FEAT-A in the title' },
];

beforeEach(() => {
  _state = { items: ITEMS, connections: [], gates: [], updateItem: vi.fn(), deleteItem: vi.fn(), createConnection: vi.fn(), deleteConnection: vi.fn(), resolveGate: vi.fn(), activeBuild: null, sessions: [], agentErrors: [] };
});

describe('<ContextItemDetail> Focus button (one row table)', () => {
  const rows = [
    { name: 'featureCode', id: 'a', focused: null, label: /Focus FEAT-A/, disabled: false },
    { name: 'lifecycle.featureCode', id: 'b', focused: null, label: /Focus FEAT-B/, disabled: false },
    { name: 'feature_code', id: 'c', focused: null, label: /Focus FEAT-C/, disabled: false },
    { name: 'already focused shows the state and is inert', id: 'a', focused: 'FEAT-A', label: /Focused: FEAT-A/, disabled: true },
    { name: 'another feature is focused: this one can still be focused', id: 'b', focused: 'FEAT-A', label: /Focus FEAT-B/, disabled: false },
    { name: 'no code (title match is not a code): no button', id: 'n', focused: null, label: null },
  ];
  it('rows', () => {
    for (const r of rows) {
      const onFocusFeature = vi.fn();
      const { unmount } = render(<ContextItemDetail itemId={r.id} onSelect={() => {}} onClose={() => {}} focusedFeature={r.focused} onFocusFeature={onFocusFeature} />);
      const btn = screen.queryByTestId('focus-feature');
      if (!r.label) { expect(btn, r.name).toBeNull(); unmount(); continue; }
      expect(btn.textContent, r.name).toMatch(r.label);
      expect(btn.disabled, r.name).toBe(r.disabled);
      if (!r.disabled) {
        fireEvent.click(btn);
        expect(onFocusFeature, r.name).toHaveBeenCalledWith(expect.objectContaining({ id: r.id }));
      }
      unmount();
    }
  });
});

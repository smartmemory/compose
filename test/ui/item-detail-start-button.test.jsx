import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ItemDetailPanel from '../../src/components/vision/ItemDetailPanel.jsx';

class FakeWS { constructor() {} close() {} set onmessage(_) {} set onerror(_) {} set onclose(_) {} set onopen(_) {} }

const noop = () => {};
const baseProps = {
  items: [], connections: [], gates: [],
  onUpdate: noop, onDelete: noop, onCreateConnection: noop, onDeleteConnection: noop,
  onSelect: noop, onClose: noop, onPressureTest: noop, onResolveGate: noop,
};

function renderPanel(item) {
  return render(<ItemDetailPanel item={item} {...baseProps} />);
}

describe('ItemDetailPanel — Start button gating (#31)', () => {
  beforeEach(() => { globalThis.WebSocket = FakeWS; });

  it('shows the Start button for a UI item with no lifecycle', () => {
    renderPanel({ id: 'ui-1', title: 'Idea', type: 'feature', status: 'planned' });
    expect(screen.queryByTestId('item-start-build')).not.toBeNull();
  });

  it('hides the Start button once the item has a lifecycle', () => {
    renderPanel({ id: 'ui-2', title: 'Building', type: 'feature', status: 'in_progress', lifecycle: { featureCode: 'FOO-1' } });
    expect(screen.queryByTestId('item-start-build')).toBeNull();
  });

  it('hides the Start button for question items and killed items', () => {
    const { unmount } = renderPanel({ id: 'q-1', title: 'Q?', type: 'question', status: 'planned' });
    expect(screen.queryByTestId('item-start-build')).toBeNull();
    unmount();
    renderPanel({ id: 'k-1', title: 'Dead', type: 'feature', status: 'killed' });
    expect(screen.queryByTestId('item-start-build')).toBeNull();
  });
});

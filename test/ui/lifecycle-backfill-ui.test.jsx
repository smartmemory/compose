import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ItemDetailPanel from '../../src/components/vision/ItemDetailPanel.jsx';
import ContextPipelineDots from '../../src/components/vision/ContextPipelineDots.jsx';
import { LIFECYCLE_PHASE_LABELS } from '../../src/components/vision/constants.js';

const noop = () => {};
const panelProps = {
  items: [], connections: [], gates: [], onUpdate: noop, onDelete: noop, onCreateConnection: noop,
  onDeleteConnection: noop, onSelect: noop, onClose: noop, onPressureTest: noop, onResolveGate: noop,
};

describe('COMP-LIFECYCLE-BACKFILL UI provenance', () => {
  it('labels the reconstructed terminal but badges only historical backfilled phases', () => {
    expect(LIFECYCLE_PHASE_LABELS.complete_backfilled).toBe('Complete (backfilled)');
    render(<ItemDetailPanel {...panelProps} item={{
      id: 'bf-1', type: 'feature', title: 'Fixture feature', status: 'complete',
      lifecycle: {
        currentPhase: 'complete_backfilled', featureCode: 'BF-1',
        phaseHistory: [
          { phase: 'design', outcome: 'backfilled', origin: 'backfill' },
          { phase: 'complete_backfilled', outcome: 'backfilled', origin: 'live' },
        ],
      },
    }} />);
    expect(screen.getAllByText('Complete (backfilled)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Backfilled')).toHaveLength(1);
  });

  it('mutes the historical backfilled dot, not the live terminal', () => {
    render(<ContextPipelineDots item={{ featureCode: 'BF-1', phaseHistory: [
      { phase: 'design', origin: 'backfill', confidence: 0.9 },
      { phase: 'complete_backfilled', origin: 'live', confidence: 1.0 },
    ] }} activeBuild={null} />);
    const dot = screen.getByTitle('Design').querySelector('div');
    expect(dot?.className).toContain('opacity-50');
    fireEvent.click(screen.getByTitle('Design'));
    expect(screen.getByText('Origin: backfill')).toBeTruthy();
    expect(screen.getByText('Confidence: 0.9')).toBeTruthy();
  });
});

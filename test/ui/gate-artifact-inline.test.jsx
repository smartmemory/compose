/**
 * COMP-COCKPIT-4: GateView renders the gate's artifactSnapshot inline
 * (collapsible) so a reviewer can read the artifact without leaving for Docs.
 * Snapshot-only — no live fetch (gate immutability).
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import GateView from '../../src/components/vision/GateView.jsx';

vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: '<svg></svg>' }) },
}));

const items = [{ id: 'i1', title: 'My feature', featureCode: 'FC-1' }];

function gateWith(snapshot) {
  return {
    id: 'g1', itemId: 'i1', status: 'pending',
    fromPhase: 'design', toPhase: 'blueprint', stepId: 'write_design',
    createdAt: new Date().toISOString(),
    artifactSnapshot: snapshot,
  };
}

describe('GateView inline artifact (COCKPIT-4)', () => {
  it('shows a View artifact toggle when a snapshot exists, hidden by default', () => {
    render(<GateView gates={[gateWith('# Design\n\nHello body')]} items={items} onResolve={vi.fn()} onSelect={vi.fn()} />);
    expect(screen.getByTestId('gate-artifact-toggle')).toBeTruthy();
    // body collapsed initially
    expect(screen.queryByTestId('gate-artifact-body')).toBeNull();
  });

  it('expands to render the snapshot markdown body on click', () => {
    render(<GateView gates={[gateWith('# Design Heading\n\nThe body text here')]} items={items} onResolve={vi.fn()} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByTestId('gate-artifact-toggle'));
    const body = screen.getByTestId('gate-artifact-body');
    expect(body).toBeTruthy();
    expect(body.textContent).toContain('Design Heading');
    expect(body.textContent).toContain('The body text here');
  });

  it('renders no artifact toggle when the gate has no snapshot', () => {
    render(<GateView gates={[gateWith(null)]} items={items} onResolve={vi.fn()} onSelect={vi.fn()} />);
    expect(screen.queryByTestId('gate-artifact-toggle')).toBeNull();
  });
});

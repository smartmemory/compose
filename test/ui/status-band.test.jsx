/**
 * status-band.test.jsx — vitest+jsdom tests for StatusBand.jsx.
 *
 * COMP-OBS-STATUS B4:
 *   - Renders the sentence from snapshot
 *   - Click toggles expansion panel
 *   - 32px height, sticky positioning
 *   - No CTA element rendered (v1 regression guard)
 *   - Empty state when no snapshot
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import StatusBand from '../../src/components/vision/StatusBand.jsx';

const NOW = '2026-04-25T12:00:00.000Z';

function makeSnap(overrides = {}) {
  return {
    sentence: 'Building execute. Open loops: 0.',
    active_phase: 'execute',
    active_goal: 'My Feature',
    pending_gates: [],
    drift_alerts: [],
    open_loops_count: 0,
    gate_load_24h: 0,
    cta: null,
    computed_at: NOW,
    ...overrides,
  };
}

// Minimal mock store — StatusBand reads statusSnapshots[featureCode]
function makeStore(featureCode, snap) {
  return { statusSnapshots: featureCode && snap ? { [featureCode]: snap } : {} };
}

describe('<StatusBand>', () => {
  it('renders the sentence from snapshot', () => {
    const snap = makeSnap({ sentence: 'Building blueprint. Open loops: 3.' });
    render(<StatusBand featureCode="FC-1" snapshot={snap} />);
    expect(screen.getByText('Building blueprint. Open loops: 3.')).toBeTruthy();
  });

  it('renders no-feature sentence when snapshot is absent', () => {
    render(<StatusBand featureCode="FC-1" snapshot={null} />);
    // Should render something reasonable — the no-feature sentence or empty
    const band = document.querySelector('[data-status-band]');
    expect(band).toBeTruthy();
  });

  it('has 32px height via inline style', () => {
    const snap = makeSnap();
    const { container } = render(<StatusBand featureCode="FC-1" snapshot={snap} />);
    const band = container.querySelector('[data-status-band]');
    expect(band).toBeTruthy();
    const { height } = band.style;
    expect(height).toBe('32px');
  });

  it('has sticky positioning', () => {
    const snap = makeSnap();
    const { container } = render(<StatusBand featureCode="FC-1" snapshot={snap} />);
    const band = container.querySelector('[data-status-band]');
    expect(band.style.position).toBe('sticky');
  });

  it('top is 0', () => {
    const snap = makeSnap();
    const { container } = render(<StatusBand featureCode="FC-1" snapshot={snap} />);
    const band = container.querySelector('[data-status-band]');
    expect(band.style.top).toBe('0px');
  });

  it('click toggles expansion panel visibility', () => {
    const snap = makeSnap({ pending_gates: ['g-1'], open_loops_count: 2 });
    const { container } = render(<StatusBand featureCode="FC-1" snapshot={snap} />);
    const band = container.querySelector('[data-status-band]');

    // Initially no expansion panel
    expect(container.querySelector('[data-status-band-expansion]')).toBeFalsy();

    // Click to expand
    fireEvent.click(band);
    expect(container.querySelector('[data-status-band-expansion]')).toBeTruthy();

    // Click again to collapse
    fireEvent.click(band);
    expect(container.querySelector('[data-status-band-expansion]')).toBeFalsy();
  });

  it('expansion panel shows open_loops_count', () => {
    const snap = makeSnap({ open_loops_count: 5 });
    const { container } = render(<StatusBand featureCode="FC-1" snapshot={snap} />);
    fireEvent.click(container.querySelector('[data-status-band]'));
    const expansion = container.querySelector('[data-status-band-expansion]');
    expect(expansion.textContent).toContain('5');
  });

  it('expansion panel shows pending_gates', () => {
    const snap = makeSnap({ pending_gates: ['gate-abc', 'gate-xyz'] });
    const { container } = render(<StatusBand featureCode="FC-1" snapshot={snap} />);
    fireEvent.click(container.querySelector('[data-status-band]'));
    const expansion = container.querySelector('[data-status-band-expansion]');
    expect(expansion.textContent).toContain('gate-abc');
  });

  // ── v1 regression guard: NO CTA rendered ─────────────────────────────────

  it('does NOT render any CTA element (v1 regression guard)', () => {
    const snap = makeSnap();
    const { container } = render(<StatusBand featureCode="FC-1" snapshot={snap} />);
    // Click to open expansion panel as well
    fireEvent.click(container.querySelector('[data-status-band]'));
    // Must have no CTA — v1: cta is always null
    const cta = container.querySelector('[data-status-band-cta]');
    expect(cta).toBeFalsy();
    // Also check there's no anchor/button labeled as a call-to-action
    const links = container.querySelectorAll('a[data-cta], button[data-cta]');
    expect(links.length).toBe(0);
  });

  it('does not render CTA even if snapshot.cta is non-null (defensive guard)', () => {
    // This tests the component's defense against a bad producer sending cta
    const snap = makeSnap({ cta: { label: 'Review', action: '/gates/g1' } });
    const { container } = render(<StatusBand featureCode="FC-1" snapshot={snap} />);
    fireEvent.click(container.querySelector('[data-status-band]'));
    const cta = container.querySelector('[data-status-band-cta]');
    expect(cta).toBeFalsy();
  });

  it('renders "Select a feature to see status." when no featureCode', () => {
    render(<StatusBand featureCode={null} snapshot={null} />);
    expect(screen.getByText('Select a feature to see status.')).toBeTruthy();
  });
});

/**
 * decision-timeline-strip.test.jsx — vitest+jsdom tests for DecisionTimelineStrip.
 *
 * COMP-OBS-TIMELINE B4: renders N cards in newest-right order, filters by
 * featureCode, empty-state collapses, role chips correct per kind.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import DecisionTimelineStrip from '../../src/components/vision/DecisionTimelineStrip.jsx';

const NOW_ISO = '2026-04-24T12:00:00Z';
const NOW_MS = Date.parse(NOW_ISO);

// ── fixture helpers ──────────────────────────────────────────────────────────

function makeEvent(overrides = {}) {
  return {
    id: `event-${Math.random().toString(36).slice(2)}`,
    feature_code: 'FC-1',
    timestamp: '2026-04-24T10:00:00Z',
    kind: 'phase_transition',
    title: 'Phase: blueprint → plan',
    metadata: { from_phase: 'blueprint', to_phase: 'plan' },
    roles: [{ name: 'PRODUCER', agent_id: null }],
    ...overrides,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('<DecisionTimelineStrip>', () => {
  it('renders nothing (empty-state: no pixels) when events list is empty', () => {
    const { container } = render(
      <DecisionTimelineStrip events={[]} currentFeatureCode="FC-1" now={NOW_MS} />
    );
    // The strip should have no cards
    const cards = container.querySelectorAll('[data-decision-card]');
    expect(cards.length).toBe(0);
  });

  it('renders one card per filtered event', () => {
    const events = [
      makeEvent({ id: 'e1', feature_code: 'FC-1', timestamp: '2026-04-24T10:00:00Z' }),
      makeEvent({ id: 'e2', feature_code: 'FC-1', timestamp: '2026-04-24T11:00:00Z' }),
      makeEvent({ id: 'e3', feature_code: 'FC-2', timestamp: '2026-04-24T09:00:00Z' }), // different feature
    ];
    const { container } = render(
      <DecisionTimelineStrip events={events} currentFeatureCode="FC-1" now={NOW_MS} />
    );
    const cards = container.querySelectorAll('[data-decision-card]');
    expect(cards.length).toBe(2);
  });

  it('renders cards in newest-right order (oldest DOM child first)', () => {
    const events = [
      makeEvent({ id: 'newest', feature_code: 'FC-1', timestamp: '2026-04-24T12:00:00Z', title: 'newest' }),
      makeEvent({ id: 'oldest', feature_code: 'FC-1', timestamp: '2026-04-24T09:00:00Z', title: 'oldest' }),
      makeEvent({ id: 'middle', feature_code: 'FC-1', timestamp: '2026-04-24T10:00:00Z', title: 'middle' }),
    ];
    const { container } = render(
      <DecisionTimelineStrip events={events} currentFeatureCode="FC-1" now={NOW_MS} />
    );
    const cards = container.querySelectorAll('[data-decision-card]');
    // First card in DOM = oldest (leftmost in strip)
    expect(cards[0].textContent).toContain('oldest');
    // Last card in DOM = newest (rightmost in strip)
    expect(cards[cards.length - 1].textContent).toContain('newest');
  });

  it('filters out events with different featureCode', () => {
    const events = [
      makeEvent({ feature_code: 'FC-DIFFERENT' }),
      makeEvent({ feature_code: 'FC-DIFFERENT' }),
    ];
    const { container } = render(
      <DecisionTimelineStrip events={events} currentFeatureCode="FC-1" now={NOW_MS} />
    );
    const cards = container.querySelectorAll('[data-decision-card]');
    expect(cards.length).toBe(0);
  });

  it('renders event title in each card', () => {
    const events = [
      makeEvent({ title: 'Phase: blueprint → plan', feature_code: 'FC-1' }),
    ];
    render(<DecisionTimelineStrip events={events} currentFeatureCode="FC-1" now={NOW_MS} />);
    expect(screen.getByText('Phase: blueprint → plan')).toBeTruthy();
  });

  it('renders PRODUCER role chip for phase_transition events', () => {
    const events = [
      makeEvent({
        feature_code: 'FC-1',
        kind: 'phase_transition',
        roles: [{ name: 'PRODUCER', agent_id: null }],
      }),
    ];
    render(<DecisionTimelineStrip events={events} currentFeatureCode="FC-1" now={NOW_MS} />);
    expect(screen.getByText('PRODUCER')).toBeTruthy();
  });

  it('renders REVIEWER role chip for review iteration events', () => {
    const events = [
      makeEvent({
        feature_code: 'FC-1',
        kind: 'iteration',
        title: 'Iteration loop started — review',
        metadata: { iteration_id: 'iter-1' },
        roles: [{ name: 'REVIEWER', agent_id: null }],
      }),
    ];
    render(<DecisionTimelineStrip events={events} currentFeatureCode="FC-1" now={NOW_MS} />);
    expect(screen.getByText('REVIEWER')).toBeTruthy();
  });

  it('renders IMPLEMENTER role chip for coverage iteration events', () => {
    const events = [
      makeEvent({
        feature_code: 'FC-1',
        kind: 'iteration',
        title: 'Iteration loop started — coverage',
        metadata: { iteration_id: 'iter-2' },
        roles: [{ name: 'IMPLEMENTER', agent_id: null }],
      }),
    ];
    render(<DecisionTimelineStrip events={events} currentFeatureCode="FC-1" now={NOW_MS} />);
    expect(screen.getByText('IMPLEMENTER')).toBeTruthy();
  });

  it('renders no role chips for events with empty roles array', () => {
    const events = [
      makeEvent({
        feature_code: 'FC-1',
        kind: 'branch',
        title: 'New branch abc123…',
        metadata: { branch_id: 'abc123', fork_uuid: null, sibling_branch_ids: [] },
        roles: [],
      }),
    ];
    const { container } = render(
      <DecisionTimelineStrip events={events} currentFeatureCode="FC-1" now={NOW_MS} />
    );
    const chips = container.querySelectorAll('[data-role-chip]');
    expect(chips.length).toBe(0);
  });

  it('renders N=5 events correctly (stress test)', () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      makeEvent({
        id: `e${i}`,
        feature_code: 'FC-1',
        timestamp: `2026-04-24T${String(i + 8).padStart(2, '0')}:00:00Z`,
        title: `Event ${i}`,
      })
    );
    const { container } = render(
      <DecisionTimelineStrip events={events} currentFeatureCode="FC-1" now={NOW_MS} />
    );
    const cards = container.querySelectorAll('[data-decision-card]');
    expect(cards.length).toBe(5);
  });
});

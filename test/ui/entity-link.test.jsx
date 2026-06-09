/**
 * entity-link.test.jsx — vitest+jsdom tests for EntityLink + NavigationContext.
 *
 * Covers (COMP-COCKPIT-8):
 *   - Renders label and dispatches the right navigation callback per kind
 *     (item/feature/gate/view) via a mocked NavigationContext provider
 *   - Renders as plain non-clickable text when no provider is present
 *   - Gate kind degrades gracefully when navigation throws or is absent
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import EntityLink from '../../src/components/shared/EntityLink.jsx';
import { NavigationContext } from '../../src/lib/navigation.jsx';

function makeNav(overrides = {}) {
  return {
    openItem: vi.fn(),
    openGate: vi.fn(),
    openView: vi.fn(),
    openFeature: vi.fn(),
    ...overrides,
  };
}

function renderWithNav(ui, nav) {
  return render(
    <NavigationContext.Provider value={nav}>{ui}</NavigationContext.Provider>
  );
}

describe('<EntityLink> — navigation dispatch per kind', () => {
  it('kind="item" renders label and calls openItem(id) on click', () => {
    const nav = makeNav();
    renderWithNav(<EntityLink kind="item" id="item-42" label="My Item" />, nav);
    const btn = screen.getByRole('button', { name: 'My Item' });
    fireEvent.click(btn);
    expect(nav.openItem).toHaveBeenCalledWith('item-42');
    expect(nav.openGate).not.toHaveBeenCalled();
    expect(nav.openView).not.toHaveBeenCalled();
    expect(nav.openFeature).not.toHaveBeenCalled();
  });

  it('kind="feature" calls openFeature(id) on click', () => {
    const nav = makeNav();
    renderWithNav(<EntityLink kind="feature" id="COMP-X-1" label="COMP-X-1" />, nav);
    fireEvent.click(screen.getByRole('button', { name: 'COMP-X-1' }));
    expect(nav.openFeature).toHaveBeenCalledWith('COMP-X-1');
  });

  it('kind="gate" calls openGate(id) on click', () => {
    const nav = makeNav();
    renderWithNav(<EntityLink kind="gate" id="gate-7" label="Design gate" />, nav);
    fireEvent.click(screen.getByRole('button', { name: 'Design gate' }));
    expect(nav.openGate).toHaveBeenCalledWith('gate-7');
  });

  it('kind="view" calls openView(id) on click', () => {
    const nav = makeNav();
    renderWithNav(<EntityLink kind="view" id="gates" label="Gates" />, nav);
    fireEvent.click(screen.getByRole('button', { name: 'Gates' }));
    expect(nav.openView).toHaveBeenCalledWith('gates');
  });

  it('falls back to id as the visible text when label is omitted', () => {
    const nav = makeNav();
    renderWithNav(<EntityLink kind="feature" id="COMP-Y-2" />, nav);
    expect(screen.getByRole('button', { name: 'COMP-Y-2' })).toBeTruthy();
  });
});

describe('<EntityLink> — no provider fallback', () => {
  it('renders plain non-clickable text when no NavigationContext provider exists', () => {
    render(<EntityLink kind="item" id="item-1" label="Plain Item" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Plain Item')).toBeTruthy();
  });

  it('does not crash on click of the plain-text fallback', () => {
    render(<EntityLink kind="gate" id="gate-1" label="Gate Label" />);
    expect(() => fireEvent.click(screen.getByText('Gate Label'))).not.toThrow();
  });
});

describe('<EntityLink> — gate kind graceful degradation', () => {
  it('does not crash when the gate navigation callback throws', () => {
    const nav = makeNav({
      openGate: vi.fn(() => { throw new Error('gate vanished'); }),
    });
    renderWithNav(<EntityLink kind="gate" id="gate-9" label="Broken Gate" />, nav);
    expect(() =>
      fireEvent.click(screen.getByRole('button', { name: 'Broken Gate' }))
    ).not.toThrow();
    expect(nav.openGate).toHaveBeenCalledWith('gate-9');
  });

  it('renders plain text when the context lacks the gate callback', () => {
    const nav = makeNav();
    delete nav.openGate;
    renderWithNav(<EntityLink kind="gate" id="gate-9" label="No Gate Nav" />, nav);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('No Gate Nav')).toBeTruthy();
  });
});

describe('<EntityLink> — resolvability (canNavigate)', () => {
  it('renders plain text when canNavigate reports the target unresolvable', () => {
    const nav = makeNav({ canNavigate: vi.fn(() => false) });
    renderWithNav(<EntityLink kind="gate" id="gate-gone" label="Stale Gate" />, nav);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Stale Gate')).toBeTruthy();
    expect(nav.canNavigate).toHaveBeenCalledWith('gate', 'gate-gone');
  });

  it('renders a clickable link when canNavigate reports the target resolvable', () => {
    const nav = makeNav({ canNavigate: vi.fn(() => true) });
    renderWithNav(<EntityLink kind="feature" id="FEAT-1" />, nav);
    fireEvent.click(screen.getByRole('button', { name: 'FEAT-1' }));
    expect(nav.openFeature).toHaveBeenCalledWith('FEAT-1');
  });

  it('stays optimistic (clickable) when the provider has no canNavigate', () => {
    const nav = makeNav();
    renderWithNav(<EntityLink kind="item" id="item-1" label="Legacy" />, nav);
    expect(screen.getByRole('button', { name: 'Legacy' })).toBeTruthy();
  });
});

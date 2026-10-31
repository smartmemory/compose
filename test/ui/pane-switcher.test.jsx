/**
 * pane-switcher.test.jsx — COMP-COCKPIT-TAB-DEPTH-1: the in-page pane switcher, `[` / `]`, per-room memory.
 * One row table per behaviour.
 */
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import PaneSwitcher, { stepPane, usePaneMemory, resetPaneMemory } from '../../src/components/cockpit/PaneSwitcher.jsx';
import WikiView from '../../src/components/cockpit/WikiView.jsx';

const PANES = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }];

function Harness({ room = 'r', trailing }) {
  const [pane, setPane] = usePaneMemory(room, 'a');
  return <PaneSwitcher panes={PANES} active={pane} onChange={setPane} label="Test panes" trailing={trailing} />;
}
const selected = () => screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent);

beforeEach(() => resetPaneMemory());
afterEach(() => cleanup());

describe('stepPane (one row table)', () => {
  const rows = [
    { active: 'a', step: 1, want: 'b' }, { active: 'c', step: 1, want: 'a' },
    { active: 'a', step: -1, want: 'c' }, { active: 'b', step: -1, want: 'a' },
  ];
  it('rows', () => { for (const r of rows) expect(stepPane(PANES, r.active, r.step), JSON.stringify(r)).toBe(r.want); });
  it('one pane or none has nothing to cycle', () => {
    expect(stepPane([PANES[0]], 'a', 1)).toBeNull();
    expect(stepPane([], 'a', 1)).toBeNull();
  });
});

describe('PaneSwitcher keys (one row table)', () => {
  const rows = [
    { name: ']', key: ']', target: 'body', want: 'B' },
    { name: '[ wraps back', key: '[', target: 'body', want: 'C' },
    { name: 'ctrl held', key: ']', opts: { ctrlKey: true }, target: 'body', want: 'A' },
    { name: 'meta held', key: ']', opts: { metaKey: true }, target: 'body', want: 'A' },
    { name: 'text input', key: ']', target: 'input', want: 'A' },
    { name: 'textarea', key: '[', target: 'textarea', want: 'A' },
    { name: 'other key', key: 'x', target: 'body', want: 'A' },
  ];
  it('rows', () => {
    for (const r of rows) {
      resetPaneMemory();
      render(<div><Harness /><input data-testid="in" /><textarea data-testid="ta" /></div>);
      const el = r.target === 'input' ? screen.getByTestId('in') : r.target === 'textarea' ? screen.getByTestId('ta') : document.body;
      fireEvent.keyDown(el, { key: r.key, ...(r.opts || {}) });
      expect(selected(), r.name).toEqual([r.want]);
      cleanup();
    }
  });

  it('is a segmented pill group, distinct from the tab rows', () => {
    render(<Harness />);
    const g = screen.getByTestId('pane-switcher');
    expect(g.getAttribute('role')).toBe('tablist');
    expect(g.getAttribute('aria-label')).toBe('Test panes');
    expect(g.className).toMatch(/rounded-full/);
    expect(g.querySelector('[class*="opacity-"]')).toBeNull();
  });

  it('typing [ in the Wiki feature-code input leaves the pane where it was', () => {
    const client = new Proxy({}, { get: () => vi.fn(() => new Promise(() => {})) });
    render(<WikiView client={client} workspace="wiki-eng" frameBase="http://127.0.0.1:4001" />);
    const input = screen.getByLabelText('Feature code');
    expect(screen.getByRole('tab', { name: 'Search' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: ']' });
    fireEvent.keyDown(input, { key: '[' });
    expect(screen.getByRole('tab', { name: 'Search' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(document.body, { key: ']' });
    expect(screen.getByRole('tab', { name: 'Graph' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('pane memory (one row table)', () => {
  it('leaving a room and returning reopens its last pane, rooms keep separate panes', () => {
    const view = render(<Harness room="one" />);
    fireEvent.click(screen.getByRole('tab', { name: 'C' }));
    expect(selected()).toEqual(['C']);
    view.unmount();
    render(<Harness room="two" />);
    expect(selected(), 'another room starts on its own default').toEqual(['A']);
    cleanup();
    render(<Harness room="one" />);
    expect(selected(), 'one returns on C').toEqual(['C']);
  });
});

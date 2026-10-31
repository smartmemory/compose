/**
 * COMP-COCKPIT-HEADER-COUNTERS-1: counters + agent pill in the top bar,
 * collapsible NEEDS ATTENTION in the left bar.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

vi.mock('../../src/components/vision/useVisionStore.js', () => ({
  useVisionStore: (sel) => { const s = { activeBuild: null, gates: new Map(), items: new Map(), recentErrors: [], iterationStates: new Map() }; return typeof sel === 'function' ? sel(s) : s; },
}));

const { default: AttentionQueueSidebar, attentionCollapsedKey } = await import('../../src/components/vision/AttentionQueueSidebar.jsx');
const { HeaderCounters, AgentStatusPill } = await import('../../src/components/cockpit/HeaderStatus.jsx');

const items = [
  { id: '1', type: 'feature', title: 'A', status: 'in_progress', group: 'G' },
  { id: '2', type: 'feature', title: 'B', status: 'blocked', group: 'G' },
  { id: '3', type: 'feature', title: 'C', status: 'planned', group: 'H' },
];
const gates = [{ id: 'g1', itemId: '3', status: 'pending', stepId: 'design' }];
const sidebarProps = {
  items, gates, onViewChange: vi.fn(), connected: true, hiddenGroups: new Set(), onToggleGroup: vi.fn(),
  visibleTracks: [], spawnedAgents: [], agentRelays: [], agentActivity: [], agentErrors: [], storageScope: 'proj-x',
};
const KEY = attentionCollapsedKey('proj-x');
const rowCount = () => screen.queryAllByTestId('attention-row').length;

beforeEach(() => { global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' })); localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const ROWS = [
  ['counters render in the header with the right counts', () => {
    render(<HeaderCounters items={items} gates={gates} />);
    const t = (id) => screen.getByTestId(id).getAttribute('aria-label');
    expect([t('header-count-total'), t('header-count-active'), t('header-count-blocked'), t('header-count-gates')])
      .toEqual(['3 items', '1 active', '1 blocked', '1 gate']);
  }],
  ['agent pill starts Idle and follows compose:agent-status', () => {
    render(<AgentStatusPill />);
    expect(screen.getByTestId('header-agent-status').textContent).toBe('Idle');
    act(() => { window.dispatchEvent(new CustomEvent('compose:agent-status', { detail: { status: 'working', category: 'writing' } })); });
    expect(screen.getByTestId('header-agent-status').textContent).toBe('Writing');
  }],
  ['sidebar no longer carries the counters or the pill', () => {
    const { container } = render(<AttentionQueueSidebar {...sidebarProps} />);
    expect(container.querySelector('[data-testid="header-counters"]')).toBeNull();
    expect(container.textContent).not.toMatch(/\d+ items/);
    expect(container.textContent).not.toMatch(/\bIdle\b/);
  }],
  ['toggle defaults to expanded with the count', () => {
    render(<AttentionQueueSidebar {...sidebarProps} />);
    expect(screen.getByTestId('attention-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('attention-count').textContent).toBe('2');
    expect(rowCount()).toBe(2);
  }],
  ['collapse hides the list and persists across remount', () => {
    const first = render(<AttentionQueueSidebar {...sidebarProps} />);
    fireEvent.click(screen.getByTestId('attention-toggle'));
    expect(screen.getByTestId('attention-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(rowCount()).toBe(0);
    expect(localStorage.getItem(KEY)).toBe('1');
    first.unmount();
    render(<AttentionQueueSidebar {...sidebarProps} />);
    expect(screen.getByTestId('attention-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(rowCount()).toBe(0);
  }],
  ['a throwing localStorage still renders expanded and toggles', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    render(<AttentionQueueSidebar {...sidebarProps} />);
    expect(screen.getByTestId('attention-toggle').getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByTestId('attention-toggle'));
    expect(screen.getByTestId('attention-toggle').getAttribute('aria-expanded')).toBe('false');
  }],
];

describe('header counters and attention collapse', () => {
  for (const [name, run] of ROWS) it(name, run);
});

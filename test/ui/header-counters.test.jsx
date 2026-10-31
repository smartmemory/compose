/**
 * COMP-COCKPIT-HEADER-COUNTERS-1: counters + agent pill in the top bar,
 * collapsible NEEDS ATTENTION in the left bar.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';

vi.mock('../../src/components/vision/useVisionStore.js', () => ({
  useVisionStore: (sel) => { const s = { activeBuild: null, gates: new Map(), items: new Map(), recentErrors: [], iterationStates: new Map() }; return typeof sel === 'function' ? sel(s) : s; },
}));

const { default: AttentionQueueSidebar, attentionCollapsedKey } = await import('../../src/components/vision/AttentionQueueSidebar.jsx');
const { HeaderCounters, AgentStatusPill } = await import('../../src/components/cockpit/HeaderStatus.jsx');
const { default: WhatLine } = await import('../../src/components/cockpit/what/WhatLine.jsx');
const { WHAT_RULES, LAST_VISIT_KEY, whatState, whatCounts } = await import('../../src/components/cockpit/what/whatRules.js');
const { resetFleetPoller } = await import('../../src/lib/fleetPoller.js');
const { resetUnitIndex } = await import('../../src/lib/useUnitIndex.js');

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

// COMP-COCKPIT-WHAT-LINE-1 fixtures: an sm_status fleet body, a unit index, and the raw inputs the rule table reads.
const NOW = Date.parse('2026-10-31T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();
const fleetBody = ({ busy = 0, jobs = 0, queue = 0 } = {}) => ({
  generated: '2026-10-31T11:58:00Z',
  sources: { sm_status: { value: {
    sessions: { value: Array.from({ length: 3 }, (_, i) => ({ name: `s${i}`, busy: i < busy })), error: null },
    jobs: { value: Array.from({ length: 4 }, (_, i) => ({ id: `j${i}`, alive: i < jobs })), error: null },
    queue: { value: Array.from({ length: queue }, (_, i) => ({ id: `q${i}` })), error: null },
  }, error: null, ts: 1, stale: false } },
});
const FLEET_DOWN = { generated: '2026-10-31T11:58:00Z', sources: { sm_status: { value: null, error: 'timed out', ts: 1, stale: false } } };
const indexOf = (units) => ({ units, asOf: '2026-10-31T11:55:00Z' });
const unit = (id, extra = {}) => ({ id, landedAt: null, waiting: null, ...extra });
const raw = (over) => ({ fleet: fleetBody(), agent: { status: 'idle' }, index: indexOf([]), now: NOW, lastVisitAt: null, ...over });
const routeFetch = (routes) => {
  global.fetch = vi.fn(async (url) => {
    const hit = Object.entries(routes).find(([p]) => String(url).startsWith(p));
    return { ok: true, status: 200, json: async () => (hit ? hit[1] : {}), text: async () => '' };
  });
};
const resetPollers = () => { resetFleetPoller(); resetUnitIndex(); };

const STATE_ROWS = [
  ['Unknown: sm_status down and no unit index', raw({ fleet: FLEET_DOWN, index: null }), 'Unknown'],
  ['Moving beats Working: a landing 1 h ago while a job runs', raw({ fleet: fleetBody({ jobs: 1 }), index: indexOf([unit('A', { landedAt: hoursAgo(1) })]) }), 'Moving'],
  ['Working, nothing landed: a busy session, last landing 3 h ago', raw({ fleet: fleetBody({ busy: 1 }), index: indexOf([unit('A', { landedAt: hoursAgo(3) })]) }), 'Working, nothing landed'],
  ['Working: only Compose\'s own agent is working', raw({ agent: { status: 'working', category: 'writing' } }), 'Working, nothing landed'],
  ['Stalled: nothing running, a unit waits on review', raw({ index: indexOf([unit('A', { waiting: 'review' })]) }), 'Stalled'],
  ['Stalled: nothing running, an owner question is open', raw({ fleet: fleetBody({ queue: 2 }) }), 'Stalled'],
  ['Idle: nothing running, nothing waiting, last landing 3 h ago', raw({ index: indexOf([unit('A', { landedAt: hoursAgo(3) })]) }), 'Idle'],
  ['Idle, not Unknown: the index is down but sm_status answers quiet', raw({ index: null }), 'Idle'],
];

const ROWS = [
  ['counters render in the header with the right counts', () => {
    render(<HeaderCounters items={items} gates={gates} />);
    const t = (id) => screen.getByTestId(id).getAttribute('aria-label');
    expect([t('header-count-total'), t('header-count-active'), t('header-count-blocked'), t('header-count-gates')])
      .toEqual(['3 items', '1 active', '1 blocked', '1 gate']);
  }],
  ['agent pill starts Idle and follows compose:agent-status', () => {
    render(<AgentStatusPill />);
    expect(screen.getByTestId('header-agent-status').textContent).toBe('Compose agent: Idle');
    act(() => { window.dispatchEvent(new CustomEvent('compose:agent-status', { detail: { status: 'working', category: 'writing' } })); });
    expect(screen.getByTestId('header-agent-status').textContent).toBe('Compose agent: Writing');
  }],
  ['WHAT_RULES first match per state: one row per state', () => {
    expect(WHAT_RULES.map((r) => r.state)).toEqual(['Unknown', 'Moving', 'Working, nothing landed', 'Stalled', 'Idle']);
    expect(STATE_ROWS.map(([name, r]) => [name, whatState(r)])).toEqual(STATE_ROWS.map(([name, , want]) => [name, want]));
  }],
  ['whatCounts: working sums sessions, jobs and the agent; unknown sources are null, never 0', () => {
    const lastVisitAt = NOW - 2 * 3_600_000;
    const index = indexOf([unit('A', { waiting: 'review' }), unit('B', { landedAt: hoursAgo(1) }), unit('C', { landedAt: hoursAgo(5) })]);
    expect(whatCounts(raw({ fleet: fleetBody({ busy: 2, jobs: 3, queue: 4 }), agent: { status: 'working', category: 'writing' }, index, lastVisitAt })))
      .toEqual({ working: 6, waitingReview: 1, waitingYou: 4, landedSinceVisit: 1 });
    expect(whatCounts(raw({ fleet: FLEET_DOWN, index: null, lastVisitAt })))
      .toEqual({ working: null, waitingReview: null, waitingYou: null, landedSinceVisit: null });
    expect(whatCounts(raw({ index, lastVisitAt: null })).landedSinceVisit).toBeNull();
  }],
  ['header pill: two labelled parts, no word hidden at any width', () => {
    resetPollers();
    routeFetch({ '/api/fleet': fleetBody({ busy: 2, jobs: 3 }) });
    render(<AgentStatusPill />);
    const pill = screen.getByTestId('header-agent-pill');
    expect(screen.getByTestId('header-agent-status').textContent).toBe('Compose agent: Idle');
    expect(screen.getByTestId('header-agent-status').getAttribute('aria-label')).toBe('Compose agent: Idle');
    expect(pill.querySelector('[class*="hidden"]')).toBeNull();
  }],
  ['header pill: sm_status down reads Fleet: unknown with no error text', async () => {
    resetPollers();
    routeFetch({ '/api/fleet': FLEET_DOWN });
    render(<AgentStatusPill />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('header-agent-fleet').textContent).toBe('Fleet: unknown'));
    expect(screen.getByTestId('header-agent-pill').textContent).not.toMatch(/timed out|error/i);
  }],
  ['collapsed counters chip keeps its words: "Compose: 3 items" with the breakdown beside it', () => {
    const { container } = render(<HeaderCounters items={items} gates={gates} />);
    const chip = screen.getByTestId('header-counters');
    expect(chip.textContent).toBe('Compose: 3 items 1 active 1 blocked 1 gate');
    expect(chip.getAttribute('title')).toBe('Compose: 3 items · 1 active · 1 blocked · 1 gate');
    expect(container.querySelector('[class*="hidden"]')).toBeNull();
  }],
  ['unknown sources render "?" in the what line, never 0 and never an error string', async () => {
    resetPollers();
    routeFetch({ '/api/fleet': FLEET_DOWN, '/api/units/index': {} });
    render(<WhatLine onOpenFleet={vi.fn()} onNavigate={vi.fn()} />);
    expect(screen.getByTestId('what-line-skeleton')).toBeTruthy();
    await screen.findByTestId('what-line');
    expect(screen.getByTestId('what-state').textContent).toBe('Unknown');
    const counts = ['working', 'review', 'you', 'landed'].map((id) => screen.getByTestId(`what-count-${id}`).textContent);
    expect(counts).toEqual(['? working', '? waiting on review', '? waiting on you', '? landed since your last visit']);
    expect(counts.join(' ')).not.toMatch(/\b0\b|error|timed out/i);
    expect(screen.getByTestId('what-count-working').getAttribute('title')).toBe('source unavailable');
  }],
  ['the what line reads as one sentence and its hover marks the matching rule', async () => {
    resetPollers();
    localStorage.setItem(LAST_VISIT_KEY, String(Date.now() - 3_600_000));
    routeFetch({ '/api/fleet': fleetBody({ busy: 2, jobs: 3, queue: 11 }), '/api/units/index': indexOf([unit('A', { waiting: 'review' })]) });
    render(<WhatLine onOpenFleet={vi.fn()} onNavigate={vi.fn()} />);
    const line = await screen.findByTestId('what-line');
    expect(screen.getByTestId('what-state').textContent).toBe('Working, nothing landed');
    expect(line).toBeTruthy();
    expect(screen.getByTestId('what-count-working').textContent).toBe('5 working');
    expect(screen.getByTestId('what-count-review').textContent).toBe('1 waiting on review');
    expect(screen.getByTestId('what-count-you').textContent).toBe('11 waiting on you');
    expect(screen.getByTestId('what-count-landed').textContent).toBe('0 landed since your last visit');
    const rules = screen.getAllByTestId('what-rule');
    expect(rules.map((r) => r.getAttribute('data-current'))).toEqual(['false', 'false', 'true', 'false', 'false']);
  }],
  ['what line counts open their places: working and review, and landed go to Fleet and Process', async () => {
    resetPollers();
    localStorage.setItem(LAST_VISIT_KEY, String(Date.now() - 3_600_000));
    routeFetch({ '/api/fleet': fleetBody({ busy: 1 }), '/api/units/index': indexOf([]) });
    const onOpenFleet = vi.fn();
    const onNavigate = vi.fn();
    render(<WhatLine onOpenFleet={onOpenFleet} onNavigate={onNavigate} />);
    await screen.findByTestId('what-line');
    fireEvent.click(screen.getByTestId('what-count-working'));
    fireEvent.click(screen.getByTestId('what-count-review'));
    fireEvent.click(screen.getByTestId('what-count-landed'));
    expect(onOpenFleet).toHaveBeenCalledTimes(1);
    expect(onNavigate.mock.calls).toEqual([['process'], ['process']]);
  }],
  ['waiting on you: compose:open-inbox first, the Fleet pane when nothing handles it', async () => {
    resetPollers();
    routeFetch({ '/api/fleet': fleetBody({ queue: 2 }), '/api/units/index': indexOf([]) });
    const onOpenFleet = vi.fn();
    render(<WhatLine onOpenFleet={onOpenFleet} onNavigate={vi.fn()} />);
    await screen.findByTestId('what-line');
    fireEvent.click(screen.getByTestId('what-count-you'));
    expect(onOpenFleet).toHaveBeenCalledTimes(1);
    const handled = (e) => e.preventDefault();
    window.addEventListener('compose:open-inbox', handled);
    fireEvent.click(screen.getByTestId('what-count-you'));
    window.removeEventListener('compose:open-inbox', handled);
    expect(onOpenFleet).toHaveBeenCalledTimes(1);
  }],
  ['last visit is written when the page hides, never on load', async () => {
    resetPollers();
    routeFetch({ '/api/fleet': fleetBody(), '/api/units/index': indexOf([]) });
    render(<WhatLine onOpenFleet={vi.fn()} onNavigate={vi.fn()} />);
    await screen.findByTestId('what-line');
    expect(localStorage.getItem(LAST_VISIT_KEY)).toBeNull();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    delete document.visibilityState;
    expect(Number(localStorage.getItem(LAST_VISIT_KEY))).toBeGreaterThan(0);
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

/**
 * COMP-COCKPIT-SOURCE-FAULTS-1: every cockpit consumer of a poller says when its source failed or went stale.
 * Each case is the reviewers' probe shape: a healthy read through the REAL poller, then a failed refresh (a
 * visibilitychange re-polls at once), and the consumer must show the shared SourceNote, not the old data as current.
 * fetch is stubbed per URL; no real route, port or project switch is touched.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act, renderHook, configure } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

configure({ asyncUtilTimeout: 5000 });

let agentNow = { status: 'idle', tool: null, category: null };
vi.mock('../../src/components/AgentStream.jsx', () => ({ getAgentStatus: () => agentNow }));
vi.mock('../../src/components/vision/useVisionStore.js', () => {
  const s = { activeBuild: null, gates: new Map(), items: new Map(), recentErrors: [], resolveGate: null, iterationStates: new Map() };
  return { useVisionStore: (sel) => (typeof sel === 'function' ? sel(s) : s) };
});

const { resetFleetPoller } = await import('../../src/lib/fleetPoller.js');
const { resetUnitIndex } = await import('../../src/lib/useUnitIndex.js');
const { resetProcessPoller } = await import('../../src/lib/processPoller.js');
const { sourceOk, sourceFail, sourceNoteText } = await import('../../src/lib/sourceState.js');
const { runningNow } = await import('../../src/components/cockpit/fleetLogic.js');
const { default: WhatLine } = await import('../../src/components/cockpit/what/WhatLine.jsx');
const { AgentStatusPill } = await import('../../src/components/cockpit/HeaderStatus.jsx');
const { useAgentState } = await import('../../src/components/cockpit/what/useAgentState.js');
const { default: NotifyChip } = await import('../../src/components/cockpit/notify/NotifyChip.jsx');
const { default: useOpsData } = await import('../../src/components/cockpit/ops/useOpsData.js');
const { default: ProgressCard } = await import('../../src/components/cockpit/ops/ProgressCard.jsx');
const { default: OpsView } = await import('../../src/components/cockpit/OpsView.jsx');
const { default: Coverage } = await import('../../src/components/shared/Coverage.jsx');
const { default: UnitName } = await import('../../src/components/shared/UnitName.jsx');
const { unitLabel } = await import('../../src/lib/unitLabel.js');
const { default: ValidateView } = await import('../../src/components/vision/ValidateView.jsx');
const { default: OpsStrip } = await import('../../src/components/cockpit/OpsStrip.jsx');
const { default: ProcessView } = await import('../../src/components/cockpit/ProcessView.jsx');

const up = (value) => ({ value, error: null, ts: 1, stale: false });
const smFleet = (panels, generated = '2026-11-03T10:00:00Z') => ({
  generated,
  sources: { sm_status: up(Object.fromEntries(Object.entries(panels).map(([k, v]) => [k, v && 'value' in v && 'error' in v ? v : up(v)]))) },
});
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const INDEX = { units: [{ id: 'U-1', lane: 'forge', title: 'Plain name', titleSource: 'stamp', waiting: 'review' }], coverage: { forge: { n: 10, pct: { review: 40 } } }, glossary: {}, asOf: '2026-11-03T10:00:00Z' };

/** fetch by URL prefix; a route's value may be a function (called per request) or `'fail'` (rejects). */
function stub(routes) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const u = String(url);
    calls.push([u, init?.method ?? 'GET']);
    const key = Object.keys(routes).find((k) => u === k || u.startsWith(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}) };
    const r = typeof routes[key] === 'function' ? routes[key](u) : routes[key];
    if (r === 'fail') throw new Error('probe offline');
    return r;
  }));
  return calls;
}
const repoll = () => act(async () => { document.dispatchEvent(new Event('visibilitychange')); });

beforeEach(() => { resetFleetPoller(); resetUnitIndex(); resetProcessPoller(); agentNow = { status: 'idle', tool: null, category: null }; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('one source-state shape (lib/sourceState.js)', () => {
  it('a failure over good data keeps it, stale, with the first failure time; a second failure keeps that time', () => {
    const a = sourceOk({ x: 1 }, 1000);
    const b = sourceFail(a, new Error('down'), 2000);
    expect(b).toEqual({ data: { x: 1 }, error: 'down', stale: true, fetchedAt: 1000, errorSince: 2000, loading: false });
    expect(sourceFail(b, 'still down', 3000).errorSince).toBe(2000);
    expect(sourceFail(null, 'never read', 5).stale).toBe(false);
    expect(sourceNoteText('Fleet', b)).toMatch(/^Fleet unreadable since \d\d:\d\d: down; showing the last good read from \d\d:\d\d$/);
    expect(sourceNoteText('Fleet', a)).toBeNull();
  });
});

describe('WHAT-LINE M1: WhatLine and HeaderStatus after a failed fleet refresh', () => {
  it('WhatLine stops counting the retained body and names the fault; the header reads Fleet unreadable', async () => {
    let fleetUp = true;
    stub({
      '/api/fleet': () => (fleetUp ? ok(smFleet({ sessions: [{ busy: true }], jobs: [], queue: [] })) : 'fail'),
      '/api/units/index': ok(INDEX),
    });
    render(<><AgentStatusPill /><WhatLine /></>);
    await waitFor(() => expect(screen.getByTestId('what-count-working').textContent).toBe('1 working'));
    expect(screen.getByTestId('header-agent-fleet').textContent).toBe('Fleet: 1 session busy');
    fleetUp = false;
    await repoll();
    await waitFor(() => expect(screen.getByTestId('what-count-working').getAttribute('data-known')).toBe('false'));
    const notes = screen.getAllByTestId('source-note').filter((n) => n.dataset.source === 'Fleet');
    expect(notes.length).toBe(2); // the header chip and the line's note
    expect(notes.some((n) => /^Fleet unreadable since \d\d:\d\d$/.test(n.textContent))).toBe(true);
    expect(notes.some((n) => /Fleet unreadable since \d\d:\d\d: probe offline; showing the last good read/.test(n.textContent))).toBe(true);
    expect(screen.queryByTestId('header-agent-fleet')).toBeNull();
  });

  it('a failed unit-index refresh makes the review count unknown and shows the index note', async () => {
    let indexUp = true;
    stub({ '/api/fleet': ok(smFleet({ sessions: [], jobs: [], queue: [] })), '/api/units/index': () => (indexUp ? ok(INDEX) : 'fail') });
    render(<WhatLine />);
    await waitFor(() => expect(screen.getByTestId('what-count-review').textContent).toBe('1 waiting on review'));
    indexUp = false;
    await repoll();
    await waitFor(() => expect(screen.getByTestId('what-count-review').getAttribute('data-known')).toBe('false'));
    expect(screen.getAllByTestId('source-note').map((n) => n.dataset.source)).toEqual(['Unit index']);
  });
});

describe('WHAT-LINE M3: one readable fleet list is not a known total', () => {
  it('sessions [] with jobs unreadable is unknown, never quiet or 0', () => {
    const fleet = smFleet({ sessions: [], jobs: { value: null, error: 'reader failed' } });
    const r = runningNow(fleet, null);
    expect(r).toMatchObject({ fleetKnown: false, busy: 0, jobs: null, text: 'jobs unknown' });
  });
  it('the header shows the known part and names the missing list; WhatLine says why', async () => {
    stub({ '/api/fleet': ok(smFleet({ sessions: [{ busy: true }], jobs: { value: null, error: 'reader failed' }, queue: [] })), '/api/units/index': ok(INDEX) });
    render(<><AgentStatusPill /><WhatLine /></>);
    await waitFor(() => expect(screen.getByTestId('header-agent-fleet').textContent).toBe('Fleet: 1 session busy · jobs unknown'));
    const w = screen.getByTestId('what-count-working');
    expect(w.getAttribute('data-known')).toBe('false');
    expect(w.getAttribute('title')).toMatch(/the jobs list is unreadable/);
  });
});

describe('WHAT-LINE M2: a line mounted mid-operation reads the agent stream status', () => {
  it('useAgentState starts from getAgentStatus, not idle', () => {
    agentNow = { status: 'working', tool: 'Write', category: 'writing' };
    const { result } = renderHook(() => useAgentState());
    expect(result.current).toMatchObject({ status: 'working', category: 'writing' });
  });
  it('the header pill mounted after the last event agrees with the stream', async () => {
    agentNow = { status: 'working', tool: 'Write', category: 'writing' };
    stub({ '/api/fleet': ok(smFleet({ sessions: [], jobs: [], queue: [] })) });
    render(<AgentStatusPill />);
    expect(screen.getByTestId('header-agent-status').textContent).toBe('Compose agent: Writing');
  });
});

const IQ = [
  { id: 'q-red', by: 'ops-main', text: 'QUESTION: overdue ask', age: 9e4, red: true },
  { id: 'up-1', by: 'ops-main', text: 'UPDATED: moved the gate. reverse: run undo.sh', age: 40, red: false },
];
const cadence = {
  '/outage': ok({ state: 'ok' }),
  '/review': ok({ reviewMaxH: 24, inReview: [], inReviewByLane: {}, ungrouped: { count: 0, oldestLanded: null }, errors: [] }),
  '/attention': ok({ alerts: [] }),
};
function stubInbox(fleet) {
  const routes = { '/api/fleet': fleet };
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url);
    if (u === '/api/fleet') { const r = typeof routes['/api/fleet'] === 'function' ? routes['/api/fleet']() : routes['/api/fleet']; if (r === 'fail') throw new Error('probe offline'); return r; }
    for (const [k, v] of Object.entries(cadence)) if (u.endsWith(k)) return v;
    return { ok: false, status: 404, json: async () => ({}) };
  }));
}
async function openInbox() {
  render(<NotifyChip />);
  await waitFor(() => expect(screen.getByTestId('notify-chip').getAttribute('data-state')).not.toBe('loading'));
  await act(async () => { window.dispatchEvent(new CustomEvent('compose:open-inbox', { cancelable: true })); });
  return screen.getByTestId('inbox-drawer');
}

describe('NOTIFY-INBOX M1-M3: the inbox drawer', () => {
  it('M1: a queue panel read with an error says so and never prints Nothing open', async () => {
    stubInbox(ok(smFleet({ queue: { value: [], error: 'UncertainSource: fixture row unreadable' }, sessions: [], jobs: [] })));
    const d = await openInbox();
    expect(d.textContent).not.toMatch(/Nothing open/);
    const n = screen.getAllByTestId('source-note').find((x) => x.dataset.source === 'Owner queue');
    expect(n.textContent).toBe('Owner queue unreadable: UncertainSource: fixture row unreadable');
  });
  it('M1: a failed refresh after a good read keeps the rows with the fleet note', async () => {
    let upNow = true;
    stubInbox(() => (upNow ? ok(smFleet({ queue: IQ, sessions: [], jobs: [] })) : 'fail'));
    const d = await openInbox();
    expect(d.textContent).toMatch(/overdue ask/);
    upNow = false;
    await repoll();
    await waitFor(() => expect(screen.getAllByTestId('source-note').some((x) => x.dataset.source === 'Fleet' && x.dataset.stale === 'true')).toBe(true));
    expect(screen.getByTestId('inbox-drawer').textContent).toMatch(/overdue ask/);
  });
  it('M2: an UPDATED ruling is decided for you, with its reverse line and Copy id', async () => {
    stubInbox(ok(smFleet({ queue: IQ, sessions: [], jobs: [] })));
    const d = await openInbox();
    const decided = d.querySelector('[data-group="decided"]');
    expect(decided).not.toBeNull();
    const toggle = decided.querySelector('button');
    fireEvent.click(toggle); // unfold the group
    await waitFor(() => expect(screen.getByTestId('inbox-reverse').textContent).toBe('run undo.sh'));
    expect(screen.getByTestId('inbox-copy-id')).toBeTruthy();
    expect(d.querySelector('[data-group="fyi"]')).toBeNull();
  });
  it('M3: a red ask (not security) gets the critical tone, collapsed and expanded', async () => {
    stubInbox(ok(smFleet({ queue: IQ, sessions: [], jobs: [] })));
    const d = await openInbox();
    const row = [...d.querySelectorAll('[data-testid="inbox-row-toggle"]')].find((b) => /overdue ask/.test(b.textContent));
    expect(row.querySelector('[data-tone="critical"]')).not.toBeNull();
    fireEvent.click(row);
    expect(d.querySelector('[data-testid="inbox-full"]').getAttribute('data-tone')).toBe('critical');
  });
});

const OPS_BODY = (landed) => ({ name: 'forge', ageS: 0, notices: 0, progress: { planned: 4, landed, builderOnly: 0, notRecorded: 0, nodes: [] }, eta: null });

describe('INIT-VIEW M1-M2: useOpsData, ProgressCard and OpsView', () => {
  it('M1: a failed poll over good data is ok + stale + error, and the card shows the note', async () => {
    let upNow = true;
    stub({ '/api/ops-status/forge/data': () => (upNow ? ok(OPS_BODY(1)) : 'fail') });
    const { result } = renderHook(() => useOpsData('forge'));
    await waitFor(() => expect(result.current.status).toBe('ok'));
    upNow = false;
    await repoll();
    await waitFor(() => expect(result.current.error).toBe('probe offline'));
    expect(result.current).toMatchObject({ status: 'ok', stale: true });
    render(<ProgressCard data={result.current.data} fetchedAt={result.current.fetchedAt} source={result.current} />);
    expect(screen.getByTestId('source-note').textContent).toMatch(/^Ops data unreadable since \d\d:\d\d: probe offline/);
  });
  it('M2: an older reply that completes after a newer one is dropped', async () => {
    let first;
    let n = 0;
    stub({ '/api/ops-status/forge/data': () => (++n === 1 ? new Promise((r) => { first = r; }) : ok(OPS_BODY(2))) });
    const { result } = renderHook(() => useOpsData('forge'));
    await repoll(); // second read starts while the first is pending
    await waitFor(() => expect(result.current.data?.progress.landed).toBe(2));
    await act(async () => { first(ok(OPS_BODY(0))); });
    expect(result.current.data.progress.landed).toBe(2);
  });
  it('OpsView shows the note in its ok branch after a failed refresh', async () => {
    let upNow = true;
    stub({ '/api/ops-status/index': ok({ pages: ['forge'] }), '/api/ops-status/forge/data': () => (upNow ? ok(OPS_BODY(1)) : 'fail') });
    render(<OpsView />);
    await waitFor(() => expect(screen.getByTestId('ops-progress-text').textContent).toBe('1 of 4 landed'));
    upNow = false;
    await repoll();
    await waitFor(() => expect(screen.getByTestId('source-note').dataset.source).toBe('Ops data'));
    expect(screen.getByTestId('ops-progress-text').textContent).toBe('1 of 4 landed');
  });
  it('the route\'s progress warnings and the estimator\'s warnings show on the card', () => {
    render(<ProgressCard data={{ ...OPS_BODY(1), progressWarnings: ['2 rows skipped (not an object)'], eta: { p50: '2h', p80: '3h', asOf: 'x', warnings: ['WARNING fell back to stamps'] } }} fetchedAt={Date.now()} />);
    expect(screen.getAllByTestId('ops-warning').map((e) => e.textContent)).toEqual(['2 rows skipped (not an object)', 'ETA: WARNING fell back to stamps']);
  });
});

describe('RULE-FRESH M1: Coverage after a failed index refresh', () => {
  it('keeps the old percentages under the shared note', async () => {
    let upNow = true;
    stub({ '/api/units/index': () => (upNow ? ok(INDEX) : 'fail') });
    render(<Coverage lane="forge" events={['review']} />);
    await waitFor(() => expect(screen.getByTestId('coverage-forge').textContent).toBe('stamps recorded: review 40%'));
    upNow = false;
    await repoll();
    await waitFor(() => expect(screen.getByTestId('source-note').dataset.stale).toBe('true'));
    expect(screen.getByTestId('coverage-forge').textContent).toMatch(/^stamps recorded: review 40%Unit index unreadable since/);
  });
  it('a partial index (queue dir unlistable) with no row for the lane names the fault; a lane warning shows too', async () => {
    stub({ '/api/units/index': ok({ ...INDEX, coverage: { other: { n: 1, pct: {}, warnings: ['glossary not JSON'] } }, error: 'queues dir unreadable (EACCES)' }) });
    render(<><Coverage lane="forge" events={['review']} /><Coverage lane="other" events={[]} /></>);
    await waitFor(() => expect(screen.getAllByTestId('source-note').length).toBe(2));
    expect(screen.getAllByTestId('source-note').map((n) => n.textContent)).toEqual(['Unit index unreadable: queues dir unreadable (EACCES)', 'other stamps unreadable: glossary not JSON']);
  });
});

describe('RULE-FRESH M2: Validate rerun over earlier findings', () => {
  it('shows Validating and marks the old findings stale', async () => {
    let n = 0;
    stub({ '/api/validate': () => (++n === 1 ? ok({ findings: [{ severity: 'warning', detail: 'old finding', kind: 'k' }] }) : new Promise(() => {})) });
    render(<ValidateView />);
    await waitFor(() => expect(screen.getByText(/old finding/)).toBeTruthy());
    expect(screen.queryByTestId('validate-loading')).toBeNull();
    const refresh = screen.getAllByRole('button').find((b) => /refresh/i.test(b.getAttribute('aria-label') ?? b.textContent ?? ''));
    fireEvent.click(refresh);
    await waitFor(() => expect(screen.getByTestId('validate-loading').textContent).toMatch(/Validating…/));
    expect(screen.getByTestId('validate-findings').dataset.stale).toBe('true');
    expect(screen.getByText(/old finding/)).toBeTruthy();
  });
});

describe('RULE-PLAIN M1-M2: UnitName', () => {
  it('M2: a failed index is source=unavailable, a pending one is loading', async () => {
    expect(unitLabel('U-1', null, 'forge').source).toBe('loading');
    expect(unitLabel('U-1', null, 'forge', { error: 'down' }).source).toBe('unavailable');
    stub({ '/api/units/index': { ok: false, status: 503, json: async () => ({}) } });
    render(<UnitName id="U-1" lane="forge" />);
    await waitFor(() => expect(screen.getByTestId('unit-name').dataset.titleSource).toBe('unavailable'));
    expect(screen.getByTestId('unit-name').getAttribute('title')).toMatch(/the unit names could not be read/);
  });
  it('M1: focus shows a tooltip the name points at, with title, code, provenance and glossary', async () => {
    stub({ '/api/units/index': ok({ ...INDEX, glossary: { forge: { 'U-1': 'A glossary sentence.' } } }) });
    render(<UnitName id="U-1" lane="forge" />);
    await waitFor(() => expect(screen.getByTestId('unit-name').dataset.titleSource).toBe('stamp'));
    const name = screen.getByTestId('unit-name');
    expect(name.tabIndex).toBe(0);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(name);
    const tip = screen.getByRole('tooltip');
    expect(name.getAttribute('aria-describedby')).toBe(tip.id);
    expect(tip.textContent).toBe("Plain name\nU-1\nfrom the unit's stamp\nA glossary sentence.");
    fireEvent.blur(name);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('other fleet consumers: OpsStrip and ProcessView', () => {
  it('OpsStrip shows the fleet note after a failed refresh, even with no pills', async () => {
    let upNow = true;
    stub({ '/api/fleet': () => (upNow ? ok(smFleet({ sessions: [], jobs: [], queue: [] })) : 'fail') });
    const { container } = render(<OpsStrip />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="source-note"]')).toBeNull();
    upNow = false;
    await repoll();
    await waitFor(() => expect(screen.getByTestId('source-note').textContent).toMatch(/^Fleet unreadable since \d\d:\d\d$/));
  });
  it('ProcessView shows the fleet note beside the owner queue card', async () => {
    const FIX = join(process.cwd(), 'test', 'fixtures', 'process');
    const env = JSON.parse(readFileSync(join(FIX, 'api-process.json'), 'utf8'));
    let upNow = true;
    stub({ '/api/process': ok(env), '/api/fleet': () => (upNow ? ok(smFleet({ queue: [] })) : 'fail'), '/api/units/index': ok(INDEX) });
    render(<ProcessView />);
    await waitFor(() => expect(screen.getByTestId('process-owner')).toBeTruthy());
    upNow = false;
    await repoll();
    await waitFor(() => expect(screen.getByTestId('process-owner').querySelector('[data-testid="source-note"]')?.dataset.source).toBe('Fleet'));
  });
});

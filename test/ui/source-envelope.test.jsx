/**
 * COMP-SOURCE-ENVELOPE-1: a source that answers 200 but whose body says the producer could not read everything is
 * shown as incomplete, never as a known zero. The reviewer's two probes (COMP-COCKPIT-SOURCE-FAULTS-1 postland M1),
 * end to end: the REAL `buildUnitIndex` producer on a scratch directory → its body as a stubbed 200 → the REAL
 * `useUnitIndex` poller → mounted WhatLine, UnitName and Coverage. fetch is stubbed per URL; no route or port is touched.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, configure } from '@testing-library/react';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

configure({ asyncUtilTimeout: 5000 });

vi.mock('../../src/components/AgentStream.jsx', () => ({ getAgentStatus: () => ({ status: 'idle', tool: null, category: null }) }));
vi.mock('../../src/components/vision/useVisionStore.js', () => {
  const s = { activeBuild: null, gates: new Map(), items: new Map(), recentErrors: [], resolveGate: null, iterationStates: new Map() };
  return { useVisionStore: (sel) => (typeof sel === 'function' ? sel(s) : s) };
});

const { buildUnitIndex } = await import('../../lib/unit-index.js');
const { resetFleetPoller } = await import('../../src/lib/fleetPoller.js');
const { resetUnitIndex } = await import('../../src/lib/useUnitIndex.js');
const { sourceOk, sourceFail, sourceFromBody, envelopeFaults, sourceNoteText, INITIAL_SOURCE } = await import('../../src/lib/sourceState.js');
const { unitLabel } = await import('../../src/lib/unitLabel.js');
const { LAST_VISIT_KEY } = await import('../../src/components/cockpit/what/whatRules.js');
const { default: WhatLine } = await import('../../src/components/cockpit/what/WhatLine.jsx');
const { default: UnitName } = await import('../../src/components/shared/UnitName.jsx');
const { default: Coverage } = await import('../../src/components/shared/Coverage.jsx');

const NOW = Date.parse('2026-11-03T12:00:00Z');
const up = (value) => ({ value, error: null, ts: 1, stale: false });
const FLEET = { generated: '2026-11-03T12:00:00Z', sources: { sm_status: up({ sessions: up([]), jobs: up([]), queue: up([]) }) } };
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

/** fetch by URL prefix → a 200 with that body; anything else 404s. */
function stub(routes) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const key = Object.keys(routes).find((k) => String(url).startsWith(k));
    return key ? ok(routes[key]) : { ok: false, status: 404, json: async () => ({}) };
  }));
}

/** The route's body for a built index (`server/unit-index-routes.js:43-48`, no lane filter), through JSON as on the wire. */
const wire = (idx) => JSON.parse(JSON.stringify({ units: idx.units, coverage: idx.coverage, glossary: idx.glossary, asOf: idx.asOf, error: idx.error, warnings: idx.warnings, ageS: 0 }));

let root;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'source-envelope-')); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });
beforeEach(() => { resetFleetPoller(); resetUnitIndex(); localStorage.setItem(LAST_VISIT_KEY, String(NOW - 3_600_000)); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

/** Probe 1: a regular file where the queues directory should be → `error = 'queues dir unreadable (ENOTDIR)'`, units []. */
async function probe1(extra = []) {
  const file = join(root, `not-a-dir-${Math.random().toString(36).slice(2)}`);
  writeFileSync(file, 'x');
  return buildUnitIndex({ queuesDir: file, extra, now: NOW, warn: () => {} });
}

/** Probe 2: the queues directory is gone (a warning) and the one extra lane file is corrupt (a coverage error). */
async function probe2() {
  const dir = mkdtempSync(join(root, 'p2-'));
  const bad = join(dir, 'forge-units.json');
  writeFileSync(bad, '{not json');
  return buildUnitIndex({ queuesDir: join(dir, 'gone'), extra: [['forge', bad]], now: NOW, warn: () => {} });
}

describe('the producer bodies the probes build (precondition)', () => {
  it('probe 1 is ENOTDIR with no units; probe 2 is a missing dir warning plus a corrupt lane', async () => {
    const a = await probe1();
    expect([a.error, a.units.length]).toEqual(['queues dir unreadable (ENOTDIR)', 0]);
    const b = await probe2();
    expect([b.error, b.warnings, b.coverage.forge.error, b.units.length]).toEqual([null, ['queues dir not found'], 'forge: not JSON', 0]);
  });
});

describe('one source shape carries "answered, incomplete" (lib/sourceState.js)', () => {
  it('envelopeFaults reads error, warnings and coverage[*].error; a clean body or a fleet-shaped body is null', () => {
    expect(envelopeFaults({ units: [], error: 'queues dir unreadable (ENOTDIR)', warnings: ['queues dir not found'], coverage: { a: { error: 'a: not JSON' }, b: { n: 1, warnings: ['1 row skipped (not an object)'] } } }))
      .toEqual(['queues dir unreadable (ENOTDIR)', 'queues dir not found', 'a: not JSON']);
    expect(envelopeFaults({ units: [], error: null, warnings: [], coverage: { a: { n: 0, pct: {} } } })).toBe(null);
    expect(envelopeFaults({ generated: 'x', sources: { sm_status: { value: null, error: 'down' } } })).toBe(null);
    expect(envelopeFaults(null)).toBe(null);
  });
  it('sourceFromBody is sourceOk plus partial; a failed refresh keeps the partial reasons; the note says incomplete', () => {
    expect(INITIAL_SOURCE.partial).toBe(null);
    expect(sourceOk({ x: 1 }, 5).partial).toBe(null);
    const s = sourceFromBody({ units: [], error: 'queues dir unreadable (ENOTDIR)' }, 5);
    expect({ ...s, data: null }).toEqual({ data: null, error: null, stale: false, fetchedAt: 5, errorSince: null, loading: false, partial: ['queues dir unreadable (ENOTDIR)'] });
    expect(sourceNoteText('Unit index', s)).toBe('Unit index incomplete: queues dir unreadable (ENOTDIR)');
    expect(sourceNoteText('Unit index', s, { short: true })).toBe('Unit index incomplete');
    const f = sourceFail(s, 'down', 9);
    expect([f.partial, f.stale]).toEqual([['queues dir unreadable (ENOTDIR)'], true]);
    expect(sourceNoteText('Unit index', f)).toMatch(/^Unit index unreadable since \d\d:\d\d: down; showing the last good read/);
  });
});

describe('probe 1 (queue dir unlistable) through the real poller', () => {
  it('WhatLine: review and landed counts are unknown, not 0, and the note names the producer reason', async () => {
    stub({ '/api/fleet': FLEET, '/api/units/index': wire(await probe1()) });
    render(<WhatLine />);
    await waitFor(() => expect(screen.getByTestId('what-line')).toBeTruthy());
    const review = screen.getByTestId('what-count-review');
    expect(review.getAttribute('data-known')).toBe('false');
    expect(review.textContent).not.toMatch(/^0 /);
    expect(review.getAttribute('aria-label')).toMatch(/Unit index incomplete/i);
    expect(screen.getByTestId('what-count-landed').getAttribute('data-known')).toBe('false');
    const notes = screen.getAllByTestId('source-note');
    expect(notes.map((n) => n.textContent)).toEqual(['Unit index incomplete: queues dir unreadable (ENOTDIR)']);
  });
  it('UnitName: a unit the index could not read is "name unavailable", not a title hole', async () => {
    stub({ '/api/units/index': wire(await probe1()) });
    render(<UnitName id="U-9" lane="forge" />);
    await waitFor(() => expect(screen.getByTestId('unit-name').dataset.titleSource).toBe('unavailable'));
    expect(screen.getByTestId('unit-name').textContent).not.toMatch(/no title recorded/);
    expect(screen.getByTestId('unit-name').getAttribute('title')).toMatch(/name unavailable/);
  });
  it('a unit the partial index did read keeps its name, with the incompleteness in its explanation', async () => {
    const extra = join(root, 'x-units.json');
    writeFileSync(extra, JSON.stringify({ units: [{ id: 'X-1', title: 'Readable unit', review_done_at: null, author_done_at: '2026-11-03T10:00:00Z' }] }));
    stub({ '/api/units/index': wire(await probe1([['x', extra]])) });
    render(<UnitName id="X-1" lane="x" />);
    await waitFor(() => expect(screen.getByTestId('unit-name').textContent).toMatch(/^Readable unit · X-1/));
    fireEvent.focus(screen.getByTestId('unit-name'));
    expect(screen.getByTestId('unit-name-tip').textContent).toMatch(/unit index incomplete/i);
  });
  it('Coverage: a lane with no row names the index-wide fault', async () => {
    stub({ '/api/units/index': wire(await probe1()) });
    render(<Coverage lane="forge" events={['review']} />);
    await waitFor(() => expect(screen.getByTestId('coverage-forge').textContent).toMatch(/^coverage unknown/));
    expect(screen.getAllByTestId('source-note').map((n) => n.textContent)).toEqual(['Unit index unreadable: queues dir unreadable (ENOTDIR)']);
  });
});

describe('probe 2 (corrupt lane file + missing queue dir) through the real poller', () => {
  it('WhatLine: unknown, not 0, with both producer reasons in the note', async () => {
    stub({ '/api/fleet': FLEET, '/api/units/index': wire(await probe2()) });
    render(<WhatLine />);
    await waitFor(() => expect(screen.getByTestId('what-line')).toBeTruthy());
    expect(screen.getByTestId('what-count-review').getAttribute('data-known')).toBe('false');
    expect(screen.getAllByTestId('source-note').map((n) => n.textContent)).toEqual(['Unit index incomplete: queues dir not found; forge: not JSON']);
  });
  it('Coverage: the corrupt lane shows its lane error; another lane shows the index-wide warning', async () => {
    stub({ '/api/units/index': wire(await probe2()) });
    render(<><Coverage lane="forge" events={['review']} /><Coverage lane="other" events={['review']} /></>);
    await waitFor(() => expect(screen.getAllByTestId('source-note').length).toBe(2));
    expect(screen.getAllByTestId('source-note').map((n) => n.textContent)).toEqual(['forge stamps unreadable: forge: not JSON', 'Unit index unreadable: queues dir not found']);
    expect(screen.getByTestId('coverage-forge').textContent).toMatch(/^coverage unknown/);
  });
  it('unitLabel: a partial index without the unit is unavailable; a whole index without it is still a hole', () => {
    const idx = { units: [], glossary: {} };
    expect(unitLabel('U-9', idx, 'forge', { partial: ['forge: not JSON'] }).source).toBe('unavailable');
    expect(unitLabel('U-9', idx, 'forge').source).toBe('none');
  });
});

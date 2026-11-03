/**
 * dayview-owner-identity.test.jsx — COMP-DAYVIEW-OWNER-IDENTITY-1, mounted: the Needs-you markers the Day ribbon draws at now
 * equal the headline's count (WhatLine, over the fleet queue), and the phone row says what the ribbon says, for the three
 * shapes the U3 reviews found open: review F1 (the stamp's remainder after its ask was answered), Codex M1 (a lane with only
 * a stamp, no ask), and a stamp whose ask (`qid`) sits on another lane. Each body is reconciled by the route's own function.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', async (orig) => ({ ...(await orig()), wsFetch: vi.fn() }));
import { wsFetch } from '../../src/lib/wsFetch.js';
import DayView from '../../src/components/ribbon/DayView.jsx';
import { reconcileOwnerSpans } from '../../lib/owner-spans.js';
import { resetFleetPoller } from '../../src/lib/fleetPoller.js';
import { resetUnitIndex } from '../../src/lib/useUnitIndex.js';

const RIBBON = JSON.parse(readFileSync(resolve(process.cwd(), 'test/fixtures/ribbon/day.json'), 'utf8'));
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
const setWidth = (w) => Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w });
const clone = (o) => JSON.parse(JSON.stringify(o));
const fleetWith = (queue) => ({
  generated: new Date().toISOString(),
  sources: { sm_status: { value: { sessions: { value: [], error: null }, jobs: { value: [], error: null }, queue: { value: queue, error: null } }, error: null, ts: 1, stale: false } },
});
const isOwner = (s) => s.kind === 'wait' && s.cause === 'owner';
const ASK = { id: 'A', by: 'forge-main', text: 'ASK: ship it?', age: 600 };

function stub(ribbon, queue, units = []) {
  wsFetch.mockImplementation(async (url) => {
    const u = String(url);
    if (u.startsWith('/api/ribbon')) return ok(ribbon);
    if (u.startsWith('/api/fleet')) return ok(fleetWith(queue));
    if (u.startsWith('/api/units/index')) return ok({ asOf: new Date().toISOString(), units });
    return ok({});
  });
  global.fetch = vi.fn(async () => ok({}));
}

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); window.history.pushState({}, '', '/');
  wsFetch.mockReset(); resetFleetPoller(); resetUnitIndex(); setWidth(1440);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); setWidth(1024); });

/** Every lane reconciled as the route does on a good queue read: every lane's queue spans are the asks. */
function reconciled(d) {
  const asks = d.lanes.flatMap((l) => l.spans.filter((s) => isOwner(s) && s.queueId));
  for (const l of d.lanes) l.spans = reconcileOwnerSpans(l.spans, { asOf: Date.parse(d.now), asks });
  return d;
}

/** Review F1: ops' ask was answered at 15:40, its stamp still open: the remainder 15:40 to now is history. */
function answeredAsk() {
  const d = clone(RIBBON);
  const ops = d.lanes.find((l) => l.lane === 'ops');
  const own = ops.spans.find(isOwner);
  ops.spans = [...ops.spans.filter((s) => s !== own), { ...own, open: true },
    { ...own, open: undefined, queueId: 'Q1', end: '2026-10-31T15:40:00-07:00', since: own.start }];
  d.owner = { open: [] };
  return { body: reconciled(d), queue: [], units: [], ownerLanes: [] };
}

/** Codex M1: ops is the only lane, it has an open stamp and no ask; no current unit, and the index calls O-2 an owner wait. */
function stampOnly() {
  const d = clone(RIBBON);
  d.lanes = d.lanes.filter((l) => l.lane === 'ops');
  const ops = d.lanes[0];
  ops.current = null;
  ops.spans = ops.spans.map((s) => (isOwner(s) ? { ...s, open: true } : s));
  d.owner = { open: [] };
  const units = [{ id: 'O-2', lane: 'ops', title: 'Launch gate author bypass', waiting: 'owner', ownerWaitSince: ops.spans.find(isOwner).start }];
  return { body: reconciled(d), queue: [], units, ownerLanes: [] };
}

/** The stamp is web's (its unit W-2 carries qid A); ask A has no lane and is shown on ops. One wait, on ops. */
function askOnAnotherLane() {
  const d = clone(RIBBON);
  const ops = d.lanes.find((l) => l.lane === 'ops');
  const web = d.lanes.find((l) => l.lane === 'web');
  const own = ops.spans.find(isOwner);
  ops.spans = [...ops.spans.filter((s) => s !== own), { ...own, open: undefined, unit: null, queueId: 'A', laneGuess: true }];
  web.spans = [...web.spans, { ...own, unit: 'W-2', qid: 'A', open: true }];
  d.owner = { open: [ASK] };
  return { body: reconciled(d), queue: [{ ...ASK, red: false }], units: [], ownerLanes: ['ops'] };
}

const headline = () => {
  const t = screen.getByTestId('what-count-you').textContent;
  return /Nothing needs you/.test(t) ? 0 : Number((t.match(/^(\d+) needs you/) || [])[1] ?? NaN);
};

describe('OWNER-IDENTITY-1: drawn owner waits at now equal the headline, on the ribbon and the phone', () => {
  // [name, build]
  const ROWS = [
    ['review F1: an answered ask\'s stamp remainder is not "waiting on you"', answeredAsk],
    ['Codex M1: a stamp-only lane draws no Needs-you marker and the phone does not say "waiting on you"', stampOnly],
    ['a stamp whose ask sits on another lane: one marker, on the ask\'s lane, never two', askOnAnotherLane],
  ];
  for (const [name, build] of ROWS) {
    it(name, async () => {
      const { body, queue, units, ownerLanes } = build();
      stub(body, queue, units);
      render(<DayView onNavigate={() => {}} />);
      await screen.findByTestId('day-ribbon');
      await waitFor(() => expect(screen.getByTestId('what-count-you').getAttribute('data-known')).toBe('true'));
      await screen.findByTestId('lane-ops');
      const n = headline();
      expect(n).toBe(ownerLanes.length);
      const marks = screen.queryAllByTestId('owner-now');
      expect(marks.length, 'drawn Needs-you markers equal the headline').toBe(n);
      expect(marks.map((m) => m.closest('[data-testid^="lane-"]')?.getAttribute('data-testid'))).toEqual(ownerLanes.map((l) => `lane-${l}`));
      const ribbonOwner = body.lanes.filter((l) => /on you/.test(screen.queryByTestId(`lane-${l.lane}`)?.querySelector('text.cur')?.textContent ?? '')).map((l) => l.lane);
      expect(ribbonOwner).toEqual(ownerLanes);
      cleanup(); resetFleetPoller(); resetUnitIndex();
      setWidth(400);
      render(<DayView onNavigate={() => {}} />);
      await screen.findByTestId('day-phone-lanes');
      await waitFor(() => expect(screen.getByTestId('what-count-you').getAttribute('data-known')).toBe('true'));
      const phoneOwner = screen.queryAllByTestId('day-phone-lane').filter((r) => /on you/.test(r.getAttribute('aria-label'))).map((r) => r.getAttribute('aria-label').split(':')[0]);
      expect(phoneOwner, 'the phone says what the ribbon says').toEqual(ownerLanes);
    }, 30000);
  }
});

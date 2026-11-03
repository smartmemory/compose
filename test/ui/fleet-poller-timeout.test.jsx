/**
 * COMP-COCKPIT-UNKNOWN-FU-1: a fleet request that never answers is cut at FLEET_TIMEOUT_MS, marked stale through the shared
 * sourceFail path, and the next tick polls again (the loop used to stop for good on one hung request).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from '@testing-library/react';
import { subscribeFleet, resetFleetPoller, FLEET_POLL_MS, FLEET_TIMEOUT_MS } from '../../src/lib/fleetPoller.js';

const BODY = { generated: 'g', sources: { sm_status: { value: { sessions: { value: [], error: null }, jobs: { value: [], error: null } }, error: null, ts: 1, stale: false } } };

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); resetFleetPoller(); });

describe('fleetPoller deadline', () => {
  it('the timeout is under the poll interval', () => { expect(FLEET_TIMEOUT_MS).toBeLessThan(FLEET_POLL_MS); });

  it('a fetch that never resolves leaves the last data, marked stale, and a second poll follows the timeout', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    let n = 0;
    let signals = [];
    vi.stubGlobal('fetch', vi.fn((url, opts) => {
      signals.push(opts?.signal);
      return ++n === 1 ? Promise.resolve({ ok: true, status: 200, json: async () => BODY }) : new Promise(() => {});
    }));
    resetFleetPoller();
    const seen = [];
    const off = subscribeFleet((s) => seen.push(s));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(seen.at(-1)).toMatchObject({ stale: false, error: null, loading: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(FLEET_POLL_MS); }); // poll 2 starts and hangs
    expect(n).toBe(2);
    expect(seen.at(-1).stale).toBe(false); // not yet timed out
    await act(async () => { await vi.advanceTimersByTimeAsync(FLEET_TIMEOUT_MS); });
    expect(seen.at(-1)).toMatchObject({ stale: true, data: BODY });
    expect(seen.at(-1).error).toMatch(/timed out/);
    expect(signals[1].aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(FLEET_POLL_MS); }); // the next tick polls again
    expect(n).toBe(3);
    off();
  });
});

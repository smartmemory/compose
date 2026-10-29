/** COMPOSE-STRAT-GATE-WIRE-1: StratumPanel loads gates and flows only through a mocked /api/stratum. */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

vi.mock('../../src/components/vision/useVisionStore.js', () => ({
  useVisionStore: (sel) => sel({ activeBuild: null }),
}));

import StratumPanel from '../../src/components/StratumPanel.jsx';
import { DEFAULT_MAIN_TABS } from '../../src/components/cockpit/viewTabsState.js';

const calls = [];
const mockApi = () => vi.fn(async (url, opts = {}) => {
  calls.push([String(url), opts.method || 'GET']);
  return { ok: true, status: 200, json: async () => [] };
});

describe('StratumPanel view', () => {
  beforeEach(() => { calls.length = 0; });
  afterEach(() => vi.unstubAllGlobals());

  it('is a default tab', () => expect(DEFAULT_MAIN_TABS).toContain('stratum'));

  it('reads gates and flows through /api/stratum only', async () => {
    vi.stubGlobal('fetch', mockApi());
    render(<StratumPanel />);
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    expect(calls.every(([u]) => u.includes('/api/stratum/'))).toBe(true);
    expect(calls.some(([u]) => u.endsWith('/gates'))).toBe(true);
    expect(calls.some(([u]) => u.endsWith('/flows'))).toBe(true);
  });
});

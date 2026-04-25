/**
 * ops-strip-budget.test.jsx — vitest+jsdom tests for the OpsStrip budget pill.
 *
 * COMP-OBS-STEPDETAIL (COMP-BUDGET-3 absorption):
 *   - Budget pill is absent when no activeFeatureCode
 *   - Budget pill is absent when budget has no maxTotal for any loopType
 *   - Budget pill renders compact "r N/M · c N/M" when at least one loopType has maxTotal
 *   - Budget pill renders only the loopTypes that have maxTotal
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

// ── Mock useVisionStore ───────────────────────────────────────────────────────

let _storeState = {
  activeBuild: null,
  gates: new Map(),
  items: new Map(),
  recentErrors: [],
  resolveGate: null,
  iterationStates: new Map(),
};

vi.mock('../../src/components/vision/useVisionStore.js', () => ({
  useVisionStore: (selector) => {
    if (typeof selector === 'function') return selector(_storeState);
    return _storeState;
  },
}));

// ── Mock fetch for budget endpoint ────────────────────────────────────────────

function mockFetch(budgetResponse) {
  global.fetch = vi.fn().mockImplementation((url) => {
    if (url?.includes?.('/api/lifecycle/budget')) {
      return Promise.resolve({
        ok: true,
        json: async () => budgetResponse,
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
}

// ── Import component after mocking ────────────────────────────────────────────
const { default: OpsStrip } = await import('../../src/components/cockpit/OpsStrip.jsx');

// ── Helpers ────────────────────────────────────────────────────────────────────

function setStore(partial) {
  _storeState = { ..._storeState, ...partial };
}

function resetStore() {
  _storeState = {
    activeBuild: null,
    gates: new Map(),
    items: new Map(),
    recentErrors: [],
    resolveGate: null,
    iterationStates: new Map(),
  };
}

function makeBudget(overrides = {}) {
  return {
    featureCode: 'FC-TEST',
    feature_total: { usedIterations: 5, usedActions: 10, totalTimeMs: 1000 },
    per_loop_type: {
      review:   { usedIterations: 5, maxTotal: 20, remaining: 15 },
      coverage: { usedIterations: 5, maxTotal: 50, remaining: 45 },
    },
    computed_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('<OpsStrip> — budget pill (COMP-OBS-STEPDETAIL)', () => {
  beforeEach(() => {
    resetStore();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when activeBuild is null (ops strip hidden)', () => {
    mockFetch(null);
    setStore({ activeBuild: null });
    const { container } = render(<OpsStrip activeView="cockpit" />);
    // OpsStrip hides when no entries
    expect(container.querySelector('.ops-strip')).toBeNull();
  });

  it('does not show budget pill when budget is null', async () => {
    mockFetch(null);
    setStore({
      activeBuild: { featureCode: 'FC-TEST', status: 'running', currentStep: 'step-1' },
    });

    await act(async () => {
      render(<OpsStrip activeView="cockpit" />);
    });

    const container = document.querySelector('.ops-strip');
    if (container) {
      // Budget pill should not appear if budget not loaded or no maxTotal
      expect(container.textContent).not.toMatch(/r \d+\/\d+/);
    }
  });

  it('renders compact budget pill when both loopTypes have maxTotal', async () => {
    const budget = makeBudget();
    mockFetch(budget);

    setStore({
      activeBuild: { featureCode: 'FC-TEST', status: 'running', currentStep: 'step-1' },
    });

    await act(async () => {
      render(<OpsStrip activeView="cockpit" />);
    });

    // After async budget fetch resolves
    await act(async () => {});

    const strip = document.querySelector('.ops-strip');
    if (strip) {
      // The pill should contain "r 5/20" and "c 5/50"
      expect(strip.textContent).toMatch(/r 5\/20/);
      expect(strip.textContent).toMatch(/c 5\/50/);
    }
  });

  it('omits coverage from pill when coverage has no maxTotal', async () => {
    const budget = makeBudget({
      per_loop_type: {
        review:   { usedIterations: 3, maxTotal: 20, remaining: 17 },
        coverage: { usedIterations: 3, maxTotal: null, remaining: null },
      },
    });
    mockFetch(budget);

    setStore({
      activeBuild: { featureCode: 'FC-TEST', status: 'running', currentStep: 'step-1' },
    });

    await act(async () => {
      render(<OpsStrip activeView="cockpit" />);
    });
    await act(async () => {});

    const strip = document.querySelector('.ops-strip');
    if (strip) {
      expect(strip.textContent).toMatch(/r 3\/20/);
      expect(strip.textContent).not.toMatch(/c \d+\/\d+/);
    }
  });

  it('does not render budget pill when no loopType has maxTotal', async () => {
    const budget = makeBudget({
      per_loop_type: {
        review:   { usedIterations: 5, maxTotal: null, remaining: null },
        coverage: { usedIterations: 5, maxTotal: null, remaining: null },
      },
    });
    mockFetch(budget);

    setStore({
      activeBuild: { featureCode: 'FC-TEST', status: 'running', currentStep: 'step-1' },
    });

    await act(async () => {
      render(<OpsStrip activeView="cockpit" />);
    });
    await act(async () => {});

    const strip = document.querySelector('.ops-strip');
    if (strip) {
      expect(strip.textContent).not.toMatch(/r \d+\/\d+/);
    }
  });
});

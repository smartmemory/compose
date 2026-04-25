/**
 * context-step-detail.test.jsx — vitest+jsdom tests for ContextStepDetail.jsx
 *
 * COMP-OBS-STEPDETAIL covers:
 *   - Retries section hidden when step.retries is zero/absent
 *   - Retries section renders count when step.retries is a positive int
 *   - Retries section renders count when step.retries is an array
 *   - Postcondition violations section hidden when step.violations is empty
 *   - Postcondition violations section renders when violations present
 *   - Live counters section hidden when no running loop for this step
 *   - Live counters section renders attempt count when loop is running
 *   - Component subscribes to useVisionStore (no self-fetch for activeBuild)
 *   - Step "not found" renders gracefully when stepId not in activeBuild
 *   - budget pill text in live counters when budget present
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

// ── Mock useVisionStore ───────────────────────────────────────────────────────
// We intercept the module so ContextStepDetail uses our fake store.

let _storeState = { activeBuild: null, iterationStates: new Map() };

vi.mock('../../src/components/vision/useVisionStore.js', () => ({
  useVisionStore: (selector) => {
    if (typeof selector === 'function') return selector(_storeState);
    return _storeState;
  },
}));

// ── Mock fetch for budget endpoint ────────────────────────────────────────────

function mockFetchBudget(response = null) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => response ?? {
      featureCode: 'FC-TEST',
      feature_total: { usedIterations: 3, usedActions: 5, totalTimeMs: 1000 },
      per_loop_type: {
        review:   { usedIterations: 3, maxTotal: 20, remaining: 17 },
        coverage: { usedIterations: 3, maxTotal: 50, remaining: 47 },
      },
      computed_at: new Date().toISOString(),
    },
  });
}

// ── Import component after mocking ───────────────────────────────────────────
const { default: ContextStepDetail } = await import('../../src/components/cockpit/ContextStepDetail.jsx');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStep(overrides = {}) {
  return {
    id: 'step-1',
    status: 'done',
    ...overrides,
  };
}

function makeActiveBuild(steps = []) {
  return {
    featureCode: 'FC-TEST',
    steps,
  };
}

function setStore(partial) {
  _storeState = { activeBuild: null, iterationStates: new Map(), ..._storeState, ...partial };
}

function resetStore() {
  _storeState = { activeBuild: null, iterationStates: new Map() };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('<ContextStepDetail> — store subscription replaces self-fetch', () => {
  beforeEach(() => {
    resetStore();
    mockFetchBudget();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders step-not-found when activeBuild is null', () => {
    setStore({ activeBuild: null });
    render(<ContextStepDetail stepId="step-1" />);
    expect(screen.getByText(/step-1/i, { exact: false })).toBeTruthy();
  });

  it('renders step data from store activeBuild (no fetch needed)', async () => {
    setStore({ activeBuild: makeActiveBuild([makeStep({ id: 'step-1', status: 'done' })]) });
    // fetch should NOT be called for build/state — only budget endpoint may be called
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    global.fetch = fetchSpy;

    await act(async () => {
      render(<ContextStepDetail stepId="step-1" />);
    });

    // Verify /api/build/state was not fetched
    const buildStateCalls = (fetchSpy.mock.calls ?? []).filter(c => c[0]?.includes?.('/api/build/state'));
    expect(buildStateCalls.length).toBe(0);
  });
});

describe('<ContextStepDetail> — Retries section', () => {
  beforeEach(() => { resetStore(); mockFetchBudget(); });

  it('hides retries section when step.retries is absent', () => {
    setStore({ activeBuild: makeActiveBuild([makeStep({ id: 'step-1' })]) });
    const { container } = render(<ContextStepDetail stepId="step-1" />);
    // Should not render any element with "Retried" text
    expect(container.textContent).not.toMatch(/retried/i);
  });

  it('hides retries section when step.retries is 0', () => {
    setStore({ activeBuild: makeActiveBuild([makeStep({ id: 'step-1', retries: 0 })]) });
    const { container } = render(<ContextStepDetail stepId="step-1" />);
    expect(container.textContent).not.toMatch(/retried/i);
  });

  it('renders "Retried 3 times" when step.retries is 3', () => {
    setStore({ activeBuild: makeActiveBuild([makeStep({ id: 'step-1', retries: 3 })]) });
    render(<ContextStepDetail stepId="step-1" />);
    expect(screen.getByText(/retried 3 times/i)).toBeTruthy();
  });

  it('renders retry count from array length when step.retries is an array', () => {
    const retries = [{ reason: 'timeout' }, { reason: 'exit-1' }];
    setStore({ activeBuild: makeActiveBuild([makeStep({ id: 'step-1', retries })]) });
    render(<ContextStepDetail stepId="step-1" />);
    expect(screen.getByText(/retried 2 times/i)).toBeTruthy();
  });
});

describe('<ContextStepDetail> — Postcondition violations section', () => {
  beforeEach(() => { resetStore(); mockFetchBudget(); });

  it('hides violations section when step.violations is absent', () => {
    setStore({ activeBuild: makeActiveBuild([makeStep({ id: 'step-1' })]) });
    const { container } = render(<ContextStepDetail stepId="step-1" />);
    expect(container.textContent).not.toMatch(/postcondition violations/i);
  });

  it('hides violations section when step.violations is empty', () => {
    setStore({ activeBuild: makeActiveBuild([makeStep({ id: 'step-1', violations: [] })]) });
    const { container } = render(<ContextStepDetail stepId="step-1" />);
    expect(container.textContent).not.toMatch(/postcondition violations/i);
  });

  it('renders "Postcondition violations" heading when violations present', () => {
    const violations = [{ name: 'ensure-tests', message: 'Tests failed: 3' }];
    setStore({ activeBuild: makeActiveBuild([makeStep({ id: 'step-1', violations })]) });
    render(<ContextStepDetail stepId="step-1" />);
    expect(screen.getByText(/postcondition violations/i)).toBeTruthy();
  });

  it('renders each violation message', () => {
    const violations = [
      { name: 'ensure-tests', message: 'Tests failed: 3' },
      { message: 'Coverage dropped below 80%' },
    ];
    setStore({ activeBuild: makeActiveBuild([makeStep({ id: 'step-1', violations })]) });
    render(<ContextStepDetail stepId="step-1" />);
    expect(screen.getByText('Tests failed: 3')).toBeTruthy();
    expect(screen.getByText('Coverage dropped below 80%')).toBeTruthy();
  });
});

describe('<ContextStepDetail> — Live counters section', () => {
  beforeEach(() => { resetStore(); mockFetchBudget(); });

  it('hides live counters section when no running iteration exists', () => {
    setStore({
      activeBuild: makeActiveBuild([makeStep({ id: 'step-1' })]),
      iterationStates: new Map(),
    });
    const { container } = render(<ContextStepDetail stepId="step-1" />);
    expect(container.textContent).not.toMatch(/live counters/i);
  });

  it('hides live counters when loop exists but no stepId match', () => {
    const iter = { loopId: 'l1', stepId: 'step-99', status: 'running', count: 2, maxIterations: 5, loopType: 'review', startedAt: new Date().toISOString() };
    setStore({
      activeBuild: makeActiveBuild([makeStep({ id: 'step-1' })]),
      iterationStates: new Map([['l1', iter]]),
    });
    const { container } = render(<ContextStepDetail stepId="step-1" />);
    expect(container.textContent).not.toMatch(/live counters/i);
  });

  it('renders live counters heading when running loop matches stepId', async () => {
    const iter = {
      loopId: 'l1', stepId: 'step-1', status: 'running',
      count: 2, maxIterations: 8, loopType: 'review',
      startedAt: new Date(Date.now() - 5000).toISOString(),
      wallClockTimeout: null,
    };
    setStore({
      activeBuild: makeActiveBuild([makeStep({ id: 'step-1' })]),
      iterationStates: new Map([['l1', iter]]),
    });

    await act(async () => {
      render(<ContextStepDetail stepId="step-1" />);
    });

    expect(screen.getByText(/live counters/i)).toBeTruthy();
  });

  it('renders attempt N/M in live counters', async () => {
    const iter = {
      loopId: 'l1', stepId: 'step-1', status: 'running',
      count: 3, maxIterations: 10, loopType: 'review',
      startedAt: new Date(Date.now() - 2000).toISOString(),
      wallClockTimeout: null,
    };
    setStore({
      activeBuild: makeActiveBuild([makeStep({ id: 'step-1' })]),
      iterationStates: new Map([['l1', iter]]),
    });

    await act(async () => {
      render(<ContextStepDetail stepId="step-1" />);
    });

    // Should show attempt 3/10
    expect(screen.getByText(/3\/10/)).toBeTruthy();
  });

  it('degrades gracefully when iterationStates entries lack stepId', () => {
    // No stepId on the iteration — live counters section should not appear
    const iter = { loopId: 'l1', status: 'running', count: 1, maxIterations: 5, loopType: 'review', startedAt: new Date().toISOString() };
    setStore({
      activeBuild: makeActiveBuild([makeStep({ id: 'step-1' })]),
      iterationStates: new Map([['l1', iter]]),
    });
    const { container } = render(<ContextStepDetail stepId="step-1" />);
    expect(container.textContent).not.toMatch(/live counters/i);
  });
});

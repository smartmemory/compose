/**
 * completion-badge.test.jsx — vitest+jsdom tests for CompletionBadge.jsx and
 * the pure computeDivergence helper (COMP-PARITY-5).
 *
 * Covers (component, fetch mocked):
 *   - golden: completion shows short SHA + "tests pass" (emerald), no divergence
 *   - tests-failed chip (rose)
 *   - divergence — completion present but status not complete (message has SHA)
 *   - divergence — status complete but no completion (no-evidence message)
 *   - neutral — no completion, non-complete status → "No recorded completion.", no flag
 *   - aligned — completion + status complete → badge, no flag
 *   - no featureCode (free item) → renders nothing
 *
 * Covers (pure logic): every divergence rule row from the blueprint/design.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', () => ({ wsFetch: vi.fn() }));

import { wsFetch } from '../../src/lib/wsFetch.js';
import CompletionBadge from '../../src/components/vision/shared/CompletionBadge.jsx';
import { computeDivergence } from '../../src/components/vision/shared/completionDivergence.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeCompletion(overrides = {}) {
  return {
    commit_sha_short: 'c149a4e5',
    commit_sha: 'c149a4e51234567890abcdef',
    tests_pass: true,
    recorded_at: '2026-06-16T12:00:00Z',
    ...overrides,
  };
}

function mockCompletions(completions) {
  wsFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ completions, count: completions.length }),
  });
}

// ── Tests: component ──────────────────────────────────────────────────────────

describe('CompletionBadge — component', () => {
  beforeEach(() => {
    wsFetch.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('golden — shows short SHA + tests-pass (emerald), no divergence', async () => {
    mockCompletions([makeCompletion({ tests_pass: true })]);
    render(<CompletionBadge featureCode="COMP-PARITY-5" status="complete" />);

    await waitFor(() => expect(screen.getByTestId('completion-sha')).toBeDefined());
    expect(screen.getByTestId('completion-sha').textContent).toContain('c149a4e5');

    const tests = screen.getByTestId('completion-tests');
    expect(tests.textContent).toMatch(/tests pass/i);
    expect(tests.className).toMatch(/emerald/);

    expect(screen.queryByTestId('completion-divergence')).toBeNull();

    // fetch keyed on featureCode + limit=1
    expect(wsFetch).toHaveBeenCalledWith(
      '/api/completions?featureCode=COMP-PARITY-5&limit=1',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('tests-failed chip renders rose', async () => {
    mockCompletions([makeCompletion({ tests_pass: false })]);
    render(<CompletionBadge featureCode="COMP-PARITY-5" status="complete" />);

    const tests = await screen.findByTestId('completion-tests');
    expect(tests.textContent).toMatch(/tests failed/i);
    expect(tests.className).toMatch(/rose/);
  });

  it('divergence — completion present but status not complete (message has SHA)', async () => {
    mockCompletions([makeCompletion({ commit_sha_short: 'c149a4e5' })]);
    render(<CompletionBadge featureCode="COMP-PARITY-5" status="in_progress" />);

    const flag = await screen.findByTestId('completion-divergence');
    expect(flag.textContent).toContain('c149a4e5');
    expect(flag.textContent).toMatch(/in_progress/);
  });

  it('divergence — status complete but no completion (no-evidence message)', async () => {
    mockCompletions([]);
    render(<CompletionBadge featureCode="COMP-PARITY-5" status="complete" />);

    const flag = await screen.findByTestId('completion-divergence');
    expect(flag.textContent).toMatch(/no recorded completion/i);
    // the empty-state line is shown for the missing completion
    expect(screen.getByTestId('completion-none')).toBeDefined();
  });

  it('neutral — no completion + non-complete status → no divergence flag', async () => {
    mockCompletions([]);
    render(<CompletionBadge featureCode="COMP-PARITY-5" status="planned" />);

    await waitFor(() => expect(screen.getByTestId('completion-none')).toBeDefined());
    expect(screen.queryByTestId('completion-divergence')).toBeNull();
  });

  it('aligned — completion + status complete → badge, no divergence flag', async () => {
    mockCompletions([makeCompletion()]);
    render(<CompletionBadge featureCode="COMP-PARITY-5" status="complete" />);

    await waitFor(() => expect(screen.getByTestId('completion-badge')).toBeDefined());
    expect(screen.getByTestId('completion-sha')).toBeDefined();
    expect(screen.queryByTestId('completion-divergence')).toBeNull();
  });

  it('no featureCode (free item) → renders nothing and does not fetch', async () => {
    const { container } = render(<CompletionBadge featureCode={undefined} status="planned" />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('completion-badge')).toBeNull();
    expect(wsFetch).not.toHaveBeenCalled();
  });
});

// ── Tests: pure logic (computeDivergence rule rows) ────────────────────────────

describe('computeDivergence', () => {
  const completion = { commit_sha_short: 'abc12345', commit_sha: 'abc1234567890', tests_pass: true };

  it('no completion + non-complete status → none, not diverged', () => {
    const r = computeDivergence('planned', null);
    expect(r).toEqual({ kind: 'none', diverged: false, message: null });
  });

  it('no completion + complete status → diverged (no-evidence)', () => {
    const r = computeDivergence('complete', null);
    expect(r.kind).toBe('diverged');
    expect(r.diverged).toBe(true);
    expect(r.message).toMatch(/no recorded completion/i);
  });

  it('completion + complete status → aligned, not diverged', () => {
    const r = computeDivergence('complete', completion);
    expect(r).toEqual({ kind: 'aligned', diverged: false, message: null });
  });

  it('completion + in_progress status → diverged (message has SHA)', () => {
    const r = computeDivergence('in_progress', completion);
    expect(r.kind).toBe('diverged');
    expect(r.diverged).toBe(true);
    expect(r.message).toContain('abc12345');
    expect(r.message).toMatch(/in_progress/);
  });

  it('completion + killed status → aligned-terminal, not diverged', () => {
    const r = computeDivergence('killed', completion);
    expect(r).toEqual({ kind: 'aligned-terminal', diverged: false, message: null });
  });

  it('falls back to commit_sha slice when commit_sha_short is absent', () => {
    const r = computeDivergence('review', { commit_sha: 'deadbeefcafef00d' });
    expect(r.diverged).toBe(true);
    expect(r.message).toContain('deadbeef'); // first 8 chars
  });

  it('handles null/undefined status with a completion present → diverged', () => {
    const r = computeDivergence(null, completion);
    expect(r.diverged).toBe(true);
    expect(r.message).toMatch(/unknown/);
  });
});

/**
 * COMP-PARITY-6: ValidateView — fetches GET /api/validate on mount (project
 * scope by default), groups findings by severity, supports a Project↔Feature
 * scope toggle, a ↻ refresh, an empty state, and degrades on an
 * { unavailable } body — never throws.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', () => ({ wsFetch: vi.fn() }));

import { wsFetch } from '../../src/lib/wsFetch.js';
import ValidateView from '../../src/components/vision/ValidateView.jsx';

function validateResponse(overrides = {}) {
  const findings = overrides.findings ?? [
    { severity: 'error', kind: 'ROUNDTRIP_NOT_FIXED_POINT', detail: 'roadmap diverges on regen' },
    { severity: 'warning', kind: 'ROADMAP_LOSSY', detail: 'lossy phase order', feature_code: 'FOO-1' },
    { severity: 'info', kind: 'ROADMAP_NARRATIVE_OWNED', detail: 'narrative-owned' },
  ];
  const bySeverity = overrides.bySeverity ?? { error: 1, warning: 1, info: 1 };
  return { scope: 'project', validated_at: 'X', findings, bySeverity, ...overrides };
}

function mockValidate(body) {
  wsFetch.mockResolvedValue({ ok: true, json: async () => body });
}

describe('ValidateView', () => {
  beforeEach(() => {
    wsFetch.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('fetches on mount with project scope and renders grouped findings', async () => {
    mockValidate(validateResponse());
    render(<ValidateView />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalledWith('/api/validate?scope=project'));

    // Each severity group renders with its row(s).
    expect(screen.getByTestId('validate-group-error')).toBeTruthy();
    expect(screen.getByTestId('validate-group-warning')).toBeTruthy();
    expect(screen.getByTestId('validate-group-info')).toBeTruthy();
    expect(screen.getByTestId('validate-finding-error').textContent).toMatch(/ROUNDTRIP_NOT_FIXED_POINT/);
    expect(screen.getByTestId('validate-finding-error').textContent).toMatch(/roadmap diverges on regen/);
    expect(screen.getByTestId('validate-finding-warning').textContent).toMatch(/FOO-1/);
  });

  it('renders the bySeverity counts in the toolbar', async () => {
    mockValidate(validateResponse({ bySeverity: { error: 2, warning: 3, info: 4 } }));
    render(<ValidateView />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalled());
    const toolbar = screen.getByTestId('validate-view').firstChild;
    expect(toolbar.textContent).toMatch(/2 error/);
    expect(toolbar.textContent).toMatch(/3 warning/);
    expect(toolbar.textContent).toMatch(/4 info/);
  });

  it('renders the empty state when there are no findings (no error)', async () => {
    mockValidate(validateResponse({ findings: [], bySeverity: { error: 0, warning: 0, info: 0 } }));
    render(<ValidateView />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('No findings')).toBeTruthy());
    expect(screen.queryByTestId('validate-group-error')).toBeNull();
  });

  it('scope toggle to feature refetches with ?scope=feature&featureCode=…', async () => {
    mockValidate(validateResponse());
    render(<ValidateView featureCode="FOO-1" />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalledWith('/api/validate?scope=project'));

    fireEvent.change(screen.getByTestId('validate-scope'), { target: { value: 'feature' } });
    await waitFor(() =>
      expect(wsFetch).toHaveBeenCalledWith('/api/validate?scope=feature&featureCode=FOO-1'),
    );
  });

  it('refresh button re-invokes wsFetch', async () => {
    mockValidate(validateResponse());
    render(<ValidateView />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('validate-refresh'));
    await waitFor(() => expect(wsFetch).toHaveBeenCalledTimes(2));
  });

  it('degrades on an { unavailable } body — shows the unavailable message, no throw', async () => {
    mockValidate({ scope: 'project', findings: [], bySeverity: { error: 0, warning: 0, info: 0 }, unavailable: true, error: 'validate failed' });
    render(<ValidateView />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/Validation unavailable/)).toBeTruthy());
    expect(screen.getByText(/validate failed/)).toBeTruthy();
  });

  it('renders an error state when the fetch rejects, without throwing', async () => {
    wsFetch.mockRejectedValue(new Error('boom'));
    render(<ValidateView />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/Unavailable: boom/)).toBeTruthy());
  });
});

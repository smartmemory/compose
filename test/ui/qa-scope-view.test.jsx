/**
 * COMP-PARITY-10: QaScopeView — reads the active featureCode, fetches
 * /api/qa-scope?featureCode=…, renders affected/adjacent/unmapped lists, shows a
 * not-found / empty-diff guidance for those response shapes, refetches on ↻, and
 * degrades to an error state when wsFetch rejects (never throws).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', () => ({ wsFetch: vi.fn() }));

import { wsFetch } from '../../src/lib/wsFetch.js';
import QaScopeView from '../../src/components/vision/QaScopeView.jsx';

function scopeResponse(overrides = {}) {
  return {
    found: true,
    featureCode: 'COMP-X',
    filesChanged: ['pages/users/[id].tsx', 'lib/util.ts'],
    framework: 'nextjs',
    docsOnly: false,
    affected: ['/users/:id'],
    adjacent: ['/users'],
    unmappedFiles: ['lib/util.ts'],
    emptyDiff: false,
    ...overrides,
  };
}

function mockScope(body) {
  wsFetch.mockResolvedValue({ ok: true, json: async () => body });
}

describe('QaScopeView', () => {
  beforeEach(() => {
    wsFetch.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the empty placeholder and does NOT fetch when no featureCode', async () => {
    render(<QaScopeView featureCode={null} />);
    expect(screen.getByTestId('qa-scope-empty')).toBeTruthy();
    expect(wsFetch).not.toHaveBeenCalled();
  });

  it('fetches /api/qa-scope?featureCode=… and renders affected/adjacent/unmapped lists', async () => {
    mockScope(scopeResponse());
    render(<QaScopeView featureCode="COMP-X" />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalledWith('/api/qa-scope?featureCode=COMP-X'));

    expect(screen.getByTestId('qa-scope-view')).toBeTruthy();
    expect(screen.getByTestId('qa-scope-affected').textContent).toMatch(/\/users\/:id/);
    expect(screen.getByTestId('qa-scope-adjacent').textContent).toMatch(/\/users/);
    expect(screen.getByTestId('qa-scope-unmapped').textContent).toMatch(/lib\/util\.ts/);
  });

  it('url-encodes the featureCode in the fetch', async () => {
    mockScope(scopeResponse({ featureCode: 'COMP X/1' }));
    render(<QaScopeView featureCode="COMP X/1" />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalledWith('/api/qa-scope?featureCode=COMP%20X%2F1'));
  });

  it('renders the not-found message for a found:false response', async () => {
    mockScope({ found: false, featureCode: 'NOPE' });
    render(<QaScopeView featureCode="NOPE" />);
    await waitFor(() => expect(screen.getByTestId('qa-scope-not-found')).toBeTruthy());
  });

  it('renders the empty-diff guidance for an emptyDiff:true response', async () => {
    mockScope(scopeResponse({ emptyDiff: true, affected: [], adjacent: [], unmappedFiles: [], filesChanged: [] }));
    render(<QaScopeView featureCode="COMP-X" />);
    await waitFor(() => expect(screen.getByTestId('qa-scope-empty-diff')).toBeTruthy());
    expect(screen.queryByTestId('qa-scope-affected')).toBeNull();
  });

  it('surfaces a degraded {found:true,error} response instead of a blank success block', async () => {
    // The route returns this when the route-mapper/classifier throws
    // (qa-scope-routes.js:81). Without handling, the success block would render
    // "Framework: undefined" with empty lists; we must show the error instead.
    mockScope({ found: true, featureCode: 'COMP-X', error: 'qa-scope failed' });
    render(<QaScopeView featureCode="COMP-X" />);
    await waitFor(() => expect(screen.getByTestId('qa-scope-degraded')).toBeTruthy());
    expect(screen.getByTestId('qa-scope-degraded').textContent).toMatch(/qa-scope failed/);
    // Must NOT fall through to the success UI.
    expect(screen.queryByTestId('qa-scope-affected')).toBeNull();
  });

  it('↻ refresh re-issues the fetch', async () => {
    mockScope(scopeResponse());
    render(<QaScopeView featureCode="COMP-X" />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('qa-scope-refresh'));
    await waitFor(() => expect(wsFetch).toHaveBeenCalledTimes(2));
  });

  it('clears stale scope when the active feature changes (no stale render under new header)', async () => {
    mockScope(scopeResponse({ featureCode: 'COMP-A', affected: ['/a-route'] }));
    const { rerender } = render(<QaScopeView featureCode="COMP-A" />);
    await waitFor(() => expect(screen.getByTestId('qa-scope-affected').textContent).toMatch(/\/a-route/));

    // Switch feature: a slow/never-resolving fetch should NOT keep showing COMP-A data.
    let resolveNext;
    wsFetch.mockReturnValue(new Promise(res => { resolveNext = res; }));
    rerender(<QaScopeView featureCode="COMP-B" />);
    await waitFor(() => expect(screen.queryByTestId('qa-scope-affected')).toBeNull());
    expect(screen.getByText(/COMP-B/)).toBeTruthy();
    // Clean up the dangling promise.
    resolveNext?.({ ok: true, json: async () => scopeResponse({ featureCode: 'COMP-B' }) });
  });

  it('renders an error state when the fetch rejects, without throwing', async () => {
    wsFetch.mockRejectedValue(new Error('boom'));
    render(<QaScopeView featureCode="COMP-X" />);
    await waitFor(() => expect(screen.getByTestId('qa-scope-error')).toBeTruthy());
    expect(screen.getByTestId('qa-scope-error').textContent).toMatch(/boom/);
  });
});

/**
 * COMP-PARITY-3-2: MobileEnvHealth — read-only environment-health indicator for
 * the mobile PWA. Header dot reflects `summary` color; tapping reveals a compact
 * detail (missing-dep count, version-behind, per-hook state). Fetches once on
 * mount via wsFetch('/api/environment-health'); degrades gracefully on error.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', () => ({ wsFetch: vi.fn() }));

import { wsFetch } from '../../src/lib/wsFetch.js';
import MobileEnvHealth from '../../src/mobile/components/MobileEnvHealth.jsx';

function healthResponse(overrides = {}) {
  return {
    summary: 'warn',
    dependencies: { present: [{ id: 'superpowers:tdd' }], missing: [{ id: 'refactor', optional: false }] },
    binaries: { present: [{ id: 'rtk' }], missing: [{ id: 'ffmpeg', optional: true }] },
    version: { current: '0.2.0', latest: '0.3.0', behind: true, source: 'cache' },
    hooks: {
      'post-commit': { state: 'absent' },
      'pre-push': { state: 'installed-stale', reason: 'STALE_WORKSPACE_ID' },
    },
    ...overrides,
  };
}

function mockHealth(body) {
  wsFetch.mockResolvedValue({ ok: true, json: async () => body });
}

describe('MobileEnvHealth', () => {
  beforeEach(() => {
    wsFetch.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('fetches on mount from the environment-health endpoint', async () => {
    mockHealth(healthResponse());
    render(<MobileEnvHealth />);
    await waitFor(() =>
      expect(wsFetch).toHaveBeenCalledWith('/api/environment-health')
    );
  });

  it('renders the dot with the summary color (warn → amber) and title', async () => {
    mockHealth(healthResponse({ summary: 'warn' }));
    render(<MobileEnvHealth />);
    await waitFor(() =>
      expect(screen.getByTestId('mobile-env-health-dot').getAttribute('title')).toMatch(/warn/)
    );
    const dot = screen.getByTestId('mobile-env-health-dot').querySelector('.m-env-dot');
    expect(dot).toBeTruthy();
    // warn maps to the mobile amber token
    expect(dot.style.background).toBe('var(--m-warn)');
  });

  it('maps ok → green', async () => {
    mockHealth(healthResponse({ summary: 'ok' }));
    render(<MobileEnvHealth />);
    await waitFor(() =>
      expect(screen.getByTestId('mobile-env-health-dot').querySelector('.m-env-dot').style.background).toBe('var(--m-ok)')
    );
  });

  it('maps error → red', async () => {
    mockHealth(healthResponse({ summary: 'error' }));
    render(<MobileEnvHealth />);
    await waitFor(() =>
      expect(screen.getByTestId('mobile-env-health-dot').querySelector('.m-env-dot').style.background).toBe('var(--m-danger)')
    );
  });

  it('reveals the detail on tap with missing-dep count, version-behind, and per-hook state', async () => {
    mockHealth(healthResponse());
    render(<MobileEnvHealth />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalled());

    // detail hidden until tapped
    expect(screen.queryByTestId('mobile-env-health-detail')).toBeNull();

    fireEvent.click(screen.getByTestId('mobile-env-health-dot'));

    const detail = screen.getByTestId('mobile-env-health-detail');
    expect(detail).toBeTruthy();

    // 1 missing skill (refactor) + 1 missing binary (ffmpeg) = 2
    expect(screen.getByTestId('mobile-env-health-deps').textContent).toMatch(/2 dependencies missing/);
    // version drift
    expect(screen.getByTestId('mobile-env-health-version').textContent).toMatch(/0\.2\.0 → 0\.3\.0/);
    expect(screen.getByTestId('mobile-env-health-version').textContent).toMatch(/behind/);
    // per-hook rows
    expect(screen.getByTestId('mobile-env-health-hook-post-commit').textContent).toMatch(/absent/);
    expect(screen.getByTestId('mobile-env-health-hook-pre-push').textContent).toMatch(/installed-stale/);
  });

  it('shows "All dependencies present" and version up-to-date when nothing is missing', async () => {
    mockHealth(healthResponse({
      summary: 'ok',
      dependencies: { present: [{ id: 'a' }], missing: [] },
      binaries: { present: [{ id: 'b' }], missing: [] },
      version: { current: '0.3.0', latest: '0.3.0', behind: false, source: 'cache' },
      hooks: { 'post-commit': { state: 'installed-current' }, 'pre-push': { state: 'installed-current' } },
    }));
    render(<MobileEnvHealth />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('mobile-env-health-dot'));
    expect(screen.getByTestId('mobile-env-health-deps').textContent).toMatch(/All dependencies present/);
    expect(screen.getByTestId('mobile-env-health-version').textContent).toMatch(/up to date/);
  });

  it('renders a neutral dot and an Unavailable detail when the fetch rejects, without throwing', async () => {
    wsFetch.mockRejectedValue(new Error('boom'));
    render(<MobileEnvHealth />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalled());

    // neutral (dim) dot, title falls back to unknown
    const dot = screen.getByTestId('mobile-env-health-dot');
    expect(dot.getAttribute('title')).toMatch(/unknown/);
    expect(dot.querySelector('.m-env-dot').style.background).toBe('var(--m-text-dim)');

    fireEvent.click(dot);
    expect(screen.getByTestId('mobile-env-health-detail').textContent).toMatch(/Unavailable/);
  });

  it('reports unavailable doctor sections as unavailable, NOT a false "all present"', async () => {
    mockHealth(healthResponse({
      summary: 'warn',
      dependencies: { unavailable: true },
      binaries: { unavailable: true },
      version: null,
      hooks: { unavailable: true },
    }));
    render(<MobileEnvHealth />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('mobile-env-health-dot'));
    // Must NOT claim health when the section couldn't be read.
    expect(screen.getByTestId('mobile-env-health-deps').textContent).toMatch(/dependencies unavailable/);
    expect(screen.getByTestId('mobile-env-health-deps').textContent).not.toMatch(/All dependencies present/);
    expect(screen.getByTestId('mobile-env-health-version').textContent).toMatch(/version check unavailable/);
    expect(screen.getByTestId('mobile-env-health-detail').textContent).toMatch(/hook status unavailable/);
    // The dot still reflects the server's warn summary.
    expect(screen.getByTestId('mobile-env-health-dot').getAttribute('title')).toMatch(/warn/);
  });

  it('toggles the detail closed on a second tap', async () => {
    mockHealth(healthResponse());
    render(<MobileEnvHealth />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalled());

    const dot = screen.getByTestId('mobile-env-health-dot');
    fireEvent.click(dot);
    expect(screen.getByTestId('mobile-env-health-detail')).toBeTruthy();
    fireEvent.click(dot);
    expect(screen.queryByTestId('mobile-env-health-detail')).toBeNull();
  });
});

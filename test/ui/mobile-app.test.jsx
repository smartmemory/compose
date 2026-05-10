import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import MobileApp from '../../src/mobile/MobileApp.jsx';
import { getSensitiveToken, setSensitiveToken } from '../../src/lib/compose-api.js';

const TOKEN_KEY = 'compose:mobile:sensitiveToken';

function setLocation(path) {
  // jsdom supports replaceState
  window.history.replaceState({}, '', path);
}

describe('<MobileApp> shell', () => {
  beforeEach(() => {
    localStorage.clear();
    setSensitiveToken(null);
    setLocation('/m');
  });

  it('renders the mobile shell with all 4 nav buttons', () => {
    render(<MobileApp />);
    expect(screen.getByTestId('mobile-root')).toBeTruthy();
    expect(screen.getByTestId('mobile-nav-agents')).toBeTruthy();
    expect(screen.getByTestId('mobile-nav-roadmap')).toBeTruthy();
    expect(screen.getByTestId('mobile-nav-builds')).toBeTruthy();
    expect(screen.getByTestId('mobile-nav-ideas')).toBeTruthy();
  });

  it('defaults to the agents tab', () => {
    render(<MobileApp />);
    expect(screen.getByTestId('mobile-tab-agents')).toBeTruthy();
    expect(screen.getByTestId('mobile-nav-agents').getAttribute('aria-pressed')).toBe('true');
  });

  it('switches to roadmap tab on nav click and updates URL', () => {
    render(<MobileApp />);
    act(() => {
      fireEvent.click(screen.getByTestId('mobile-nav-roadmap'));
    });
    expect(screen.getByTestId('mobile-tab-roadmap')).toBeTruthy();
    expect(window.location.pathname).toBe('/m/roadmap');
  });

  it('switches to ideas, builds tabs and updates URL', () => {
    render(<MobileApp />);
    act(() => { fireEvent.click(screen.getByTestId('mobile-nav-ideas')); });
    expect(screen.getByTestId('mobile-tab-ideas')).toBeTruthy();
    expect(window.location.pathname).toBe('/m/ideas');

    act(() => { fireEvent.click(screen.getByTestId('mobile-nav-builds')); });
    expect(screen.getByTestId('mobile-tab-builds')).toBeTruthy();
    expect(window.location.pathname).toBe('/m/builds');
  });

  it('reads tab from initial pathname', () => {
    setLocation('/m/builds');
    render(<MobileApp />);
    expect(screen.getByTestId('mobile-tab-builds')).toBeTruthy();
  });

  it('persists ?token=... to localStorage, applies to compose-api, and strips from URL', () => {
    setLocation('/m/agents?token=abc123');
    render(<MobileApp />);
    expect(localStorage.getItem(TOKEN_KEY)).toBe('abc123');
    expect(getSensitiveToken()).toBe('abc123');
    // URL stripped of ?token=
    expect(window.location.search).toBe('');
    expect(window.location.pathname).toBe('/m/agents');
  });

  it('restores token from localStorage on mount when no ?token= present', () => {
    localStorage.setItem(TOKEN_KEY, 'persisted-token');
    setLocation('/m');
    render(<MobileApp />);
    expect(getSensitiveToken()).toBe('persisted-token');
  });
});

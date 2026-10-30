/** COMPOSE-OPS-TAB-1: Ops view renders from a mocked index and remembers the last page. */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import OpsView from '../../src/components/cockpit/OpsView.jsx';
import { locateView } from '../../lib/view-keys.js';

const mockIndex = (pages) => vi.fn(async () => ({ ok: true, json: async () => ({ pages }) }));

describe('OpsView', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('is a sub-tab of the Fleet room', () => expect(locateView('ops')).toEqual({ top: 'fleet', sub: 'ops' }));

  it('picker + iframe from the index, remembers last page', async () => {
    const f = mockIndex(['forge', 'wiki']);
    vi.stubGlobal('fetch', f);
    const { container } = render(<OpsView />);
    await waitFor(() => screen.getByText('wiki'));
    expect(container.querySelector('iframe').getAttribute('src')).toBe('/ops-status/forge/status.html');
    fireEvent.click(screen.getByText('wiki'));
    expect(container.querySelector('iframe').getAttribute('src')).toBe('/ops-status/wiki/status.html');
    expect(localStorage.getItem('compose:opsPage')).toBe('wiki');
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe('/api/ops-status/index');
  });

  it('empty index shows a notice and no iframe', async () => {
    vi.stubGlobal('fetch', mockIndex([]));
    const { container } = render(<OpsView />);
    await waitFor(() => screen.getByText(/No Ops status pages/));
    expect(container.querySelector('iframe')).toBeNull();
  });
});

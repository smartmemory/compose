/**
 * COMP-COCKPIT-2: ChallengeModal no longer hardcodes localhost:4001/4002.
 * - agent spawn/status → relative wsFetch (same-origin orchestrator API, 4001).
 * - failures surface a toast instead of failing to console only.
 * (The 4002 terminal-inject portability is covered by agentServerUrl's own unit test.)
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', () => ({ wsFetch: vi.fn() }));
import { wsFetch } from '../../src/lib/wsFetch.js';
import ChallengeModal from '../../src/components/vision/ChallengeModal.jsx';

const item = { id: 'i1', title: 'Some decision', type: 'decision', status: 'vision', phase: 'vision' };
const renderModal = () =>
  render(
    <ChallengeModal item={item} items={[item]} connections={[]} onUpdate={vi.fn()} onClose={vi.fn()} />,
  );

describe('ChallengeModal hostname portability (COCKPIT-2)', () => {
  beforeEach(() => wsFetch.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('spawns via a relative URL, never hardcoded localhost:4001', async () => {
    wsFetch.mockResolvedValue({ ok: true, json: async () => ({ agentId: 'a1' }) });
    renderModal();
    fireEvent.click(screen.getByText(/Run Pressure Test/i));
    await waitFor(() => expect(wsFetch).toHaveBeenCalled());
    const url = wsFetch.mock.calls[0][0];
    expect(url).toBe('/api/agent/spawn');
    expect(url).not.toMatch(/localhost|127\.0\.0\.1|:4001/);
  });

  it('fires an error toast when spawn returns a non-ok response', async () => {
    wsFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: 'down' }) });
    const events = [];
    const handler = (e) => events.push(e.detail);
    window.addEventListener('compose:notify', handler);
    try {
      renderModal();
      fireEvent.click(screen.getByText(/Run Pressure Test/i));
      await waitFor(() => expect(events.some((d) => d.level === 'error')).toBe(true));
    } finally {
      window.removeEventListener('compose:notify', handler);
    }
  });
});

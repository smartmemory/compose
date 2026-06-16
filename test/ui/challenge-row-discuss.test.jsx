/**
 * COMP-COCKPIT-11: the ChallengeRow "Discuss" button must POST to the live
 * agent-server route /api/agent/message (body { prompt }), not the dead
 * /api/terminal/inject (a leftover from the retired terminal-server.js).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', () => ({ wsFetch: vi.fn() }));
import { wsFetch } from '../../src/lib/wsFetch.js';
import { ChallengeRow } from '../../src/components/vision/ChallengeModal.jsx';

const item = { id: 'q1', title: 'Should we cache tokens?', type: 'question', status: 'vision', description: 'caching decision' };

describe('ChallengeRow Discuss (COCKPIT-11)', () => {
  beforeEach(() => wsFetch.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('posts to /api/agent/message with a { prompt } body, not the dead /api/terminal/inject', async () => {
    wsFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    render(<ChallengeRow item={item} onUpdate={vi.fn()} />);
    fireEvent.click(screen.getByText(/Discuss/i));
    await waitFor(() => expect(wsFetch).toHaveBeenCalled());
    const [url, opts] = wsFetch.mock.calls[0];
    expect(url).toMatch(/\/api\/agent\/message$/);
    expect(url).not.toMatch(/terminal\/inject/);
    const body = JSON.parse(opts.body);
    expect(body).toHaveProperty('prompt');
    expect(body.prompt).toMatch(/caching decision/);
  });

  it('surfaces an error toast when the route returns non-ok', async () => {
    wsFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: 'down' }) });
    const events = [];
    const handler = (e) => events.push(e.detail);
    window.addEventListener('compose:notify', handler);
    try {
      render(<ChallengeRow item={item} onUpdate={vi.fn()} />);
      fireEvent.click(screen.getByText(/Discuss/i));
      await waitFor(() => expect(events.some((d) => d.level === 'error')).toBe(true));
    } finally {
      window.removeEventListener('compose:notify', handler);
    }
  });
});

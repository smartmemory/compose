/**
 * COMP-COCKPIT-1: silent action failures now surface a toast.
 * Representative coverage of the F1 fix — feedback fires on BOTH a rejected
 * fetch (transport) AND a non-ok response (server), not just catch.
 * Uses PipelineView (approve/reject) as the exemplar; the same notify-on-both
 * pattern is applied at every silent site.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', () => ({ wsFetch: vi.fn() }));
import { wsFetch } from '../../src/lib/wsFetch.js';
import PipelineView from '../../src/components/vision/PipelineView.jsx';

const draft = { draftId: 'd1', templateId: 't1', steps: [] };

function captureNotifications(run) {
  const events = [];
  const handler = (e) => events.push(e.detail);
  window.addEventListener('compose:notify', handler);
  return run(events).finally(() => window.removeEventListener('compose:notify', handler));
}

describe('Cockpit action feedback (COCKPIT-1)', () => {
  beforeEach(() => wsFetch.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('approve: a non-ok response fires an error toast (F1 server path)', async () => {
    wsFetch.mockResolvedValue({ ok: false, status: 500 });
    await captureNotifications(async (events) => {
      render(<PipelineView pipelineDraft={draft} onSelectStep={vi.fn()} onRefresh={vi.fn()} />);
      fireEvent.click(screen.getByText('Approve'));
      await waitFor(() => expect(events.some((d) => d.level === 'error')).toBe(true));
    });
  });

  it('reject: a rejected fetch fires an error toast (F1 transport path)', async () => {
    // PipelineView also fires a mount-time wsFetch (undefined url); resolve that,
    // reject only the user-initiated /reject call.
    wsFetch.mockImplementation((url) =>
      String(url).includes('/reject')
        ? Promise.reject(new Error('network down'))
        : Promise.resolve({ ok: true }));
    await captureNotifications(async (events) => {
      render(<PipelineView pipelineDraft={draft} onSelectStep={vi.fn()} onRefresh={vi.fn()} />);
      fireEvent.click(screen.getByText('Reject'));
      await waitFor(() => expect(events.some((d) => d.level === 'error')).toBe(true));
    });
  });

  it('approve: a successful response fires a success toast', async () => {
    wsFetch.mockResolvedValue({ ok: true });
    await captureNotifications(async (events) => {
      render(<PipelineView pipelineDraft={draft} onSelectStep={vi.fn()} onRefresh={vi.fn()} />);
      fireEvent.click(screen.getByText('Approve'));
      await waitFor(() => expect(events.some((d) => d.level === 'info')).toBe(true));
    });
  });
});

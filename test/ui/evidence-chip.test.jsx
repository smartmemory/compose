/**
 * evidence-chip.test.jsx — EvidenceChip (COMP-DOGFOOD-EVIDENCE-GATE-1).
 *
 * A feature's shown state carries `ev` (kind + id on hover) when the evidence
 * store holds a receipt claiming that state, `no receipt` in the needs-you hue
 * when it does not, and muted "receipts unreadable" when the store read fails
 * (unknown is not none). fetch mocked; the receipt matching is pure.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', () => ({ wsFetch: vi.fn() }));

import { wsFetch } from '../../src/lib/wsFetch.js';
import EvidenceChip, { receiptFor } from '../../src/components/vision/shared/EvidenceChip.jsx';

const rec = (id, claim, kind = 'sha') => ({ id, kind, checked_at: '2026-11-03T14:00:00.000Z', subject: { tool: 'set_feature_status', feature: 'F-1', claim } });

function mockRecords(records) {
  wsFetch.mockResolvedValue({ ok: true, json: async () => ({ records }) });
}

beforeEach(() => { wsFetch.mockReset(); });
afterEach(() => { cleanup(); });

describe('receiptFor', () => {
  it('matches the claimed state case-insensitively and takes the newest', () => {
    const rs = [rec('ev:aaaaaaaaaaaaaaaa', 'COMPLETE'), rec('ev:bbbbbbbbbbbbbbbb', 'IN_PROGRESS'), rec('ev:cccccccccccccccc', 'COMPLETE')];
    expect(receiptFor(rs, 'complete').id).toBe('ev:cccccccccccccccc');
    expect(receiptFor(rs, 'in_progress').id).toBe('ev:bbbbbbbbbbbbbbbb');
    expect(receiptFor(rs, 'parked')).toBeNull();
    expect(receiptFor(null, 'complete')).toBeNull();
  });
});

describe('EvidenceChip', () => {
  it('shows ev with the kind and id on hover when a receipt backs the current state', async () => {
    mockRecords([rec('ev:0123456789abcdef', 'COMPLETE', 'process')]);
    render(<EvidenceChip featureCode="F-1" status="complete" />);
    const chip = await screen.findByTestId('evidence-chip');
    expect(chip.textContent).toBe('ev');
    expect(chip.getAttribute('title')).toMatch(/^process · ev:0123456789abcdef/);
    expect(wsFetch.mock.calls[0][0]).toBe('/api/evidence?feature=F-1');
  });

  it('shows "no receipt" in the needs-you hue when no receipt claims the current state', async () => {
    mockRecords([rec('ev:0123456789abcdef', 'IN_PROGRESS')]);
    render(<EvidenceChip featureCode="F-1" status="complete" />);
    const none = await screen.findByTestId('evidence-none');
    expect(none.textContent).toBe('no receipt');
    expect(none.className).toMatch(/--needs-you/);
  });

  it('says the store is unreadable rather than claiming none', async () => {
    wsFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    render(<EvidenceChip featureCode="F-1" status="complete" />);
    await screen.findByTestId('evidence-unknown');
    expect(screen.queryByTestId('evidence-none')).toBeNull();
  });

  it('renders nothing for an item with no feature code', async () => {
    const { container } = render(<EvidenceChip featureCode={null} status="planned" />);
    await waitFor(() => expect(container.innerHTML).toBe(''));
    expect(wsFetch).not.toHaveBeenCalled();
  });
});

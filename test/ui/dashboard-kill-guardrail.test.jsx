/**
 * COMP-COCKPIT-6: killing a gate from the Dashboard now requires a reason,
 * matching GateView / ItemDetailPanel. No more instant no-undo kills.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DialogProvider } from '../../src/components/ui/DialogProvider.jsx';
import DashboardView from '../../src/components/vision/DashboardView.jsx';

const gates = [{ id: 'g1', status: 'pending', itemId: 'i1', fromPhase: 'design' }];
const items = [{ id: 'i1', title: 'My feature', type: 'feature', featureCode: 'FC-1' }];

function renderDashboard(onResolveGate) {
  // featureCode is required so DashboardView renders the full dashboard
  // (it short-circuits to an empty state when no feature is in progress).
  return render(
    <DialogProvider>
      <DashboardView items={items} gates={gates} featureCode="FC-1" onResolveGate={onResolveGate} />
    </DialogProvider>,
  );
}

describe('Dashboard gate-kill guardrail (COCKPIT-6)', () => {
  it('requires a reason before killing; empty reason is blocked', async () => {
    const onResolveGate = vi.fn();
    renderDashboard(onResolveGate);

    fireEvent.click(screen.getByText('Kill'));
    await screen.findByText('Kill this gate?');

    // Confirm disabled while reason empty
    expect(screen.getByTestId('dialog-confirm').disabled).toBe(true);
    expect(onResolveGate).not.toHaveBeenCalled();

    // Enter reason → resolves with killed + reason
    fireEvent.change(screen.getByTestId('dialog-input'), { target: { value: 'scope drift' } });
    fireEvent.click(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(onResolveGate).toHaveBeenCalledWith('g1', 'killed', 'scope drift'));
  });

  it('cancelling the kill does not resolve the gate', async () => {
    const onResolveGate = vi.fn();
    renderDashboard(onResolveGate);
    fireEvent.click(screen.getByText('Kill'));
    await screen.findByText('Kill this gate?');
    fireEvent.click(screen.getByTestId('dialog-cancel'));
    await waitFor(() => expect(screen.queryByText('Kill this gate?')).toBeNull());
    expect(onResolveGate).not.toHaveBeenCalled();
  });
});

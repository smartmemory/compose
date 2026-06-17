/**
 * COMP-PARITY-8: BuildAllGsdControl dispatches the two batch-grade build verbs
 * (`build --all`, `gsd <CODE>`) through the shared startBuild helper.
 *
 * startBuild is mocked here (not fetch): the integrator-owned startBuild.js
 * change that omits featureCode for mode:'all' has not landed yet, so this test
 * asserts the *payload the component hands to startBuild* — the contract this
 * component owns — independent of how startBuild later serializes it. Wrapped in
 * <DialogProvider> so the confirm-gated Build-all path resolves through the real
 * dialog (dashboard-kill-guardrail.test.jsx pattern).
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock the shared dispatch helper before importing the component under test.
vi.mock('../../src/lib/startBuild.js', () => ({
  startBuild: vi.fn(async () => new Response('{}', { status: 200 })),
}));

import { DialogProvider } from '../../src/components/ui/DialogProvider.jsx';
import BuildAllGsdControl from '../../src/components/cockpit/BuildAllGsdControl.jsx';
import { startBuild } from '../../src/lib/startBuild.js';

function renderControl() {
  return render(
    <DialogProvider>
      <BuildAllGsdControl />
    </DialogProvider>,
  );
}

describe('<BuildAllGsdControl>', () => {
  beforeEach(() => {
    startBuild.mockReset();
    startBuild.mockResolvedValue(new Response('{}', { status: 200 }));
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('opens the popover from the header trigger', () => {
    renderControl();
    expect(screen.queryByTestId('build-all-gsd-popover')).toBeNull();
    fireEvent.click(screen.getByTestId('build-all-gsd-trigger'));
    expect(screen.getByTestId('build-all-gsd-popover')).toBeTruthy();
  });

  it('Build all → confirms then dispatches { mode: "all" } (no featureCode)', async () => {
    renderControl();
    fireEvent.click(screen.getByTestId('build-all-gsd-trigger'));
    fireEvent.click(screen.getByTestId('build-all-submit'));

    // Confirm dialog appears; nothing dispatched until confirmed.
    await screen.findByText('Build all PLANNED features?');
    expect(startBuild).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('dialog-confirm'));

    await waitFor(() => expect(startBuild).toHaveBeenCalledTimes(1));
    expect(startBuild).toHaveBeenCalledWith({ mode: 'all' });
  });

  it('Build all cancel → nothing dispatched', async () => {
    renderControl();
    fireEvent.click(screen.getByTestId('build-all-gsd-trigger'));
    fireEvent.click(screen.getByTestId('build-all-submit'));

    await screen.findByText('Build all PLANNED features?');
    fireEvent.click(screen.getByTestId('dialog-cancel'));

    await waitFor(() => expect(screen.queryByText('Build all PLANNED features?')).toBeNull());
    expect(startBuild).not.toHaveBeenCalled();
  });

  it('GSD with a code → dispatches { featureCode, mode: "gsd" } (trimmed)', async () => {
    renderControl();
    fireEvent.click(screen.getByTestId('build-all-gsd-trigger'));
    fireEvent.change(screen.getByTestId('build-gsd-feature-input'), { target: { value: '  FOO-1  ' } });
    fireEvent.click(screen.getByTestId('build-gsd-submit'));

    await waitFor(() => expect(startBuild).toHaveBeenCalledTimes(1));
    expect(startBuild).toHaveBeenCalledWith({ featureCode: 'FOO-1', mode: 'gsd' });
  });

  it('GSD submit is disabled (and dispatches nothing) while the code is empty', () => {
    renderControl();
    fireEvent.click(screen.getByTestId('build-all-gsd-trigger'));
    expect(screen.getByTestId('build-gsd-submit').disabled).toBe(true);

    fireEvent.change(screen.getByTestId('build-gsd-feature-input'), { target: { value: 'X-1' } });
    expect(screen.getByTestId('build-gsd-submit').disabled).toBe(false);

    // Whitespace-only stays blocked.
    fireEvent.change(screen.getByTestId('build-gsd-feature-input'), { target: { value: '   ' } });
    expect(screen.getByTestId('build-gsd-submit').disabled).toBe(true);
    expect(startBuild).not.toHaveBeenCalled();
  });

  it('surfaces a server error (409) and keeps the popover open', async () => {
    const err = new Error('A build is already active');
    err.status = 409;
    startBuild.mockRejectedValueOnce(err);

    renderControl();
    fireEvent.click(screen.getByTestId('build-all-gsd-trigger'));
    fireEvent.change(screen.getByTestId('build-gsd-feature-input'), { target: { value: 'FOO-1' } });
    fireEvent.click(screen.getByTestId('build-gsd-submit'));

    await waitFor(() => expect(screen.getByTestId('build-all-gsd-error').textContent).toMatch(/already active/i));
    expect(screen.getByTestId('build-all-gsd-popover')).toBeTruthy();
  });
});

/**
 * COMP-STRAT-BUILDER-HANDLE-1: Save reads the builder's document at click time through FlowBuilder's ref handle, so an edit made an
 * instant before Save is in what is saved. Fake timers are never advanced: the old pane waited on a timer for the export, so under
 * these clocks its Save never reached the client. Needs the sibling stratum-ui build (the handle is not in the installed 0.1.0).
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import StratumBuilderPane from '../../src/components/cockpit/StratumBuilderPane.jsx';

const linked = typeof __STRATUM_UI__ !== 'undefined' && __STRATUM_UI__;
const clientWith = () => ({ saveSpec: vi.fn(async (name) => ({ ok: true, name, created: true })) });

describe.skipIf(!linked)('Save reads the builder document at click time', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('an added step and a typed, uncommitted step id are in the saved document, with no timer advanced', async () => {
    const client = clientWith();
    render(<StratumBuilderPane client={client} />);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    fireEvent.change(screen.getByTestId('builder-save-name'), { target: { value: 'quick' } });
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    fireEvent.click(screen.getByRole('button', { name: 'add set step' }));
    const field = screen.getByLabelText('field id');
    field.focus();
    fireEvent.change(field, { target: { value: 'typed_step' } }); // a draft: it commits on blur
    expect(document.activeElement).toBe(field);
    await act(async () => { screen.getByTestId('builder-save').click(); }); // a click that does not move focus, at once
    expect(client.saveSpec).toHaveBeenCalledTimes(1);
    expect(client.saveSpec.mock.calls[0][0]).toBe('quick');
    expect(client.saveSpec.mock.calls[0][1].flows.main.steps.map((step) => step.id)).toContain('typed_step');
  });

  it('a pane never edited saves what a fresh builder starts from', async () => {
    const client = clientWith();
    render(<StratumBuilderPane client={client} />);
    fireEvent.change(screen.getByTestId('builder-save-name'), { target: { value: 'fresh' } });
    await act(async () => { screen.getByTestId('builder-save').click(); });
    expect(client.saveSpec.mock.calls[0][1]).toMatchObject({ version: 1, flows: { entry: 'main' } });
  });
});

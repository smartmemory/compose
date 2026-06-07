/**
 * COMP-COCKPIT-1: DialogProvider — promise-based confirm/prompt/confirmWithReason.
 * Replaces synchronous window.confirm/prompt with in-app modals that return Promises,
 * so call sites stay ~1 line: `if (await confirm({...})) act()`.
 */
import React, { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  DialogProvider,
  useConfirm,
  usePrompt,
  useConfirmWithReason,
} from '../../src/components/ui/DialogProvider.jsx';

/** Harness: invokes a hook, stashes the resolved value into the DOM for assertion. */
function Harness({ hook, opts }) {
  const run = hook();
  const [result, setResult] = useState('<<pending>>');
  return (
    <div>
      <button onClick={async () => setResult(String(await run(opts)))}>go</button>
      <span data-testid="result">{result}</span>
    </div>
  );
}

const renderHook = (hook, opts) =>
  render(
    <DialogProvider>
      <Harness hook={hook} opts={opts} />
    </DialogProvider>,
  );

const result = () => screen.getByTestId('result').textContent;

describe('DialogProvider', () => {
  it('confirm resolves true on confirm, false on cancel', async () => {
    renderHook(useConfirm, { title: 'Proceed?' });
    fireEvent.click(screen.getByText('go'));
    await screen.findByText('Proceed?');
    fireEvent.click(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(result()).toBe('true'));

    fireEvent.click(screen.getByText('go'));
    await screen.findByText('Proceed?');
    fireEvent.click(screen.getByTestId('dialog-cancel'));
    await waitFor(() => expect(result()).toBe('false'));
  });

  it('prompt resolves the entered value, null on cancel', async () => {
    renderHook(usePrompt, { title: 'Feature code' });
    fireEvent.click(screen.getByText('go'));
    await screen.findByText('Feature code');
    fireEvent.change(screen.getByTestId('dialog-input'), { target: { value: 'COMP-X' } });
    fireEvent.click(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(result()).toBe('COMP-X'));

    fireEvent.click(screen.getByText('go'));
    await screen.findByText('Feature code');
    fireEvent.click(screen.getByTestId('dialog-cancel'));
    await waitFor(() => expect(result()).toBe('null'));
  });

  it('required prompt blocks confirm while empty', async () => {
    renderHook(usePrompt, { title: 'Required', required: true });
    fireEvent.click(screen.getByText('go'));
    await screen.findByText('Required');
    expect(screen.getByTestId('dialog-confirm').disabled).toBe(true);
    fireEvent.change(screen.getByTestId('dialog-input'), { target: { value: 'x' } });
    expect(screen.getByTestId('dialog-confirm').disabled).toBe(false);
  });

  it('opening a second dialog settles the first caller (no stranded promise)', async () => {
    function Twice() {
      const confirm = useConfirm();
      const [a, setA] = React.useState('<<pending>>');
      const [b, setB] = React.useState('<<pending>>');
      return (
        <div>
          <button onClick={async () => { setA(String(await confirm({ title: 'Q1' }))); }}>open-a</button>
          <button onClick={async () => { setB(String(await confirm({ title: 'Q2' }))); }}>open-b</button>
          <span data-testid="a">{a}</span>
          <span data-testid="b">{b}</span>
        </div>
      );
    }
    render(
      <DialogProvider>
        <Twice />
      </DialogProvider>,
    );
    fireEvent.click(screen.getByText('open-a'));
    await screen.findByText('Q1');
    fireEvent.click(screen.getByText('open-b')); // preempts the first
    // first caller is settled (cancelled → false), not stranded
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('false'));
    fireEvent.click(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('true'));
  });

  it('confirmWithReason blocks empty and returns the trimmed reason', async () => {
    renderHook(useConfirmWithReason, { title: 'Kill gate?', destructive: true });
    fireEvent.click(screen.getByText('go'));
    await screen.findByText('Kill gate?');
    expect(screen.getByTestId('dialog-confirm').disabled).toBe(true);
    fireEvent.change(screen.getByTestId('dialog-input'), { target: { value: '  bad design  ' } });
    fireEvent.click(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(result()).toBe('bad design'));
  });
});

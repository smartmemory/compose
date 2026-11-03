/** WIKI-PAGED-CURSOR-FU-1: usePagedCall + Pager through the real hook (fake `run`, no fetch). */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { usePagedCall, Pager } from '@wiki/components';

const linked = typeof __WIKI_COMPONENTS__ !== 'undefined' && __WIKI_COMPONENTS__;

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const page = (text, next_cursor, total = 100) => ({ items: [text], total, next_cursor });

function Probe({ ws, run }) {
  const p = usePagedCall(['t', ws], (pg) => run({ workspace: ws, ...pg }));
  return (
    <div>
      <ul>{p.items.map((t) => <li key={t}>{t}</li>)}</ul>
      <span data-testid="state">{`index=${p.index} loading=${p.isLoading}`}</span>
      <Pager p={p} />
    </div>
  );
}
const nextBtn = () => screen.getByRole('button', { name: 'Next page' });
const prevBtn = () => screen.getByRole('button', { name: 'Previous page' });

describe.skipIf(!linked)('usePagedCall', () => {
  it('M1: Next and Prev are disabled while the next page is pending, and a double click pushes one cursor', async () => {
    const d2 = deferred();
    const run = vi.fn(async (a) => (a.cursor === 'c2' ? d2.promise : page('A page 1', 'c2')));
    render(<Probe ws="A" run={run} />);
    await screen.findByText('A page 1');
    expect(nextBtn().disabled).toBe(false);
    fireEvent.click(nextBtn());
    fireEvent.click(nextBtn());
    expect(nextBtn().disabled).toBe(true);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await act(async () => {}); // a stray third call would land here
    expect(run).toHaveBeenCalledTimes(2);
    expect(prevBtn().disabled).toBe(true);
    expect(screen.getByText('A page 1')).toBeTruthy(); // the same key's previous page stays shown while pending
    await act(async () => { d2.resolve(page('A page 2', null)); });
    await screen.findByText('A page 2');
    expect(screen.getByTestId('state').textContent).toBe('index=1 loading=false');
    expect(prevBtn().disabled).toBe(false);
    fireEvent.click(prevBtn());
    await screen.findByText('A page 1');
    expect(screen.getByTestId('state').textContent).toBe('index=0 loading=false');
  });

  it('M2: a new key shows a loading state, not the old rows, and never sends the old cursor', async () => {
    const dB = deferred();
    const run = vi.fn(async (a) => (a.workspace === 'B' ? dB.promise : page('A private decision', 'A-c2')));
    const { rerender } = render(<Probe ws="A" run={run} />);
    await screen.findByText('A private decision');
    rerender(<Probe ws="B" run={run} />);
    expect(screen.queryByText('A private decision')).toBeNull();
    expect(screen.getByTestId('state').textContent).toBe('index=0 loading=true');
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull(); // no total yet: the Pager is hidden
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls.map((c) => c[0])).toEqual([{ workspace: 'A', size: 50 }, { workspace: 'B', size: 50 }]);
    await act(async () => { dB.resolve(page('B page 1', null, 1)); });
    await screen.findByText('B page 1');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('L1: going back to an earlier key starts at page 1', async () => {
    const run = vi.fn(async (a) => page(`${a.workspace} ${a.cursor ? 'page 2' : 'page 1'}`, a.cursor ? null : `${a.workspace}-c2`));
    const { rerender } = render(<Probe ws="A" run={run} />);
    await screen.findByText('A page 1');
    fireEvent.click(nextBtn());
    await screen.findByText('A page 2');
    rerender(<Probe ws="B" run={run} />);
    await screen.findByText('B page 1');
    rerender(<Probe ws="A" run={run} />);
    await screen.findByText('A page 1');
    expect(screen.getByTestId('state').textContent).toBe('index=0 loading=false');
    expect(run.mock.calls.at(-1)[0]).toEqual({ workspace: 'A', size: 50 });
    await waitFor(() => expect(nextBtn().disabled).toBe(false));
  });
});

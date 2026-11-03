/**
 * COMP-COCKPIT-12-FU-1 (folded FLEET-PROJECTS-1 M1/L1, FLEET-PROJECTS-2 M2): the saved-order override, the save error
 * line and the roots reload, on the real fleetProjects.js with only wsFetch stubbed.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', async (orig) => ({ ...(await orig()), wsFetch: vi.fn() }));
import { wsFetch } from '../../src/lib/wsFetch.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveOrder, resetFleetProjects, saveFleetProjects, selectProjectRow, useFleetProjects, useFleetRoots } from '../../src/lib/fleetProjects.js';
import { resetProcessPoller } from '../../src/lib/processPoller.js';
import FleetProjectsSection from '../../src/components/vision/FleetProjectsSection.jsx';

const reply = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });

function OrderProbe({ fleet }) {
  const lanes = useFleetProjects();
  return <div><span data-testid="order">{JSON.stringify(effectiveOrder(fleet, lanes))}</span><span data-testid="err">{lanes.saveError ?? ''}</span></div>;
}

describe('saved order override (FLEET-PROJECTS-1 M1, L1)', () => {
  beforeEach(() => { cleanup(); wsFetch.mockReset(); resetFleetProjects(); });

  it('M1: after a confirmed save, a later fetched envelope with a different order shows', async () => {
    wsFetch.mockResolvedValue(reply({ ok: true }));
    const before = { projects: ['a', 'b'] };
    const view = render(<OrderProbe fleet={before} />);
    await act(async () => { await saveFleetProjects(['b', 'a']); });
    expect(screen.getByTestId('order').textContent).toBe('["b","a"]'); // the envelope seen before the save does not undo it
    view.rerender(<OrderProbe fleet={{ projects: ['a', 'b'] }} />); // a poll after the save: another tab saved a different order
    await waitFor(() => expect(screen.getByTestId('order').textContent).toBe('["a","b"]'));
    view.rerender(<OrderProbe fleet={{ projects: ['b', 'a'] }} />);
    await waitFor(() => expect(screen.getByTestId('order').textContent).toBe('["b","a"]')); // and it keeps following the server
  });

  it('M1: an envelope that matches the saved order ends the override too', async () => {
    wsFetch.mockResolvedValue(reply({ ok: true }));
    const view = render(<OrderProbe fleet={{ projects: ['a', 'b'] }} />);
    await act(async () => { await saveFleetProjects(['b', 'a']); });
    view.rerender(<OrderProbe fleet={{ projects: ['b', 'a'] }} />);
    view.rerender(<OrderProbe fleet={{ projects: ['b', 'a', 'c'] }} />);
    await waitFor(() => expect(screen.getByTestId('order').textContent).toBe('["b","a","c"]'));
  });

  it('while a save is in flight the optimistic order holds against an old envelope', async () => {
    let release;
    wsFetch.mockImplementation(() => new Promise((r) => { release = () => r(reply({ ok: true })); }));
    const view = render(<OrderProbe fleet={{ projects: ['a', 'b'] }} />);
    await act(async () => { saveFleetProjects(['b', 'a']); await new Promise((r) => setTimeout(r, 0)); });
    view.rerender(<OrderProbe fleet={{ projects: ['a', 'b'] }} />);
    expect(screen.getByTestId('order').textContent).toBe('["b","a"]');
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
  });

  it('L1: a queued save that succeeds after an earlier one failed leaves no error', async () => {
    let n = 0;
    wsFetch.mockImplementation(async () => { n += 1; return n === 1 ? reply({ error: 'disk is read-only' }, 500) : reply({ ok: true }); });
    render(<OrderProbe fleet={{ projects: ['a', 'b'] }} />);
    await act(async () => { saveFleetProjects(['b', 'a']); await saveFleetProjects(['a']); });
    expect(wsFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('err').textContent).toBe('');
  });

  it('a save that fails alone still leaves its error line', async () => {
    wsFetch.mockResolvedValue(reply({ error: 'disk is read-only' }, 500));
    render(<OrderProbe fleet={{ projects: ['a', 'b'] }} />);
    await act(async () => { await saveFleetProjects(['b', 'a']); });
    expect(screen.getByTestId('err').textContent).toBe('Not saved: disk is read-only');
  });
});

describe('roots config error (FLEET-PROJECTS-2 M2)', () => {
  beforeEach(() => { cleanup(); wsFetch.mockReset(); resetFleetProjects(); });

  function RootsProbe() {
    const { roots, error } = useFleetRoots(true);
    return <span data-testid="roots">{error ?? JSON.stringify(roots)}</span>;
  }

  it('a 200 body carrying an error is read again on the next mount', async () => {
    let n = 0;
    wsFetch.mockImplementation(async () => { n += 1; return n === 1 ? reply({ roots: {}, error: 'fleet.roots must map lane names to a path or null' }) : reply({ roots: { forge: { root: '/p/forge', hasCompose: true } }, error: null }); });
    const first = render(<RootsProbe />);
    await waitFor(() => expect(screen.getByTestId('roots').textContent).toMatch(/^fleet\.roots must map/));
    first.unmount();
    render(<RootsProbe />);
    await waitFor(() => expect(screen.getByTestId('roots').textContent).toContain('/p/forge'));
    expect(wsFetch).toHaveBeenCalledTimes(2);
  });

  it('a clean answer is still read once per page', async () => {
    wsFetch.mockResolvedValue(reply({ roots: { forge: { root: '/p/forge', hasCompose: true } }, error: null }));
    const first = render(<RootsProbe />);
    await waitFor(() => expect(screen.getByTestId('roots').textContent).toContain('/p/forge'));
    first.unmount();
    render(<RootsProbe />);
    expect(wsFetch).toHaveBeenCalledTimes(1);
  });
});

describe('a refused project switch (FLEET-PROJECTS-2 M1), the switch helper injected, never the real route', () => {
  it('selectProjectRow: one decision per click', async () => {
    const ROWS = [
      ['no project for the lane', { lane: 'main', root: null }, null, { noProjectLane: 'main', refused: null }, 0],
      ['already the open project', { lane: 'hub', root: '/p/hub', projectRoot: '/p/hub' }, null, { noProjectLane: null, refused: null }, 0],
      ['the switch succeeds', { lane: 'hub', root: '/p/hub', projectRoot: '/p/boot' }, true, { noProjectLane: null, refused: null }, 1],
      ['the switch is refused: the room stays, the lane is named', { lane: 'hub', root: '/p/hub', projectRoot: '/p/boot' }, false, { noProjectLane: undefined, refused: 'hub' }, 1],
    ];
    for (const [name, input, answer, want, calls] of ROWS) {
      const switchProject = vi.fn(async () => answer);
      expect(await selectProjectRow({ ...input, switchProject }), name).toEqual(want);
      expect(switchProject, name).toHaveBeenCalledTimes(calls);
    }
  });

  it('the row list says so, keeps the old project selected, and a clean state shows no line', async () => {
    const envelope = JSON.parse(readFileSync(join(process.cwd(), 'test', 'fixtures', 'process', 'api-process.json'), 'utf8'));
    envelope.fleet = { known: ['hub', 'main'], projects: ['hub', 'main'], error: null };
    wsFetch.mockReset(); resetFleetProjects(); resetProcessPoller();
    wsFetch.mockImplementation(async (url) => reply(String(url).startsWith('/api/fleet/roots')
      ? { roots: { hub: { root: '/p/hub', hasCompose: true }, main: { root: '/p/boot', hasCompose: true } }, error: null } : envelope));
    const props = { mode: 'project', projectRoot: '/p/boot', onSelectProject: vi.fn() };
    const view = render(<FleetProjectsSection {...props} />);
    await screen.findByTestId('fleet-project-hub');
    expect(screen.queryByTestId('fleet-project-switch-refused')).toBeNull();
    view.rerender(<FleetProjectsSection {...props} switchRefused="hub" />);
    expect(screen.getByTestId('fleet-project-switch-refused').textContent).toBe('Could not open hub. The room still shows the project it had.');
    await waitFor(() => expect(screen.getByTestId('fleet-project-select-main').getAttribute('aria-pressed')).toBe('true'));
    expect(screen.getByTestId('fleet-project-select-hub').getAttribute('aria-pressed')).toBe('false');
    cleanup();
    resetProcessPoller();
  });
});

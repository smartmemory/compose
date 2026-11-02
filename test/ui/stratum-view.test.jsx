/** COMPOSE-STRAT-TAB-1: the Stratum tab renders @smartmemory/stratum-ui screens from a fake DataClient (no fetch). */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import StratumView from '../../src/components/cockpit/StratumView.jsx';
import { createStratumDataClient } from '../../src/lib/clients/stratum.js';
import { locateView } from '../../lib/view-keys.js';

const linked = typeof __STRATUM_UI__ !== 'undefined' && __STRATUM_UI__;
const run = (id) => ({
  id, flowName: `flow-${id}`, status: 'running', displayStatus: 'awaiting_gate', stepCount: 2, completedSteps: 1,
  currentStepId: 'g', round: 0, startedAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:01:00Z', spent: {}, waitingGates: 1,
});

afterEach(() => vi.unstubAllGlobals());

describe('Stratum tab', () => {
  it('is a sub-tab of the Fleet room', () => expect(locateView('stratum')).toEqual({ top: 'fleet', sub: 'stratum' }));

  it.skipIf(!linked)('renders runs and gates from the injected client without fetching', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('a component fetched'); });
    vi.stubGlobal('fetch', fetchSpy);
    const client = {
      listRuns: vi.fn(async () => [run('r1')]),
      getRun: vi.fn(async () => null),
      listGates: vi.fn(async () => []),
      resolveGate: vi.fn(),
    };
    render(<StratumView client={client} />);
    await waitFor(() => expect(client.listRuns).toHaveBeenCalled());
    expect(await screen.findByText(/flow-r1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Gates' }));
    await waitFor(() => expect(client.listGates).toHaveBeenCalled());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Compose stratum DataClient', () => {
  it('talks only to /api/stratum-ui and carries the gate token', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      calls.push([String(url), opts.method || 'GET', opts.body]);
      const ok = String(url).includes('/gates/') ? { ok: true, runId: 'r', stepId: 's', outcome: 'approve', result: 'done' } : [];
      return { ok: true, status: 200, json: async () => ok };
    }));
    const client = createStratumDataClient();
    await client.listRuns();
    await client.listGates();
    const out = await client.resolveGate({ runId: 'r 1', stepId: 's', action: 'approve', gateToken: 'tok' });
    expect(out.ok).toBe(true);
    expect(calls.every(([u]) => u.startsWith('/api/stratum-ui/'))).toBe(true);
    expect(calls[2][0]).toBe('/api/stratum-ui/gates/r%201/s/approve');
    expect(JSON.parse(calls[2][2]).gateToken).toBe('tok');
  });

  it('getRun returns null on 404 and refusals never throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    const client = createStratumDataClient();
    expect(await client.getRun('x')).toBeNull();
    const out = await client.resolveGate({ runId: 'x', stepId: 's', action: 'reject', gateToken: 't' });
    expect(out).toMatchObject({ ok: false, kind: 'error', code: 'HTTP_404' });
  });
});

describe('Stratum pane memory (review L2)', () => {
  it.skipIf(!linked)('leaving on Gates and coming back reopens Gates', async () => {
    const { resetPaneMemory } = await import('../../src/components/cockpit/PaneSwitcher.jsx');
    resetPaneMemory();
    const client = { listRuns: vi.fn(async () => []), getRun: vi.fn(async () => null), listGates: vi.fn(async () => []), resolveGate: vi.fn() };
    const first = render(<StratumView client={client} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Gates' }));
    await waitFor(() => expect(client.listGates).toHaveBeenCalled(), { timeout: 5000 });
    first.unmount();
    render(<StratumView client={client} />);
    expect(screen.getByRole('tab', { name: 'Gates' }).getAttribute('aria-selected')).toBe('true');
    resetPaneMemory();
  });
});

// COMP-SUBAPP-STRAT-AUTHOR-1: the "New pipeline" pane is FlowBuilder plus Save / Open over the client's optional methods.
describe('Stratum New pipeline pane', () => {
  const started = Date.now();
  const base = () => ({ listRuns: vi.fn(async () => []), getRun: vi.fn(async () => null), listGates: vi.fn(async () => []), resolveGate: vi.fn() });
  const openPane = async () => {
    const { resetPaneMemory } = await import('../../src/components/cockpit/PaneSwitcher.jsx');
    resetPaneMemory();
    fireEvent.click(screen.getByRole('tab', { name: 'New pipeline' }));
    return screen.findByTestId('stratum-builder-pane');
  };
  afterEach(() => console.log(`# stratum builder pane wall ${Date.now() - started} ms`));

  it.skipIf(!linked)('saves through the client, shows the refusal text, and opens a saved spec', async () => {
    const saved = { version: 1, flows: { entry: 'main', main: { input: {}, steps: [{ id: 'set_1', set: {}, out: '' }] } } };
    const client = {
      ...base(),
      validateSpec: vi.fn(async () => ({ status: 'valid' })),
      listSpecs: vi.fn(async () => [{ name: 'kept', updatedAt: '2026-11-02T00:00:00Z' }]),
      readSpec: vi.fn(async () => saved),
      saveSpec: vi.fn(async () => ({ ok: false, code: 'NOT_BUILDER_FILE', message: 'build.stratum.yaml exists and was not written by the pipeline builder; pick another name' })),
    };
    render(<StratumView client={client} />);
    await openPane();
    await waitFor(() => expect(client.listSpecs).toHaveBeenCalled());
    const save = screen.getByTestId('builder-save');
    expect(save.disabled).toBe(true); // no spec yet
    fireEvent.click(screen.getByRole('button', { name: 'New' })); // FlowBuilder hands the empty spec out via onChange (debounced)
    fireEvent.change(screen.getByTestId('builder-save-name'), { target: { value: 'build' } });
    await waitFor(() => expect(screen.getByTestId('builder-save').disabled).toBe(false), { timeout: 3000 });
    fireEvent.click(screen.getByTestId('builder-save'));
    await waitFor(() => expect(client.saveSpec).toHaveBeenCalled());
    expect(client.saveSpec.mock.calls[0][0]).toBe('build');
    expect(client.saveSpec.mock.calls[0][1]).toMatchObject({ version: 1 });
    expect((await screen.findByRole('alert')).textContent).toMatch(/not written by the pipeline builder/);

    fireEvent.change(screen.getByTestId('builder-open'), { target: { value: 'kept' } });
    await waitFor(() => expect(client.readSpec).toHaveBeenCalledWith('kept'));
    expect((await screen.findByRole('status')).textContent).toMatch(/Opened kept/);
    expect(screen.getByTestId('builder-save-name').value).toBe('kept');
  });

  it.skipIf(!linked)('hides Save and Open when the client lacks those methods, and still renders the builder', async () => {
    render(<StratumView client={base()} />);
    await openPane();
    expect(screen.queryByTestId('builder-save')).toBeNull();
    expect(screen.queryByTestId('builder-open')).toBeNull();
    const validate = screen.getByRole('button', { name: /Validate/ });
    expect(validate.disabled).toBe(true); // no validateSpec on this client
  });
});

describe('Compose stratum DataClient builder methods', () => {
  it('routes validate/plan/specs to /api/stratum-ui and never throws on a save refusal', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      calls.push([String(url), opts.method || 'GET']);
      if (String(url).endsWith('/specs/nope')) return { ok: false, status: 404, json: async () => ({}) };
      if (String(url).includes('/specs/bad')) return { ok: false, status: 422, json: async () => ({ ok: false, code: 'INVALID', message: 'the engine rejected the spec (1 error)', errors: [{ code: 'X', path: 'p', message: 'm' }] }) };
      return { ok: true, status: 200, json: async () => ({ status: 'valid' }) };
    }));
    const client = createStratumDataClient();
    expect(await client.validateSpec({})).toEqual({ status: 'valid' });
    await client.planFlow({}, {});
    expect(await client.readSpec('nope')).toBeNull();
    const refused = await client.saveSpec('bad', {});
    expect(refused).toMatchObject({ ok: false, code: 'INVALID', message: 'the engine rejected the spec (1 error)' });
    expect(calls).toEqual([
      ['/api/stratum-ui/validate', 'POST'], ['/api/stratum-ui/plan', 'POST'], ['/api/stratum-ui/specs/nope', 'GET'], ['/api/stratum-ui/specs/bad', 'POST'],
    ]);
  });
});

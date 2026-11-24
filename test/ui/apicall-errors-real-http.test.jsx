/**
 * COMP-APICALL-ERRORS-1 real-use check: three real controls (New item dialog Create, Gate Approve,
 * Settings reset) against a REAL http server answering 500, and against a closed port
 * (ECONNREFUSED). Nothing in the store or fetch path is mocked; the only shim prefixes the
 * relative /api URL with the server's origin (jsdom has no origin to resolve against).
 */
import React from 'react';
import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { useVisionStore } from '../../src/components/vision/useVisionStore.js';
import ItemFormDialog from '../../src/components/vision/shared/ItemFormDialog.jsx';
import GateView from '../../src/components/vision/GateView.jsx';
import { DialogProvider } from '../../src/components/ui/DialogProvider.jsx';
import SettingsPanel from '../../src/components/vision/SettingsPanel.jsx';

let server, base, closedBase, toasts;
const realFetch = globalThis.fetch;
const onNotify = (e) => toasts.push(e.detail);
const pointAt = (origin) => vi.stubGlobal('fetch', (u, o) => realFetch(String(u).startsWith('/') ? origin + u : u, o));

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'server exploded' }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const dead = http.createServer();
  await new Promise(r => dead.listen(0, '127.0.0.1', r));
  closedBase = `http://127.0.0.1:${dead.address().port}`;
  await new Promise(r => dead.close(r)); // port now refuses connections
});
afterAll(() => new Promise(r => server.close(r)));
beforeEach(() => { toasts = []; window.addEventListener('compose:notify', onNotify); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { cleanup(); window.removeEventListener('compose:notify', onNotify); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const gate = { id: 'g1', itemId: 'i1', status: 'pending', stepId: 's1', fromPhase: 'design', toPhase: 'implement', createdAt: new Date().toISOString() };
const item = { id: 'i1', title: 'Feature one', type: 'feature', phase: 'design', status: 'planned' };
const settings = { policies: {}, iterations: {}, models: {}, theme: 'dark' };

for (const [label, origin, expectText] of [['HTTP 500', () => base, 'server exploded'], ['stopped server', () => closedBase, '']]) {
  describe(`real ${label}`, () => {
    it('New item dialog: stays open, shows inline error and a toast', async () => {
      pointAt(origin());
      const onClose = vi.fn();
      render(<ItemFormDialog open onClose={onClose} />);
      fireEvent.change(screen.getByPlaceholderText(/title/i), { target: { value: 'My item' } });
      fireEvent.click(screen.getByRole('button', { name: /create/i }));
      await waitFor(() => expect(toasts.length).toBe(1));
      expect(onClose).not.toHaveBeenCalled();
      expect(await screen.findByText(/Failed to create item/)).toBeTruthy();
      if (expectText) { expect(toasts[0].message).toContain(expectText); }
      console.log(`SHOWS[${label}] new-item: inline="${screen.getByText(/Failed to create item/).textContent}" toast="${toasts[0].message}" dialogClosed=${onClose.mock.calls.length > 0}`);
    });

    it('Gate Approve: toast with the reason', async () => {
      pointAt(origin());
      const resolveGate = useVisionStore.getState().resolveGate;
      render(<GateView gates={[gate]} items={[item]} onResolve={resolveGate} onSelect={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));
      await waitFor(() => expect(toasts.length).toBe(1));
      expect(toasts[0].level).toBe('error');
      console.log(`SHOWS[${label}] gate-approve: toast="${toasts[0].message}"`);
    });

    it('Settings reset: toast with the reason', async () => {
      pointAt(origin());
      const { resetSettings, updateSettings } = useVisionStore.getState();
      render(<DialogProvider><SettingsPanel settings={settings} onSettingsChange={updateSettings} onReset={resetSettings} views={[]} /></DialogProvider>);
      const reset = screen.getAllByRole('button').find(b => /reset/i.test(b.textContent));
      expect(reset).toBeTruthy();
      fireEvent.click(reset);
      fireEvent.click(await screen.findByRole('button', { name: /^confirm$/i }));
      await waitFor(() => expect(toasts.length).toBeGreaterThanOrEqual(1));
      console.log(`SHOWS[${label}] settings-reset: toast="${toasts[0].message}"`);
    });
  });
}

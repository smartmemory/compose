/**
 * COMP-COCKPIT-13-POLISH: the new behaviour of the reworked Process view, on the recorded GET /api/process
 * envelope (test/fixtures/process/api-process.json). The figures themselves stay pinned by process-view.test.jsx;
 * these rows cover only the details drawer, expand-to-table and the badge tooltips.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ProcessView from '../../src/components/cockpit/ProcessView.jsx';
import { resetProcessPoller } from '../../src/lib/processPoller.js';
import { resetFleetPoller } from '../../src/lib/fleetPoller.js';

const FIX = join(process.cwd(), 'test', 'fixtures', 'process');
const readJson = (...p) => JSON.parse(readFileSync(join(FIX, ...p), 'utf8'));
const envelope = () => structuredClone(readJson('api-process.json'));
const FLEET = { generated: '2026-10-30T20:00:00Z', sources: { sm_status: { value: { queue: { value: [], error: null } }, error: null, ts: 1, stale: false } } };

function mount(env) {
  resetProcessPoller();
  resetFleetPoller();
  vi.stubGlobal('fetch', vi.fn(async (url) => ({ ok: true, status: 200, json: async () => (String(url).startsWith('/api/process') ? env : FLEET) })));
  render(<ProcessView />);
}
const drawer = () => screen.getByTestId('process-drawer');

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ROWS = [
  {
    name: 'drawer: closed at first, a tile "details" opens it on that section, Escape closes it and focus returns',
    async run() {
      mount(envelope());
      await screen.findByTestId('process-rollup-table');
      expect(drawer().hidden).toBe(true);
      const opener = screen.getByRole('button', { name: 'Gate min / land details' });
      opener.focus();
      fireEvent.click(opener);
      expect(drawer().hidden).toBe(false);
      expect(document.activeElement.id).toBe('process-drawer-gate_minutes');
      expect(within(drawer()).getByTestId('fig-hub-gate_minutes-last5').textContent).toContain(String(envelope().sources.builder.value.pages.hub.value.gate_minutes.last5[0][0]));
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(drawer().hidden).toBe(true);
      expect(document.activeElement).toBe(opener);
    },
  },
  {
    name: 'drawer: a rollup row "basis" opens it on that row, the close button closes it',
    async run() {
      mount(envelope());
      await screen.findByTestId('process-rollup-table');
      const measure = readJson('out', 'master', 'process.json').rows[0].measure;
      fireEvent.click(screen.getByRole('button', { name: `basis for ${measure}` }));
      expect(drawer().hidden).toBe(false);
      expect(document.activeElement.id).toBe('process-drawer-rollup-0');
      expect(document.activeElement.getAttribute('data-testid')).toBe('rollup-basis-0');
      fireEvent.click(within(drawer()).getByRole('button', { name: 'Close details' }));
      expect(drawer().hidden).toBe(true);
    },
  },
  {
    name: 'expand to table: grid cells carry the verbatim text as a tooltip, the table shows it in the cell, and back',
    async run() {
      mount(envelope());
      await screen.findByTestId('process-rollup-table');
      const toggle = screen.getByTestId('process-rollup-expand');
      expect(toggle.textContent).toBe('Expand to table');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(screen.getByTestId('rollup-cell-0-1').getAttribute('role')).toBe('tooltip');
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(toggle.textContent).toBe('Back to grid');
      expect(screen.getByTestId('rollup-cell-0-1').tagName).toBe('TD');
      expect(screen.getByTestId('rollup-cell-0-1').textContent).toBe(readJson('out', 'master', 'process.json').rows[0].cells[1]);
      fireEvent.click(toggle);
      expect(screen.getByTestId('rollup-cell-0-1').getAttribute('role')).toBe('tooltip');
    },
  },
  {
    name: 'badge tooltips: stale names the builder reason, failed names time and reason, missing names the no_data text or "not reported"',
    async run() {
      const env = envelope();
      const pages = env.sources.builder.value.pages;
      delete pages.hub.value.review_rounds;
      mount(env);
      await screen.findByTestId('process-rollup-table');
      const stale = screen.getByTestId('stale-hub-gate_minutes');
      expect(stale.getAttribute('role')).toBe('tooltip');
      expect(stale.textContent).toBe(`stale: ${pages.hub.value.gate_minutes.stale}`);
      expect(within(screen.getByTestId('process-hub-gate_minutes')).getByText('stale')).toBeTruthy();
      const missing = screen.getByTestId('empty-hub-review_rounds');
      expect([missing.getAttribute('role'), missing.textContent]).toEqual(['tooltip', 'not reported']);
      const failed = within(screen.getByTestId('process-col-main')).getByRole('tooltip', { hidden: true });
      expect(failed.textContent).toBe(`failed ${pages.main.failed.time}: ${pages.main.failed.reason}`);
      fireEvent.click(screen.getByRole('button', { name: 'Fixture main' }));
      expect(screen.getByTestId('empty-main-gate_minutes').textContent).toBe(pages.main.value.no_data.gate_minutes);
      expect(within(screen.getByTestId('process-main-gate_minutes')).getByText('no data')).toBeTruthy();
    },
  },
];

describe('Process view polish', () => {
  it('row table', async () => {
    for (const row of ROWS) {
      try { await row.run(); } catch (e) { e.message = `${row.name}: ${e.message}`; throw e; }
      cleanup();
    }
  });
});

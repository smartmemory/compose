/**
 * COMP-COCKPIT-DECISIONS-1: the Decisions pane in Projects › Review. It scopes to the project whose module is the
 * cockpit's root, reads /api/decisions with plain fetch (no workspace header, no project switch), and its segmented
 * filters (project / decider / standing) and More rebuild the query. Rows show the decider chip, an exact or
 * inferred tag, the status chip, and "commit pending" while the blame is cold. One row table.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';

const { default: DecisionsPane } = await import('../../src/components/cockpit/DecisionsPane.jsx');
const { resetFleetProjects } = await import('../../src/lib/fleetProjects.js');
const { projectOfRoot, decisionsUrl, toggleDecider } = await import('../../src/components/cockpit/decisionsPaneLogic.js');

const MODEL = {
  configured: true,
  projects: [
    { name: 'smartmemory', label: 'SmartMemory', root: '/r/sm', modules: [] },
    { name: 'forge', label: 'Forge', root: '/r/forge', modules: [{ name: 'compose', realpath: '/r/forge/compose' }] },
  ],
  laneIndex: {},
};
const row = (over) => ({
  id: 'L1', line: 1, at: '2026-11-01T11:40:00.000Z', day: '2026-11-01', decider: 'owner', by: 'owner', via: 's1-chat', summary: 's', text: 't',
  units: [], refs: [], echoes: [], maybe: [], status: 'standing', statusBy: null, exact: false, inferred: true, dId: null, tags: [],
  commit: null, commitPending: false, source: 'ledger', projects: [], ...over,
});
const D1 = row({ id: 'D-0001', line: 22710, exact: true, inferred: false, dId: 'D-0001', summary: 'owner decision lines carry a D-id', commitPending: true });
const D2 = row({ id: 'D-0002', line: 22712, exact: true, inferred: false, dId: 'D-0002', summary: 'use all 3 boxes', status: 'superseded', statusBy: { line: 22715 }, commit: 'abcdef1234567890' });
const ABS = row({ id: 'L9', line: 9, decider: 'absent', by: 'sm20-main', via: null, summary: 'CORE-X waits', tags: ['relay-only'], echoes: [{ line: 12, by: 's2-coord' }] });

function body(rows, over = {}) {
  return {
    asOf: 'x', filters: {}, total: rows.length, nextCursor: null, rows,
    counts: { projects: { all: 9, fleet: 4, forge: 3 }, decider: { owner: 2, absent: 1, lane: 0, queue: 0 } },
    projects: MODEL.projects, blame: { state: 'cold' }, sourceErrors: {}, ...over,
  };
}

function stubFetch(answer = () => body([D1, D2, ABS])) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    calls.push([u, opts.headers ?? {}]);
    const json = u.startsWith('/api/projects') ? MODEL : answer(u);
    return { ok: true, status: 200, json: async () => json };
  }));
  return calls;
}
const decisionCalls = (calls) => calls.filter(([u]) => u.startsWith('/api/decisions')).map(([u]) => new URL(u, 'http://x').searchParams);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); resetFleetProjects(); });

describe('DecisionsPane', () => {
  // [name, setup(calls) -> assertions]
  const ROWS = [
    ['scopes to the project holding the cockpit root, plain fetch with no workspace header', async (calls) => {
      await waitFor(() => expect(decisionCalls(calls).some((p) => p.get('project') === 'forge')).toBe(true));
      expect(screen.getByTestId('decisions-scope-this').textContent).toContain('Forge');
      expect(calls.every(([u, h]) => !u.includes('/api/project/switch') && !('X-Compose-Workspace-Id' in h))).toBe(true);
    }],
    ['D-0001 shows as an exact row with commit pending; D-0002 says what superseded it; the absent row is relay-only', async () => {
      const rows = await screen.findAllByTestId('decision-row');
      const d1 = within(rows.find((r) => r.dataset.id === 'D-0001'));
      expect(d1.getAllByTestId('decision-tag').map((t) => t.textContent)).toEqual(['exact D-0001']);
      expect(d1.getByTestId('decision-source').textContent).toBe('commit pending · ledger.md#L22710');
      const d2 = within(rows.find((r) => r.dataset.id === 'D-0002'));
      expect([d2.getByTestId('decision-status').textContent, d2.getByTestId('decision-source').textContent]).toEqual(['superseded by L22715', 'abcdef123456']);
      const abs = within(rows.find((r) => r.dataset.id === 'L9'));
      expect([abs.getByTestId('decision-decider').textContent, abs.getAllByTestId('decision-tag').map((t) => t.textContent)]).toEqual(['Owner-absent', ['inferred', 'relay-only']]);
      expect(screen.getByTestId('decisions-blame').textContent).toContain('cold');
      expect(screen.getByTestId('decisions-legend').textContent).toBe('standing = no recorded reversal');
    }],
    ['expanding a row shows its premises and echoes', async () => {
      const rows = await screen.findAllByTestId('decision-row');
      fireEvent.click(within(rows.find((r) => r.dataset.id === 'L9')).getByTestId('decision-summary'));
      expect(screen.getByTestId('decision-premises').textContent).toContain('L12 s2-coord');
    }],
    ['Fleet-wide, a decider toggle and standing-only rebuild the query', async (calls) => {
      await screen.findAllByTestId('decision-row');
      fireEvent.click(screen.getByTestId('decisions-scope-fleet'));
      fireEvent.click(screen.getByTestId('decisions-decider-lane'));
      fireEvent.click(screen.getByTestId('decisions-status-standing'));
      await waitFor(() => {
        const last = decisionCalls(calls).at(-1);
        expect([last.get('project'), last.get('decider'), last.get('status')]).toEqual(['fleet', 'owner,absent,queue', 'standing']);
      });
    }],
    ['More appends the next page', async (calls) => {
      fireEvent.click(await screen.findByTestId('decisions-more'));
      await waitFor(() => expect(screen.getAllByTestId('decision-row').map((r) => r.dataset.id)).toEqual(['D-0001', 'D-0002']));
      expect(decisionCalls(calls).at(-1).get('cursor')).toBe('1');
    }, (u) => (new URL(u, 'http://x').searchParams.get('cursor') ? body([D2], { total: 2 }) : body([D1], { total: 2, nextCursor: '1' }))],
    ['a failing source is a visible line, the rows still show', async () => {
      expect((await screen.findByTestId('decisions-source-error')).textContent).toBe('ledger unavailable: ENOENT');
      expect(screen.queryByTestId('decisions-empty')).not.toBeNull();
    }, () => body([], { sourceErrors: { ledger: 'ENOENT' } })],
  ];
  for (const [name, check, answer] of ROWS) {
    it(name, async () => {
      const calls = stubFetch(answer);
      render(<DecisionsPane projectRoot="/r/forge/compose/" />);
      await check(calls);
    });
  }
  it('logic: root to project (module, root, nested path, none), URL defaults, the last decider stays on', () => {
    expect([
      projectOfRoot(MODEL.projects, '/r/forge/compose')?.name, projectOfRoot(MODEL.projects, '/r/sm')?.name,
      projectOfRoot(MODEL.projects, '/r/sm/sub/dir')?.name, projectOfRoot(MODEL.projects, '/elsewhere'), projectOfRoot(null, '/r/sm'),
    ]).toEqual(['forge', 'smartmemory', 'smartmemory', null, null]);
    expect(decisionsUrl({ scope: 'this', project: null })).toBe('/api/decisions?project=fleet&status=all&size=50');
    expect(toggleDecider(['lane'], 'lane')).toEqual(['lane']);
  });
});

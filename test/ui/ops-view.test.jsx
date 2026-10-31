/** COMPOSE-OPS-TAB-1 + COMP-COCKPIT-INIT-VIEW-1: Ops view renders natively from a mocked index and data route, remembers the last page. */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import OpsView from '../../src/components/cockpit/OpsView.jsx';
import { locateView } from '../../lib/view-keys.js';

const graph = vi.hoisted(() => ({ props: null }));
vi.mock('../../src/components/GraphRenderer.jsx', () => ({
  default: (props) => { graph.props = props; return <div data-testid="graph" />; },
}));

const NODES = [
  { id: 'A-1', title: 'Alpha plain title', titleSource: 'stamp', landedAt: '2026-10-30T10:00:00Z', builderStatus: 'landed', deps: [] },
  { id: 'B-1', title: 'Bravo plain title', titleSource: 'stamp', landedAt: '2026-10-31T09:00:00Z', builderStatus: 'landed', deps: ['A-1'] },
  { id: 'C-1', title: 'Charlie plain title', titleSource: 'stamp', landedAt: null, builderStatus: 'queue', deps: ['B-1', 'GONE-1'] },
];
const DATA = {
  name: 'forge', asOf: '2026-10-31 19:27 local', ageS: 90, notices: 72,
  progress: { planned: 3, landed: 2, builderOnly: 1, notRecorded: 4, nodes: NODES },
  eta: { p50: '13h', p80: '48h', asOf: '2026-10-31T19:13' },
};
const jsonRes = (status, body) => ({ ok: status < 400, status, json: async () => body });

/** Routes by URL: the index, one data body per lane (a function or a status/body pair), the unit index empty. */
const mockApi = ({ pages = ['forge', 'wiki'], data = {} } = {}) => vi.fn(async (url) => {
  if (url === '/api/ops-status/index') return jsonRes(200, { pages });
  if (url === '/api/units/index') return jsonRes(200, { units: [], glossary: {} });
  const m = url.match(/^\/api\/ops-status\/([^/]+)\/data$/);
  if (m) { const d = data[m[1]] ?? [200, DATA]; return jsonRes(d[0], d[1]); }
  return jsonRes(404, {});
});
const callsTo = (f, re) => f.mock.calls.filter((c) => re.test(c[0])).length;

const VIEW_ROWS = [
  ['progress text, not-recorded and builder-only lines', async () => {
    vi.stubGlobal('fetch', mockApi());
    render(<OpsView />);
    await waitFor(() => screen.getByText('2 of 3 landed'));
    screen.getByText('4 not recorded in stamps');
    screen.getByText('1 the builder calls landed with no stamp');
  }],
  ['ETA line with P50 and P80, and NO DATA with its reason', async () => {
    vi.stubGlobal('fetch', mockApi({ data: { wiki: [200, { ...DATA, eta: { noData: true, raw: 'NO DATA (n=3)' } }] } }));
    render(<OpsView />);
    await waitFor(() => screen.getByTestId('ops-eta'));
    expect(screen.getByTestId('ops-eta').textContent).toBe('P50 13h · P80 48h (estimate as of 2026-10-31T19:13)');
    fireEvent.click(screen.getByText('wiki'));
    await waitFor(() => expect(screen.getByTestId('ops-eta').textContent).toBe('No estimate yet (NO DATA (n=3))'));
  }],
  ['DAG props: plain title as label, code as sublabel, dangling dep dropped, state colours', async () => {
    localStorage.setItem('compose:opsShowLanded:forge', '1'); // F1: the default scope is unlanded + direct deps; this row checks the whole lane
    vi.stubGlobal('fetch', mockApi());
    render(<OpsView />);
    await waitFor(() => expect(graph.props?.nodes?.length).toBe(3));
    expect(graph.props.nodes.map((n) => [n.label, n.sublabel])).toEqual([
      ['Alpha plain title', 'A-1'], ['Bravo plain title', 'B-1'], ['Charlie plain title', 'C-1'],
    ]);
    expect(graph.props.edges).toEqual([{ from: 'A-1', to: 'B-1' }, { from: 'B-1', to: 'C-1' }]);
    expect(graph.props.nodes.map((n) => n.color)).toEqual(['#22c55e', '#22c55e', '#94a3b8']); // C-1 waits: GONE-1 is not a landed unit
    expect(graph.props.layout.rankDir).toBe('LR');
    expect([graph.props.legend, graph.props.sublabelInNode]).toEqual([false, true]);
  }],
  ['F1 default DAG scope is unlanded + direct deps, the switch shows the whole lane and is remembered per lane', async () => {
    const wide = [...NODES, { id: 'D-1', title: 'Delta plain title', titleSource: 'stamp', landedAt: '2026-10-29T10:00:00Z', builderStatus: 'landed', deps: [] }];
    vi.stubGlobal('fetch', mockApi({ data: { forge: [200, { ...DATA, progress: { ...DATA.progress, nodes: wide } }] } }));
    render(<OpsView />);
    await waitFor(() => expect(graph.props?.nodes?.length).toBe(2)); // C-1 plus its dep B-1; A-1 and D-1 are landed and not depended on directly
    expect(graph.props.nodes.map((n) => n.sublabel)).toEqual(['B-1', 'C-1']);
    expect(graph.props.edges).toEqual([{ from: 'B-1', to: 'C-1' }]);
    expect([graph.props.fillFromColor, graph.props.minZoom, graph.props.nodeHeight]).toEqual([true, 0.01, 48]);
    fireEvent.click(screen.getByLabelText('Show landed too'));
    await waitFor(() => expect(graph.props.nodes.length).toBe(4));
    expect(localStorage.getItem('compose:opsShowLanded:forge')).toBe('1');
    expect(localStorage.getItem('compose:opsShowLanded:wiki')).toBeNull();
  }],
  ['F1 a lane with nothing unlanded says All N landed instead of drawing a box', async () => {
    const done = NODES.slice(0, 2);
    vi.stubGlobal('fetch', mockApi({ data: { forge: [200, { ...DATA, progress: { ...DATA.progress, nodes: done } }] } }));
    render(<OpsView />);
    await waitFor(() => screen.getByText('All 2 landed'));
    expect(graph.props).toBeNull();
    fireEvent.click(screen.getByLabelText('Show landed too'));
    await waitFor(() => expect(graph.props.nodes.length).toBe(2));
  }],
  ['notices collapsed with the live count, below the content', async () => {
    vi.stubGlobal('fetch', mockApi());
    const { container } = render(<OpsView />);
    await waitFor(() => screen.getByText('72 data-quality notes from the builder'));
    const details = screen.getByTestId('ops-notices');
    expect(details.hasAttribute('open')).toBe(false);
    expect(container.textContent.indexOf('2 of 3 landed')).toBeLessThan(container.textContent.indexOf('72 data-quality notes'));
  }],
  ['landed list newest first', async () => {
    vi.stubGlobal('fetch', mockApi());
    render(<OpsView />);
    await waitFor(() => expect(screen.getAllByTestId('landed-row').length).toBe(2));
    expect(screen.getAllByTestId('landed-row').map((r) => r.textContent.startsWith('B-1') || r.textContent.includes('B-1'))).toEqual([true, false]);
  }],
  ['404 shows the route message and keeps the Builder page link', async () => {
    vi.stubGlobal('fetch', mockApi({ data: { forge: [404, { error: 'no data.json yet; the builder writes it on its next tick' }] } }));
    render(<OpsView />);
    await waitFor(() => screen.getByText(/no data\.json yet/));
    expect(screen.getByText('Builder page ↗').getAttribute('href')).toBe('/ops-status/forge/status.html');
    expect(screen.queryByText(/of \d+ landed/)).toBeNull();
  }],
  ['loading shows a skeleton and no zero', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => (url === '/api/ops-status/index' ? Promise.resolve(jsonRes(200, { pages: ['forge'] })) : new Promise(() => {}))));
    render(<OpsView />);
    await waitFor(() => screen.getByTestId('ops-skeleton'));
    expect(screen.queryByText(/of \d+ landed/)).toBeNull();
  }],
];

describe('OpsView', () => {
  beforeEach(() => { localStorage.clear(); graph.props = null; });
  afterEach(() => vi.unstubAllGlobals());

  it('is a sub-tab of the Fleet room', () => expect(locateView('ops')).toEqual({ top: 'fleet', sub: 'ops' }));

  it('picker + Builder page link from the index, remembers last page', async () => {
    const f = mockApi();
    vi.stubGlobal('fetch', f);
    render(<OpsView />);
    await waitFor(() => screen.getByText('wiki'));
    expect(screen.getByText('Builder page ↗').getAttribute('href')).toBe('/ops-status/forge/status.html');
    fireEvent.click(screen.getByText('wiki'));
    expect(screen.getByText('Builder page ↗').getAttribute('href')).toBe('/ops-status/wiki/status.html');
    expect(localStorage.getItem('compose:opsPage')).toBe('wiki');
    expect(callsTo(f, /^\/api\/ops-status\/index$/)).toBe(1);
    expect(callsTo(f, /^\/api\/ops-status\/[^/]+\/data$/)).toBe(2);
    expect(f.mock.calls[0][0]).toBe('/api/ops-status/index');
  });

  for (const [name, run] of VIEW_ROWS) it(name, run);

  it('empty index shows a notice and no iframe', async () => {
    vi.stubGlobal('fetch', mockApi({ pages: [] }));
    const { container } = render(<OpsView />);
    await waitFor(() => screen.getByText(/No Ops status pages/));
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.queryByText('Builder page ↗')).toBeNull();
  });
});

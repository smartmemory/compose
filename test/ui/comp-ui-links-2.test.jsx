/**
 * COMP-UI-LINKS-2: the cockpit link rows COMP-UI-LINKS-1 left. One representative link per room, each asserting the navigation call
 * and its target (the mechanism), plus the degrade-to-text path and the entity tokenizer behind Inbox, Journal and the free-text rows.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { NavigationContext } from '../../src/lib/navigation.jsx';
import EntityLink, { LinkedText } from '../../src/components/shared/EntityLink.jsx';
import NowDrawer from '../../src/components/ribbon/now/NowDrawer.jsx';
import HomeSections from '../../src/components/vision/HomeSections.jsx';
import TimelineEvent from '../../src/components/vision/TimelineEvent.jsx';
import DecisionCard from '../../src/components/vision/DecisionCard.jsx';
import DecisionsPane from '../../src/components/cockpit/DecisionsPane.jsx';
import AgentCard from '../../src/components/shared/AgentCard.jsx';
import ContextSessionsTable from '../../src/components/vision/ContextSessionsTable.jsx';
import ContextErrorLog from '../../src/components/vision/ContextErrorLog.jsx';
import LinkedMarkdown from '../../src/components/vision/shared/LinkedMarkdown.jsx';
import MessageCard from '../../src/components/agent/MessageCard.jsx';
import IdeaboxView from '../../src/components/vision/IdeaboxView.jsx';
import { useIdeaboxStore } from '../../src/components/vision/useIdeaboxStore.js';
import { promotedFeature } from '../../src/components/vision/IdeaboxView.jsx';
import { entityParts, parseEntityHref } from '../../src/lib/entityParts.js';
import { entityLinkParts, linkParts } from '../../src/components/cockpit/notify/inboxLogic.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const makeNav = (extra = {}) => ({
  openItem: vi.fn(), openGate: vi.fn(), openView: vi.fn(), openFeature: vi.fn(), openRoom: vi.fn(), openFile: vi.fn(),
  canNavigate: () => true, ...extra,
});
const withNav = (ui, nav) => render(<NavigationContext.Provider value={nav}>{ui}</NavigationContext.Provider>);

describe('Day: Now drawer', () => {
  it('a waiting unit opens the Cadence room on that unit', () => {
    const nav = makeNav();
    const index = { units: [{ id: 'U-9', lane: 'ops', title: 'the title', waiting: 'review', authorDoneAt: '2026-11-02T00:00:00Z' }] };
    withNav(<NowDrawer kind="waiting" onClose={() => {}} fleet={null} index={index} now={Date.parse('2026-11-03T00:00:00Z')} />, nav);
    fireEvent.click(screen.getByRole('button', { name: 'U-9' }));
    expect(nav.openRoom).toHaveBeenCalledWith('cadence', { kind: 'unit', id: 'U-9' });
  });
});

describe('Project home', () => {
  const sections = {
    needsYou: { gates: [{ gate: { id: 'g1', stepId: 'design' }, item: { title: 'Gated' } }], queue: [], errors: [{ message: 'boom' }] },
    running: { build: { featureCode: 'F-1', status: 'running' }, agents: [{ agentId: 'a1', agentType: 'explorer' }] },
    inProgress: [], recentlyChanged: [], recentBuilds: [{ featureCode: 'F-2', status: 'complete' }],
  };
  it('the build row opens the Pipeline and the agent row opens Sessions', () => {
    const onNavigate = vi.fn();
    render(<HomeSections sections={sections} onNavigate={onNavigate} onJumpToGate={vi.fn()} onStopAgent={vi.fn()} />);
    fireEvent.click(screen.getByTestId('home-build-row'));
    expect(onNavigate).toHaveBeenLastCalledWith('pipeline');
    fireEvent.click(screen.getByTestId('home-agent-link'));
    expect(onNavigate).toHaveBeenLastCalledWith('sessions');
    fireEvent.click(screen.getByTestId('home-error-row'));
    expect(onNavigate).toHaveBeenLastCalledWith('sessions');
  });
  it('a recent build opens its feature when Compose holds it, else the Past builds view', () => {
    const onNavigate = vi.fn();
    const nav = makeNav({ canNavigate: (k, id) => id === 'F-2' });
    withNav(<HomeSections sections={sections} onNavigate={onNavigate} />, nav);
    fireEvent.click(screen.getByTestId('home-build-history-row'));
    expect(nav.openFeature).toHaveBeenCalledWith('F-2');
    cleanup();
    withNav(<HomeSections sections={sections} onNavigate={onNavigate} />, makeNav({ canNavigate: () => false }));
    fireEvent.click(screen.getByTestId('home-build-history-row'));
    expect(onNavigate).toHaveBeenLastCalledWith('build-history');
  });
  it('degrade: a gate row with no jump handler is text with a reason, never a dead button', () => {
    render(<HomeSections sections={sections} />);
    const row = screen.getByTestId('home-gate-row');
    expect(row.tagName).toBe('DIV');
    expect(row.getAttribute('title')).toMatch(/No gate view/);
  });
});

describe('Dashboard agent cards, event timeline, decision strip', () => {
  it('an agent card label opens Sessions only when given a handler', () => {
    const onOpen = vi.fn();
    const { rerender } = render(<AgentCard agent={{ agentType: 'explorer', status: 'running' }} onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId('agent-card-open'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    rerender(<AgentCard agent={{ agentType: 'explorer', status: 'running' }} />);
    expect(screen.queryByTestId('agent-card-open')).toBeNull();
  });
  it('a gate event opens its gate; a session event is text with the reason', () => {
    const nav = makeNav();
    withNav(<TimelineEvent event={{ category: 'gate', title: 'Gate opened', meta: { gateId: 'g-7' }, timestamp: null }} />, nav);
    fireEvent.click(screen.getByRole('button', { name: /Gate opened/ }));
    expect(nav.openGate).toHaveBeenCalledWith('g-7');
    cleanup();
    withNav(<TimelineEvent event={{ category: 'session', title: 'Session', meta: { toolCount: 3 }, timestamp: null }} />, nav);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('timeline-event').getAttribute('title')).toMatch(/No target/);
  });
  it('a decision card opens the Decisions room', () => {
    const nav = makeNav();
    const { container } = withNav(<DecisionCard event={{ kind: 'decision', title: 'Pick A', timestamp: null, roles: [] }} />, nav);
    fireEvent.click(container.querySelector('[data-decision-card]'));
    expect(nav.openView).toHaveBeenCalledWith('decisions');
  });
});

describe('Decisions room', () => {
  it('a unit opens the Cadence room, a tag narrows the list through the search box (nothing written)', async () => {
    const row = {
      id: 'd1', summary: 'Use plan A', text: 'because', decider: 'owner', status: 'standing', tags: ['routing'], projects: ['forge'],
      units: ['COMP-X-1'], refs: [{ kind: 'file', value: 'docs/a/b.md' }, { kind: 'commit', value: 'abc1234' }], by: 'maya',
    };
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push([String(url), init?.method ?? 'GET']);
      return { ok: true, json: async () => ({ rows: [row], total: 1, counts: { projects: {}, decider: {} }, nextCursor: null }) };
    }));
    const nav = makeNav();
    withNav(<DecisionsPane projectRoot="/x" onOpenFile={nav.openFile} />, nav);
    const rowEl = await screen.findByTestId('decision-row');
    fireEvent.click(within(rowEl).getByTestId('decision-summary'));
    fireEvent.click(within(rowEl).getByRole('button', { name: 'COMP-X-1' }));
    expect(nav.openRoom).toHaveBeenCalledWith('cadence', { kind: 'unit', id: 'COMP-X-1' });
    fireEvent.click(within(rowEl).getByRole('button', { name: 'file docs/a/b.md' }));
    expect(nav.openFile).toHaveBeenCalledWith('docs/a/b.md');
    expect(within(rowEl).getByText('commit abc1234').getAttribute('title')).toMatch(/No target/);
    fireEvent.click(within(rowEl).getByTestId('decision-tag'));
    expect(screen.getByTestId('decisions-search').value).toBe('routing');
    expect(calls.every(([, m]) => m === 'GET')).toBe(true);
  });
});

describe('Ideas', () => {
  it('a promoted idea names the feature it became', () => {
    expect(promotedFeature('PROMOTED (→ COMP-UI-LINKS-2)')).toBe('COMP-UI-LINKS-2');
    expect(promotedFeature('PROMOTED (COMP-X-1)')).toBe('COMP-X-1');
    expect(promotedFeature('NEW')).toBeNull();
  });
});

describe('Journal, Context panel, Agent stream', () => {
  it('a feature code and a repo path inside markdown open through the navigation context; code spans do not', () => {
    const nav = makeNav();
    withNav(<LinkedMarkdown content={'Shipped COMP-UI-LINKS-2, see docs/features/X-1/design.md and `run COMP-NOT-LINK`.'} />, nav);
    fireEvent.click(screen.getByRole('link', { name: 'COMP-UI-LINKS-2' }));
    expect(nav.openFeature).toHaveBeenCalledWith('COMP-UI-LINKS-2');
    fireEvent.click(screen.getByRole('link', { name: 'docs/features/X-1/design.md' }));
    expect(nav.openFile).toHaveBeenCalledWith('docs/features/X-1/design.md');
    expect(screen.queryByRole('link', { name: 'COMP-NOT-LINK' })).toBeNull(); // not on its own: code with other text around it is code
  });
  it('an inline-code span that is exactly one path links, and stays code', () => {
    const nav = makeNav();
    const { container } = withNav(<LinkedMarkdown content={'built `docs/gate-jev.md` and `npm run build COMP-X-1`'} />, nav);
    const link = screen.getByRole('link', { name: 'docs/gate-jev.md' });
    expect(link.querySelector('code')).not.toBeNull();
    fireEvent.click(link);
    expect(nav.openFile).toHaveBeenCalledWith('docs/gate-jev.md');
    expect(container.querySelectorAll('a')).toHaveLength(1);
  });
  it('degrade: tokens the cockpit cannot open stay plain text', () => {
    const { container } = withNav(<LinkedText text="see COMP-GONE-1 now" />, makeNav({ canNavigate: () => false }));
    expect(container.textContent).toBe('see COMP-GONE-1 now');
    expect(container.querySelector('button, span[data-no-target]')).toBeNull();
  });
  it('a context-panel session opens Sessions; an error opens its file and Sessions', () => {
    const nav = makeNav();
    withNav(<ContextSessionsTable featureCode="F-1" sessions={[{ id: 's1', featureCode: 'F-1', source: 'claude', summary: 'did it' }]} items={[]} />, nav);
    fireEvent.click(screen.getByText('claude'));
    fireEvent.click(screen.getByRole('button', { name: 'Open in Sessions' }));
    expect(nav.openView).toHaveBeenCalledWith('sessions');
    cleanup();
    withNav(<ContextErrorLog featureCode="F-1" errors={[{ featureCode: 'F-1', tool: 'Bash', message: 'bad', file: 'docs/a.md' }]} items={[]} />, nav);
    fireEvent.click(screen.getByText('bad'));
    fireEvent.click(screen.getByRole('button', { name: 'docs/a.md' }));
    expect(nav.openFile).toHaveBeenCalledWith('docs/a.md');
  });
  it('a build message names its feature as a link', () => {
    const nav = makeNav();
    withNav(<MessageCard msg={{ type: 'system', subtype: 'build_start', featureCode: 'COMP-B-1' }} />, nav);
    fireEvent.click(screen.getByRole('button', { name: 'COMP-B-1' }));
    expect(nav.openFeature).toHaveBeenCalledWith('COMP-B-1');
  });
});

describe('EntityLink kinds added here, and the degrade path', () => {
  it.each([
    ['unit', 'U-1', 'openRoom', ['cadence', { kind: 'unit', id: 'U-1' }]],
    ['session', 'lane-a', 'openRoom', ['fleet', { kind: 'session', name: 'lane-a' }]],
    ['step', 'run-1#build', 'openRoom', ['stratum', { kind: 'step', runId: 'run-1', stepId: 'build' }]],
    ['file', 'docs/x.md', 'openFile', ['docs/x.md']],
  ])('%s calls %s with its target', (kind, id, cb, args) => {
    const nav = makeNav();
    withNav(<EntityLink kind={kind} id={id} />, nav);
    fireEvent.click(screen.getByRole('button'));
    expect(nav[cb]).toHaveBeenCalledWith(...args);
  });
  it('with no handler it is text, with a title saying why', () => {
    withNav(<EntityLink kind="unit" id="U-1" />, makeNav({ openRoom: undefined }));
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('U-1').getAttribute('title')).toMatch(/No link here/);
  });
});

describe('Inbox entity parts', () => {
  it('keeps URL parts and splits feature codes and paths out of the text', () => {
    const text = 'Ship COMP-UI-LINKS-2 per docs/a/b.md at https://x.test/p';
    expect(entityLinkParts(text)).toEqual([
      { text: 'Ship ' }, { entity: 'feature', text: 'COMP-UI-LINKS-2' }, { text: ' per ' },
      { entity: 'file', text: 'docs/a/b.md' }, { text: ' at ' }, { href: 'https://x.test/p', text: 'https://x.test/p' },
    ]);
    expect(linkParts('plain COMP-X-1')).toEqual([{ text: 'plain COMP-X-1' }]); // the URL-only splitter is unchanged
  });
  it('the tokenizer round-trips and the markdown href round-trips', () => {
    const text = 'a COMP-A-1, b/c.md#L3 z';
    expect(entityParts(text).map((p) => p.value).join('')).toBe(text);
    const { container } = withNav(<LinkedMarkdown content={text} />, makeNav());
    expect(container.querySelector('a').getAttribute('href')).toBe('#entity:feature:COMP-A-1');
    expect(parseEntityHref('#entity:file:b/c.md#L3')).toEqual({ kind: 'file', id: 'b/c.md#L3' });
    expect(parseEntityHref('https://x')).toBeNull();
  });
});

describe('Past builds and Sessions: a feature code with no roadmap item', () => {
  it('is text with a reason, not a dead button', async () => {
    const { default: PastBuildsView } = await import('../../src/components/vision/PastBuildsView.jsx');
    const builds = [{ featureCode: 'FEAT-GONE', mode: 'feature', status: 'complete', completedAt: '2026-06-08T03:00:00.000Z', durationMs: 1000 }];
    render(<PastBuildsView builds={builds} items={[]} onSelectItem={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'FEAT-GONE' })).toBeNull();
    expect(screen.getByText('FEAT-GONE').getAttribute('title')).toMatch(/No roadmap item/);
  });
});

describe('A file link needs a Wiki tab', () => {
  it('is text with a reason when the cockpit says it cannot open files', () => {
    const { container } = withNav(<LinkedText text="see docs/a/b.md" />, makeNav({ canNavigate: (k) => k !== 'file' }));
    expect(container.textContent).toBe('see docs/a/b.md');
    cleanup();
    withNav(<EntityLink kind="file" id="docs/a/b.md" />, makeNav({ canNavigate: (k) => k !== 'file' }));
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('docs/a/b.md').getAttribute('title')).toMatch(/Wiki tab is not available/);
  });
});

describe('A source path is not a wiki document', () => {
  it('stays text: the tokenizer and the Context error row both leave a .js path alone', () => {
    expect(entityParts('see lib/gate-jev.js and docs/a/b.md').map((p) => p.kind)).toEqual(['text', 'file']);
    const nav = makeNav();
    withNav(<ContextErrorLog featureCode="F-1" errors={[{ featureCode: 'F-1', tool: 'Bash', message: 'bad', file: 'src/a.js' }]} items={[]} />, nav);
    fireEvent.click(screen.getByText('bad'));
    expect(screen.queryByRole('button', { name: 'src/a.js' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open in Sessions' })).toBeTruthy();
  });
});

// ── COMP-UI-LINKS-2-FU-1: a link whose target cannot open is text with a reason, in every path that makes links ──

describe('FU-1 M1: a room that is unavailable makes its links text', () => {
  const roomsOff = (nav) => makeNav({ canNavigate: (kind) => !['unit', 'step'].includes(kind), ...nav });
  it.each([
    ['unit', 'U-1', /Cadence room is not available/],
    ['step', 'run-1#build', /Stratum room is not available/],
  ])('a %s link is text with the reason, and nothing is called', (kind, id, reason) => {
    const nav = roomsOff();
    withNav(<EntityLink kind={kind} id={id} />, nav);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(id).getAttribute('title')).toMatch(reason);
    fireEvent.click(screen.getByText(id));
    expect(nav.openRoom).not.toHaveBeenCalled();
  });
  it('a session link is unaffected: the Fleet room is not package-gated', () => {
    const nav = roomsOff();
    withNav(<EntityLink kind="session" id="lane-a" />, nav);
    fireEvent.click(screen.getByRole('button'));
    expect(nav.openRoom).toHaveBeenCalledWith('fleet', { kind: 'session', name: 'lane-a' });
  });
});

describe('FU-1 M3: file tokens and authored hrefs', () => {
  it.each(['../x.md', 'a/../../x.md', '/etc/x.md', '~/x.md', '~/a/x.md', 'https://h.test/a/x.md', 'file:///a/x.md'])(
    '%s stays text in the tokenizer and in LinkedText', (path) => {
      expect(entityParts(`see ${path} now`).every((p) => p.kind === 'text')).toBe(true);
      const nav = makeNav();
      const { container } = withNav(<LinkedText text={`see ${path} now`} />, nav);
      expect(container.querySelector('button, a')).toBeNull();
      expect(container.textContent).toBe(`see ${path} now`);
    });
  it('a safe path still links', () => {
    expect(entityParts('see docs/a/x.md').map((p) => p.kind)).toEqual(['text', 'file']);
  });
  it('an authored #entity:file href with a traversal path is text and a click never opens it', () => {
    const nav = makeNav();
    const { container } = withNav(<LinkedMarkdown content={'[outside](#entity:file:../../x.md) and [ok](#entity:file:docs/a/x.md)'} />, nav);
    expect(screen.getByText('outside').closest('a')).toBeNull();
    expect(screen.getByText('outside').getAttribute('title')).toMatch(/not a repo document path/);
    fireEvent.click(screen.getByText('outside'));
    expect(nav.openFile).not.toHaveBeenCalled();
    expect(container.querySelectorAll('a')).toHaveLength(1);
    fireEvent.click(screen.getByRole('link', { name: 'ok' }));
    expect(nav.openFile).toHaveBeenCalledWith('docs/a/x.md');
  });
  it('an authored entity href the provider refuses is text; one for an unknown kind is text', () => {
    const nav = makeNav({ canNavigate: () => false });
    withNav(<LinkedMarkdown content={'[g](#entity:feature:COMP-A-1) [z](#entity:bogus:1)'} />, nav);
    expect(screen.queryByRole('link')).toBeNull();
    fireEvent.click(screen.getByText('g'));
    fireEvent.click(screen.getByText('z'));
    expect(nav.openFeature).not.toHaveBeenCalled();
    expect(nav.openItem).not.toHaveBeenCalled();
  });
  it('parseEntityHref accepts only the known kinds', () => {
    expect(parseEntityHref('#entity:bogus:1')).toBeNull();
    expect(parseEntityHref('#entity:unit:U-1')).toEqual({ kind: 'unit', id: 'U-1' });
  });
});

describe('FU-1 M2: the linkifier follows the markdown parser', () => {
  it('a reference link keeps its https href, a definition is untouched', () => {
    const { container } = withNav(<LinkedMarkdown content={'See [COMP-MODEL-AB][ref] and [COMP-MODEL-AB][] and [COMP-MODEL-AB].\n\n[ref]: https://example.test/a\n[COMP-MODEL-AB]: https://example.test/b'} />, makeNav());
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://example.test/a', 'https://example.test/b', 'https://example.test/b']);
    expect(container.textContent).not.toContain('#entity');
  });
  it('double-backtick and tilde code are untouched', () => {
    const { container } = withNav(<LinkedMarkdown content={'a ``COMP-MODEL-AB`` b ``COMP-X-1 docs/a/b.md``\n\n~~~\nCOMP-MODEL-AB docs/a/b.md\n~~~\n'} />, makeNav());
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).toContain('COMP-MODEL-AB docs/a/b.md');
    expect(container.textContent).not.toContain('](');
    expect(container.querySelectorAll('code')).toHaveLength(3);
  });
  it('prose tokens still link and an autolinked URL is left alone', () => {
    const nav = makeNav();
    const { container } = withNav(<LinkedMarkdown content={'COMP-A-1 at https://x.test/COMP-B-2/y.md'} />, nav);
    expect([...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['#entity:feature:COMP-A-1', 'https://x.test/COMP-B-2/y.md']);
  });
});

describe('FU-1 warnings: Ideas chips and a timeline event that names an item', () => {
  it('an Ideas tag chip and a cluster chip filter the list', async () => {
    const idea = { id: 'IDEA-1', num: 1, title: 'Fix login', description: '', priority: 'P0', status: 'NEW', tags: ['auth'], cluster: 'Onboarding' };
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ideas: [idea], killed: [], clusters: [] }) })));
    useIdeaboxStore.setState({ ideas: [idea], killed: [], selectedIdeaId: null, filters: { tag: '', status: '', priority: '', search: '' } });
    render(<IdeaboxView />);
    fireEvent.click(await screen.findByTestId('idea-tag'));
    expect(useIdeaboxStore.getState().filters.tag).toBe('auth');
    useIdeaboxStore.setState({ filters: { tag: '', status: '', priority: '', search: '' }, selectedIdeaId: 'IDEA-1' });
    fireEvent.click(await screen.findByTestId('idea-cluster'));
    expect(useIdeaboxStore.getState().filters.search).toBe('Onboarding');
  });
  it('a timeline event with meta.itemId opens that item', () => {
    const onSelectItem = vi.fn();
    const nav = makeNav();
    withNav(<TimelineEvent onSelectItem={onSelectItem} event={{ category: 'build', title: 'Built', meta: { itemId: 'item-9' }, timestamp: null }} />, nav);
    fireEvent.click(screen.getByTestId('timeline-event'));
    expect(onSelectItem).toHaveBeenCalledWith('item-9');
    expect(nav.openGate).not.toHaveBeenCalled();
  });
});

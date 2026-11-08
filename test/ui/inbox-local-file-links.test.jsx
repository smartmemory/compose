/**
 * COMP-INBOX-LOCAL-FILE-LINKS-1: an absolute home-dir path in an inbox card is a link titled "open on this Mac"; a click calls
 * the navigation context's openLocalFile, and a refused open puts its reason on the link's title. The client helper posts the
 * path without its :line suffix.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', async (orig) => ({ ...(await orig()), wsFetch: vi.fn() }));
import { wsFetch } from '../../src/lib/wsFetch.js';
import InboxDrawer from '../../src/components/cockpit/notify/InboxDrawer.jsx';
import { NavigationContext } from '../../src/lib/navigation.jsx';
import EntityLink, { LinkedText } from '../../src/components/shared/EntityLink.jsx';
import { resetFleetPoller } from '../../src/lib/fleetPoller.js';
import { openLocalFile, OPEN_PATH_URL } from '../../src/lib/openLocalFile.js';

const PATH = '/Users/ruze/reg/my/SmartMemory/smart-memory-ops/units/REL-2.0-LOCAL-ACCEPT-1/report-final-sdk-e2e.md';
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
const fleetWith = (queue) => ({
  generated: new Date().toISOString(),
  sources: { sm_status: { value: { sessions: { value: [], error: null }, jobs: { value: [], error: null }, queue: { value: queue, error: null } }, error: null, ts: 1, stale: false } },
});

beforeEach(() => {
  wsFetch.mockReset(); resetFleetPoller();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('inbox card: a home-dir path opens on the Mac', () => {
  it('the owner card renders the report path as one link; a click opens it; a refusal becomes the title', async () => {
    wsFetch.mockImplementation(async (url) => (String(url).startsWith('/api/fleet') ? ok(fleetWith([{ id: 'Q1', by: 'forge-main', text: `ASK: card 1 of 5, ok?\nReport: ${PATH}`, age: 60 }])) : ok({})));
    const nav = { openLocalFile: vi.fn(async () => ({ status: 'rejected', reason: 'no such file or folder' })), canNavigate: () => true };
    render(<NavigationContext.Provider value={nav}><InboxDrawer /></NavigationContext.Provider>);
    await act(async () => { window.dispatchEvent(new CustomEvent('compose:open-inbox', { cancelable: true })); });
    fireEvent.click(await screen.findByTestId('inbox-row-toggle'));
    const link = await screen.findByRole('button', { name: PATH });
    expect(link.getAttribute('title')).toBe('open on this Mac');
    fireEvent.click(link);
    expect(nav.openLocalFile).toHaveBeenCalledWith(PATH);
    await waitFor(() => expect(link.getAttribute('title')).toBe('not opened: no such file or folder'));
    expect(screen.getByTestId('inbox-full').textContent).toContain(`Report: ${PATH}`);
  });
  it('degrade: with no openLocalFile in the context the path is plain text', () => {
    const { container } = render(<NavigationContext.Provider value={{ openFile: vi.fn(), canNavigate: () => true }}><LinkedText text={`see ${PATH}`} /></NavigationContext.Provider>);
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toBe(`see ${PATH}`);
  });
  it('an accepted open keeps the default title', async () => {
    const nav = { openLocalFile: vi.fn(async () => ({ status: 'accepted', path: PATH })) };
    render(<NavigationContext.Provider value={nav}><EntityLink kind="localfile" id={`${PATH}:12`} /></NavigationContext.Provider>);
    fireEvent.click(screen.getByRole('button'));
    await act(async () => { await Promise.resolve(); });
    expect(nav.openLocalFile).toHaveBeenCalledWith(`${PATH}:12`);
    expect(screen.getByRole('button').getAttribute('title')).toBe('open on this Mac');
  });
  it('a traversal id is text with a reason, never a button', () => {
    const nav = { openLocalFile: vi.fn() };
    render(<NavigationContext.Provider value={nav}><EntityLink kind="localfile" id="/Users/a/../etc/passwd" /></NavigationContext.Provider>);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('/Users/a/../etc/passwd').getAttribute('title')).toMatch(/not a path under a home folder/);
  });
});

describe('openLocalFile (client helper)', () => {
  it('POSTs {path} without the :line suffix and returns the reply', async () => {
    const fetcher = vi.fn(async () => ok({ status: 'accepted', path: PATH }));
    expect(await openLocalFile(`${PATH}:40`, { fetcher })).toEqual({ status: 'accepted', path: PATH });
    expect(fetcher.mock.calls[0][0]).toBe(OPEN_PATH_URL);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ path: PATH });
    expect(fetcher.mock.calls[0][1].method).toBe('POST');
  });
  it('an HTTP error or a thrown fetch is a rejected reply', async () => {
    expect(await openLocalFile(PATH, { fetcher: async () => ({ ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) }) })).toEqual({ status: 'rejected', reason: 'Unauthorized' });
    expect((await openLocalFile(PATH, { fetcher: async () => { throw new Error('down'); } })).status).toBe('rejected');
  });
});

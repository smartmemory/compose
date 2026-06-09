/**
 * COMP-COCKPIT-9: JournalView — journal & changelog cockpit surface.
 * Self-fetching view: source toggle (journal/changelog), feature filter,
 * structured-section rendering through MarkdownViewer, inline write form
 * that POSTs /api/journal and refreshes, EntityLink degradation without
 * a NavigationContext provider.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import JournalView from '../../src/components/vision/JournalView.jsx';
import { NavigationContext } from '../../src/lib/navigation.jsx';
import { setSensitiveToken } from '../../src/lib/compose-api.js';

vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: '<svg></svg>' }) },
}));

const journalEntries = [
  {
    date: '2026-06-09',
    session_number: 7,
    slug: 'big-session',
    path: 'docs/journal/2026-06-09-session-7-big-session.md',
    summary: 'A big session',
    feature_code: 'FEAT-9',
    sections: {
      what_happened: 'We did the thing.',
      what_we_built: 'A surface.',
      what_we_learned: 'Lessons abound.',
      open_threads: '- [ ] follow up',
    },
    closing_line: 'Onward.',
  },
];

const changelogEntries = [
  {
    date_or_version: '2026-06-08',
    code: 'CL-1',
    summary: 'Changelog thing',
    body: 'Body of the changelog entry.',
    line_number: 5,
  },
];

describe('JournalView (COCKPIT-9)', () => {
  let fetchCalls;
  let postResponse;
  let notifications;
  const onNotify = (e) => notifications.push(e.detail);

  beforeEach(() => {
    setSensitiveToken('test-token');
    fetchCalls = [];
    notifications = [];
    postResponse = { status: 200, body: { path: 'docs/journal/x.md' } };
    window.addEventListener('compose:notify', onNotify);
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
      const u = String(url);
      fetchCalls.push({ url: u, opts });
      if (opts.method === 'POST') {
        return new Response(JSON.stringify(postResponse.body), { status: postResponse.status });
      }
      if (u.startsWith('/api/changelog')) {
        return new Response(JSON.stringify({ entries: changelogEntries, count: changelogEntries.length }), { status: 200 });
      }
      return new Response(JSON.stringify({ entries: journalEntries, count: journalEntries.length }), { status: 200 });
    });
  });

  afterEach(() => {
    window.removeEventListener('compose:notify', onNotify);
    vi.restoreAllMocks();
  });

  it('fetches /api/journal on mount and renders structured sections', async () => {
    render(<JournalView />);
    await waitFor(() => expect(screen.getByText('A big session')).toBeTruthy());
    expect(fetchCalls[0].url).toMatch(/^\/api\/journal/);
    // labeled section blocks
    expect(screen.getByText('What happened')).toBeTruthy();
    expect(screen.getByText('What we built')).toBeTruthy();
    expect(screen.getByText('What we learned')).toBeTruthy();
    expect(screen.getByText('Open threads')).toBeTruthy();
    // section content rendered (through MarkdownViewer)
    expect(screen.getByText('We did the thing.')).toBeTruthy();
  });

  it('toggle switches source to /api/changelog', async () => {
    render(<JournalView />);
    await waitFor(() => expect(screen.getByText('A big session')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'changelog' }));
    await waitFor(() => expect(screen.getByText('Changelog thing')).toBeTruthy());
    expect(fetchCalls.some(c => c.url.startsWith('/api/changelog'))).toBe(true);
  });

  it('feature filter is passed as ?feature=', async () => {
    render(<JournalView />);
    await waitFor(() => expect(screen.getByText('A big session')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Feature filter'), { target: { value: 'FEAT-9' } });
    await waitFor(() =>
      expect(fetchCalls.some(c => c.url.includes('feature=FEAT-9'))).toBe(true)
    );
  });

  it('renders feature codes as plain text without a NavigationContext provider', async () => {
    render(<JournalView />);
    await waitFor(() => expect(screen.getByText('FEAT-9')).toBeTruthy());
    // EntityLink degrades to a span (not a button) without provider
    expect(screen.getByText('FEAT-9').tagName).toBe('SPAN');
  });

  it('renders feature codes as EntityLink buttons that navigate with a provider', async () => {
    const openFeature = vi.fn();
    render(
      <NavigationContext.Provider value={{ openFeature }}>
        <JournalView />
      </NavigationContext.Provider>
    );
    await waitFor(() => expect(screen.getByText('FEAT-9')).toBeTruthy());
    const link = screen.getByText('FEAT-9');
    expect(link.tagName).toBe('BUTTON');
    fireEvent.click(link);
    expect(openFeature).toHaveBeenCalledWith('FEAT-9');
  });

  it('write form POSTs with token, notifies success, and refreshes the list', async () => {
    render(<JournalView />);
    await waitFor(() => expect(screen.getByText('A big session')).toBeTruthy());
    const fetchCountBefore = fetchCalls.length;

    fireEvent.click(screen.getByRole('button', { name: /new entry/i }));
    fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'Fresh entry' } });
    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'h' } });
    fireEvent.change(screen.getByLabelText('What we built'), { target: { value: 'b' } });
    fireEvent.change(screen.getByLabelText('What we learned'), { target: { value: 'l' } });
    fireEvent.change(screen.getByLabelText('Open threads'), { target: { value: 't' } });
    fireEvent.click(screen.getByRole('button', { name: /write entry/i }));

    await waitFor(() => expect(notifications.length).toBeGreaterThan(0));
    expect(notifications[0].message).toMatch(/journal entry written/i);
    expect(notifications[0].level).toBe('info');

    const post = fetchCalls.find(c => c.opts.method === 'POST');
    expect(post).toBeTruthy();
    expect(post.url).toBe('/api/journal');
    expect(post.opts.headers['x-compose-token']).toBe('test-token');
    const body = JSON.parse(post.opts.body);
    expect(body.summary).toBe('Fresh entry');
    expect(body.sections.what_happened).toBe('h');
    expect(body.sections.open_threads).toBe('t');
    expect(body.feature_code).toBeUndefined(); // no code entered → omitted

    // refresh happened: a GET after the POST
    await waitFor(() => {
      const after = fetchCalls.slice(fetchCountBefore);
      expect(after.some(c => !c.opts.method && c.url.startsWith('/api/journal'))).toBe(true);
    });
  });

  it('write form sends feature_code, seeded from the active filter', async () => {
    render(<JournalView />);
    await waitFor(() => expect(screen.getByText('A big session')).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/filter by feature code/i), { target: { value: 'FEAT-9' } });
    fireEvent.click(screen.getByRole('button', { name: /new entry/i }));
    // Seeded from the filter, still editable.
    expect(screen.getByLabelText('Feature code').value).toBe('FEAT-9');

    fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'Scoped entry' } });
    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'h' } });
    fireEvent.change(screen.getByLabelText('What we built'), { target: { value: 'b' } });
    fireEvent.change(screen.getByLabelText('What we learned'), { target: { value: 'l' } });
    fireEvent.change(screen.getByLabelText('Open threads'), { target: { value: 't' } });
    fireEvent.click(screen.getByRole('button', { name: /write entry/i }));

    await waitFor(() => {
      const post = fetchCalls.find(c => c.opts.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(post.opts.body).feature_code).toBe('FEAT-9');
    });
  });

  it('write failure notifies error and keeps the form open', async () => {
    postResponse = { status: 400, body: { error: 'summary is required' } };
    render(<JournalView />);
    await waitFor(() => expect(screen.getByText('A big session')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /new entry/i }));
    fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'h' } });
    fireEvent.change(screen.getByLabelText('What we built'), { target: { value: 'b' } });
    fireEvent.change(screen.getByLabelText('What we learned'), { target: { value: 'l' } });
    fireEvent.change(screen.getByLabelText('Open threads'), { target: { value: 't' } });
    fireEvent.click(screen.getByRole('button', { name: /write entry/i }));

    await waitFor(() => expect(notifications.length).toBeGreaterThan(0));
    expect(notifications[0].level).toBe('error');
    expect(notifications[0].message).toMatch(/summary is required/i);
    expect(screen.getByTestId('journal-write-form')).toBeTruthy();
  });
});

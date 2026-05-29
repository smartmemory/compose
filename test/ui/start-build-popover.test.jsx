import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import StartBuildPopover from '../../src/components/vision/StartBuildPopover.jsx';
import { setSensitiveToken } from '../../src/lib/compose-api.js';

let fetchCalls = [];
let startResponse = { status: 200, body: { started: true } };

function mockFetch() {
  fetchCalls = [];
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), opts });
    if (String(url).includes('/api/build/start')) {
      return new Response(JSON.stringify(startResponse.body), { status: startResponse.status });
    }
    return new Response('{}', { status: 200 });
  });
}

describe('<StartBuildPopover>', () => {
  beforeEach(() => {
    setSensitiveToken('test-token');
    startResponse = { status: 200, body: { started: true } };
    mockFetch();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('prefills the feature code from the item and POSTs /api/build/start with the token', async () => {
    const onClose = vi.fn();
    render(<StartBuildPopover item={{ id: 'ui-uuid-1', title: 'A UI item', featureCode: 'FOO-1' }} onClose={onClose} />);

    const input = screen.getByTestId('start-build-feature-input');
    expect(input.value).toBe('FOO-1');

    fireEvent.click(screen.getByTestId('start-build-submit'));

    await waitFor(() => expect(fetchCalls.some(c => c.url.includes('/api/build/start'))).toBe(true));
    const call = fetchCalls.find(c => c.url.includes('/api/build/start'));
    expect(call.opts.method).toBe('POST');
    expect(call.opts.headers['x-compose-token']).toBe('test-token');
    expect(JSON.parse(call.opts.body)).toEqual({ featureCode: 'FOO-1', mode: 'feature', description: '' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('falls back to the item id when there is no featureCode, and submits bug mode', async () => {
    const onClose = vi.fn();
    render(<StartBuildPopover item={{ id: 'ui-uuid-2', title: 'no code' }} onClose={onClose} />);

    expect(screen.getByTestId('start-build-feature-input').value).toBe('ui-uuid-2');
    fireEvent.click(screen.getByTestId('start-build-mode-bug'));
    fireEvent.change(screen.getByTestId('start-build-description'), { target: { value: 'crashes on save' } });
    fireEvent.click(screen.getByTestId('start-build-submit'));

    await waitFor(() => expect(fetchCalls.some(c => c.url.includes('/api/build/start'))).toBe(true));
    const call = fetchCalls.find(c => c.url.includes('/api/build/start'));
    expect(JSON.parse(call.opts.body)).toEqual({ featureCode: 'ui-uuid-2', mode: 'bug', description: 'crashes on save' });
  });

  it('defaults mode to bug for a type:bug item', async () => {
    render(<StartBuildPopover item={{ id: 'b-1', title: 'A bug', type: 'bug', featureCode: 'BUG-7' }} onClose={vi.fn()} />);
    expect(screen.getByTestId('start-build-mode-bug').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('start-build-submit'));
    await waitFor(() => expect(fetchCalls.some(c => c.url.includes('/api/build/start'))).toBe(true));
    expect(JSON.parse(fetchCalls.find(c => c.url.includes('/api/build/start')).opts.body).mode).toBe('bug');
  });

  it('surfaces a server error (409) and does not close', async () => {
    startResponse = { status: 409, body: { error: 'A build is already active for ui-uuid-1' } };
    const onClose = vi.fn();
    render(<StartBuildPopover item={{ id: 'ui-uuid-1', featureCode: 'FOO-1' }} onClose={onClose} />);

    fireEvent.click(screen.getByTestId('start-build-submit'));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/already active/i));
    expect(onClose).not.toHaveBeenCalled();
  });
});

/**
 * wsFetch.test.js — unit tests for the workspace-aware fetch wrapper.
 *
 * COMP-WORKSPACE-HTTP T1:
 *   - Relative URL with id set → header injected
 *   - Absolute URL with id set → header injected
 *   - No id set → header absent
 *   - User-passed opts.headers preserved (spread, not clobbered)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setWorkspaceId, getWorkspaceId, wsFetch } from './wsFetch.js';

describe('wsFetch', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchMock;
    setWorkspaceId(null);
  });

  it('exports setWorkspaceId / getWorkspaceId that round-trip', () => {
    setWorkspaceId('ws-abc');
    expect(getWorkspaceId()).toBe('ws-abc');
    setWorkspaceId(null);
    expect(getWorkspaceId()).toBe(null);
  });

  it('injects X-Compose-Workspace-Id header on relative URL when id is set', async () => {
    setWorkspaceId('ws-abc');
    await wsFetch('/api/foo');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/foo');
    expect(opts.headers['X-Compose-Workspace-Id']).toBe('ws-abc');
  });

  it('injects X-Compose-Workspace-Id header on absolute URL when id is set', async () => {
    setWorkspaceId('ws-xyz');
    await wsFetch('http://localhost:4001/api/bar');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:4001/api/bar');
    expect(opts.headers['X-Compose-Workspace-Id']).toBe('ws-xyz');
  });

  it('omits X-Compose-Workspace-Id header when no id is set', async () => {
    await wsFetch('/api/foo');
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['X-Compose-Workspace-Id']).toBeUndefined();
  });

  it('preserves user-passed opts.headers via spread (not clobbered)', async () => {
    setWorkspaceId('ws-abc');
    await wsFetch('/api/foo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Custom': 'keep-me' },
      body: '{}',
    });
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.method).toBe('POST');
    expect(opts.body).toBe('{}');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.headers['X-Custom']).toBe('keep-me');
    expect(opts.headers['X-Compose-Workspace-Id']).toBe('ws-abc');
  });
});

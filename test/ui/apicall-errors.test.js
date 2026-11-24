/**
 * COMP-APICALL-ERRORS-1: a failed server call through the vision store's apiCall
 * must show a toast (compose:notify, level error), return {error}, and never throw.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useVisionStore } from '../../src/components/vision/useVisionStore.js';

let toasts;
const onNotify = (e) => toasts.push(e.detail);
const reply = (status, body) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

beforeEach(() => { toasts = []; window.addEventListener('compose:notify', onNotify); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { window.removeEventListener('compose:notify', onNotify); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('apiCall failure surfacing', () => {
  it('HTTP 500 on createItem: toast with server error, returns {error}', async () => {
    vi.stubGlobal('fetch', reply(500, { error: 'boom' }));
    const r = await useVisionStore.getState().createItem({ type: 'task', title: 'x' });
    expect(r.error).toBe('boom');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].level).toBe('error');
    expect(toasts[0].message).toContain('boom');
  });

  it('stopped server (fetch rejects) on deleteItem: toast, returns {error}, no throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const r = await useVisionStore.getState().deleteItem('abc');
    expect(r.error).toContain('Failed to fetch');
    expect(toasts.map(t => t.level)).toEqual(['error']);
  });

  it('resolveGate on a 409 expired gate: toast + {error}', async () => {
    vi.stubGlobal('fetch', reply(409, { error: 'gate expired' }));
    const r = await useVisionStore.getState().resolveGate('g1', 'approved');
    expect(r.error).toBe('gate expired');
    expect(toasts[0].message).toContain('gate expired');
  });

  it('non-JSON error body falls back to HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 502 })));
    const r = await useVisionStore.getState().updateSettings({});
    expect(r.error).toBe('HTTP 502');
    expect(toasts).toHaveLength(1);
  });

  it('saveAsTemplate failure is silent (caller shows it inline) but still returns {error}', async () => {
    vi.stubGlobal('fetch', reply(409, { error: 'id collision' }));
    useVisionStore.setState({ editorModel: { version: '0.2' }, editorErrors: { errors: [] }, editorYamlPending: false });
    const r = await useVisionStore.getState().saveAsTemplate({ filename: 'a.stratum.yaml', metadata: { id: 'a' } });
    expect(r.error).toBe('id collision');
    expect(toasts).toHaveLength(0);
  });

  it('success path unchanged: no toast, data returned', async () => {
    vi.stubGlobal('fetch', reply(200, { ok: true, id: 'n1' }));
    const r = await useVisionStore.getState().createItem({ type: 'task', title: 'x' });
    expect(r.id).toBe('n1');
    expect(toasts).toHaveLength(0);
  });
});

/**
 * usageClient.js — the Usage view's DataClient (COMP-OBS-STATS-1).
 *
 * UsageView never fetches: it calls `client.getStats(...)`. This default client
 * goes through wsFetch so the workspace header and auth match every other /api
 * call; tests inject a fake client instead.
 */
import { wsFetch } from '../../lib/wsFetch.js';

export const defaultUsageClient = {
  async getStats({ from, to, compare } = {}) {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (compare) params.set('compare', '1');
    const res = await wsFetch(`/api/usage/stats?${params}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `usage stats failed (${res.status})`);
    return body;
  },
};

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
  /** COMP-COCKPIT-PROCESS-DATA-1: per-seat quota rows, `{v, generated_at, seats: {value, error, ts, stale}}`. */
  async getSeats() {
    const res = await wsFetch('/api/usage/seats');
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `usage seats failed (${res.status})`);
    return body;
  },
  /** COMP-COCKPIT-RIBBON-METER-1: the one API-credit reader, `{v, generated_at, credit: {value, error, ts, stale}}`. */
  async getCredit() {
    const res = await wsFetch('/api/usage/credit');
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `usage credit failed (${res.status})`);
    return body;
  },
  /** Today's closed hours of fleet spend, `{v, generated_at, hourly: {value: {buckets: [{start, usd}]}, error}}`. */
  async getHourly() {
    const res = await wsFetch('/api/usage/hourly');
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `usage hourly failed (${res.status})`);
    return body;
  },
};

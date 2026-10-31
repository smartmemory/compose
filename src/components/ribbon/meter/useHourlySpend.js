/**
 * useHourlySpend — the Day page's one client of `GET /api/usage/hourly` (today's closed hours of fleet spend). Returns
 * `{value, error}` for the money card, or null until the first answer. The server caches for 5 minutes and the first
 * run can be slow, so this polls at the same pace and never blocks the meter.
 */
import { useEffect, useState } from 'react';
import { defaultUsageClient } from '../../usage/usageClient.js';

export const HOURLY_POLL_MS = 300_000;

export default function useHourlySpend(client = defaultUsageClient) {
  const [hourly, setHourly] = useState(null);
  useEffect(() => {
    if (typeof client?.getHourly !== 'function') return undefined;
    let live = true;
    const load = () => client.getHourly()
      .then((body) => { if (live) setHourly({ value: body?.hourly?.value ?? null, error: body?.hourly?.error ?? null }); })
      .catch((err) => { if (live) setHourly({ value: null, error: err.message || String(err) }); });
    load();
    const timer = setInterval(load, HOURLY_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [client]);
  return hourly;
}

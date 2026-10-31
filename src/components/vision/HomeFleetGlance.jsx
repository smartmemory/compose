import React, { useCallback, useEffect, useState } from 'react';
import { useFleet } from '../../lib/fleetPoller.js';
import { defaultUsageClient } from '../usage/usageClient.js';
import { fleetSpend } from '../usage/FleetUsage.jsx';
import CostMeter from '../cockpit/cost/CostMeter.jsx';

export const HOME_SEATS_POLL_MS = 60_000;

/**
 * Home's fleet glance (COMP-COCKPIT-COST-METER-1): the one cost meter, compact. It replaces Cadence's `SeatStrip`
 * (raw floats, retired Max seat) so Home and Usage > Seats and fleet read the same seats through the same rounding.
 * Reads `client.getSeats()` (GET /api/usage/seats) and the shared `useFleet` poll for dollars; needs no Cadence package.
 */
export default function HomeFleetGlance({ client = defaultUsageClient }) {
  const fleet = useFleet();
  const [seats, setSeats] = useState({ loading: true, body: null, error: null });
  const load = useCallback(() => {
    let live = true;
    client.getSeats()
      .then((body) => { if (live) setSeats({ loading: false, body, error: null }); })
      .catch((err) => { if (live) setSeats({ loading: false, body: null, error: err.message || String(err) }); });
    return () => { live = false; };
  }, [client]);
  useEffect(() => {
    let stop = load();
    const timer = setInterval(() => { stop(); stop = load(); }, HOME_SEATS_POLL_MS);
    return () => { clearInterval(timer); stop(); };
  }, [load]);

  const src = seats.body?.seats;
  const rows = Array.isArray(src?.value?.seats) ? src.value.seats : null;
  const { ceiling, spend } = fleetSpend(fleet.data);
  return (
    <CostMeter
      compact
      seats={rows}
      seatsError={seats.error || src?.error || null}
      loading={seats.loading}
      spend={fleet.loading && !fleet.data ? null : { ceiling, spend }}
      asOf={src?.value?.generated_at ?? null}
    />
  );
}

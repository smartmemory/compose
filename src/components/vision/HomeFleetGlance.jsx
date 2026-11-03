import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useFleet } from '../../lib/fleetPoller.js';
import { defaultUsageClient } from '../usage/usageClient.js';
import { fleetSpend, useSeatsTick } from '../usage/FleetUsage.jsx';
import SourceNote from '../cockpit/SourceNote.jsx';
import CostMeter from '../cockpit/cost/CostMeter.jsx';
import useApiCredit from '../cockpit/cost/useApiCredit.js';

export const HOME_SEATS_POLL_MS = 60_000;

/**
 * The seats read the cost meter takes (COMP-COCKPIT-COST-METER-1; shared with Day by COMP-COCKPIT-RIBBON-TOP-1 so the two
 * pages never hold two copies): `client.getSeats()` (GET /api/usage/seats) every 60 s and the shared `useFleet` poll for
 * dollars. Returns the exact `CostMeter` props.
 */
export function useCostMeterProps(client = defaultUsageClient) {
  const fleet = useFleet();
  const [seats, setSeats] = useState({ loading: true, body: null, error: null });
  const load = useCallback(() => {
    let live = true;
    client.getSeats()
      .then((body) => { if (live) setSeats({ loading: false, body, error: null }); })
      .catch((err) => { if (live) setSeats({ loading: false, body: null, error: err.message || String(err) }); });
    return () => { live = false; };
  }, [client]);
  const stopRef = useRef(() => {});
  const reload = useCallback(() => { stopRef.current(); stopRef.current = load(); }, [load]);
  useEffect(() => {
    reload();
    return () => stopRef.current();
  }, [reload]);
  useSeatsTick(reload, fleet); // the shared fleet poll's ticks (paused while hidden); see FleetUsage.jsx

  const credit = useApiCredit(client);
  const src = seats.body?.seats;
  const rows = Array.isArray(src?.value?.seats) ? src.value.seats : null;
  const { ceiling, spend } = fleetSpend(fleet.data);
  return {
    seats: rows,
    seatsError: seats.error || src?.error || null,
    loading: seats.loading,
    spend: fleet.loading && !fleet.data ? null : { ceiling, spend },
    asOf: src?.value?.generated_at ?? null,
    credit,
    fleetState: fleet, // not a CostMeter prop: the glance shows the shared stale/unreadable note from it
  };
}

/**
 * Home's fleet glance (COMP-COCKPIT-COST-METER-1): the one cost meter, compact. It replaces Cadence's `SeatStrip`
 * (raw floats, retired Max seat) so Home and Usage > Seats and fleet read the same seats through the same rounding.
 * Needs no Cadence package.
 */
export default function HomeFleetGlance({ client = defaultUsageClient }) {
  const { fleetState, ...meter } = useCostMeterProps(client);
  return (
    <>
      <CostMeter compact {...meter} />
      <SourceNote source="Fleet" state={fleetState} />
    </>
  );
}

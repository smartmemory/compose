import React, { useMemo } from 'react';
import { DataClientProvider, SeatStrip } from '@cadence/ui';
import '@cadence/ui/styles.css';
import { createCadenceDataClient } from '../../lib/clients/cadence.js';

/**
 * Home's fleet glance (COMP-AUDIT-18): the Cadence seat strip. `SeatStrip`
 * renders only inside a DataClientProvider, so Home wraps it the same way
 * CadenceView does. Mounted only when the Cadence package is available.
 */
export default function HomeFleetGlance({ client }) {
  const dataClient = useMemo(() => client ?? createCadenceDataClient(), [client]);
  return (
    <DataClientProvider client={dataClient}>
      <SeatStrip />
    </DataClientProvider>
  );
}

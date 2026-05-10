import React from 'react';

const KNOWN = new Set([
  'planned',
  'in_progress',
  'blocked',
  'complete',
  'partial',
  'superseded',
  'parked',
]);

export default function StatusPill({ status, children }) {
  const norm = typeof status === 'string' ? status.toLowerCase() : '';
  const known = KNOWN.has(norm) ? norm : 'unknown';
  const label = children ?? (status ?? 'unknown');
  return (
    <span className="m-status-pill" data-status={known}>
      {label}
    </span>
  );
}

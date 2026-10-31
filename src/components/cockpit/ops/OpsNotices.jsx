import React from 'react';

/** One muted line under the content. The route carries only the count, so the expansion says where the list is. */
export default function OpsNotices({ count, lane }) {
  if (!count) return null;
  return (
    <details className="text-xs text-muted-foreground" data-testid="ops-notices">
      <summary className="cursor-pointer">{count} data-quality notes from the builder</summary>
      <p className="mt-1">
        The builder printed these while reading the {lane} plan. The list is on the{' '}
        <a className="underline" href={`/ops-status/${encodeURIComponent(lane)}/status.html`} target="_blank" rel="noopener noreferrer">Builder page</a>.
      </p>
    </details>
  );
}

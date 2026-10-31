import React, { useState } from 'react';
import useOpsStatusIndex from './useOpsStatusIndex.js';
import useOpsData from './ops/useOpsData.js';
import ProgressCard from './ops/ProgressCard.jsx';
import OpsDag from './ops/OpsDag.jsx';
import LandedList from './ops/LandedList.jsx';
import OpsNotices from './ops/OpsNotices.jsx';
import PaneSwitcher from './PaneSwitcher.jsx';

const KEY = 'compose:opsPage';

function Skeleton() {
  return <div className="space-y-3 animate-pulse" data-testid="ops-skeleton"><div className="h-24 rounded-md bg-muted" /><div className="h-64 rounded-md bg-muted" /></div>;
}

/** Fleet › Ops: the builder's facts rendered natively per lane (COMP-COCKPIT-INIT-VIEW-1); the static page stays one click away. */
export default function OpsView() {
  const pages = useOpsStatusIndex();
  const [page, setPage] = useState(() => {
    try { return globalThis.localStorage?.getItem(KEY) || ''; } catch { return ''; }
  });
  const current = pages.includes(page) ? page : pages[0];
  const ops = useOpsData(current);
  if (pages.length === 0) {
    return <div className="p-6 text-sm text-muted-foreground">No Ops status pages available.</div>;
  }
  const pick = (name) => {
    setPage(name);
    try { globalThis.localStorage?.setItem(KEY, name); } catch { /* ignore */ }
  };
  const nodes = ops.data?.progress?.nodes ?? [];
  return (
    <div className="flex flex-col h-full min-h-0">
      <PaneSwitcher
        panes={pages.map((n) => ({ key: n, label: n, testId: `ops-pane-${n}` }))}
        active={current}
        onChange={pick}
        label="Ops status pages"
        trailing={<a className="ml-auto text-xs underline" href={`/ops-status/${encodeURIComponent(current)}/status.html`} target="_blank" rel="noopener noreferrer">Builder page ↗</a>}
      />
      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-4">
        {ops.status === 'loading' && <Skeleton />}
        {ops.status === 'missing' && <div className="text-sm text-muted-foreground">{ops.message}. Use the Builder page link meanwhile.</div>}
        {ops.status === 'error' && <div className="text-sm text-muted-foreground">The data route failed: {ops.message}. Use the Builder page link meanwhile.</div>}
        {ops.status === 'ok' && (
          <>
            <ProgressCard data={ops.data} fetchedAt={ops.fetchedAt} />
            {nodes.length > 0 && <OpsDag nodes={nodes} lane={current} />}
            {nodes.length > 0 && <LandedList nodes={nodes} lane={current} />}
            <OpsNotices count={ops.data.notices} lane={current} />
          </>
        )}
      </div>
    </div>
  );
}

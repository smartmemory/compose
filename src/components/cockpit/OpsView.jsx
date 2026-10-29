import React, { useState } from 'react';
import useOpsStatusIndex from './useOpsStatusIndex.js';

const KEY = 'compose:opsPage';

/** Ops status pages in an iframe (COMPOSE-OPS-TAB-1). */
export default function OpsView() {
  const pages = useOpsStatusIndex();
  const [page, setPage] = useState(() => {
    try { return globalThis.localStorage?.getItem(KEY) || ''; } catch { return ''; }
  });
  if (pages.length === 0) {
    return <div className="p-6 text-sm text-muted-foreground">No Ops status pages available.</div>;
  }
  const current = pages.includes(page) ? page : pages[0];
  const pick = (name) => {
    setPage(name);
    try { globalThis.localStorage?.setItem(KEY, name); } catch { /* ignore */ }
  };
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex gap-1 p-2 border-b" role="tablist" aria-label="Ops status pages">
        {pages.map((n) => (
          <button
            key={n}
            role="tab"
            aria-selected={n === current}
            onClick={() => pick(n)}
            className={`px-2 py-1 text-xs rounded ${n === current ? 'bg-accent font-medium' : 'opacity-70 hover:opacity-100'}`}
          >
            {n}
          </button>
        ))}
      </div>
      <iframe
        key={current}
        title={`Ops status: ${current}`}
        src={`/ops-status/${encodeURIComponent(current)}/status.html`}
        className="flex-1 min-h-0 w-full border-0"
      />
    </div>
  );
}

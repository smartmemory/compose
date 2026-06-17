/**
 * QaScopeView — QA Scope cockpit view (COMP-PARITY-10).
 *
 * Surfaces `compose qa-scope <CODE>` (COMP-QA diff-to-route mapping) for the
 * active feature: changed files → affected / adjacent routes + unmapped files.
 * Backed by GET /api/qa-scope?featureCode=…; read-only, degrades, never throws.
 *
 * Props:
 *   featureCode {string|null}  the active feature code (from CockpitView)
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { wsFetch } from '../../lib/wsFetch.js';

function RouteList({ testid, label, routes, empty }) {
  return (
    <div className="mt-3 first:mt-0" data-testid={testid}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
        {label} ({routes.length})
      </div>
      {routes.length === 0 ? (
        <div className="text-[11px] text-muted-foreground italic">{empty}</div>
      ) : (
        <ul className="text-[12px] font-mono space-y-0.5">
          {routes.map(r => <li key={r}>{r}</li>)}
        </ul>
      )}
    </div>
  );
}

export default function QaScopeView({ featureCode }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const reqIdRef = useRef(0);

  const fetchScope = useCallback(async () => {
    if (!featureCode) return;
    // Monotonic request token: ignore any response that is not the latest
    // in-flight request, so a slow older fetch (e.g. a feature switch overlapping
    // an in-flight load) can't overwrite newer state with stale data.
    const myId = ++reqIdRef.current;
    setLoading(true);
    try {
      const r = await wsFetch(`/api/qa-scope?featureCode=${encodeURIComponent(featureCode)}`);
      const json = await r.json();
      if (myId !== reqIdRef.current) return;
      setData(json);
      setError(null);
    } catch (e) {
      if (myId !== reqIdRef.current) return;
      setData(null);
      setError(e?.message || 'unavailable');
    } finally {
      if (myId === reqIdRef.current) setLoading(false);
    }
  }, [featureCode]);

  // Clear stale scope when the active feature changes so the old payload does
  // not keep rendering under the new feature's header while its fetch is in
  // flight. Keyed on featureCode (not fetchScope) so a manual ↻ refresh does
  // not blank the panel.
  useEffect(() => { setData(null); setError(null); }, [featureCode]);

  useEffect(() => { fetchScope(); }, [fetchScope]);

  if (!featureCode) {
    return (
      <div data-testid="qa-scope-empty" className="flex-1 flex items-center justify-center text-[12px] text-muted-foreground italic">
        Select a feature to see its QA scope.
      </div>
    );
  }

  return (
    <div data-testid="qa-scope-view" className="flex-1 overflow-auto p-4 text-foreground">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold">QA Scope · <span className="font-mono">{featureCode}</span></h2>
        <button
          data-testid="qa-scope-refresh"
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          onClick={fetchScope}
          disabled={loading}
          title="Refresh"
        >↻</button>
      </div>

      {error && <div data-testid="qa-scope-error" className="text-destructive text-[12px]">Unavailable: {error}</div>}
      {!data && !error && (
        <div className="text-muted-foreground text-[12px]">{loading ? 'Analyzing…' : 'No data'}</div>
      )}

      {data && data.found === false && (
        <div data-testid="qa-scope-not-found" className="text-muted-foreground text-[12px]">
          No feature found for <span className="font-mono">{featureCode}</span>.
        </div>
      )}

      {data && data.found && data.error && (
        <div data-testid="qa-scope-degraded" className="text-destructive text-[12px]">
          QA scope failed: {data.error}
        </div>
      )}

      {data && data.found && !data.error && data.emptyDiff && (
        <div data-testid="qa-scope-empty-diff" className="text-muted-foreground text-[12px]">
          No filesChanged recorded for {featureCode}. Run a build first so the pipeline tracks touched files.
        </div>
      )}

      {data && data.found && !data.error && !data.emptyDiff && (
        <>
          <div className="text-[11px] text-muted-foreground mb-2">
            Framework: <span className="font-mono">{data.framework}</span>
            {data.docsOnly ? ' · docs-only' : ''}
          </div>
          <RouteList testid="qa-scope-affected" label="Affected routes" routes={data.affected || []} empty="(none — no code files mapped to known routes)" />
          <RouteList testid="qa-scope-adjacent" label="Adjacent routes" routes={data.adjacent || []} empty="(none)" />
          <RouteList testid="qa-scope-unmapped" label="Unmapped files" routes={data.unmappedFiles || []} empty="(none)" />
        </>
      )}
    </div>
  );
}

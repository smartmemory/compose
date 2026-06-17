import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { wsFetch } from '../../lib/wsFetch.js';
import EmptyState from './shared/EmptyState.jsx';

const SEV_COLOR = {
  error:   'hsl(var(--destructive))',
  warning: 'hsl(var(--warning))',
  info:    'hsl(var(--muted-foreground))',
};
const SEV_ORDER = ['error', 'warning', 'info'];

/**
 * ValidateView — read-only `compose validate` findings surface (COMP-PARITY-6).
 *
 * Fetches GET /api/validate for the current scope (project by default; feature
 * when a feature is focused), groups findings by severity. Mirrors the
 * EnvironmentHealthPanel fetch pattern: monotonic request token, manual refresh,
 * degrades — never throws.
 *
 * Props:
 *   featureCode — active feature code (enables feature-scope toggle); from App.
 */
export default function ValidateView({ featureCode }) {
  const [scope, setScope] = useState('project');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const reqIdRef = useRef(0);

  // A feature-scope request needs a code; fall back to project if none.
  const effectiveScope = scope === 'feature' && featureCode ? 'feature' : 'project';

  const fetchFindings = useCallback(async () => {
    const myId = ++reqIdRef.current;
    setLoading(true);
    try {
      const qs = effectiveScope === 'feature'
        ? `?scope=feature&featureCode=${encodeURIComponent(featureCode)}`
        : '?scope=project';
      const r = await wsFetch(`/api/validate${qs}`);
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
  }, [effectiveScope, featureCode]);

  useEffect(() => { fetchFindings(); }, [fetchFindings]);

  const findings = Array.isArray(data?.findings) ? data.findings : [];
  const grouped = SEV_ORDER.map((sev) => [sev, findings.filter((f) => f.severity === sev)]);

  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="validate-view">
      {/* Toolbar: scope toggle + counts + refresh */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-border shrink-0">
        <select
          data-testid="validate-scope"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className="text-xs px-1.5 py-0.5 h-6 rounded bg-muted text-foreground border border-border cursor-pointer"
        >
          <option value="project">Project</option>
          <option value="feature" disabled={!featureCode}>
            {featureCode ? `Feature: ${featureCode}` : 'Feature (none focused)'}
          </option>
        </select>
        {SEV_ORDER.map((sev) => (
          <span key={sev} className="flex items-center gap-1 text-[10px]">
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: SEV_COLOR[sev], display: 'inline-block' }} />
            <span className="text-muted-foreground">{data?.bySeverity?.[sev] ?? 0} {sev}</span>
          </span>
        ))}
        <button
          data-testid="validate-refresh"
          className="ml-auto text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          onClick={fetchFindings}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh validation findings"
        >
          ↻
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto">
        {error && <div className="px-3 py-2 text-destructive text-xs">Unavailable: {error}</div>}
        {data?.unavailable && !error && (
          <div className="px-3 py-2 text-muted-foreground text-xs">Validation unavailable{data.error ? `: ${data.error}` : ''}</div>
        )}
        {!error && !data?.unavailable && findings.length === 0 && (
          <EmptyState
            icon={ShieldCheck}
            title={loading ? 'Validating…' : 'No findings'}
            description="Cross-artifact validation found no issues for this scope"
            className="py-8"
          />
        )}
        {grouped.map(([sev, rows]) => rows.length > 0 && (
          <div key={sev} data-testid={`validate-group-${sev}`}>
            <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sticky top-0 bg-background">
              {sev} ({rows.length})
            </div>
            {rows.map((f, i) => (
              <div
                key={`${sev}-${i}`}
                data-testid={`validate-finding-${sev}`}
                className="flex items-start gap-2 px-3 py-2 border-b border-border/50 hover:bg-muted/30 transition-colors"
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: SEV_COLOR[sev], display: 'inline-block', marginTop: 4, flexShrink: 0 }} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-mono text-foreground">{f.kind}</span>
                    {f.feature_code && (
                      <span className="text-[10px] font-mono text-blue-400">{f.feature_code}</span>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">{f.detail}</p>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

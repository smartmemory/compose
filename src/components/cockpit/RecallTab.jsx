/**
 * RecallTab — ranked prior-context lookup from SmartMemory (COMP-SMARTMEMORY-RECALL S03).
 *
 * Fetch-on-open, no streaming: mirrors ContextFilesTab's useEffect([featureCode])
 * + AbortController pattern. States: loading skeleton → ranked list → empty
 * ("no prior context") → unreachable ("SmartMemory unreachable").
 *
 * Props:
 *   featureCode {string}       canonical feature code to query recall for
 *   workspaceId {string|null}  current workspace identity; included in the
 *     fetch effect's deps so an in-app workspace switch (same featureCode)
 *     refetches instead of leaving the previous workspace's stale hits/
 *     project-badge context on screen
 */
import React, { useEffect, useState } from 'react';
import { Brain } from 'lucide-react';
import { wsFetch } from '../../lib/wsFetch.js';

function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export default function RecallTab({ featureCode, workspaceId = null }) {
  const [state, setState] = useState('loading'); // 'loading' | 'unreachable' | 'results'
  const [results, setResults] = useState([]);
  const [currentProject, setCurrentProject] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');

    wsFetch(`/api/smartmemory/recall?featureCode=${encodeURIComponent(featureCode)}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => {
        if (controller.signal.aborted) return;
        if (data?.available === false) {
          setState('unreachable');
          return;
        }
        setResults(data?.results || []);
        setCurrentProject(data?.project ?? null);
        setState('results');
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setState('unreachable');
      });

    return () => controller.abort();
  }, [featureCode, workspaceId]);

  if (state === 'loading') {
    return (
      <div data-testid="recall-loading" className="p-3 text-[11px] text-muted-foreground italic">
        Loading recall...
      </div>
    );
  }

  if (state === 'unreachable') {
    return (
      <div data-testid="recall-unreachable" className="p-3 flex flex-col items-center gap-2 text-muted-foreground">
        <Brain style={{ width: 20, height: 20, opacity: 0.5 }} />
        <span className="text-[11px] italic">SmartMemory unreachable</span>
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div data-testid="recall-empty" className="p-3 flex flex-col items-center gap-2 text-muted-foreground">
        <Brain style={{ width: 20, height: 20, opacity: 0.5 }} />
        <span className="text-[11px] italic">No prior context.</span>
      </div>
    );
  }

  return (
    <div className="p-2 space-y-1">
      {results.map((row) => {
        const scorePct = typeof row.score === 'number' ? Math.max(0, Math.min(100, Math.round(row.score * 100))) : null;
        const showProjectBadge = row.project && row.project !== currentProject;
        return (
          <div
            key={row.id}
            data-testid={`recall-row-${row.id}`}
            className="p-2 rounded"
            style={{ border: '1px solid hsl(var(--border))' }}
          >
            <p className="text-xs text-foreground">{row.snippet}</p>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {scorePct != null && (
                <div
                  data-testid={`recall-score-${row.id}`}
                  title={`score ${row.score}`}
                  style={{ width: 40, height: 4, borderRadius: 2, background: 'hsl(var(--muted))', overflow: 'hidden' }}
                >
                  <div style={{ width: `${scorePct}%`, height: '100%', background: 'hsl(var(--accent))' }} />
                </div>
              )}
              {row.memoryType && (
                <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
                  {row.memoryType}
                </span>
              )}
              {row.ts && (
                <span className="text-[9px] text-muted-foreground">{relativeTime(row.ts)}</span>
              )}
              {showProjectBadge && (
                <span
                  data-testid={`recall-project-${row.id}`}
                  className="text-[9px] px-1 rounded"
                  style={{ background: 'hsl(var(--accent) / 0.15)', color: 'hsl(var(--accent))' }}
                >
                  {row.project}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

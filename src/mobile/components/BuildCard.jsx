import React, { useCallback, useState } from 'react';

function formatRelative(ts) {
  if (!ts) return '';
  const t = typeof ts === 'string' ? Date.parse(ts) : Number(ts);
  if (!t || Number.isNaN(t)) return '';
  const ms = Date.now() - t;
  if (ms < 5_000) return 'just now';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}

function tailLines(active, n = 3) {
  if (!active) return [];
  if (Array.isArray(active.logTail)) return active.logTail.slice(-n);
  if (Array.isArray(active.recentLogs)) return active.recentLogs.slice(-n);
  if (Array.isArray(active.steps)) {
    return active.steps.slice(-n).map(s => `${s.id || s.name || ''}: ${s.status || ''}`.trim());
  }
  return [];
}

function isTerminal(status) {
  return status === 'completed' || status === 'aborted' || status === 'failed' || status === 'done';
}

export default function BuildCard({ active, onOpen, onAbort, aborting }) {
  const [err, setErr] = useState(null);
  const featureCode = active?.featureCode || '(unknown)';
  const mode = active?.mode || 'feature';
  const status = active?.status || 'unknown';
  const startedAt = active?.startedAt || active?.started_at || null;
  const tail = tailLines(active);

  const handleAbort = useCallback(async (e) => {
    e?.stopPropagation();
    if (!active?.featureCode) return;
    setErr(null);
    try {
      await onAbort?.({ featureCode: active.featureCode });
    } catch (ex) {
      setErr(ex.message || 'Failed to abort');
    }
  }, [active, onAbort]);

  const handleOpen = useCallback(() => onOpen?.(active), [onOpen, active]);

  return (
    <div
      className="m-build-card"
      data-testid="mobile-build-card"
      data-feature={featureCode}
      role="button"
      tabIndex={0}
      onClick={handleOpen}
      onKeyDown={(e) => { if (e.key === 'Enter') handleOpen(); }}
    >
      <div className="m-build-card-row">
        <div className="m-build-card-feature" title={featureCode}>{featureCode}</div>
        <span className="m-status-pill" data-status={status}>{status}</span>
      </div>
      <div className="m-build-card-meta">
        <span className="m-build-card-mode" data-mode={mode}>{mode}</span>
        <span className="m-build-card-time">{formatRelative(startedAt)}</span>
      </div>
      {tail.length > 0 && (
        <div className="m-build-card-tail">
          {tail.map((line, i) => (
            <div key={i} className="m-build-card-tail-line">{String(line).slice(0, 200)}</div>
          ))}
        </div>
      )}
      <div className="m-build-card-actions">
        <button
          type="button"
          className="m-btn m-btn-danger m-btn-sm"
          data-testid="mobile-build-abort"
          disabled={aborting || isTerminal(status)}
          onClick={handleAbort}
        >
          {aborting ? 'Aborting…' : 'Abort'}
        </button>
      </div>
      {err && <div className="m-agent-card-error">{err}</div>}
    </div>
  );
}

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAgentStream } from '../../hooks/useAgentStream.js';

function eventLine(evt, idx) {
  if (typeof evt === 'string') return evt;
  if (evt?.type && evt?.message) {
    return `[${evt.type}] ${typeof evt.message === 'string' ? evt.message : JSON.stringify(evt.message)}`;
  }
  if (evt?.type) return `[${evt.type}] ${JSON.stringify(evt).slice(0, 240)}`;
  try { return JSON.stringify(evt); } catch { return `(unserializable #${idx})`; }
}

function isTerminal(status) {
  return status === 'completed' || status === 'aborted' || status === 'failed' || status === 'done';
}

export default function BuildDetailView({ active, onClose, onAbort }) {
  const featureCode = active?.featureCode;
  // Filter the SSE stream to events tied to this build's flow when possible.
  const { events } = useAgentStream({ agentId: active?.flowId || null });
  const bottomRef = useRef(null);
  const [aborting, setAborting] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length]);

  const handleAbort = useCallback(async () => {
    if (!featureCode) return;
    setAborting(true);
    setErr(null);
    try {
      await onAbort?.({ featureCode });
    } catch (ex) {
      setErr(ex.message || 'Failed to abort');
    } finally {
      setAborting(false);
    }
  }, [featureCode, onAbort]);

  if (!active) return null;
  const status = active.status || 'unknown';
  const mode = active.mode || 'feature';

  return (
    <div className="m-overlay" data-testid="mobile-build-detail" role="dialog" aria-modal="true">
      <header className="m-overlay-header">
        <div className="m-overlay-header-inner">
          <div className="m-overlay-title" title={featureCode}>{featureCode}</div>
          <span className="m-status-pill" data-status={status}>{status}</span>
          <span className="m-build-card-mode" data-mode={mode}>{mode}</span>
        </div>
        <div className="m-overlay-actions">
          <button
            type="button"
            className="m-btn m-btn-danger m-btn-sm"
            disabled={aborting || isTerminal(status)}
            onClick={handleAbort}
            data-testid="mobile-build-detail-abort"
          >
            {aborting ? 'Aborting…' : 'Abort'}
          </button>
          <button
            type="button"
            className="m-btn m-btn-sm"
            onClick={onClose}
            data-testid="mobile-build-detail-close"
          >
            Close
          </button>
        </div>
      </header>

      <div className="m-overlay-body m-agent-log">
        {events.length === 0 ? (
          <div className="m-empty">No live events yet.</div>
        ) : (
          events.map((e, i) => (
            <div key={i} className="m-agent-log-line">{eventLine(e, i)}</div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {err && <div className="m-agent-card-error">{err}</div>}
    </div>
  );
}

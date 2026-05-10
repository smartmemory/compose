import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAgentStream } from '../../hooks/useAgentStream.js';
import { wsFetch } from '../../lib/wsFetch.js';
import { withComposeToken } from '../../lib/compose-api.js';

const AGENT_PORT = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_AGENT_PORT) || '4002';

function agentUrl(path) {
  if (typeof window === 'undefined' || !window.location) return path;
  return `${window.location.protocol}//${window.location.hostname}:${AGENT_PORT}${path}`;
}

function eventLine(evt, idx) {
  if (typeof evt === 'string') return evt;
  if (evt?.type && evt?.message) return `[${evt.type}] ${typeof evt.message === 'string' ? evt.message : JSON.stringify(evt.message)}`;
  if (evt?.type) return `[${evt.type}] ${JSON.stringify(evt).slice(0, 240)}`;
  try { return JSON.stringify(evt); } catch { return `(unserializable #${idx})`; }
}

export default function AgentDetailView({ agent, onClose }) {
  const id = agent?.agentId || agent?.id;
  const { events } = useAgentStream({ agentId: id });
  const bottomRef = useRef(null);
  const [killing, setKilling] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length]);

  const handleKill = useCallback(async () => {
    if (!id) return;
    setKilling(true);
    setError(null);
    try {
      const res = await wsFetch(agentUrl(`/api/agent/${encodeURIComponent(id)}/stop`), {
        method: 'POST',
        headers: withComposeToken({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        let data = null;
        try { data = await res.json(); } catch { /* */ }
        throw new Error((data && data.error) || `HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setKilling(false);
    }
  }, [id]);

  if (!agent) return null;

  return (
    <div className="m-overlay" data-testid="mobile-agent-detail" role="dialog" aria-modal="true">
      <header className="m-overlay-header">
        <div className="m-overlay-header-inner">
          <div className="m-overlay-title" title={id}>{id}</div>
          <span className="m-status-pill" data-status={agent.status}>{agent.status || 'unknown'}</span>
        </div>
        <div className="m-overlay-actions">
          <button
            type="button"
            className="m-btn m-btn-danger m-btn-sm"
            disabled={killing}
            onClick={handleKill}
            data-testid="mobile-agent-detail-kill"
          >
            {killing ? 'Killing…' : 'Kill'}
          </button>
          <button
            type="button"
            className="m-btn m-btn-sm"
            onClick={onClose}
            data-testid="mobile-agent-detail-close"
          >
            Close
          </button>
        </div>
      </header>

      <div className="m-overlay-body m-agent-log">
        {events.length === 0 ? (
          <div className="m-empty">No live events for this agent yet.</div>
        ) : (
          events.map((e, i) => (
            <div key={i} className="m-agent-log-line">{eventLine(e, i)}</div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {error && <div className="m-agent-card-error">{error}</div>}
    </div>
  );
}

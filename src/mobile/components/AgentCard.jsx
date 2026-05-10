import React, { useCallback, useState } from 'react';
import { wsFetch } from '../../lib/wsFetch.js';
import { withComposeToken } from '../../lib/compose-api.js';

const AGENT_PORT = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_AGENT_PORT) || '4002';

function agentUrl(path) {
  if (typeof window === 'undefined' || !window.location) return path;
  return `${window.location.protocol}//${window.location.hostname}:${AGENT_PORT}${path}`;
}

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

export default function AgentCard({ agent, onOpen, onAfterKill }) {
  const [killing, setKilling] = useState(false);
  const [error, setError] = useState(null);
  const id = agent.agentId || agent.id;
  const status = agent.status || 'unknown';
  const lastActivity = agent.lastActivityAt || agent.lastEventAt || agent.startedAt || null;

  const handleKill = useCallback(async (e) => {
    e?.stopPropagation();
    if (!id) return;
    if (!window.confirm) {
      // jsdom envs / production fallback — trust the user clicked the button
    }
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
      onAfterKill?.(id);
    } catch (err) {
      setError(err.message);
    } finally {
      setKilling(false);
    }
  }, [id, onAfterKill]);

  const handleClick = useCallback(() => onOpen?.(agent), [onOpen, agent]);

  return (
    <div
      className="m-agent-card"
      data-testid={`mobile-agent-card-${id}`}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => { if (e.key === 'Enter') handleClick(); }}
    >
      <div className="m-agent-card-row">
        <div className="m-agent-card-id" title={id}>{id || '(no id)'}</div>
        <span className="m-status-pill" data-status={status}>{status}</span>
      </div>
      <div className="m-agent-card-meta">
        <span className="m-agent-card-time">{formatRelative(lastActivity)}</span>
        <button
          type="button"
          className="m-btn m-btn-danger m-btn-sm"
          data-testid={`mobile-agent-kill-${id}`}
          disabled={killing || status !== 'running'}
          onClick={handleKill}
        >
          {killing ? 'Killing…' : 'Kill'}
        </button>
      </div>
      {error && <div className="m-agent-card-error">{error}</div>}
    </div>
  );
}

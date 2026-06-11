/**
 * useInteractiveSession — tracks the singleton interactive agent session
 * (agent-server.js). Polls GET /api/agent/session/status and exposes
 * sendMessage(text) which posts to /api/agent/session (first message) or
 * /api/agent/message (follow-up). Sends x-compose-token via withComposeToken.
 *
 * The interactive session is *exclusive* (one at a time). When `active` is
 * false, sendMessage will still create a new session via /api/agent/session.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { withComposeToken } from '../../lib/compose-api.js';
import { wsFetch, getAuthMode } from '../../lib/wsFetch.js';

import { agentServerUrl } from '../../lib/agentServer.js';
const POLL_MS = 5000;

// COMP-MOBILE-REMOTE S05: single mode check. In paired mode the agent-server
// is reached through the 4001 proxy (relative paths, wsFetch auth); in legacy
// mode the direct :4002 URLs keep working (localhost).
const PROXY_PATHS = {
  '/api/agent/session': '/api/agent/proxy/session',
  '/api/agent/message': '/api/agent/proxy/message',
  '/api/agent/interrupt': '/api/agent/proxy/interrupt',
  '/api/agent/session/status': '/api/agent/proxy/session/status',
};

function resolveAgentUrl(path) {
  if (getAuthMode() === 'mobile-paired') return PROXY_PATHS[path] || path;
  return agentServerUrl(path);
}

async function postSensitive(path, body) {
  const res = await wsFetch(resolveAgentUrl(path), {
    method: 'POST',
    headers: withComposeToken({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* */ }
  if (!res.ok) {
    const msg = (data && data.error) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

export function useInteractiveSession() {
  const [active, setActive] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await wsFetch(resolveAgentUrl('/api/agent/session/status'));
      const data = await res.json().catch(() => ({}));
      if (!aliveRef.current) return;
      setActive(!!data.active);
      setSessionId(data.sessionId || null);
      setError(null);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err.message);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => {
      aliveRef.current = false;
      clearInterval(id);
    };
  }, [refresh]);

  const sendMessage = useCallback(async (text) => {
    const trimmed = (text || '').trim();
    if (!trimmed) throw new Error('message is empty');
    setSending(true);
    try {
      // Use /message when a session is live; otherwise create a new one.
      const path = sessionId ? '/api/agent/message' : '/api/agent/session';
      const result = await postSensitive(path, { prompt: trimmed });
      // Refresh to pick up the new sessionId / active flag.
      refresh();
      return result;
    } finally {
      setSending(false);
    }
  }, [sessionId, refresh]);

  const interrupt = useCallback(async () => {
    return postSensitive('/api/agent/interrupt', {});
  }, []);

  return { active, sessionId, loading, error, sending, sendMessage, interrupt, refresh };
}

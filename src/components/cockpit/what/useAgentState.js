/**
 * useAgentState.js — COMP-COCKPIT-WHAT-LINE-1: Compose's own agent status from the `compose:agent-status` window event
 * AgentStream dispatches (`AgentStream.jsx:191`). Shared by the header pill and Home's status line so both read one source.
 */
import { useEffect, useState } from 'react';

export function useAgentState() {
  const [agentState, setAgentState] = useState({ status: 'idle', category: null });
  useEffect(() => {
    const handler = (e) => setAgentState(e.detail || { status: 'idle' });
    window.addEventListener('compose:agent-status', handler);
    return () => window.removeEventListener('compose:agent-status', handler);
  }, []);
  return agentState;
}

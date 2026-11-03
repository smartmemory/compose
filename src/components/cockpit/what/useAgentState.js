/**
 * useAgentState.js — COMP-COCKPIT-WHAT-LINE-1: Compose's own agent status from the `compose:agent-status` window event
 * AgentStream dispatches. Shared by the header pill and Home's status line so both read one source.
 * COMP-COCKPIT-SOURCE-FAULTS-1 (WHAT-LINE M2): a hook mounted after the last event starts from AgentStream's current
 * status (`getAgentStatus`), not idle, so a page opened mid-operation agrees with the header.
 */
import { useEffect, useState } from 'react';
import { getAgentStatus } from '../../AgentStream.jsx';

const same = (a, b) => a?.status === b?.status && a?.category === b?.category && a?.tool === b?.tool;

export function useAgentState() {
  const [agentState, setAgentState] = useState(getAgentStatus);
  useEffect(() => {
    const handler = (e) => setAgentState(e.detail || { status: 'idle' });
    window.addEventListener('compose:agent-status', handler);
    // A status set between the first render and this subscription would otherwise be missed until the next event.
    const now = getAgentStatus();
    setAgentState((s) => (same(s, now) ? s : now));
    return () => window.removeEventListener('compose:agent-status', handler);
  }, []);
  return agentState;
}
